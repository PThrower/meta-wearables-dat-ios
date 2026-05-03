#!/usr/bin/env bash
# preview-manager.sh — Dynamic preview environment manager
#
# Manages branch preview deployments for *.dev.simulationapi.com
# Each preview gets its own relay + gateway process pair on allocated ports.
#
# Usage:
#   preview-manager.sh spawn <branch>        # Create/update a preview
#   preview-manager.sh destroy <slug>         # Tear down a preview
#   preview-manager.sh list                   # Show active previews
#   preview-manager.sh cleanup                # Destroy previews older than TTL
#   preview-manager.sh status <slug>          # Check a single preview's health
#
# Layout on VPS:
#   /root/previews/
#     registry.json          # { "previews": { "slug": { ports, pids, branch, ... } } }
#     <slug>/                # git checkout + built assets
#       hosted/server/
#       hosted/gateway/
#       hosted/web-platform/dist/
#
# Port pool:
#   Relay:    8081 - 8090
#   Gateway:  3001 - 3010
#   (supports up to 10 concurrent previews)

set -euo pipefail

# --- Config ---

PREVIEWS_DIR="/root/previews"
REGISTRY_FILE="$PREVIEWS_DIR/registry.json"
REPO_DIR="/root/relay-server"
MAX_PREVIEWS=10
PREVIEW_TTL_HOURS=24
RELAY_PORT_START=8081
GATEWAY_PORT_START=3001
CADDYFILE="/etc/caddy/Caddyfile"
LOG_DIR="/var/log/previews"

BUN="/root/.bun/bin/bun"

# --- Helpers ---

log() { echo "[$(date '+%H:%M:%S')] $*"; }
err() { echo "[$(date '+%H:%M:%S')] ERROR: $*" >&2; }

branch_to_slug() {
  echo "$1" | tr '/' '-' | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]//g'
}

slug_to_domain() {
  echo "${1}.dev.simulationapi.com"
}

ensure_registry() {
  mkdir -p "$PREVIEWS_DIR" "$LOG_DIR"
  if [ ! -f "$REGISTRY_FILE" ]; then
    echo '{"previews":{}}' > "$REGISTRY_FILE"
  fi
}

read_registry() {
  cat "$REGISTRY_FILE"
}

write_registry() {
  local json="$1"
  echo "$json" > "$REGISTRY_FILE"
}

get_field() {
  local slug="$1" field="$2"
  read_registry | "$BUN" -e "
    const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const p = data.previews?.['$slug'];
    if (p && p['$field'] !== undefined) { console.log(typeof p['$field'] === 'object' ? JSON.stringify(p['$field']) : p['$field']); }
    else { process.exit(1); }
  " 2>/dev/null
}

set_field() {
  local slug="$1" field="$2" value="$3"
  local tmp
  tmp=$(read_registry | "$BUN" -e "
    const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    if (!data.previews) data.previews = {};
    if (!data.previews['$slug']) data.previews['$slug'] = {};
    const val = '$value';
    try { data.previews['$slug']['$field'] = JSON.parse(val); } catch { data.previews['$slug']['$field'] = val; }
    console.log(JSON.stringify(data));
  ")
  write_registry "$tmp"
}

# --- Port Allocation ---

allocate_ports() {
  local used_relay used_gw
  used_relay=$(read_registry | "$BUN" -e "
    const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const used = Object.values(data.previews || {}).map(p => p.relayPort);
    console.log(JSON.stringify(used));
  ")
  used_gw=$(read_registry | "$BUN" -e "
    const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const used = Object.values(data.previews || {}).map(p => p.gatewayPort);
    console.log(JSON.stringify(used));
  ")

  for i in $(seq 0 $((MAX_PREVIEWS - 1))); do
    local relay_port=$((RELAY_PORT_START + i))
    local gw_port=$((GATEWAY_PORT_START + i))
    if ! echo "$used_relay" | grep -q "\"$relay_port\"" && ! echo "$used_gw" | grep -q "\"$gw_port\""; then
      echo "$relay_port $gw_port"
      return 0
    fi
  done
  err "No available ports (all $MAX_PREVIEWS slots in use)"
  return 1
}

count_previews() {
  read_registry | "$BUN" -e "
    const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    console.log(Object.keys(data.previews || {}).length);
  "
}

# --- Caddy Management ---

update_caddy() {
  # Extract preview routes from registry and inject between delimiters
  local preview_block=""
  local entries
  entries=$(read_registry | "$BUN" -e "
    const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    Object.entries(data.previews || {}).forEach(([slug, p]) => {
      console.log(slug + ' ' + p.gatewayPort);
    });
  " 2>/dev/null || true)

  while IFS=' ' read -r slug gw_port; do
    [ -z "$slug" ] && continue
    local domain
    domain=$(slug_to_domain "$slug")
    preview_block+="${domain} {
    reverse_proxy localhost:${gw_port}
}
"
  done <<< "$entries"

  # Build new Caddyfile: everything up to BEGIN marker + preview block + after END marker
  local new_caddy
  if grep -q "# BEGIN PREVIEWS" "$CADDYFILE" 2>/dev/null; then
    new_caddy=$(sed '/# BEGIN PREVIEWS/,/# END PREVIEWS/d' "$CADDYFILE")
    new_caddy+=$'\n'"# BEGIN PREVIEWS (auto-managed by preview-manager.sh — do not edit)"$'\n'
    new_caddy+="$preview_block"
    new_caddy+="# END PREVIEWS"$'\n'
  else
    new_caddy=$(cat "$CADDYFILE")
    new_caddy+=$'\n'$'\n'"# BEGIN PREVIEWS (auto-managed by preview-manager.sh — do not edit)"$'\n'
    new_caddy+="$preview_block"
    new_caddy+="# END PREVIEWS"$'\n'
  fi

  echo "$new_caddy" > "$CADDYFILE"
  caddy reload --config "$CADDYFILE" 2>&1 || {
    err "Caddy reload failed — check Caddyfile syntax"
    return 1
  }
  log "Caddy reloaded with $(echo "$entries" | grep -c . || echo 0) preview routes"
}

# --- Process Management ---

start_preview_processes() {
  local slug="$1" relay_port="$2" gw_port="$3"
  local preview_dir="$PREVIEWS_DIR/$slug"

  # Source cargo env for potential WASM rebuilds
  source "$HOME/.cargo/env" 2>/dev/null || true

  # --- Build ---
  log "Building WASM frame relay"
  cd "$preview_dir/hosted/packages/frame-relay-wasm"
  wasm-pack build --target nodejs --out-dir ../../server/pkg 2>&1 || {
    err "WASM build failed for $slug"
    return 1
  }

  log "Building relay-protocol"
  cd "$preview_dir/hosted/packages/relay-protocol"
  if [ ! -d dist ] || [ "$(find src -newer dist -type f 2>/dev/null | wc -l)" -gt 0 ]; then
    "$BUN" install && "$BUN" x tsc
  fi

  log "Building web platform"
  cd "$preview_dir/hosted/web-platform"
  "$BUN" install && "$BUN" x vite build

  log "Installing server deps"
  cd "$preview_dir/hosted/server"
  "$BUN" install

  log "Installing gateway deps"
  cd "$preview_dir/hosted/gateway"
  "$BUN" install

  # --- Prepare env ---
  local env_file="$preview_dir/hosted/server/.env"
  # Copy production env as base (has secrets)
  if [ -f "$REPO_DIR/hosted/server/.env" ]; then
    cp "$REPO_DIR/hosted/server/.env" "$env_file"
  else
    err "Production .env not found at $REPO_DIR/hosted/server/.env"
    return 1
  fi

  # Override ports for this preview
  sed -i "s/^RELAY_PORT=.*/RELAY_PORT=$relay_port/" "$env_file" 2>/dev/null || echo "RELAY_PORT=$relay_port" >> "$env_file"
  sed -i "s/^GATEWAY_PORT=.*/GATEWAY_PORT=$gw_port/" "$env_file" 2>/dev/null || true  # gateway doesn't read this but useful for reference

  # Version stamp
  local commit version
  commit=$(cd "$preview_dir" && git rev-parse --short HEAD)
  version="$(date +%Y%m%d-%H%M)"
  sed -i "s/^GIT_COMMIT=.*/GIT_COMMIT=$commit/" "$env_file" 2>/dev/null || echo "GIT_COMMIT=$commit" >> "$env_file"
  sed -i "s/^BUILD_VERSION=.*/BUILD_VERSION=$version/" "$env_file" 2>/dev/null || echo "BUILD_VERSION=$version" >> "$env_file"

  # --- Kill existing processes if restarting ---
  local old_relay_pid old_gw_pid
  old_relay_pid=$(get_field "$slug" "relayPid" 2>/dev/null || echo "")
  old_gw_pid=$(get_field "$slug" "gatewayPid" 2>/dev/null || echo "")
  [ -n "$old_relay_pid" ] && kill "$old_relay_pid" 2>/dev/null || true
  [ -n "$old_gw_pid" ] && kill "$old_gw_pid" 2>/dev/null || true
  sleep 1

  # --- Start relay ---
  log "Starting relay on port $relay_port"
  cd "$preview_dir/hosted/server"
  RELAY_PORT="$relay_port" \
  RELAY_TRUST_HEADERS=1 \
  RELAY_NO_AUTH=1 \
  nohup "$BUN" run src/server.ts \
    >> "$LOG_DIR/${slug}-relay.log" 2>&1 &
  local relay_pid=$!

  # --- Start gateway ---
  log "Starting gateway on port $gw_port"
  cd "$preview_dir/hosted/gateway"
  GATEWAY_PORT="$gw_port" \
  RELAY_PORT="$relay_port" \
  RELAY_TRUST_HEADERS=1 \
  VIEWER_DIST="$preview_dir/hosted/web-platform/dist" \
  nohup "$BUN" run src/index.ts \
    >> "$LOG_DIR/${slug}-gateway.log" 2>&1 &
  local gw_pid=$!

  # --- Store PIDs ---
  set_field "$slug" "relayPid" "$relay_pid"
  set_field "$slug" "gatewayPid" "$gw_pid"

  log "Started relay (PID $relay_pid :$relay_port) and gateway (PID $gw_pid :$gw_port)"
}

# --- Health Check ---

health_check() {
  local port="$1" max_attempts="${2:-10}" i=1
  while [ $i -le $max_attempts ]; do
    if curl -sf "http://localhost:${port}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    i=$((i + 1))
  done
  return 1
}

# --- Commands ---

cmd_spawn() {
  local branch="$1"
  local slug
  slug=$(branch_to_slug "$branch")
  local domain
  domain=$(slug_to_domain "$slug")
  local preview_dir="$PREVIEWS_DIR/$slug"

  ensure_registry

  # Check if preview already exists — if so, rebuild it (update)
  local existing_relay_port
  existing_relay_port=$(get_field "$slug" "relayPort" 2>/dev/null || echo "")

  if [ -n "$existing_relay_port" ]; then
    log "Preview '$slug' already exists — updating in place"
    local relay_port="$existing_relay_port"
    local gw_port
    gw_port=$(get_field "$slug" "gatewayPort")
  else
    # Check capacity
    local count
    count=$(count_previews)
    if [ "$count" -ge "$MAX_PREVIEWS" ]; then
      err "Maximum previews ($MAX_PREVIEWS) reached. Run 'cleanup' or 'destroy' to free slots."
      return 1
    fi

    # Allocate ports
    local ports
    ports=$(allocate_ports)
    relay_port=$(echo "$ports" | awk '{print $1}')
    local gw_port
    gw_port=$(echo "$ports" | awk '{print $2}')

    # Register in registry
    read_registry | "$BUN" -e "
      const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      data.previews['$slug'] = {
        branch: '$branch',
        relayPort: $relay_port,
        gatewayPort: $gw_port,
        relayPid: 0,
        gatewayPid: 0,
        createdAt: new Date().toISOString(),
        path: '$preview_dir'
      };
      console.log(JSON.stringify(data));
    " > "${REGISTRY_FILE}.tmp" && mv "${REGISTRY_FILE}.tmp" "$REGISTRY_FILE"
    log "Allocated ports relay:$relay_port gateway:$gw_port for '$slug'"
  fi

  # Clone or update checkout
  if [ -d "$preview_dir/.git" ]; then
    log "Fetching latest for $branch"
    cd "$preview_dir"
    git fetch origin "$branch"
    git reset --hard "origin/$branch"
    git clean -fd hosted/server/pkg/ hosted/web-platform/dist/ 2>/dev/null || true
  else
    log "Cloning $branch into $preview_dir"
    rm -rf "$preview_dir"
    git clone --branch "$branch" --single-branch "https://github.com/ebowwa/meta-wearables-dat-ios.git" "$preview_dir"
    cd "$preview_dir"
  fi

  # Build + start processes
  start_preview_processes "$slug" "$relay_port" "$gw_port"

  # Update Caddy routing
  update_caddy

  # Health check
  log "Waiting for relay health on :$relay_port"
  if health_check "$relay_port" 10; then
    log "Relay healthy"
  else
    err "Relay health check failed — check $LOG_DIR/${slug}-relay.log"
    return 1
  fi

  log "Waiting for gateway health on :$gw_port"
  if health_check "$gw_port" 10; then
    log "Gateway healthy"
  else
    err "Gateway health check failed — check $LOG_DIR/${slug}-gateway.log"
    return 1
  fi

  local commit
  commit=$(cd "$preview_dir" && git rev-parse --short HEAD)
  log "============================================="
  log "Preview ready!"
  log "  Branch:   $branch"
  log "  URL:      https://$domain"
  log "  Commit:   $commit"
  log "  Relay:    :$relay_port (PID $(get_field "$slug" relayPid))"
  log "  Gateway:  :$gw_port (PID $(get_field "$slug" gatewayPid))"
  log "  Logs:     $LOG_DIR/${slug}-{relay,gateway}.log"
  log "============================================="
}

cmd_destroy() {
  local slug="$1"
  ensure_registry

  # Verify it exists
  local relay_port gw_port relay_pid gw_pid
  relay_port=$(get_field "$slug" "relayPort" 2>/dev/null) || { err "Preview '$slug' not found"; return 1; }
  gw_port=$(get_field "$slug" "gatewayPort")
  relay_pid=$(get_field "$slug" "relayPid" 2>/dev/null || echo "")
  gw_pid=$(get_field "$slug" "gatewayPid" 2>/dev/null || echo "")

  log "Destroying preview '$slug'"

  # Kill processes
  [ -n "$relay_pid" ] && kill "$relay_pid" 2>/dev/null && log "Killed relay PID $relay_pid" || true
  [ -n "$gw_pid" ] && kill "$gw_pid" 2>/dev/null && log "Killed gateway PID $gw_pid" || true

  # Kill anything still on those ports (belt and suspenders)
  fuser -k "$relay_port/tcp" 2>/dev/null || true
  fuser -k "$gw_port/tcp" 2>/dev/null || true

  # Remove from registry
  read_registry | "$BUN" -e "
    const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    delete data.previews['$slug'];
    console.log(JSON.stringify(data));
  " > "${REGISTRY_FILE}.tmp" && mv "${REGISTRY_FILE}.tmp" "$REGISTRY_FILE"

  # Remove checkout
  rm -rf "$PREVIEWS_DIR/$slug"
  rm -f "$LOG_DIR/${slug}-relay.log" "$LOG_DIR/${slug}-gateway.log"

  # Update Caddy
  update_caddy

  log "Preview '$slug' destroyed"
}

cmd_list() {
  ensure_registry
  local count
  count=$(count_previews)

  if [ "$count" -eq 0 ]; then
    log "No active previews"
    return 0
  fi

  log "Active previews ($count/$MAX_PREVIEWS):"
  read_registry | "$BUN" -e "
    const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const previews = data.previews || {};
    const now = Date.now();
    console.log('');
    console.log('SLUG'.padEnd(30) + 'BRANCH'.padEnd(25) + 'DOMAIN'.padEnd(40) + 'AGE'.padEnd(10) + 'RELAY'.padEnd(8) + 'GW'.padEnd(8));
    console.log('-'.repeat(121));
    Object.entries(previews).forEach(([slug, p]) => {
      const age = Math.round((now - new Date(p.createdAt).getTime()) / 3600000);
      const domain = slug + '.dev.simulationapi.com';
      console.log(
        slug.padEnd(30) +
        (p.branch || '').padEnd(25) +
        domain.padEnd(40) +
        (age + 'h').padEnd(10) +
        (':' + p.relayPort).padEnd(8) +
        (':' + p.gatewayPort).padEnd(8)
      );
    });
    console.log('');
  "
}

cmd_status() {
  local slug="$1"
  ensure_registry

  local relay_port
  relay_port=$(get_field "$slug" "relayPort" 2>/dev/null) || { err "Preview '$slug' not found"; return 1; }
  local gw_port
  gw_port=$(get_field "$slug" "gatewayPort")
  local domain
  domain=$(slug_to_domain "$slug")

  local relay_ok="DOWN" gw_ok="DOWN"
  curl -sf "http://localhost:${relay_port}/health" >/dev/null 2>&1 && relay_ok="UP"
  curl -sf "http://localhost:${gw_port}/health" >/dev/null 2>&1 && gw_ok="UP"

  log "Preview '$slug' status:"
  log "  Domain:   https://$domain"
  log "  Relay:    :$relay_port [$relay_ok]"
  log "  Gateway:  :$gw_port [$gw_ok]"
  log "  Branch:   $(get_field "$slug" branch)"
  log "  Created:  $(get_field "$slug" createdAt)"
  [ "$relay_ok" = "UP" ] && log "  Relay health: $(curl -sf "http://localhost:${relay_port}/health" 2>/dev/null)"
}

cmd_cleanup() {
  ensure_registry
  local count=0

  # Destroy previews older than TTL
  local slugs
  slugs=$(read_registry | "$BUN" -e "
    const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const now = Date.now();
    const ttl = $PREVIEW_TTL_HOURS * 3600000;
    Object.entries(data.previews || {}).forEach(([slug, p]) => {
      if (now - new Date(p.createdAt).getTime() > ttl) {
        console.log(slug);
      }
    });
  " 2>/dev/null || true)

  while IFS= read -r slug; do
    [ -z "$slug" ] && continue
    log "TTL expired: $slug"
    cmd_destroy "$slug"
    count=$((count + 1))
  done <<< "$slugs"

  # Also destroy previews whose processes have died
  slugs=$(read_registry | "$BUN" -e "
    const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    Object.entries(data.previews || {}).forEach(([slug, p]) => {
      console.log(slug + ' ' + p.relayPid + ' ' + p.gatewayPid);
    });
  " 2>/dev/null || true)

  while IFS=' ' read -r slug relay_pid gw_pid; do
    [ -z "$slug" ] && continue
    if ! kill -0 "$relay_pid" 2>/dev/null || ! kill -0 "$gw_pid" 2>/dev/null; then
      log "Dead processes: $slug (relay PID $relay_pid, gateway PID $gw_pid)"
      cmd_destroy "$slug"
      count=$((count + 1))
    fi
  done <<< "$slugs"

  if [ "$count" -eq 0 ]; then
    log "No previews to clean up"
  else
    log "Cleaned up $count preview(s)"
  fi
}

# --- Main ---

case "${1:-help}" in
  spawn)
    [ -z "${2:-}" ] && { err "Usage: preview-manager.sh spawn <branch>"; exit 1; }
    cmd_spawn "$2"
    ;;
  destroy)
    [ -z "${2:-}" ] && { err "Usage: preview-manager.sh destroy <slug>"; exit 1; }
    cmd_destroy "$2"
    ;;
  list)
    cmd_list
    ;;
  status)
    [ -z "${2:-}" ] && { err "Usage: preview-manager.sh status <slug>"; exit 1; }
    cmd_status "$2"
    ;;
  cleanup)
    cmd_cleanup
    ;;
  help|*)
    echo "preview-manager.sh — Dynamic preview environment manager"
    echo ""
    echo "Commands:"
    echo "  spawn <branch>    Create or update a preview for a branch"
    echo "  destroy <slug>    Tear down a preview (slug = branch with / replaced by -)"
    echo "  list              Show all active previews"
    echo "  status <slug>     Check health of a specific preview"
    echo "  cleanup           Destroy previews older than ${PREVIEW_TTL_HOURS}h or with dead processes"
    echo ""
    echo "Examples:"
    echo "  preview-manager.sh spawn feat/my-feature"
    echo "  # → https://feat-my-feature.dev.simulationapi.com"
    echo "  preview-manager.sh destroy feat-my-feature"
    echo "  preview-manager.sh list"
    echo "  preview-manager.sh cleanup"
    ;;
esac
