# PRD-005: Browser Viewer & Creator Gallery

**Product:** com.mwdat-ios / Relay Viewer
**Owner:** @ebowwa
**Status:** P0 Complete
**Last Updated:** 2026-04-10
**Depends On:** PRD-002 (Multi-session relay), PRD-004 (Stored sessions for gallery), PRD-007 (Viewer auth)

---

## Problem

The glasses operator streams video and audio. Remote people need to watch. The relay server fans out FRLY/FRAU frames, but the browser experience is minimal: a single-stream viewer with manual WebSocket URL entry, a static gallery page, and a directory listing. There is no session discovery, no auth, no quality controls, and no way to browse past recordings.

The viewer needs to evolve from a debug tool into a usable product surface where remote viewers can discover live sessions, watch streams with synchronized audio, browse recorded sessions, and interact with AI detection overlays.

---

## Users

| Persona | Description | Primary Need |
|---------|-------------|--------------|
| **Live Viewer** | Person watching a glasses stream in real-time | Low-latency video + audio; quality controls; session discovery |
| **Gallery Browser** | Person reviewing past sessions | Browse recordings; play back; view AI highlights/transcriptions |
| **Operator** | Person wearing glasses | Share a session link; see who's watching; control viewer access |
| **Developer** | Building on the platform | Debug viewer for testing relay, pipeline, wire protocol |

---

## Current State

### What Exists

| File | Purpose |
|------|---------|
| `relay/viewer/index.html` | Live stream viewer: WebSocket connect, FRLY canvas decode, FRAU audio decode with A/V sync |
| `relay/viewer/directory.html` | Session directory listing (basic) |
| `relay/viewer/gallery.html` | "CaringMind -- Creator Gallery"; grid UI; server injects `<!--__GALLERY_DATA__-->` |

### Live Viewer Features (index.html)

- Manual WebSocket URL input
- FRLY binary parsing (29-byte header + JPEG)
- Canvas rendering via `URL.createObjectURL(Blob)`
- FRAU audio decoding with `AudioContext`
- A/V sync: video-clock mapping, audio scheduled relative to video timestamps
- Look-ahead clamped to 5ms-200ms
- Auto-reconnect on disconnect
- Frame counter and FPS display

### Gaps

1. ~~**Manual URL entry**~~ -- RESOLVED: session directory at `/` with clickable session cards
2. ~~**No session discovery**~~ -- RESOLVED: `/sessions` JSON endpoint + directory landing page
3. **No auth** -- anyone with the URL watches; no viewer identity (see PRD-007 for Google OAuth implementation)
4. ~~**No quality controls**~~ -- RESOLVED: viewer quality preset selector (High/Medium/Low/Mini)
5. ~~**No viewer count**~~ -- RESOLVED: viewer count in session directory + stats endpoint
6. ~~**Gallery is static**~~ -- RESOLVED: live bucket queries with 30s TTL cache
7. ~~**No recording playback**~~ -- RESOLVED: MP4 export with R2 caching, `/session/{id}/video.mp4`
8. **No AI overlay** -- detection events not rendered on the video canvas (blocked on PRD-003 P1-2)
9. **No mobile-responsive layout** -- designed for desktop browsers
10. **No share functionality** -- no way to generate a sharable session link

---

## Requirements

### P0 -- Must Have

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| P0-1 | Session discovery page (replaces manual URL entry) | Landing page lists active sessions with device name, thumbnail, viewer count, FPS; click to watch |
| P0-2 | Auto-connect viewer from session URL | `/session/{id}` loads viewer pre-connected to that session; no manual config |
| P0-3 | Live video rendering with FRLY decode | Canvas rendering of JPEG frames; sequence number ordering; drop stale frames |
| P0-4 | Live audio playback with FRAU decode and A/V sync | PCM audio scheduled against video timestamps; jitter buffer; volume control |
| P0-5 | Quality preset selector | Viewer can choose: High (30fps), Medium (15fps), Low (8fps), Mini (4fps); sent as WebSocket control message |
| P0-6 | Connection status indicator | Visual indicator: connected (green), connecting (yellow), disconnected (red), reconnecting (spinner) |
| P0-7 | Mobile-responsive layout | Viewer and directory work on phone-sized screens; touch-friendly controls |

### P1 -- Should Have

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| P1-1 | Google OAuth viewer auth | Viewer authenticates before accessing any session; auth token passed on WebSocket upgrade; see PRD-007 for implementation |
| P1-2 | Viewer count display (for operator and viewers) | "N viewers watching" shown in both the iOS app and the browser viewer |
| P1-3 | Sharable session link | Operator can generate `https://relay.simulationapi.com/session/{id}` link; copy to clipboard |
| P1-4 | Gallery page with stored session browsing | Grid of past sessions from bucket; thumbnail, duration, date, device name; click to play |
| P1-5 | Recording playback in browser | Play stored MJPEG + PCM from bucket via retrieval endpoints; scrub/seek within segments |
| P1-6 | Fullscreen mode | Double-click or button to enter fullscreen; ESC to exit |
| P1-7 | Frame stats overlay (toggle) | FPS, latency, resolution, bitrate visible as overlay; default off |

### P2 -- Could Have

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| P2-1 | AI detection overlay on live canvas | Bounding boxes for persons/faces drawn on canvas; text recognition displayed as overlay |
| P2-2 | AI detection timeline in gallery playback | Markers on playback scrubber showing when detections occurred; click to jump |
| P2-3 | Transcription display (live and recorded) | Whisper transcription text shown below or beside the video feed |
| P2-4 | Multi-session grid view | Watch multiple sessions simultaneously in a tiled layout |
| P2-5 | Screenshot/clip capture from viewer | Viewer can grab a still frame or short clip from the live stream |
| P2-6 | Dark/light theme toggle | Viewer respects `prefers-color-scheme` and allows manual override |
| P2-7 | Notification when operator goes live | Registered viewers get browser notification when a new session starts |

---

## Technical Architecture

### Page Structure

```
https://relay.simulationapi.com/
       |
       +-- /                     -> Session Directory (active sessions)
       +-- /session/{id}         -> Live Viewer (auto-connected)
       +-- /gallery              -> Stored Session Gallery
       +-- /gallery/{id}         -> Recorded Session Playback
```

All pages are static HTML served by the Bun relay server. No frontend framework -- vanilla HTML/CSS/JS for zero build step and minimal payload.

### Live Viewer Data Flow

```
[Bun Server]
     |
     +-- /view?session={id}&quality=medium
     |         WebSocket binary (FRLY + FRAU frames)
     |
     v
[Browser]
     |
     +-- Parse binary: check magic bytes (FRLY vs FRAU)
     +-- FRLY: extract JPEG -> Blob -> createObjectURL -> drawImage on <canvas>
     +-- FRAU: extract PCM -> Int16Array -> AudioBuffer -> AudioContext.schedule()
     +-- A/V sync: map FRLY timestamp to AudioContext.currentTime
     +-- Ring buffer: hold last 5 audio chunks for jitter smoothing
```

### Gallery Data Flow

```
[Bun Server]
     |
     +-- GET /sessions?stored=true
     |         JSON: [{id, metadata, thumbUrl, duration, date}]
     |
     +-- GET /recording/{id}/video
     |         MJPEG stream (concatenated segments from bucket)
     |
     +-- GET /recording/{id}/audio
     |         PCM/WAV stream (from bucket)
     |
     +-- GET /recording/{id}/ai
     |         JSON: detections + transcriptions
     |
     v
[Browser Gallery]
     |
     +-- Grid of session cards (thumbnail, metadata)
     +-- Click -> Playback page
     +-- MJPEG decode: split on JPEG SOI (0xFFD8), render per-frame on canvas
     +-- PCM decode: AudioContext scheduling (same as live)
     +-- Scrub bar: seek by segment index
```

### Quality Preset Control

```
Viewer selects quality preset
       |
       v
WebSocket send: JSON { type: "quality", preset: "medium" }
       |
       v
Server updates viewer's FrameRelay FPS target
       |
       v
Server throttles frame delivery to that viewer
```

### Key Files

| File | Purpose |
|------|---------|
| `relay/viewer/index.html` | Live stream viewer (FRLY/FRAU decode, canvas, A/V sync) |
| `relay/viewer/directory.html` | Session directory listing |
| `relay/viewer/gallery.html` | Stored session gallery and playback |
| `relay/server/src/server.ts` | Serves static HTML; handles WebSocket upgrade; quality preset routing |
| `relay/server/src/session-export.ts` | Gallery data, thumbnail generation, retrieval proxy |

---

## UX Flow

### Live Viewing

```
1. Visit https://relay.simulationapi.com/
   -> See directory of active sessions
   -> Each card: thumbnail (last frame), device name, "3 viewers", "28 fps"
   
2. Click a session card
   -> Navigates to /session/{id}
   -> Auto-connects WebSocket
   -> Video fills viewport, audio begins
   -> Bottom bar: quality selector, volume, fullscreen, stats toggle
   -> Connection status indicator (top-left)
   
3. Quality adjustment
   -> Click quality dropdown: High | Medium | Low | Mini
   -> Server adjusts frame delivery rate
   -> FPS counter updates accordingly
```

### Gallery Browsing

```
1. Visit /gallery
   -> Grid of past sessions
   -> Each card: thumbnail, date, duration, device name
   -> Sort: newest first
   
2. Click a session card
   -> Navigates to /gallery/{id}
   -> Video player with scrub bar
   -> Play/pause, volume, fullscreen
   -> AI detection markers on scrub bar (P2-2)
   -> Transcription panel (P2-3)
```

---

## Success Metrics

| Metric | Target | Method |
|--------|--------|--------|
| Time from page load to first frame | < 2 seconds | Performance profiling (from `DOMContentLoaded` to first canvas paint) |
| Audio/video sync drift | < 50ms | Timestamp comparison at viewer |
| Page weight (directory) | < 100KB transferred | Network tab measurement |
| Page weight (viewer) | < 50KB transferred (excluding stream data) | Network tab measurement |
| Gallery load time | < 1 second for 50 sessions | Server response time + DOM render |
| Mobile Lighthouse score | > 85 performance | Lighthouse audit |

---

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| MJPEG playback performance in browser (CPU-intensive canvas draw) | Medium | Offload to `OffscreenCanvas` in Web Worker; limit to 30fps cap |
| Audio jitter on poor networks | Medium | Ring buffer with 5-chunk lookahead; graceful degradation to muted |
| Gallery grows unbounded | Low | Pagination; server returns max 50 sessions per page; "load more" |
| No browser notification API consent | Low | Prompt once; degrade gracefully if denied |
| Static HTML limits interactivity | Low | Vanilla JS is sufficient; no framework overhead; can upgrade later |
| CORS issues with bucket retrieval | Low | Server proxies all bucket reads; no direct browser-to-bucket |
