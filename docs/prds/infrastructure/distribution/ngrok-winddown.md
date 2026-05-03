# Ngrok Winddown Log

## What We Had

Ngrok was our initial TLS tunneling solution for getting `wss://` (secure WebSocket) connectivity from the iOS app and browser viewers to the Bun relay server on the Hetzner VPS (`46.225.151.52`).

### Setup

- **Binary:** ngrok free tier, installed on VPS
- **Command:** `ngrok http 8080`
- **Admin API:** `http://localhost:4040/api/tunnels` (port 4040)
- **Authtoken:** Stored in Doppler as `NGROK_AUTHTOKEN`
- **Public URL:** Changed on every restart (e.g. `https://d80f-2a01-4f8-c013-ff7f-00-1.ngrok-free.app`)
- **Ports:** ngrok listened on 4040 (admin) and provided a public 443 endpoint

### Why It Worked (Initially)

- Zero-config TLS termination -- ngrok gave us `wss://` URLs without owning a domain
- Quick to stand up during early development on a single WiFi network
- iOS `URLSessionWebSocketTask` requires TLS (`wss://`) for some network configurations

### Why It Became a Problem

- **URL instability:** Free tier URL changes on every restart. iOS app hardcodes the relay URL, so every ngrok restart broke the app until we updated the URL
- **Interstitial page:** Browsers hitting the ngrok URL got a "visit site" interstitial page that blocked automated connections
- **Connection drops:** ngrok's free tier had idle timeouts that killed WebSocket connections, contributing to the POSIX error 57 ("Socket is not connected") issue we debugged extensively
- **Extra port:** Ran an unnecessary port 4040 admin API alongside Caddy's 443

## What We Replaced It With

**Caddy** reverse proxy with automatic Let's Encrypt TLS on `relay.simulationapi.com`.

```
relay.simulationapi.com {
    reverse_proxy localhost:8080
}
```

- **Domain:** `relay.simulationapi.com` (DNS A record -> `46.225.151.52`)
- **Permanent URL:** No more rotating URLs. iOS app uses `wss://relay.simulationapi.com/publish`
- **No idle timeouts:** Caddy is a proper reverse proxy, not a tunnel service
- **WebSocket support:** Natively handles `Connection: Upgrade` without custom transport config
- **Auto-TLS:** Let's Encrypt certificate auto-provisioned and renewed by Caddy

## What We Wound Down

1. Killed ngrok process on VPS: `kill $(pgrep ngrok)`
2. Port 4040 (ngrok admin API) no longer listening
3. Removed ngrok from NETWORKING.md service table
4. Updated iOS app default URL from ngrok to `wss://relay.simulationapi.com/publish`

### Left In Place

- **Doppler secret `NGROK_AUTHTOKEN`:** Still exists in Doppler but unused. Can be removed.
- **ngrok binary:** Still installed on VPS (`/usr/local/bin/ngrok`). Can be uninstalled.
- **DNS:** No longer needed for ngrok, but `relay.simulationapi.com` A record remains active and points to the VPS (used by Caddy).

## Lessons

- Ngrok is fine for quick prototyping but not suitable for persistent WebSocket connections
- Free-tier tunnel services introduce connection instability that masquerades as application bugs
- Caddy + a cheap domain is a permanent solution with less operational overhead than a free tunnel
- The POSIX 57 errors we spent time debugging were partly caused by ngrok's idle connection management

## Timeline

| Date | Event |
|------|-------|
| Initial | ngrok set up for TLS tunneling to relay server |
| Debugging | Discovered POSIX error 57 on WebSocket sends -- partially caused by ngrok idle drops |
| Migration | Set up Caddy + `relay.simulationapi.com` with auto-TLS |
| 2026-04-01 | Killed ngrok process, updated docs, wound down ngrok infrastructure |
