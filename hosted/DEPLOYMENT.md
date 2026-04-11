# Relay Server — Deployment Reference

## Canonical VPS Layout

**Server:** `relay.simulationapi.com` (Hetzner)  
**Process manager:** systemd (`caringmind-relay.service`)  
**One and only source of truth on VPS:**

```
/root/relay-server/          ← git clone of meta-wearables-dat-ios
  relay/
    server/
      src/                   ← LIVE CODE (what bun executes)
        server.ts
        session-export.ts
        session-registry.ts
        session-recorder.ts
        protocol.ts
        types.ts
      .env                   ← R2/S3 secrets (gitignored, never commit)
      .doppler.yaml          ← project: caringmind-relay, config: prd
      package.json
      node_modules/
    viewer/
      index.html
      directory.html
      gallery.html
```

## How the Server Runs

```
systemd: caringmind-relay.service
  ExecStartPre: cd /root/relay-server && git pull origin feat/stream-registry
  WorkingDirectory: /root/relay-server/relay/server
  ExecStart: bun run src/server.ts
  EnvironmentFile: /root/relay-server/relay/server/.env
  Restart: always, RestartSec: 5
  Logs: /var/log/caringmind-relay.log
```

Caddy proxies `:443`/`:80` → `:8080`.

## Deploy New Code

```bash
# On VPS — systemd handles git pull on every restart, or manually:
ssh root@relay.simulationapi.com
cd /root/relay-server
git pull origin feat/stream-registry
systemctl restart caringmind-relay.service
systemctl status caringmind-relay.service
```

## Branch Strategy

Active branch: `feat/stream-registry`  
The VPS tracks **`origin feat/stream-registry`**, not `main`.  
`ExecStartPre` always pulls latest on service (re)start.

## Secrets

Stored in `/root/relay-server/relay/server/.env` — **never in git**.  
Variables: `OBJECT_STORE_PROVIDER`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`,  
`S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_FORCE_PATH_STYLE`.

Doppler config (`caringmind-relay / prd`) is the source of record for secrets.  
To rotate: update in Doppler → re-export to `.env` → `systemctl restart caringmind-relay`.

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
| `/root/viewer/` | Stale HTML, superseded by `relay/viewer/` |

> **Rule:** There is exactly ONE git clone on this VPS: `/root/relay-server`.  
> There is exactly ONE place bun runs from: `/root/relay-server/relay/server/`.  
> If you find anything else claiming to be the relay server — delete it.

## Local ↔ VPS Sync Check

```bash
# What the VPS is running:
ssh root@relay.simulationapi.com "cd /root/relay-server && git log --oneline -3"

# What local has:
cd relay && git log --oneline -3

# Diff a specific file:
ssh root@relay.simulationapi.com "cat /root/relay-server/relay/server/src/server.ts" \
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
