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

Caddy proxies `:443`/`:80` → `:8080`.

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
