# PRD: Git Push / VPS Update / Deploy Workflow

## Status: ACTIVE

End-to-end workflow for pushing code changes to the relay server and iOS app.

---

## Infrastructure

| Component | Value |
|-----------|-------|
| VPS IP | `46.225.151.52` |
| Hostname | `caringmind-relay` |
| SSH user | `root` |
| Repo on VPS | `/root/relay-server` |
| Branch | `feat/stream-registry` |
| Remote | `git@github.com:ebowwa/meta-wearables-dat-ios.git` |
| Service | `caringmind-relay.service` |
| Runtime | Bun (`/root/.bun/bin/bun`) |
| Working dir | `/root/relay-server/hosted/server` |
| Log file | `/var/log/caringmind-relay.log` |
| Session storage | Cloudflare R2 (`caringmind-sessions`) |
| Port | `8080` |
| iPhone | Starlink (`00008110-001619CA1452801E`), iOS 18.7.3 |

---

## 1. Relay Server (TypeScript / Bun)

### Local development

```
cd packages/src/products/active/com.mwdat-ios
```

### Push to remote

```bash
git add hosted/server/src/<changed-files>
git commit -m "feat: description of change"
git push origin feat/stream-registry
```

### Deploy to VPS

The systemd service auto-pulls on restart (`ExecStartPre` runs `git pull`):

```bash
# From local machine (via SSH):
ssh root@46.225.151.52 "cd /root/relay-server && git pull origin feat/stream-registry && systemctl restart caringmind-relay"
```

Or step-by-step:

```bash
ssh root@46.225.151.52

# 1. Pull latest
cd /root/relay-server
git pull origin feat/stream-registry

# 2. Update version stamp in .env (optional, for /stats identification)
echo "GIT_COMMIT=$(git rev-parse --short=7 HEAD)" >> hosted/server/.env
echo "BUILD_VERSION=$(date +%Y%m%d-%H%M)" >> hosted/server/.env

# 3. Restart service
systemctl restart caringmind-relay

# 4. Verify
sleep 3
systemctl is-active caringmind-relay     # should print "active"
tail -10 /var/log/caringmind-relay.log   # check for startup logs or errors
curl -s http://localhost:8080/stats | python3 -m json.tool  # verify gitCommit matches
```

### Troubleshooting

```bash
# Check if server is crash-looping
systemctl status caringmind-relay

# View recent logs
tail -50 /var/log/caringmind-relay.log

# Run manually to see errors directly
cd /root/relay-server/hosted/server
/root/.bun/bin/bun run src/server.ts

# Common failures:
#   - "Cannot find module './X.js'" → file was not committed/pushed to git
#   - "'await' can only be used inside async" → missing async keyword
#   - "bun: command not found" → PATH not set in systemd (check Environment= line)
```

### systemd service file

Located at `/etc/systemd/system/caringmind-relay.service`:

```ini
[Unit]
Description=CaringMind Frame Relay Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/relay-server/hosted/server
EnvironmentFile=/root/relay-server/hosted/server/.env
Environment=BUN_INSTALL=/root/.bun
Environment=PATH=/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=RELAY_NO_AUTH=1
ExecStartPre=/bin/bash -c 'cd /root/relay-server && git pull origin feat/stream-registry'
ExecStart=/root/.bun/bin/bun run src/server.ts
Restart=always
RestartSec=5
StandardOutput=append:/var/log/caringmind-relay.log
StandardError=append:/var/log/caringmind-relay.log

[Install]
WantedBy=multi-user.target
```

### Environment variables

File: `/root/relay-server/hosted/server/.env`

| Variable | Purpose |
|----------|---------|
| `OBJECT_STORE_PROVIDER` | `s3` (Cloudflare R2) |
| `S3_ACCESS_KEY` | R2 access key |
| `S3_SECRET_KEY` | R2 secret key |
| `S3_BUCKET` | `caringmind-sessions` |
| `S3_ENDPOINT` | R2 endpoint URL |
| `S3_FORCE_PATH_STYLE` | `true` |
| `S3_REGION` | `auto` |
| `RELAY_NO_AUTH` | `1` (disable auth for dev) |
| `RELAY_PORT` | `8080` (default) |
| `GIT_COMMIT` | Short SHA for `/stats` identification |
| `BUILD_VERSION` | Timestamp for `/stats` identification |

---

## 2. iOS App (Xcode / TestFlight)

### Build and install to device

```bash
# Open Xcode project
open publishers/CameraAccess/CameraAccess.xcodeproj

# Or via command line:
xcodebuild -scheme CameraAccess \
  -destination 'id=00008110-001619CA1452801E' \
  -configuration Debug build
```

### Install to physical device

1. Connect iPhone via USB
2. Select device as run destination in Xcode
3. Product > Run (Cmd+R)
4. First install: Settings > General > VPN & Device Management > trust developer profile

### TestFlight distribution

See [PRD-001-testflight.md](./PRD-001-testflight.md) — blocked by prerequisite.

---

## 3. End-to-End Test Flow

### Start streaming from iPhone

1. Open CameraAccess app
2. Ensure glasses are connected via Bluetooth
3. Tap Start Streaming
4. Optionally enable Relay with the server URL: `wss://relay.simulationapi.com/publish`

### Send inbound audio (server-to-publisher)

```bash
# On VPS — build FRAU frame and POST to audio-in endpoint:
python3 << 'EOF'
import struct, time, urllib.request, math

SAMPLE_RATE = 22050
CHUNK_SAMPLES = int(SAMPLE_RATE * 0.2)  # 0.2s per frame
CHUNK_BYTES = CHUNK_SAMPLES * 2         # 16-bit PCM

pcm_data = open("/tmp/jfk_moon.pcm", "rb").read()
total_chunks = len(pcm_data) // CHUNK_BYTES

for i in range(total_chunks):
    chunk = pcm_data[i * CHUNK_BYTES : (i + 1) * CHUNK_BYTES]
    if len(chunk) < CHUNK_BYTES:
        break

    frame = (
        b'FRAU' +
        struct.pack('B', 3) +                    # codecType 3 (inbound)
        struct.pack('<Q', i) +                    # sequence
        struct.pack('<I', SAMPLE_RATE) +          # sampleRate
        struct.pack('<H', 1) +                    # channels
        struct.pack('<H', 16) +                   # bitsPerSample
        struct.pack('<Q', int(time.time() * 1000)) +  # timestamp
        chunk                                     # raw PCM
    )

    req = urllib.request.Request(
        'http://localhost:8080/session/default/audio-in',
        data=frame,
        headers={'Content-Type': 'application/octet-stream'}
    )
    urllib.request.urlopen(req).read()

    if i % 500 == 0:
        print(f"  {i}/{total_chunks}")

print(f"Done: {total_chunks} frames sent")
EOF
```

### Verify

```bash
# Check server stats
curl -s http://localhost:8080/stats | python3 -m json.tool

# Check recording export
curl -s http://localhost:8080/latest/export | python3 -m json.tool

# Check server logs
tail -20 /var/log/caringmind-relay.log
```

---

## 4. Wire Protocols

### FRLY (video frame)

```
[4B "FRLY"][8B sequence][4B width][4B height][1B quality][8B timestamp_ms][JPEG payload]
```

### FRAU (audio frame)

```
[4B "FRAU"][1B codecType][8B sequence][4B sampleRate][2B channels][2B bitsPerSample][8B timestamp_ms][PCM payload]
```

| codecType | Source | Sample Rate |
|-----------|--------|-------------|
| 0 | Phone built-in mic | 48000 |
| 1 | Glasses HFP mic | 16000 (upsampled from 8000) |
| 2 | TTS playback | 22050 |
| 3 | Inbound (relay to publisher) | varies |

---

## 5. Server Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/publish?session=<id>` | WS | iOS publisher connects here |
| `/view?session=<id>` | WS | Browser viewers connect here |
| `/tap/audio?session=<id>` | WS | Audio tap for external consumers |
| `/sessions` | GET | List all sessions (live + historical) |
| `/session/<id>` | GET | Serve viewer HTML |
| `/session/<id>/audio-in` | POST | Push FRAU audio to publisher + record + fanout |
| `/session/<id>/thumbnail` | GET | First-frame JPEG |
| `/session/<id>/video.mp4` | GET | MP4 export (cached to R2) |
| `/session/<id>/export` | GET | Recording metadata |
| `/session/<id>/share` | POST | Create share token |
| `/session/<id>/share/<tok>` | DELETE | Revoke share token |
| `/session/<id>/shares` | GET | List share tokens |
| `/session/<id>/access` | PATCH | Update access level / ACL |
| `/latest/video.mp4` | GET | Redirect to most recent MP4 |
| `/latest/export` | GET | Most recent recording metadata |
| `/stats` | GET | Server stats (auth required) |
| `/gallery/api` | GET | Gallery JSON feed (auth required) |
| `/` | GET | Unified viewer page |
