# Bandwidth Offloading Architecture: Alternatives to the Relay Pattern

`docs/infrastructure-capacity-planning.md` establishes that outbound bandwidth, not CPU/RAM, is the binding constraint at ~100 publishers with 3 viewers each. A 1 Gbps port saturates before CPU does. This doc analyzes architectural alternatives for shifting that bandwidth burden away from the relay server, examines trade-offs, and provides a decision framework for when each is worth adopting.

Written 2026-04-03 as a planning document. Depends on `docs/infrastructure-capacity-planning.md`.

---

## The Problem

The relay server is a memory-copy machine. For each publisher frame (~20KB JPEG), it copies that buffer to N viewer sockets. The math is linear:

```
1 publisher at 15fps x 20KB = 300 KB/s inbound
N viewers at high quality    = N x 300 KB/s outbound

At 100 publishers, 3 viewers each (mixed quality):
  outbound = 100 x ~900 KB/s = ~90 MB/s = ~720 Mbps
```

A 1 Gbps port tops out around there. CPU usage is under 10%. You're paying for compute you can't use because the network pipe is full.

This doc explores ways to break that linear relationship.

---

## Approach 1: Peer-to-Peer (WebRTC Mesh)

### How It Works

Publisher sends one copy of each frame to a signaling server. Viewers connect directly to the publisher (or to each other) via WebRTC data channels. The server becomes a signaling relay, not a media relay.

```
Current:
  Publisher --> Server --> Viewer A
                        --> Viewer B
                        --> Viewer C
  Server outbound: 3x frame bandwidth

WebRTC Mesh:
  Publisher --> Server (signaling only, tiny JSON messages)
            --> Viewer A (direct P2P)
            --> Viewer B (direct P2P)
            --> Viewer C (direct P2P)
  Server outbound: ~0 (signaling overhead only)
```

### Requirements

| Component | Detail |
|-----------|--------|
| Signaling server | Minimal WebSocket server for SDP exchange and ICE candidate passing |
| STUN server | Public IP discovery for NAT traversal. Free: Google's `stun:stun.l.google.com:19302` |
| TURN server | Fallback for symmetric NATs. Required for ~10-20% of connections. Paid or self-hosted (`coturn`) |
| iOS WebRTC SDK | Google's `GoogleWebRTC` pod or `WebRTC` framework via SPM |
| Browser WebRTC | `RTCPeerConnection` + `RTCDataChannel` -- native in all modern browsers |

### Bandwidth Shift

```
Before:  Server handles 300 KB/s x N_viewers per publisher
After:   Publisher's upstream handles 300 KB/s x N_viewers

Publisher upstream (typical home LTE/5G):
  - LTE: 5-50 Mbps up = 625 KB/s - 6.25 MB/s = 2-20 viewers at high quality
  - 5G:  50-200 Mbps up = 6.25 - 25 MB/s = 20-83 viewers at high quality
  - WiFi: 10-100 Mbps up = 1.25 - 12.5 MB/s = 4-41 viewers at high quality
```

### Trade-offs

| Factor | Assessment |
|--------|------------|
| Server bandwidth | Near zero for media -- signaling only |
| Publisher bandwidth | Increases linearly with viewers -- may saturate mobile uplink |
| Latency | Lower than relay (direct path, no server hop) |
| Reliability | Degrades with publisher network quality -- viewer experience depends on publisher's upstream |
| Complexity | High -- ICE negotiation, NAT traversal, TURN fallback, reconnection |
| iOS integration | WebRTC framework is large (~50MB), complex API, backgrounding constraints |
| Browser support | Native, well-supported |
| Connection setup | 1-3 seconds for ICE negotiation vs instant WebSocket |

### When to Adopt

- Publishers on reliable high-bandwidth uplinks (5G, fiber)
- Viewer count per publisher is low (1-5)
- Latency optimization is critical
- Server bandwidth cost is the primary constraint

### When NOT to Adopt

- Publishers on unreliable or bandwidth-limited connections (LTE in rural areas, weak signal)
- Large viewer counts per publisher (10+)
- The iOS publisher is already battery/CPU constrained
- Rapid connection/disconnection (caregiver monitoring with frequent app switches)

---

## Approach 2: CDN / Edge Relay

### How It Works

Publisher sends one stream to an edge node. CDN replicates to viewers from cache or edge nodes. The relay server becomes an origin, and a CDN layer sits in front.

```
Current:
  Publisher --> Relay Server --> Viewers

CDN:
  Publisher --> Relay Server (origin)
                     |
                     v
               CDN Edge Nodes (auto-replicated)
                     |
              +------+------+
              v      v      v
           Viewer  Viewer  Viewer

Server outbound: 1 copy to CDN (or 1 copy per edge node)
CDN outbound: N copies to viewers
```

### Options

| CDN | WebSocket Support | Pricing | Notes |
|-----|-------------------|---------|-------|
| Cloudflare | Yes (via Spectrum, Enterprise) | $0 egress with R2 | Best fit if already using R2 for storage |
| Fastly | Yes (via Fanout) | Pay per connection-minute | Good for real-time |
| AWS CloudFront | No native WS | Pay per GB egress | Would need API GW WS + CloudFront |
| Hetzner LB | No | EUR 5.40/month | Not a real CDN, just load balancing |

### Bandwidth Shift

```
Before:  Server outbound = N_viewers x frame_bandwidth
After:   Server outbound = 1 stream to CDN edge (or a few edges)

CDN handles the fan-out. Server bandwidth becomes negligible.
```

### Trade-offs

| Factor | Assessment |
|--------|------------|
| Server bandwidth | Near zero -- CDN absorbs fan-out |
| Latency | CDN adds 1-2 hops but edges are closer to viewers |
| Cost | CDN egress fees unless using zero-egress provider (Cloudflare R2 + Spectrum) |
| Complexity | Medium -- CDN configuration, WebSocket compatibility |
| Operational | CDN adds a dependency and debugging surface |
| Real-time suitability | Variable -- some CDNs buffer or add latency to WebSocket frames |

### When to Adopt

- High viewer-to-publisher ratios (10+ viewers per stream)
- Viewers are geographically distributed
- Server is on a bandwidth-limited or metered connection
- Cloudflare is already in use (zero additional operational cost)

### When NOT to Adopt

- Small-scale (< 50 publishers, < 5 viewers each)
- All users in same geographic region as server
- CDN egress costs exceed server bandwidth costs
- WebSocket support requires enterprise-tier CDN contracts

---

## Approach 3: Simulcast / Quality Ladder

### How It Works

Server encodes multiple quality levels of each frame. Viewers receive the quality level matching their connection. Not a full bandwidth offload, but reduces average outbound by serving lower quality to viewers who can't use high quality anyway.

```
Current:
  Publisher sends 720p @ 0.6 quality (~20KB/frame)
  Server fans out the SAME frame to all viewers

Simulcast:
  Publisher sends 720p @ 0.6 quality
  Server generates:
    - 720p @ 0.6 (~20KB) for high quality viewers
    - 480p @ 0.4 (~8KB) for medium quality viewers
    - 320p @ 0.3 (~4KB) for low quality viewers
    - 160p @ 0.2 (~1.5KB) for mini quality viewers

  Current average outbound: ~15KB/frame (mixed viewers)
  Simulcast average outbound: ~8KB/frame (right-sized per viewer)
```

### Requirements

Server-side JPEG resize. Currently the server does zero image processing -- it's a memcpy relay. Adding resize means CPU work per frame.

```
Per frame CPU cost (estimate):
  - Decode JPEG: ~2ms on single vCPU
  - Resize to 480p: ~1ms
  - Re-encode JPEG: ~2ms
  - Total: ~5ms per quality tier per frame

At 15fps, that's 75ms/s per tier. For 4 tiers: 300ms/s = 30% of one vCPU.
```

This makes CPU the bottleneck before bandwidth, which may or may not be an improvement depending on server specs.

### Bandwidth Reduction

```
Without simulcast (current throttle approach):
  high (15fps):   15 x 20KB = 300 KB/s
  medium (15fps): 15 x 20KB = 300 KB/s  <-- same frame, just fewer of them
  low (8fps):      8 x 20KB = 160 KB/s
  mini (4fps):     4 x 20KB =  80 KB/s

With simulcast:
  high (15fps):   15 x 20KB = 300 KB/s
  medium (15fps): 15 x  8KB = 120 KB/s  <-- smaller frame
  low (8fps):      8 x  4KB =  32 KB/s
  mini (4fps):     4 x  1.5KB = 6 KB/s

Mixed scenario (2 high, 2 medium, 1 low):
  Current: 2x300 + 2x300 + 1x160 = 1360 KB/s
  Simulcast: 2x300 + 2x120 + 1x32 = 872 KB/s  (36% reduction)
```

### Trade-offs

| Factor | Assessment |
|--------|------------|
| Server bandwidth | 30-40% reduction with mixed quality viewers |
| Server CPU | Significant increase -- image decode/resize/encode per tier |
| Complexity | Medium -- need image processing pipeline on server |
| Viewer quality | Better -- right-sized frames instead of fewer oversized frames |
| Publisher impact | Zero -- publisher still sends one stream |
| Phase-in | Can be added incrementally per quality tier |

### When to Adopt

- Viewer quality mix is diverse (some want high, some want mini)
- Server has spare CPU (current usage is <10%)
- Bandwidth is metered or expensive
- You want to improve viewer experience at lower quality tiers

### When NOT to Adopt

- All viewers use the same quality level
- Server CPU is already near capacity
- The current throttle approach is sufficient for viewer counts

---

## Approach 4: Publisher-Side Encoding Tiers

### How It Works

Instead of the server re-encoding, the iOS publisher sends multiple quality tiers in parallel. The server becomes a pure router again (no image processing) but the publisher does more work.

```
Current:
  iOS sends 1 stream (720p @ 0.6 quality, 15fps)

Multi-encode:
  iOS sends 3 streams:
    - 720p @ 0.6 quality, 15fps  --> 300 KB/s uplink
    - 480p @ 0.4 quality, 15fps  --> 120 KB/s uplink
    - 320p @ 0.3 quality, 8fps   -->  32 KB/s uplink
  Total publisher uplink: ~452 KB/s (was 300 KB/s + 768 KB/s audio)

Server receives 3 streams, fans out the right one to each viewer.
No image processing on server. Server is a memcpy router again.
```

### iOS Impact

```
Additional CPU per tier:
  - CIImage resize: ~0.5ms
  - CGImage JPEG encode: ~1.5ms
  - Total per tier: ~2ms per frame

At 15fps: 30ms/s per tier = 3% CPU per tier
For 2 extra tiers: ~6% additional CPU on iPhone

Additional battery: moderate -- JPEG encoding is the expensive part
Additional uplink: ~50% more bandwidth from phone
```

### Trade-offs

| Factor | Assessment |
|--------|------------|
| Server bandwidth | Same reduction as simulcast (30-40%) |
| Server CPU | Zero increase -- pure routing |
| Publisher CPU | Moderate increase (~6% for 2 extra tiers) |
| Publisher bandwidth | ~50% increase in uplink |
| Publisher battery | Moderate increase in drain |
| Complexity | Medium -- iOS multi-encode pipeline, server multi-stream routing |
| Latency | Lower for low-quality viewers (no server-side re-encode delay) |

### When to Adopt

- Server CPU is constrained but bandwidth is metered
- Publisher devices are high-end (iPhone 14+, good battery)
- Publishers on unlimited data plans or WiFi
- You want zero server-side image processing

### When NOT to Adopt

- Publishers are battery-constrained (long monitoring sessions)
- Publishers on metered connections
- iPhone CPU is already busy with AIStage, recording, etc.
- The relay server has spare CPU (it usually does)

---

## Approach 5: Selective Forwarding Unit (SFU)

### How It Works

Dedicated media server (SFU) handles the fan-out. The relay server becomes an application server (auth, session management, API) and delegates media routing to the SFU. This is the architecture used by production WebRTC platforms (Janus, mediasoup, LiveKit).

```
Current:
  Bun Relay Server handles everything (WebSocket + fan-out + API)

SFU:
  Bun App Server (auth, API, session management)
       |
       +--> SFU (Janus / mediasoup / LiveKit)
              |
              +--> Publisher sends stream(s) to SFU
              +--> SFU fans out to viewers
              +--> SFU handles simulcast, recording, etc.

Server bandwidth: near zero for media
SFU bandwidth: handles all fan-out (can be on high-bandwidth instance)
```

### Options

| SFU | Protocol | Language | WebSocket | iOS SDK | Cost |
|-----|----------|----------|-----------|---------|------|
| LiveKit | WebRTC | Go | Yes | Yes (native Swift SDK) | Open source, self-hosted |
| mediasoup | WebRTC | C++/Node | Yes | Via WebRTC framework | Open source, self-hosted |
| Janus | WebRTC | C | Via plugins | Via WebRTC framework | Open source, self-hosted |
| Pion | WebRTC | Go | Yes | Via WebRTC framework | Open source, self-hosted |

### Bandwidth Shift

```
All media bandwidth moves to the SFU:
  - App server: signaling + API only (minimal bandwidth)
  - SFU: all frame fan-out (100% of current relay bandwidth)
  - SFU can be deployed on a high-bandwidth instance or CDN edge
```

### Trade-offs

| Factor | Assessment |
|--------|------------|
| Server bandwidth | Zero for media -- SFU handles it all |
| Complexity | Highest of all approaches -- new infrastructure, new protocol |
| Operational cost | Additional server/process for SFU |
| Feature set | SFUs provide simulcast, recording, multi-party for free |
| iOS integration | Requires WebRTC framework (~50MB) or LiveKit Swift SDK |
| Migration | Major refactor -- wire protocol changes, auth flow changes |
| Maturity | Production-proven (LiveKit powers thousands of deployments) |

### When to Adopt

- Scale exceeds what a single relay server can handle (100+ publishers)
- Need production-grade features (recording, simulcast, multi-party)
- Ready to invest in infrastructure complexity
- Building a platform, not a prototype

### When NOT to Adopt

- Current scale is fine (< 100 publishers)
- The single-server relay works (it does today)
- Not ready for WebRTC complexity on iOS
- Time-to-market is priority over scale

---

## Decision Framework

```
                    How many viewers per publisher?
                           |
                    +------+-------+
                    |      |       |
                   1-3    3-10    10+
                    |      |       |
                    v      v       v
               Current   Simulcast  SFU or CDN
               relay is   (Approach (Approach 2
               fine.      3)        or 5)
                    |      |
                    |      v
                    |   CPU available
                    |   on server?
                    |    |       |
                    |   Yes      No
                    |    |       |
                    |    v       v
                    |  Server-  Publisher-
                    |  side     side
                    |  simulcast multi-encode
                    |  (A3)     (A4)
                    |
                    v
               Publisher on
               reliable uplink?
                 |       |
                Yes      No
                 |       |
                 v       v
               Consider   Current
               P2P WebRTC relay is
               (Approach 1) best option
```

---

## Recommendation: Phased Adoption

### Phase 1: Stay with Current Relay (< 50 publishers)

The current architecture handles this. 1 Gbps with 80% headroom supports ~100 publishers with 3 viewers each. At 50 publishers, you're at half capacity. No architectural changes needed.

### Phase 2: Simulcast (50-150 publishers)

Add server-side JPEG resize for quality tiers. CPU cost is acceptable on a CX32 (2 vCPU). Bandwidth reduction of 30-40% extends single-server capacity to ~150 publishers.

Implementation:
1. Add image processing to fan-out loop in `server.ts`
2. Use `sharp` (Bun native) or WASM-based JPEG resize
3. Cache resized frames per quality tier (avoid re-encoding identical frames)
4. No iOS changes required

### Phase 3: SFU (150+ publishers)

Deploy LiveKit or mediasoup alongside the relay server. The Bun server becomes an application server. The SFU handles media routing, simulcast, and recording.

This is a major architectural change. Only justified when Phase 2's capacity is exhausted.

### Phase 4: Regional CDN (500+ publishers)

Multi-region deployment with CDN edges. Publisher routes to nearest edge. Viewers connect to same edge or nearest replica. Requires LiveKit Cloud or similar managed SFU with geographic routing.

---

## Quick Reference: Bandwidth per Approach

| Approach | Server Outbound per Publisher (3 viewers, mixed) | Publisher Uplink | Server CPU | Complexity |
|----------|--------------------------------------------------|------------------|------------|------------|
| Current relay | 900 KB/s | 300 KB/s | < 1% | Low |
| P2P WebRTC | ~0 (signaling) | 900 KB/s | < 1% | High |
| CDN edge | ~0 to CDN | 300 KB/s | < 1% | Medium |
| Simulcast (server) | 580 KB/s (36% reduction) | 300 KB/s | ~30% | Medium |
| Publisher multi-encode | 580 KB/s (36% reduction) | 452 KB/s | < 1% | Medium |
| SFU (LiveKit) | 0 (SFU handles) | 300 KB/s | < 1% | High |

---

## Staleness Warning

This document was written against the codebase on `feat/telemetry-diagnostics` at commit `33ea802`. Depends on:

- `docs/infrastructure-capacity-planning.md` -- capacity math and Hetzner server specs
- `docs/pipeline-architecture.md` -- wire protocols (FRLY/FRAU) and iOS capture pipeline
- `docs/telemetry-observability.md` -- metrics for monitoring bandwidth saturation
- `docs/multi-session-platform.md` -- multi-publisher session routing
- `docs/persistence-architecture.md` -- recording bandwidth impact on server
- `docs/multi-tenant-bucket-architecture.md` -- signed URLs for offloading data retrieval
- `docs/ai-pipeline-bucket-integration.md` -- AI worker as additional fan-out consumer
