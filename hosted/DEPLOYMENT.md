# Hosted Server — Deployment Reference

## Canonical VPS Layout

**Server:** `relay.simulationapi.com` (Hetzner)
**Process manager:** systemd (`caringmind-relay.service`)
**One and only source of truth on VPS:**

```
/root/relay-server/          ← git clone of meta-wearables-dat-ios
  hosted/
    packages/
      relay-protocol/        ← shared wire protocol (must build before server)
        dist/                ← built by `bun x tsc` (gitignored)
        src/
        package.json
    server/
      src/                   ← LIVE CODE (what bun executes)
        server.ts
        auth.ts
        audio-tap.ts
        permissions.ts
        protocol.ts
        session-export.ts
        session-recorder.ts
        session-registry.ts
        types.ts
      test/                  ← unit tests
      .env                   ← R2/S3 secrets (gitignored, never commit)
      .doppler.yaml          ← project: caringmind-hosted, config: prd
      package.json
      node_modules/
    viewer/                  ← Vite + TypeScript frontend
      src/
        main.ts, live.ts, auth.ts, recorded.ts, share.ts
        gallery/render.ts, gallery/format.ts
        player/relay-player.ts, player/frau-builder.ts, player/audio-worklet.ts
      index.html
      style.css
      vite.config.ts
```

## How the Server Runs

```
systemd: caringmind-relay.service
  ExecStartPre: cd /root/relay-server && git pull origin feat/stream-registry
  WorkingDirectory: /root/relay-server/hosted/server
  ExecStart: /root/.bun/bin/bun run src/server.ts
  EnvironmentFile: /root/relay-server/hosted/server/.env
  Restart: always, RestartSec: 5
  Logs: /var/log/caringmind-relay.log
```

The Bun server is **pure API** — it serves JSON endpoints and WebSocket upgrades only.
The viewer SPA is served directly by Caddy from `hosted/viewer/dist/`.
On startup the viewer fetches runtime config (auth, version) from `/api/config`.

**Architecture:**
```
Browser → Caddy (:443)
             ├─ /api/*        → Bun (:8080)  [JSON API + WebSocket]
             ├─ /publish      → Bun (:8080)  [WebSocket]
             ├─ /view         → Bun (:8080)  [WebSocket]
             ├─ /session/*    → Bun (:8080)  [JSON API]
             └─ /*            → hosted/viewer/dist/index.html  [SPA]
```

## Infrastructure Configs

Authoritative copies live in `hosted/infra/` and are tracked in git:

| File | VPS Location | Purpose |
|------|-------------|---------|
| `infra/caringmind-relay.service` | `/etc/systemd/system/` | systemd unit |
| `infra/Caddyfile` | `/etc/caddy/` | reverse proxy |

After changing infra configs, copy to VPS and reload:

```bash
scp hosted/infra/caringmind-relay.service root@relay.simulationapi.com:/etc/systemd/system/
scp hosted/infra/Caddyfile root@relay.simulationapi.com:/etc/caddy/
ssh root@relay.simulationapi.com "systemctl daemon-reload && systemctl restart caringmind-relay"
```

## Deploy New Code

```bash
# On VPS — systemd handles git pull on every restart, or manually:
ssh root@relay.simulationapi.com
cd /root/relay-server
git pull origin feat/stream-registry

# If relay-protocol changed (rare), rebuild:
cd hosted/packages/relay-protocol && /root/.bun/bin/bun install && /root/.bun/bin/bun x tsc

# Build viewer SPA (Caddy serves from dist/):
cd /root/relay-server/hosted/viewer && /root/.bun/bin/bun install && /root/.bun/bin/bun x vite build

# If server deps changed:
cd /root/relay-server/hosted/server && /root/.bun/bin/bun install

systemctl restart caringmind-relay.service
systemctl status caringmind-relay.service
```

## Branch Strategy

Active branch: `feat/stream-registry`
The VPS tracks **`origin feat/stream-registry`**, not `main`.
`ExecStartPre` always pulls latest on service (re)start.

## Secrets

Stored in `/root/relay-server/hosted/server/.env` — **never in git**.
Variables: `OBJECT_STORE_PROVIDER`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`,
`S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_FORCE_PATH_STYLE`.

Doppler config (`caringmind-hosted / prd`) is the source of record for secrets.
To rotate: update in Doppler → re-export to `.env` → `systemctl restart caringmind-relay`.

## Build Dependency Chain

`@ebowwa/relay-protocol` is a `file:../packages/relay-protocol` local dependency.
Its `dist/` is gitignored, so it must be built on the VPS after a fresh clone or
any changes to `hosted/packages/relay-protocol/src/`:

```bash
cd /root/relay-server/hosted/packages/relay-protocol
/root/.bun/bin/bun install
/root/.bun/bin/bun x tsc          # outputs to dist/
```

Server will fail with `Cannot find module '@ebowwa/relay-protocol'` if dist/ is missing.

## What Does NOT Exist (and Must Never Be Re-created)

| Path | Why it was removed |
|------|--------------------|
| `/opt/relay/` | Stale manual snapshot, was not running anything |
| `/root/relay-server/2/` | Abandoned copy with stale `node_modules` |
| `/root/relay-server/src/` | Root-level stray `server.ts`, untracked |
| `/root/relay-server/package.json` | Root-level stray, untracked |
| `/root/relay-server/node_modules/` | Root-level, empty, gitignored |
| `/root/relay-server/pkg/` | Root-level wasm artifacts, untracked |
| `/root/meta-wearables-dat-ios/` | Second git clone, 15 commits behind, unused |
| `/root/viewer/` | Stale HTML, superseded by `hosted/viewer/` |
| `/root/relay-server/relay/` | Renamed to `hosted/` — do not re-create |

> **Rule:** There is exactly ONE git clone on this VPS: `/root/relay-server`.
> There is exactly ONE place bun runs from: `/root/relay-server/hosted/server/`.
> If you find anything else claiming to be the relay server — delete it.

## Preview Deployments

Dynamic preview environments for branch-based testing, similar to Vercel.

### DNS

Requires a wildcard A record:

| Type | Host | Value |
|------|------|-------|
| A Record | `*.dev` | `46.225.151.52` |

This makes `anything.dev.simulationapi.com` resolve to the VPS.
Caddy auto-provisions TLS per-subdomain via Let's Encrypt.

### How It Works

```
Push to feat/my-feature (paths: hosted/**)
  → .github/workflows/deploy-preview.yml fires
  → SSH into VPS, runs preview-manager.sh spawn feat/my-feature
    → Allocates port pair from pool (relay:8081+, gateway:3001+)
    → git clone into /root/previews/feat-my-feature/
    → Builds WASM + relay-protocol + web-platform
    → Copies production .env, overrides RELAY_PORT + GATEWAY_PORT
    → Starts relay + gateway as background processes
    → Injects route into Caddyfile between BEGIN/END PREVIEWS markers
    → caddy reload
    → Health checks
  → Preview live at https://feat-my-feature.dev.simulationapi.com

Branch delete / PR merge
  → .github/workflows/destroy-preview.yml fires
  → SSH into VPS, runs preview-manager.sh destroy feat-my-feature
    → Kills processes, frees ports
    → Removes Caddy route, reloads
    → rm -rf /root/previews/feat-my-feature/
```

### VPS Layout (Previews)

```
/root/previews/
  registry.json                    # State: { slug → { ports, pids, branch, ... } }
  feat-my-feature/                 # git checkout
    hosted/server/                 # built relay
    hosted/gateway/                # built gateway
    hosted/web-platform/dist/      # built SPA
    hosted/packages/               # built WASM + relay-protocol
  feat-other-thing/
    ...

/var/log/previews/
  feat-my-feature-relay.log
  feat-my-feature-gateway.log
```

### Port Pool

| Service | Range | Max |
|---------|-------|-----|
| Relay | 8081–8090 | 10 concurrent |
| Gateway | 3001–3010 | 10 concurrent |

### Preview Manager Commands

```bash
# Run on VPS:
/root/relay-server/hosted/infra/preview-manager.sh spawn feat/my-feature
/root/relay-server/hosted/infra/preview-manager.sh destroy feat-my-feature
/root/relay-server/hosted/infra/preview-manager.sh list
/root/relay-server/hosted/infra/preview-manager.sh status feat-my-feature
/root/relay-server/hosted/infra/preview-manager.sh cleanup    # destroy expired + dead
```

### Workflow Triggers

| Workflow | Trigger | Branches |
|----------|---------|----------|
| `deploy-preview.yml` | Push to `feat/*`, `fix/*`, `chore/*`, `dev` | Paths: `hosted/**` |
| `destroy-preview.yml` | Branch delete, PR merge/close | Excludes `main`, `feat/stream-registry` |
| `deploy.yml` (production) | Push to `feat/stream-registry` | Paths: `hosted/**` |

### Auto-Cleanup

- Previews older than **24 hours** are destroyed by `cleanup`
- Previews with dead processes are destroyed by `cleanup`
- Run cleanup via cron for automatic maintenance:
  ```bash
  # Add to crontab on VPS:
  0 * * * * /root/relay-server/hosted/infra/preview-manager.sh cleanup >> /var/log/previews/cleanup.log 2>&1
  ```

### Secrets

Previews copy the production `.env` (same API keys: Deepgram, Palantir, APNS, etc.).
Port overrides are injected per-preview. No separate secret management needed.

### iOS Client

The iOS app must point to the preview URL for testing:
```swift
// In StreamSessionViewModel — change the default relay URL
let relayURL = "wss://feat-my-feature.dev.simulationapi.com/publish"
```

## Local ↔ VPS Sync Check

```bash
# What the VPS is running:
ssh root@relay.simulationapi.com "cd /root/relay-server && git log --oneline -3"

# What local has:
cd hosted && git log --oneline -3

# Diff a specific file:
ssh root@relay.simulationapi.com "cat /root/relay-server/hosted/server/src/server.ts" \
  | diff - server/src/server.ts
```

## Service Commands

```bash
systemctl status caringmind-relay.service
systemctl restart caringmind-relay.service
journalctl -u caringmind-relay.service -f        # live logs
tail -f /var/log/caringmind-relay.log             # file logs
ss -tlnp | grep 8080                              # port check
```
