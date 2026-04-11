# Infrastructure and Capacity Planning

Compute resource model for the relay platform. How many concurrent publishers a server handles, how to calculate it, and what infrastructure is missing from the platform.

Written 2026-04-03 against commit `33ea802` on `feat/telemetry-diagnostics`.

---

## Per-Frame Server Work

When a publisher sends a frame, the server does this:

```
1. Receive WebSocket binary (~20KB)         -- network I/O, kernel buffer
2. Parse 29-byte FRLY header                -- DataView, ~5 arithmetic ops
3. updateTiming() on publisher               -- EMA math, ~10 arithmetic ops
4. WASM should_relay() check (publisher)     -- 1 WASM call, comparison
5. For each viewer:
   a. Check readyState                       -- memory read
   b. Quality preset lookup                  -- memory read
   c. Elapsed time check                     -- subtraction + comparison
   d. ws.send(data)                          -- memcpy to kernel buffer
   e. Increment counters                     -- 4 integer ops
   f. updateTiming() on viewer               -- EMA math, ~10 arithmetic ops
6. For each audio frame (FRAU):
   a. ws.send(data)                          -- memcpy, no throttle
```

**Key insight:** The server is a memory-copy machine. It does no encoding, no decoding, no JPEG work. It receives a buffer and copies it to N viewer sockets. The CPU cost per frame is dominated by the `ws.send()` memcpy, not by any computation.

---

## Resource Model

### Per Publisher

| Resource | Value | Derivation |
|----------|-------|------------|
| Inbound bandwidth | ~300 KB/s | 15fps x 20KB/frame (720p JPEG @ 0.6 quality) |
| Audio inbound | ~768 KB/s | 48kHz x 16-bit mono PCM continuous |
| Total inbound | ~1.07 MB/s | video + audio |
| Inbound per hour | ~3.85 GB | 1.07 MB/s x 3600 |
| Server CPU (receive + parse) | < 0.5% core | trivial arithmetic on 29 bytes, 15x/sec |
| Server memory | ~1 MB | frame buffer + timing state + publisher struct |

### Per Viewer (on top of publisher)

| Resource | Value | Derivation |
|----------|-------|------------|
| Outbound bandwidth (high) | ~300 KB/s | 15fps x 20KB, 1:1 with publisher |
| Outbound bandwidth (medium) | ~150 KB/s | throttled to 15fps |
| Outbound bandwidth (low) | ~80 KB/s | throttled to 8fps |
| Outbound bandwidth (mini) | ~40 KB/s | throttled to 4fps |
| Server CPU (send) | < 0.1% core per viewer | memcpy + timing update |
| Server memory | ~0.5 KB | viewer struct + timing state |

### Fan-Out Multiplier

The server's bottleneck is **outbound bandwidth**, not CPU. Each viewer adds outbound equal to the publisher's inbound video rate (at their quality level).

```
Publisher sends:  300 KB/s inbound (one stream)
5 viewers (high): 5 x 300 = 1,500 KB/s outbound
5 viewers (mix):  2x high + 2x medium + 1x low
                 = 600 + 300 + 80 = 980 KB/s outbound
```

---

## Capacity: How Many Publishers

### Single Publisher (Current)

The server currently accepts exactly one publisher. All viewers watch that one stream.

```
1 publisher + 10 viewers (high)
  CPU:  ~1% single core
  RAM:  ~10 MB
  In:   ~1.07 MB/s
  Out:  ~3 MB/s (10 x 300KB/s)
  Total: ~4 MB/s = 32 Mbps
```

This is nothing. A Raspberry Pi could handle it.

### Multi-Publisher (Planned)

When `docs/multi-session-platform.md` is implemented, the server routes multiple independent publisher->viewer sessions.

**Bottleneck analysis for a Hetzner CX32 (dedicated vCPU):**

| Resource | Capacity | Per Publisher | Max Publishers |
|----------|----------|-------------|----------------|
| CPU (1 vCPU) | ~100% | ~0.5% receive + N x 0.1% fan-out | 50-100 (CPU not the limit) |
| RAM (8 GB) | ~7 GB usable | ~1 MB per + ~0.5 KB per viewer | ~1000+ |
| Inbound bandwidth (1 Gbps) | ~125 MB/s | ~1.07 MB/s | ~115 |
| Outbound bandwidth (1 Gbps) | ~125 MB/s | varies by viewers | **this is the limit** |
| File descriptors | ~65K | ~12 (1 pub + 10 viewers + overhead) | ~5000 |

**Outbound bandwidth is the binding constraint.**

### The Math

```
server_outbound_capacity = 125 MB/s  (1 Gbps, theoretical max)
usable_outbound = 100 MB/s           (80% headroom for spikes, TCP overhead)

per_publisher_outbound = avg_viewers x avg_viewer_bandwidth

publishers_max = usable_outbound / per_publisher_outbound
```

**Scenario A: 3 viewers each, high quality**

```
per_publisher = 3 x 300 KB/s = 900 KB/s = 0.88 MB/s
publishers_max = 100 / 0.88 = ~113 concurrent publishers
```

**Scenario B: 5 viewers each, mixed quality**

```
per_publisher = 2x high(300) + 2x medium(150) + 1x low(80) = 980 KB/s = 0.96 MB/s
publishers_max = 100 / 0.96 = ~104 concurrent publishers
```

**Scenario C: 1 viewer each, high quality (typical caregiver monitoring)**

```
per_publisher = 1 x 300 KB/s = 0.29 MB/s
publishers_max = 100 / 0.29 = ~344 concurrent publishers
```

### Capacity by Server Size

| Hetzner Server | vCPU | RAM | Bandwidth | Max Publishers (3 viewers each) | Monthly Cost |
|---------------|------|-----|-----------|--------------------------------|-------------|
| CX22 | 2 shared | 4 GB | 20 TB | ~40 | EUR 4.15 |
| CX32 | 2 shared | 8 GB | 20 TB | ~100 | EUR 7.94 |
| CX42 | 4 shared | 16 GB | 20 TB | ~100 (bandwidth bound, not CPU) | EUR 14.92 |
| CX52 | 8 shared | 32 GB | 20 TB | ~100 (bandwidth bound) | EUR 27.60 |
| CAX11 (ARM) | 2 shared | 6 GB | 20 TB | ~90 | EUR 3.29 |
| CAX21 (ARM) | 4 shared | 12 GB | 20 TB | ~100 (bandwidth bound) | EUR 6.14 |

**Key finding:** Beyond CX32, you're paying for CPU/RAM you can't use. The 1 Gbps network port saturates before the CPU does. To go beyond ~100 publishers, you need multiple servers or a higher-bandwidth instance.

**Hetzner dedicated vCPU instances (no sharing):**

| Server | Bandwidth | Max Publishers (3 viewers) | Monthly |
|--------|-----------|---------------------------|---------|
| CCX13 | 1 Gbps | ~100 | EUR 9.34 |
| CCX23 | 1 Gbps | ~100 | EUR 17.68 |
| CCX33 | 1 Gbps | ~100 | EUR 35.36 |

Same 1 Gbps limit. Dedicated CPU helps if you need consistent latency, but doesn't change the publisher ceiling.

---

## Monthly Bandwidth Budget

Hetzner includes 20 TB outbound/month on most instances.

```
Per publisher per hour:  1.07 MB/s in + 900 KB/s out (3 viewers) = 1.95 MB/s
Per publisher per day:   1.95 x 86400 = 168 GB/day (if streaming 24h)
Per publisher per month: 168 x 30 = 5,040 GB = 5 TB/month

20 TB / 5 TB = 4 publishers streaming 24/7 (3 viewers each)
```

But real usage is not 24/7. If average session is 2 hours/day:

```
Per publisher per day:   2h x 7 GB/h = 14 GB/day (in + out combined)
Per publisher per month: 14 x 30 = 420 GB/month

20 TB / 420 GB = ~47 publishers (2h/day, 3 viewers each)
```

### With Bucket Writes (Server-Side Recording)

Adding persistence changes the bandwidth profile. The session recorder writes to S3:

```
Additional outbound to bucket:
  Video: ~300 KB/s (same as publisher inbound)
  Audio: ~768 KB/s
  Total: ~1.07 MB/s outbound to S3 per publisher

  Per hour: 3.85 GB
  Per day (2h): 7.7 GB
  Per month: 231 GB

This is server-to-S3, not server-to-internet.
  - Hetzner Storage Box: free egress (internal)
  - Cloudflare R2: free egress ($0)
  - GCS/AWS: paid egress

If using Hetzner Storage Box or R2, bucket writes don't count against the 20 TB.
If using GCS/AWS, subtract bucket bandwidth from the 20 TB budget.
```

---

## Missing Infrastructure

### 1. TLS / HTTPS

**Current:** Plain HTTP/WS. No TLS.

**Needed for:** Production deployment. Browsers require HTTPS for camera/mic permissions (not relevant here since iOS publisher doesn't use browser APIs, but viewers do).

**Options:**

| Approach | Complexity | Cost |
|----------|-----------|------|
| Caddy reverse proxy | Low -- automatic Let's Encrypt | Free |
| Nginx + certbot | Medium -- manual cert renewal | Free |
| Cloudflare tunnel | Low -- zero open ports | Free (tunnel) + domain |
| Hetzner load balancer (with TLS) | Low -- managed | EUR 5.40/month |

Caddy is the simplest: single binary, automatic HTTPS, reverse proxy to Bun on localhost.

### 2. DNS / Domain

**Current:** IP address + port.

**Needed for:** TLS certificates, user-facing URLs, multiple services on one server.

```
caringmind.dev          -> Caddy -> :443
  /                     -> relay server (viewer HTML)
  /publish              -> relay server (WebSocket)
  /view                 -> relay server (WebSocket)
  /api/*                -> relay server (HTTP)
  /stats                -> relay server (internal, firewall)
  grafana.caringmind.dev -> Caddy -> Grafana (monitoring)
```

### 3. Process Management

**Current:** `bun run server.ts` in a tmux session. Dies on crash, no restart.

**Needed:** Process supervisor that restarts on crash, captures logs, manages lifecycle.

| Approach | Complexity | Notes |
|----------|-----------|-------|
| systemd | Low | Standard on Linux, Bun as service unit |
| Docker + docker-compose | Medium | Portable, isolates dependencies |
| PM2 | Low | Node process manager, works with Bun |
| Overmind (foreman) | Low | Procfile-based, good for multi-process |

systemd is the simplest for a single Hetzner box:

```ini
[Unit]
Description=CaringMind Relay Server
After=network.target

[Service]
Type=simple
User=relay
WorkingDirectory=/opt/caringmind-relay
ExecStart=/usr/local/bin/bun run server/src/server.ts
Restart=always
RestartSec=3
EnvironmentFile=/opt/caringmind-relay/.env

[Install]
WantedBy=multi-user.target
```

### 4. Firewall / Network Security

**Current:** Port 8080 open to all.

**Needed:**

```
Allow:
  443/tcp   -- HTTPS/WSS (Caddy)
  22/tcp    -- SSH (key-only)

Block:
  8080/tcp  -- relay server (Caddy proxies to localhost:8080)
  80/tcp    -- redirect to 443 (Caddy handles)
  All other inbound
```

The relay server binds to `0.0.0.0:8080` but should bind to `127.0.0.1:8080` when Caddy is in front. No direct external access to the relay.

### 5. Backup / Disaster Recovery

**Current:** No backups. Server dies = everything gone.

**Needed:**

| What | Strategy | Tool |
|------|----------|------|
| Server config | Infrastructure as code | Hetzner API + Ansible/Terraform |
| Session data | Already in bucket (when persistence enabled) | S3 replication |
| Server state | Stateless by design -- reconnect | WebSocket reconnect (already implemented) |
| Database (future) | Periodic snapshots | SQLite backup / Postgres WAL archiving |
| Secrets | Doppler (already in use) | No change needed |

The relay server is designed to be stateless. Publishers reconnect on disconnect (already implemented with exponential backoff). Viewers reconnect. The only persistent state is in the bucket. This is a feature -- kill the server, bring it back, everything resumes.

### 6. CI/CD Pipeline

**Current:** Manual deploy (scp, tmux).

**Needed:**

```
git push -> CI builds -> tests pass -> deploy to Hetzner

Options:
  GitHub Actions + SSH deploy
  GitHub Actions + Docker build + Hetzner pull
  Doppler for secrets injection at deploy time
```

### 7. Monitoring Stack

**Current:** `/stats` endpoint, manual checks.

**Needed (when telemetry doc is implemented):**

```
Relay server
  -> /metrics (Prometheus format)
  -> Prometheus server (scrapes /metrics)
  -> Grafana (dashboards, alerts)
  -> Alertmanager (PagerDuty, Slack, email)

Or simpler:
  -> /health (liveness)
  -> Uptime Robot / Hetzner monitoring (external ping)
  -> Structured logs -> Loki (log aggregation)
```

---

## Scaling Strategy

### Stage 1: Single Server (< 100 publishers)

```
One Hetzner CX32 (or CAX21 ARM):
  - Caddy (TLS termination)
  - Bun relay server (all sessions)
  - Optional: Prometheus + Grafana (same server)

Cost: ~EUR 8-15/month
Capacity: ~100 publishers, 3 viewers each
```

### Stage 2: Single Server + External Bucket (< 100 publishers, with persistence)

```
Same CX32 + Hetzner Storage Box (BX11, 100GB):
  - Caddy (TLS termination)
  - Bun relay server (all sessions + recorder)
  - Session recorder writes to Storage Box (internal, free egress)
  - Prometheus + Grafana

Cost: ~EUR 12-19/month
Capacity: ~100 publishers, 3 viewers each + recording
Storage: 100GB (~25 hours of video)
```

### Stage 3: Multi-Server (100-500 publishers)

```
Load balancer (Hetzner LB or Caddy on dedicated node):
  - Routes publishers to relay servers by session affinity
  - Viewers connect to same relay as their publisher

2-3x CX32 relay servers:
  - Each handles ~100 publishers
  - Shared Storage Box for recordings
  - Shared Postgres for SessionIndex (replaces JSON manifests)

Cost: ~EUR 30-50/month
Capacity: 200-300 publishers
```

### Stage 4: Regional (500+ publishers)

```
DNS-based geographic routing:
  - US East relay cluster
  - EU relay cluster
  - Shared object storage (R2 for zero egress)
  - Centralized Postgres for cross-region queries

Cost: Varies by region and provider
```

Each stage adds capacity without changing the relay server code. The `ObjectStore`, `SessionIndex`, and `FramePipelineStage` interfaces remain the same.

---

## Quick Reference: Capacity Calculator

```
Max publishers = usable_bandwidth_MBps / per_publisher_outbound_MBps

Where:
  usable_bandwidth_MBps = port_speed_Mbps x 0.08  (80% of theoretical, in MB/s)
  per_publisher_outbound_MBps = (avg_viewers x avg_quality_KBps) / 1024

Example:
  1 Gbps port -> 100 MB/s usable
  3 viewers at high quality (300 KB/s each)
  per_publisher = 3 x 300 / 1024 = 0.88 MB/s
  max publishers = 100 / 0.88 = 113
```

---

## Staleness Warning

This document was written against the codebase on `feat/telemetry-diagnostics` at commit `33ea802`. Server resource usage is based on analysis of `hosted/server/src/server.ts`. Hetzner pricing as of 2026-04-03. Depends on:

- `docs/multi-session-platform.md` -- multi-publisher session routing
- `docs/telemetry-observability.md` -- metrics and monitoring
- `docs/persistence-architecture.md` -- session recorder bandwidth
- `docs/multi-tenant-bucket-architecture.md` -- storage costs
- `docs/object-store-package.md` -- bucket write overhead
