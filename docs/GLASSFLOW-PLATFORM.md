# GlassFlow Platform Documentation

> Extracted from https://www.glassflow.in on 2026-04-15
> Account: ec.arbee1@gmail.com (Clerk user: Elijah)
> Platform by DotRedLabs

---

## Table of Contents

1. [Platform Overview](#platform-overview)
2. [Architecture & Tech Stack](#architecture--tech-stack)
3. [Backend Infrastructure (Supabase)](#backend-infrastructure-supabase)
4. [LiveKit Integration](#livekit-integration)
5. [Environment Variables & Configuration](#environment-variables--configuration)
6. [Authentication (Clerk)](#authentication-clerk)
7. [Routes & Navigation](#routes--navigation)
8. [API Endpoints](#api-endpoints)
9. [Command Center (Dashboard)](#command-center-dashboard)
10. [Devices (Fleet Management)](#devices-fleet-management)
11. [Device Detail Pages](#device-detail-pages)
12. [Live Streams](#live-streams)
13. [Feeds (Recordings)](#feeds-recordings)
14. [Skills Library](#skills-library)
15. [Analytics](#analytics)
16. [Workflows](#workflows)
17. [Workflow Node Types](#workflow-node-types)
18. [Supported Hardware](#supported-hardware)
19. [Worker Roster](#worker-roster)
20. [Data Model](#data-model)
21. [Domain & Company Intelligence](#domain--company-intelligence)
22. [Demo Assets](#demo-assets)
23. [Frontend Fonts & CSS](#frontend-fonts--css)
24. [Captcha Configuration](#captcha-configuration)
25. [Competitive Landscape](#competitive-landscape)
26. [Open-Source References](#open-source-references)

---

## Platform Overview

GlassFlow is an **agentic smart glasses platform** for field worker management. It provides real-time AI guidance to workers wearing smart glasses, enabling hands-free task assistance, safety compliance monitoring, and performance analytics.

Key capabilities:
- Real-time video streaming from smart glasses to a command center
- AI-powered step-by-step task guidance delivered to workers' glasses
- Scene analysis and object detection for safety/compliance verification
- Skills extraction from recorded sessions
- Workflow builder for automated processing pipelines
- Cross-session analytics and worker performance tracking

---

## Architecture & Tech Stack

| Component | Technology | Details |
|-----------|------------|---------|
| Frontend | React SPA | Single-page application, client-side routing |
| Routing | React Router | Client-side, SPA catch-all for all routes |
| Auth | Clerk (Test Mode) | `pk_test_YnJhdmUtYm9hLTQ5LmNsZXJrLmFjY291bnRzLmRldiQ` |
| Backend | Supabase | `spuvklhxmojkntvqfohk.supabase.co` |
| Live Video | LiveKit (WebRTC) | `.livekit.cloud` / `.livekit.run` |
| Build | Static JS bundle | `main.5b01c0bb.js` (~2MB), `main.6ba1b2e2.css` |
| Hosting | Vercel | Confirmed via `REACT_APP_VERCEL_*` env vars |
| Domain | `www.glassflow.in` | Registered 2026-02-16 via GoDaddy |
| Captcha | Cloudflare Turnstile | Smart widget + invisible widget |
| Data Mode | Demo/development | Shows "demo analytics" badge, "Showing demo analytics" |

### Clerk Versions
- Clerk JS: **6.7.1**
- Clerk UI: **1.6.0**
- Clerk API Version: **2025-11-10**

---

## Backend Infrastructure (Supabase)

### Instance Details

| Property | Value |
|----------|-------|
| Project URL | `https://spuvklhxmojkntvqfohk.supabase.co` |
| REST API | `spuvklhxmojkntvqfohk.supabase.co/rest/v1/` |
| Edge Functions | `spuvklhxmojkntvqfohk.supabase.co/functions/v1/` |
| Auth Method | Supabase anon key + Clerk JWT |

### Confirmed API Calls

| Endpoint | Method | Response | Purpose |
|----------|--------|----------|---------|
| `/rest/v1/stream_sessions?select=livekit_room_name&creator_identity=eq.{email}` | GET | `[]` (empty for this user) | Query stream session room names |
| `/functions/v1/livekit-sync` | GET | `{"status":"ok","active_rooms":1,"synced":1}` | Sync LiveKit room state |

### Supabase Tables (inferred)

| Table | Fields (inferred) |
|-------|-------------------|
| `stream_sessions` | `livekit_room_name`, `creator_identity` |

### Edge Functions

| Function | Purpose |
|----------|---------|
| `livekit-sync` | Syncs LiveKit room state, returns active room count |

---

## LiveKit Integration

### Configuration

| Property | Value |
|----------|-------|
| Domain | `.livekit.cloud`, `.livekit.run` |
| Transport | WebRTC + BRIDGE_RTSP |
| Serialization | Protocol Buffers (`De.makeMessageType` patterns in bundle) |
| Sync Function | `supabase.co/functions/v1/livekit-sync` |

### LiveKit Sync Response

```json
{
  "status": "ok",
  "active_rooms": 1,
  "synced": 1
}
```

### RTSP Bridging

The bundle contains references to `BRIDGE_RTSP` transport, indicating the platform can bridge RTSP camera streams into LiveKit rooms. This enables integration with IP cameras and industrial video systems alongside smart glasses.

---

## Environment Variables & Configuration

Extracted from the JS bundle (`main.5b01c0bb.js`):

| Variable | Value | Purpose |
|----------|-------|---------|
| `REACT_APP_CLERK_PUBLISHABLE_KEY` | `pk_test_YnJhdmUtYm9hLTQ5LmNsZXJrLmFjY291bnRzLmRldiQ` | Clerk auth (test mode) |
| `REACT_APP_SUPABASE_URL` | `https://spuvklhxmojkntvqfohk.supabase.co` | Supabase project URL |
| `REACT_APP_SUPABASE_ANON_KEY` | (present, redacted) | Supabase anonymous key |
| `REACT_APP_VERCEL_DEPLOYMENT_ID` | (present) | Vercel deployment identifier |
| `REACT_APP_VERCEL_ENV` | (present) | Vercel environment (production/preview) |
| `REACT_APP_VERCEL_GIT_COMMIT_SHA` | (present) | Git commit SHA for deployment |
| `REACT_APP_VERCEL_URL` | (present) | Vercel deployment URL |

### Clerk Key Variants Found

| Key Type | Value Pattern |
|----------|--------------|
| Test | `pk_test_YnJhdmUtYm9hLTQ5LmNsZXJrLmFjY291bnRzLmRldiQ` |
| Live (unused) | `pk_live_` prefix found in bundle |

---

## Authentication (Clerk)

### Configuration

| Property | Value |
|----------|-------|
| Provider | Clerk |
| Publishable Key | `pk_test_YnJhdmUtYm9hLTQ5LmNsZXJrLmFjY291bnRzLmRldiQ` |
| Clerk Domain | `brave-boa-49.clerk.accounts.dev` |
| Application Name | DotRedLabs |
| Environment | Test mode (`test_mode: true`) |
| Instance Type | Development (`instance_environment_type: "development"`) |
| Support Level | Experimental |
| Sign-in URL | `/login` |
| Sign-up URL | `/sign-up` |
| Home URL | `https://www.glassflow.in/dashboard` |

### Auth Strategies

| Strategy | Enabled | Required |
|----------|---------|----------|
| Email + Password | Yes | Yes |
| Google OAuth | Yes | No |
| Apple OAuth | Yes | No |
| Phone Number | No | No |
| Passkey | No | No |
| Web3 Wallet | No | No |
| SAML | No | No |
| Enterprise SSO | No | No |

### Session Configuration

| Setting | Value |
|---------|-------|
| Single Session Mode | `true` (only one active session per user) |
| Cookieless Dev | `true` |
| URL-based Session Syncing | `true` |
| Enhanced Email Deliverability | `false` |
| Reverification | `true` |

### Attack Protection

| Setting | Value |
|---------|-------|
| User Lockout | Enabled (100 attempts, 60 min lockout) |
| PII Protection | Enabled |
| Email Link Same Client | Required |
| Enumeration Protection | Disabled |

### Organizations

| Setting | Value |
|---------|-------|
| Organizations | Disabled |
| Max Memberships | 5 |
| Domain Detection | Enabled |
| Auto-creation | Disabled |
| Default Template | `{{user.first_name}}'s Organization` |

### Commerce / Billing

| Setting | Value |
|---------|-------|
| User Billing | Disabled |
| Org Billing | Disabled |
| Has Paid Plans | No |
| Stripe Key | Not configured |

### Current User Profile

| Field | Value |
|-------|-------|
| Clerk User ID | `user_3CMJNGjZQghr8ss7Xv04qmVGYfG` |
| Username | `ebowwa` |
| First Name | Elijah |
| Last Name | Arbee |
| Email | `ec.arbee1@gmail.com` |
| Auth Method | Google OAuth |
| Password Enabled | No (OAuth-only) |
| Two Factor | Disabled |
| Banned | No |
| Locked | No |
| Created | 2026-04-12 (approx) |
| Last Sign In | 2026-04-15 |

### Clerk Theme Configuration

```json
{
  "general": {
    "color": "#6c47ff",
    "background_color": "#ffffff",
    "font_family": "\"Source Sans Pro\", sans-serif",
    "border_radius": "0.5em"
  },
  "buttons": {
    "font_color": "#ffffff",
    "font_family": "\"Source Sans Pro\", sans-serif",
    "font_weight": "600"
  }
}
```

---

## Routes & Navigation

### Application Routes

| Route | Page | Description |
|-------|------|-------------|
| `/` | Home/Landing | Public landing page |
| `/login` | Login | Clerk sign-in |
| `/sign-up` | Sign Up | Clerk registration |
| `/glasses` | Fleet Management | Redirects to devices view |
| `/dashboard` | Command Center | Real-time operations overview |
| `/devices` | Fleet Management | Device fleet listing |
| `/devices/:deviceId` | Device Detail | Individual device status and controls |
| `/live` | Live Streams | Active real-time video feeds |
| `/feeds` | Recorded Feeds | Completed session recordings |
| `/skills` | Skills Library | AI-extracted skill guides |
| `/analytics` | Analytics | KPIs, trends, worker performance |
| `/day/:date` | Day Detail | Day-specific session data (returned empty content during testing) |
| `/workflows` | Workflows | Visual workflow builder |
| `/workflows/:workflowId` | Workflow Detail | Individual workflow editor |

### Navigation Structure

```
GlassFlow (logo) -> /dashboard
Command Center   -> /dashboard
Devices           -> /devices
Live Streams      -> /live
Feeds             -> /feeds
Skills            -> /skills
Analytics         -> /analytics
Workflows         -> /workflows
Elijah (user)     -> [dropdown]
Sign Out          -> [button]
```

### Internal API Routes (from JS bundle)

| Route | Purpose |
|-------|---------|
| `/analytics/compliance` | Compliance rate data |
| `/analytics/overview` | Overview metrics |
| `/analytics/sessions-over-time` | Time-series session data |
| `/analytics/topics` | Topic/categorization data |
| `/analytics/workers` | Worker performance data |
| `/devices/stats/summary` | Fleet summary stats |
| `/feeds/rooms` | Recording room list |
| `/workflows/node-types/all` | Available workflow node types |
| `/day-summary` | Day summary data |

---

## API Endpoints

The following API endpoints are referenced in the JS bundle. In demo mode, these return HTML (SPA catch-all). In production, they serve JSON:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/stats` | GET | Dashboard/fleet statistics |
| `/api/videos/by-date/grouped` | GET | Recorded videos grouped by date |
| `/api/insights/summary/all` | GET | AI insights summary |
| `/api/agents` | GET | Agent/worker data |

LiveKit integration uses `api.livekit` for WebRTC signaling.

---

## Command Center (Dashboard)

**URL**: `/dashboard`

### Header Stats

| Metric | Value |
|--------|-------|
| Active Workers | 4 |
| Events | 23 |
| Completed Tasks | 7 |
| Alerts | 2 |

### Operations Overview

| Metric | Value |
|--------|-------|
| AI Status | Active |
| Active Glasses | 4 |
| Active Workers | 4 |
| Tasks Today | 12 |
| Service Calls | 8 |

### Data Processing

| Metric | Value |
|--------|-------|
| Videos processed today | 6 |
| Currently processing | 2 |
| Tasks completed | 7 / 12 |

### Safety Alerts

- 2 active safety alerts
- 94% compliance rate

### Active Sessions (9 total)

| Worker | Status | Task | Location | Duration | Events |
|--------|--------|------|----------|----------|--------|
| Lucas Brown | reviewing | Panel Upgrade - 200A Service | 789 Industrial Blvd - Unit C | 60:00 | 2 |
| Sophia Lee | active | Fiber Splice - Node 47 | Elm St Junction Box #12 | 45:00 | 3 |
| Aarav Patel | completed | RTU Compressor Replacement | 1420 Market St - Rooftop | 39:00 | 5 |
| Emma Chen | completed | Tankless Water Heater Install | 112 Cedar Ln - Basement | 48:00 | 4 |
| Emma Chen | completed | Backflow Preventer Test | Riverdale Office Park - Utility | 24:00 | 5 |
| Sophia Lee | completed | ONT Installation - Residential | 2815 Oak Ridge Dr | 33:00 | 6 |
| Lucas Brown | completed | Emergency Breaker Replacement | Sunrise Apartments - Bldg 4 | 25:00 | 3 |
| Aarav Patel | completed | Ductwork Leak Inspection | Westfield Mall - Mech Room B | 31:00 | 4 |
| Aarav Patel | completed | Thermostat Calibration | 550 Pine Ave - Suite 301 | 20:00 | 7 |

### Guidance Feed (Real-time AI Events)

| Timestamp | Worker | AI Guidance |
|-----------|--------|-------------|
| 02:42 AM | Aarav Patel | High voltage detected on disconnect - verify lockout/tagout before proceeding |
| 03:15 AM | Sophia Lee | Step 6: Clean fiber ends with IPA wipe before inserting into fusion splicer |
| 03:22 AM | Lucas Brown | Wire gauge mismatch on circuit 14 - use 10 AWG for 30A breaker, not 12 AWG |
| 03:35 AM | Aarav Patel | Detected: Refrigerant recovery machine (R-410A) - correct for this unit type |
| 03:48 AM | Emma Chen | Gas line pressure above threshold - shut supply valve before continuing |
| 04:05 AM | Aarav Patel | Step 12: Verify refrigerant charge at 118 PSI before sealing service valve |
| 04:18 AM | Emma Chen | Incorrect flare fitting on gas line - use 3/4" not 1/2" for this model |
| 04:30 AM | Lucas Brown | Final step: Apply torque to main lugs at 250 in-lbs per manufacturer spec |

### Performance Metrics

| Metric | Value |
|--------|-------|
| Task Completion | 87% |
| Safety Score | 96% |
| Efficiency | 91% |
| Tasks On Time | 7 / 12 |
| Avg Time Saved | 18% |
| Delayed Tasks | 2 |
| Safety Incidents | 2 |

### Reports Available

- Daily Report
- Weekly Report
- Monthly Report
- Export Raw Data

### Daily Report Modal (2026-04-15)

Triggered by clicking "Daily Report" button. Shows "Showing demo report data" badge.

**Summary Stats:**

| Metric | Value |
|--------|-------|
| Sessions | 4 |
| Analyzed | 3 |
| Workers | 4 |
| Duration | 3h 24m |
| Service Calls | 8 |
| Tasks Done | 7 |
| Avg Response | 18m |

**Key Findings:**
1. RTU compressor replacement completed 15% faster with guided refrigerant charge verification
2. Fiber splice loss measured at -0.08dB - well under 0.1dB threshold with AI alignment assist
3. Gas line pressure alert prevented potential safety incident during water heater install
4. Wire gauge mismatch caught early on panel upgrade - avoided code violation

**Recommendations:**
1. Schedule follow-up inspection for Denver rooftop solar array (device offline)
2. Update lockout/tagout guidance prompts for HVAC high-voltage disconnect procedures
3. Enable fiber attenuation auto-check on all telecom splice sessions

**Actions:** Export PDF, Close

---

## Devices (Fleet Management)

**URL**: `/devices`

### Fleet Summary

| Metric | Value |
|--------|-------|
| Total Devices | 6 |
| Active Sessions | 4 |
| Guidance Events Today | 23 |
| Tasks Completed | 87 |
| Service Calls Today | 10 |

### Device Filters

- All
- Online
- Syncing
- Charging
- Offline

### Fleet Roster

| Device | Model | Variant | Status | State | Worker | Role | Task | Battery | Storage | Signal | Location | Events | Calls | Serial |
|--------|-------|---------|--------|-------|--------|------|------|---------|---------|--------|----------|--------|-------|--------|
| Meta Ray-Ban Gen 2 | Meta Ray-Ban | Gen 2 - Wayfarer | online | Active | Aarav Patel | HVAC Technician | RTU Compressor Replacement | 86% | 24/32GB | 94% | 1420 Market St - Rooftop | 8 | 3 | MRB2-4A71-0092 |
| K900 Pro | K900 | Pro - Industrial | syncing | Active | Sophia Lee | Telecom Installer | Fiber Splice - Node 47 | 72% | 48/64GB | 88% | Elm St Junction Box #12 | 6 | 2 | K9P-7B23-0148 |
| XY Smart Gen 1 | XY Smart | Gen 1 - Standard | online | Standby | Lucas Brown | Electrician | Panel Upgrade - 200A Service | 42% | 12/32GB | 79% | 789 Industrial Blvd - Unit C | 4 | 2 | XYS1-3C45-0076 |
| Meta Ray-Ban Gen 1 | Meta Ray-Ban | Gen 1 - Stories | online | Active | Emma Chen | Plumber | Tankless Water Heater Install | 91% | 18/32GB | 96% | 112 Cedar Ln - Basement | 3 | 2 | MRB1-2D89-0034 |
| XY Smart Gen 2 | XY Smart | Gen 2 - Rugged | offline | Idle | Mason Clark | Solar Technician | No active task | 19% | 28/64GB | 52% | Denver Site B - Rooftop | 0 | 0 | XYS2-8E12-0201 |
| Meta Oakley | Meta Oakley | Holbrook - Sport | online | Active | Mia Anderson | Maintenance Tech | CNC Spindle Bearing Replacement | 67% | 20/32GB | 84% | Lakewood Industrial - Bay 7 | 2 | 1 | MOK-5F67-0115 |

### Serial Number Format

| Prefix | Device Family |
|--------|---------------|
| MRB1 | Meta Ray-Ban Gen 1 |
| MRB2 | Meta Ray-Ban Gen 2 |
| K9P | K900 Pro |
| XYS1 | XY Smart Gen 1 |
| XYS2 | XY Smart Gen 2 |
| MOK | Meta Oakley |

---

## Device Detail Pages

**URL Pattern**: `/devices/:deviceId` (e.g., `/devices/demo-device-1`)

### Device 1: Meta Ray-Ban Gen 2 (MRB2-4A71-0092)

| Field | Value |
|-------|-------|
| Worker | Aarav Patel |
| Task | RTU Compressor Replacement |
| Guidance Mode | Active |
| Guidance Events Today | 8 |
| Battery | 86% |
| Storage | 24GB |
| Signal | 94% |
| Latency | 48ms / Jitter: 12ms |
| Location | 1420 Market St - Rooftop |
| Project | HVAC Service |
| Last Sync | 4/15/2026, 8:20:00 AM |
| Registered | 4/13/2026 |
| Session History | 3 sessions |
| Quick Actions | Export Session Logs, Update Firmware, Remote Restart |

### Device 2: K900 Pro (K9P-7B23-0148)

| Field | Value |
|-------|-------|
| Worker | Sophia Lee |
| Task | Fiber Splice - Node 47 |
| Guidance Mode | Active |
| Guidance Events Today | 6 |
| Battery | 72% |
| Storage | 48GB |
| Signal | 88% |
| Latency | 54ms / Jitter: 16ms |
| Location | Elm St Junction Box #12 |
| Project | Fiber Network Expansion |
| Last Sync | 4/15/2026, 8:18:00 AM |
| Registered | 4/13/2026 |
| Session History | 2 sessions |

### Device 3: XY Smart Gen 1 (XYS1-3C45-0076)

| Field | Value |
|-------|-------|
| Worker | Lucas Brown |
| Task | Panel Upgrade - 200A Service |
| Guidance Mode | Standby |
| Guidance Events Today | 4 |
| Battery | 42% |
| Storage | 12GB |
| Signal | 79% |
| Latency | 67ms / Jitter: 23ms |
| Location | 789 Industrial Blvd - Unit C |
| Project | Commercial Electrical |
| Last Sync | 4/15/2026, 7:52:00 AM |
| Registered | 4/13/2026 |
| Session History | 2 sessions |

### Device 4: Meta Ray-Ban Gen 1 (MRB1-2D89-0034)

| Field | Value |
|-------|-------|
| Worker | Emma Chen |
| Task | Tankless Water Heater Install |
| Guidance Mode | Active |
| Guidance Events Today | 3 |
| Battery | 91% |
| Storage | 18GB |
| Signal | 96% |
| Latency | 43ms / Jitter: 11ms |
| Location | 112 Cedar Ln - Basement |
| Project | Residential Plumbing |
| Last Sync | 4/15/2026, 8:21:00 AM |
| Registered | 4/13/2026 |
| Session History | 2 sessions |

### Device 5: XY Smart Gen 2 (XYS2-8E12-0201)

| Field | Value |
|-------|-------|
| Worker | Mason Clark |
| Task | None |
| Guidance Mode | Idle |
| Guidance Events Today | 0 |
| Battery | 19% |
| Storage | 28GB |
| Signal | 52% |
| Latency | 92ms / Jitter: 34ms |
| Location | Denver Site B - Rooftop |
| Project | Solar Panel Installation |
| Last Sync | 4/14/2026, 12:08:00 PM |
| Registered | 4/13/2026 |
| Session History | 0 sessions |
| Status | **OFFLINE** |

### Device Controls (available on all devices)

- Settings
- Sync Now
- Export Session Logs
- Update Firmware
- Remote Restart

### Device Detail Tabs

- Live Status
- Session History
- Performance

---

## Live Streams

**URL**: `/live`

"Watch active field sessions in real-time. Completed recordings are available in Feeds."

- Refresh button available
- No active live streams at time of extraction

---

## Feeds (Recordings)

**URL**: `/feeds`

"Recorded Feeds"

- 0 recordings at time of extraction
- Filter: "All Rooms"
- Empty state: "No recordings found"

---

## Skills Library

**URL**: `/skills`

"Skills Library - 2 skills extracted from recordings"

### Completed Skills

#### 1. High-Protein Breakfast Prep

| Field | Value |
|-------|-------|
| Status | completed |
| Category | cooking |
| Level | beginner |
| Steps | 4 |
| Duration | 10m |
| Description | A guide to preparing a quick, high-protein breakfast or snack using protein powder, milk, and almond butter, including a grocery shopping list. |

#### 2. Prepare Overnight Protein Oats

| Field | Value |
|-------|-------|
| Status | completed |
| Category | cooking |
| Level | beginner |
| Steps | 8 |
| Duration | 10m |
| Description | Prepare a nutritious, no-cook breakfast or snack by layering oats, protein powder, milk, and flavorings in a mug and refrigerating it to set. |

### Processing/Failed Skills

- 3 entries in "processing" state (0 steps each)
- 3 entries in "failed" state (0 steps each)

---

## Analytics

**URL**: `/analytics`

"Cross-session KPIs, trends, and worker performance"

### Time Filters

- Day
- Week
- Month

### Summary Metrics

| Metric | Value |
|--------|-------|
| Total Sessions | 112 |
| Active Now | 4 |
| Avg Duration | 34m |
| Task Completion | 91% |
| Safety Flags | 3 |
| Satisfaction | 87% |

### Sessions Over Time (7 Days)

| Date | Sessions (approximate) |
|------|----------------------|
| 04-09 | ~4 |
| 04-10 | ~6 |
| 04-11 | ~8 |
| 04-12 | ~5 |
| 04-13 | ~7 |
| 04-14 | ~8 |
| 04-15 | ~3 |

### Service Categories (by volume)

1. HVAC Repair
2. Fiber Installation
3. Electrical Panel
4. Plumbing Service
5. Equipment Diagnosis
6. Safety Compliance
7. Water Heater
8. Solar Installation
9. CNC Maintenance
10. Preventive Maintenance

### Worker Performance Table

| Worker | Role | Sessions | Tasks/Week | Completion | On-Time | Avg Response | Satisfaction | Safety Flags |
|--------|------|----------|------------|------------|---------|-------------|-------------|-------------|
| Aarav Patel | HVAC Technician | 32 | 8 | 94% | 96% | 16m | 91% | 0 |
| Sophia Lee | Telecom Installer | 24 | 6 | 88% | 88% | 22m | 84% | 1 |
| Lucas Brown | Electrician | 18 | 5 | 83% | 82% | 28m | 79% | 2 |
| Emma Chen | Plumber | 27 | 7 | 98% | 98% | 14m | 93% | 0 |
| Mason Clark | Solar Technician | 11 | 3 | 76% | 74% | 32m | 72% | 0 |
| Mia Anderson | Maintenance Tech | 8 | 4 | 92% | 92% | 20m | 88% | 0 |

### Compliance Rates (Based on 98 analyzed sessions)

| Category | Rate |
|----------|------|
| Safety Gear | 97% |
| Lockout Tagout | 94% |
| Permit Verification | 91% |
| Code Compliance | 96% |
| Documentation | 88% |

---

## Workflows

**URL**: `/workflows`

Visual workflow builder with node-based graph editor.

### New Workflow Modal

Clicking "New Workflow" opens a modal:
- Title: "New Workflow"
- Description: "Create a new AI pipeline"
- Actions: Cancel, Create, Close

### UI Elements

- Workflow list sidebar
- New Workflow button
- Node palette ("ADD NODES")
- Canvas area (JSON view available)
- Save and Run buttons
- Connection counter ("0 nodes, 0 connections")

### Empty State

"Select a Workflow. Choose from the left or create new."

---

## Workflow Node Types

Available node types in the workflow builder:

| Node Type | Category | Purpose |
|-----------|----------|---------|
| Live Camera Feed | Input | Streams real-time video from smart glasses |
| Guidance Output | Output | Sends AI-generated guidance to worker's glasses |
| Scene Analyzer | Processing | Analyzes video frames for objects, hazards, compliance |
| Guidance LLM | AI | Language model for generating step-by-step instructions |
| Processor | Processing | General-purpose data processing node |
| Filter | Processing | Filters data based on conditions |
| Aggregator | Processing | Aggregates data from multiple sources |

---

## Supported Hardware

### Smart Glasses Models

| Model | Variant | Storage | Use Case |
|-------|---------|---------|----------|
| Meta Ray-Ban Gen 1 | Gen 1 - Stories | 32GB | General field work |
| Meta Ray-Ban Gen 2 | Gen 2 - Wayfarer | 32GB | Primary device (HVAC, plumbing) |
| K900 Pro | Pro - Industrial | 64GB | Heavy industrial (telecom, fiber) |
| XY Smart Gen 1 | Gen 1 - Standard | 32GB | Standard field work |
| XY Smart Gen 2 | Gen 2 - Rugged | 64GB | Rugged environments (solar) |
| Meta Oakley | Holbrook - Sport | 32GB | Sport/industrial hybrid |

### Device States

- **online** - Connected and operational
- **syncing** - Connected, syncing data
- **offline** - Disconnected
- **Charging** - Connected to power (filter option)

### Guidance Modes

- **Active** - Worker receiving real-time AI guidance
- **Standby** - Device online, worker on break
- **Idle** - Device online, no task assigned

---

## Worker Roster

| Worker | Role | Device | Serial | Project |
|--------|------|--------|--------|---------|
| Aarav Patel | HVAC Technician | Meta Ray-Ban Gen 2 | MRB2-4A71-0092 | HVAC Service |
| Sophia Lee | Telecom Installer | K900 Pro | K9P-7B23-0148 | Fiber Network Expansion |
| Lucas Brown | Electrician | XY Smart Gen 1 | XYS1-3C45-0076 | Commercial Electrical |
| Emma Chen | Plumber | Meta Ray-Ban Gen 1 | MRB1-2D89-0034 | Residential Plumbing |
| Mason Clark | Solar Technician | XY Smart Gen 2 | XYS2-8E12-0201 | Solar Panel Installation |
| Mia Anderson | Maintenance Tech | Meta Oakley | MOK-5F67-0115 | CNC Maintenance |

---

## Data Model

### Device

```
{
  id: string,              // "demo-device-1" (URL slug)
  serial: string,          // "MRB2-4A71-0092"
  model: string,           // "Meta Ray-Ban Gen 2"
  variant: string,         // "Gen 2 - Wayfarer"
  status: "online" | "syncing" | "offline",
  state: "Active" | "Standby" | "Idle",
  battery: number,         // 0-100
  storage: { used: number, total: number }, // GB
  signal: number,          // 0-100
  latency: number,         // ms
  jitter: number,          // ms
  worker: { name, role },
  task: string,
  location: string,
  project: string,
  lastSync: datetime,
  registered: date,
  guidanceMode: "Active" | "Standby" | "Idle",
  guidanceEventsToday: number,
  sessionCount: number
}
```

### Session

```
{
  id: string,
  worker: string,
  status: "active" | "completed" | "reviewing",
  task: string,
  location: string,
  date: datetime,
  duration: string,        // "45:00"
  events: number,
  compliance: number       // percentage
}
```

### Guidance Event

```
{
  worker: string,
  timestamp: string,       // "02:42 AM"
  message: string,         // AI guidance text
  type: "safety" | "step" | "detection" | "correction"
}
```

### Skill

```
{
  id: string,
  title: string,
  status: "completed" | "processing" | "failed",
  category: string,        // "cooking", etc.
  level: string,           // "beginner", etc.
  steps: number,
  duration: string,        // "10m"
  description: string
}
```

### Workflow Node

```
{
  type: "Live Camera Feed" | "Guidance Output" | "Scene Analyzer" |
        "Guidance LLM" | "Processor" | "Filter" | "Aggregator",
  config: object,
  connections: string[]    // node IDs
}
```

### Analytics Session

```
{
  date: string,
  sessions: number,
  category: string,
  worker: {
    name: string,
    role: string,
    totalSessions: number,
    tasksPerWeek: number,
    completionRate: number,
    onTimeRate: number,
    avgResponseTime: string,
    satisfaction: number,
    safetyFlags: number
  }
}
```

---

## Screenshots Captured

| File | Page |
|------|------|
| `/tmp/gf_command_center.png` | Dashboard / Command Center |
| `/tmp/gf_devices.png` | Fleet Management |
| `/tmp/gf_live_streams.png` | Live Streams |
| `/tmp/gf_feeds.png` | Recorded Feeds |
| `/tmp/gf_skills.png` | Skills Library |
| `/tmp/gf_analytics.png` | Analytics |
| `/tmp/gf_workflows.png` | Workflows |
| `/tmp/gf_device_0.png` - `/tmp/gf_device_4.png` | Individual Device Details |
| `/tmp/gf_public_glasses.png` | Glasses (public) |
| `/tmp/gf_public_sign_up.png` | Sign Up page |
| `/tmp/gf_add_device.png` | Fleet Management (Add Device) |
| `/tmp/gf_new_workflow.png` | New Workflow modal |
| `/tmp/gf_login_page.png` | Login redirect (shows dashboard) |
| `/tmp/gf_home_page.png` | Landing page (visual, no text) |
| `/tmp/gf_device_settings.png` | Device detail with settings |
| `/tmp/gf_export_data.png` | Dashboard with export button |
| `/tmp/gf_daily_report.png` | Daily Report modal |
| `/tmp/gf_day_detail.png` | Day detail page (empty) |

---

## Raw Data Files

| File | Content |
|------|---------|
| `/tmp/gf_all_sections.json` | All dashboard section text content |
| `/tmp/gf_device_details.json` | All 5 device detail page contents |
| `/tmp/gf_nav_links.json` | Navigation link inventory |
| `/tmp/gf_public_pages.json` | Public page text content |
| `/tmp/gf_main_bundle.js` | Full JS bundle (2MB) |
| `/tmp/gf_dashboard_source.html` | Dashboard HTML source |
| `/tmp/gf_network_responses.json` | All captured network responses (Supabase, Clerk, API) |
| `/tmp/gf_network_requests.json` | All captured network requests |
| `/tmp/gf_interactive_exploration.json` | Interactive exploration results (8 targets) |

---

## Domain & Company Intelligence

### WHOIS Data

| Property | Value |
|----------|-------|
| Domain | `glassflow.in` |
| Registrar | GoDaddy |
| Registered | **2026-02-16** (2 months old at time of extraction) |
| Expires | 2027-02-16 |
| Company | DotRedLabs |

### DotRedLabs (Parent Entity)

| Property | Value |
|----------|-------|
| Public Presence | **Zero** - no GitHub org, LinkedIn, Crunchbase, or website found |
| Assessment | Pre-launch/stealth entity, likely parent company behind GlassFlow.in |
| Admin Email | `gnikhil335@gmail.com` (found in `api.js` source code) |

### GlassFlow.in Company Details

| Property | Value |
|----------|-------|
| Tagline | "The Gateway to AI Superpowers for Physical Workers" |
| Offices | **Bangalore / SF / Shenzhen** |
| Core Concept | "Physical AI Data Engine" - workers capture first-person POV, AI structures into procedures |
| Analogy Used | "Claude Code for the physical world" (directly referenced on landing page) |
| Business Model | Enterprise SaaS with hardware (Meta Ray-Ban glasses) |
| Pricing | Enterprise (unlimited glasses, talk to sales) + Pilot Program (5 glasses, 30 days) |
| Customer Logos | **Urban Company** (barber services), **Reliance** (sales training) |

### Industries Targeted

1. HVAC (field service, "Instant Master Mechanic")
2. Telecom (fiber installation, "Wire-Perfect Every Time")
3. Electrical (panel upgrades, code compliance)
4. Plumbing (water heater, gas line work)
5. Solar (rooftop installation)
6. Healthcare (protocol compliance)
7. Manufacturing (defect detection)
8. Field Services (general maintenance)

### Important: glassflow.in vs glassflow.dev

These are **two completely different companies/products**:

| Property | glassflow.in (this platform) | glassflow.dev (unrelated) |
|----------|------------------------------|---------------------------|
| Product | Agentic smart glasses for field workers | Kafka-to-ClickHouse ETL pipeline |
| Company | DotRedLabs | GlassFlow GmbH (Berlin, Germany) |
| Funding | Unknown (stealth) | $5.9M seed round (Oct 2024) |
| Founded | 2026 | 2023 |
| Employees | Unknown | ~9 |
| Focus | Industrial IoT, worker guidance | Data engineering, streaming ETL |
| Tech | React + Supabase + LiveKit + Clerk | Python, Kafka, ClickHouse |
| Lead Investor | Unknown | Upfront Ventures |

---

## Demo Assets

### Video Thumbnails

The platform serves 9 demo video thumbnails for the landing/public pages:

| Asset | URL |
|-------|-----|
| Session 1 | `/assets/videos/demos/session-1-thumb.jpg` |
| Session 2 | `/assets/videos/demos/session-2-thumb.jpg` |
| Session 3 | `/assets/videos/demos/session-3-thumb.jpg` |
| Session 4 | `/assets/videos/demos/session-4-thumb.jpg` |
| Session 5 | `/assets/videos/demos/session-5-thumb.jpg` |
| Session 6 | `/assets/videos/demos/session-6-thumb.jpg` |
| Session 7 | `/assets/videos/demos/session-7-thumb.jpg` |
| Session 8 | `/assets/videos/demos/session-8-thumb.jpg` |
| Session 9 | `/assets/videos/demos/session-9-thumb.jpg` |

All confirmed returning `200 OK` with `image/jpeg` content type.

---

## Frontend Fonts & CSS

### Font Stack

| Font | Weights | Usage |
|------|---------|-------|
| Space Grotesk | 500, 600, 700 | Headings, branding |
| Figtree | 400, 500, 600, 700 | Body text |
| Roboto Mono | 400, 500, 700 | Code, data, monospace |
| Inter | 300, 400, 500, 600, 700 | General UI (loaded via CSS import) |
| Source Sans Pro | 400, 600 | Clerk auth UI |

### CSS Framework

- Tailwind CSS (evidenced by `--tw-*` CSS custom properties)
- Dark theme default (`html lang="en" class="dark"`)
- Theme color: `#1a1f2e` (dark navy background)
- Brand color: `#6c47ff` (purple, from Clerk theme)

---

## Captcha Configuration

| Property | Value |
|----------|-------|
| Provider | Cloudflare Turnstile |
| Smart Widget Key | `0x4AAAAAAAWXJGBD7bONzLBd` |
| Invisible Widget Key | `0x4AAAAAAAFV93qQdS0ycilX` |
| Widget Type | `smart` |
| Sign-up Captcha | Enabled |
| OAuth Bypass | None configured |

---

## Competitive Landscape

### Direct Competitors (Smart Glasses for Field Service)

| Company | Product | Focus |
|---------|---------|-------|
| GlassFlow.in (DotRedLabs) | This platform | Agentic AI guidance on smart glasses |
| TeamViewer (Frontline) | xAssist | Remote expert video assistance |
| Vuzix | Shield+ / M400 | Industrial AR glasses |
| RealWear | Navigator 2 | Voice-controlled industrial headset |
| Iristick | H1 / E1 | Smart safety glasses for industry |

### Indirect / Adjacent

| Company | Product | Notes |
|---------|---------|-------|
| GlassFlow GmbH | glassflow.dev | Kafka ETL (different company, same name) |
| Meta | Ray-Ban Meta glasses | Hardware used by GlassFlow.in |
| LiveKit | Open-source WebRTC | Infrastructure used by GlassFlow.in |

---

## Open-Source References

### Intent-Lab/GlassFlow (GitHub)

- **URL**: `https://github.com/Intent-Lab/GlassFlow`
- **Stars**: 81 | **Forks**: 8
- **Created**: March 7, 2026
- **Creator**: Xiaoan (Sean) Liu (`@sseanliu`) - Research Intern at Google, NYC
- **Org**: Intent Labs ("Reducing the cost between human intent and action")
- **License**: NOASSERTION
- **Purpose**: Real-time transcription on Meta Ray-Ban smart glasses
- **Key Features**: Deepgram Nova-3 streaming STT, speaker diarization, Gemini Live AI, WebRTC streaming, iOS + Android
- **Likely relationship**: Unrelated company, but works in same technical space (Meta Ray-Ban + AI)

### Intent-Lab/VisionClaw (GitHub)

- **URL**: `https://github.com/Intent-Lab/VisionClaw`
- **Stars**: 2,093 | **Forks**: 379
- **Purpose**: Full agentic AI assistant using Gemini Live + OpenClaw (56+ tools/skills)
- **Note**: Much more mature/popular sister project

### Intent Labs Organization

- 4 public repos: VisionClaw, GlassFlow, Matcha ("Agent-native voice + vision OS for wearables")
- Created March 9, 2026
- Mission: "Building AI systems that augment cognition, bridge comprehension gaps, and democratize knowledge access"

---

## Extracted Source Code

Full source code extracted from source map (8.7MB `.map` file):

| Location | Details |
|----------|---------|
| `/tmp/glassflow-source/` | 51 files, 508KB original source |
| `docs/glassflow-source/` | Copy in project directory |
| `/tmp/gf_main_bundle.js` | Minified bundle (2MB) |
| `/tmp/gf_main_bundle.js.map` | Source map with original code (8.7MB) |
| `/tmp/gf_chunk_639.js` | Lazy-loaded chunk (81KB) |
| `/tmp/gf_chunk_639.js.map` | Chunk source map (493KB) |

### Source Tree

```
glassflow-source/
├── index.js                    # React entry point
├── App.js                      # Router + ClerkProvider + ThemeProvider
├── context/
│   ├── AuthContext.js           # Dual auth: Clerk + Legacy FastAPI
│   └── ThemeContext.js          # Dark mode only (forced)
├── components/
│   ├── Header.js               # Nav with lucide-react icons, #E0FF00 accent
│   ├── ProtectedRoute.js       # Auth guard
│   ├── DaySummary.js           # Day summary component
│   └── TimelineItem.js         # Timeline renderer
├── components/ui/
│   ├── button.jsx              # Custom "hex" variants (hex, hex-outline, hex-ghost, hex-icon)
│   ├── badge.jsx, dialog.jsx, input.jsx, label.jsx
│   ├── progress.jsx, scroll-area.jsx, select.jsx
│   ├── sonner.jsx, switch.jsx, tabs.jsx, textarea.jsx
│   └── hex-donut.jsx           # Custom hex donut chart
├── lib/
│   ├── api.js                  # 54 API endpoints (auth, devices, media, workflows, feeds, skills)
│   ├── demoData.js             # All mock data (devices, sessions, analytics, reports)
│   └── utils.js                # Tailwind merge utilities
└── pages/
    ├── LandingPage.js          # Public marketing page
    ├── LoginPage.js            # Clerk sign-in
    ├── SignUpPage.js           # Clerk registration
    ├── HomePage.js             # Command Center (dashboard)
    ├── DevicesPage.js          # Fleet management
    ├── DeviceDetailPage.js     # Individual device view
    ├── LiveStreamPage.js       # Live WebRTC feeds
    ├── FeedsPage.js            # Recorded sessions
    ├── SkillsPage.js           # AI-extracted skills
    ├── AnalyticsPage.js        # KPIs, charts, worker performance
    ├── DayPage.js              # Day-specific data
    └── WorkflowBuilderPage.js  # Visual node-based workflow editor
```

### Key Source Code Findings

| Finding | Detail |
|---------|--------|
| Admin email | `gnikhil335@gmail.com` hardcoded in `api.js` for Supabase admin check |
| Auth modes | Clerk (production) or legacy FastAPI username/password (fallback) |
| Token storage | `glassflow_access_token` in localStorage, Clerk JWT as bearer |
| Token refresh | Every 50 seconds (Clerk tokens expire ~60s) |
| Brand color | `#E0FF00` (neon yellow-green) - hex button variants, accents |
| Supabase tables | `stream_sessions`, `skills`, `devices`, `media_assets` |
| Supabase Storage | `recordings` bucket, prefixes `sessions/` and `dotred/` |
| Edge Functions | `livekit-join-token`, `livekit-sync`, `extract-skill` |
| Recording format | `sbx-{id}-{date}T{time}.mp4` |
| All data | Mock/demo - `demoData.js` contains fabricated dataset |

### All 54 API Endpoints (from `lib/api.js`)

| Category | Endpoints |
|----------|-----------|
| Auth | `POST /auth/login`, `GET /auth/me`, `POST /auth/device/register`, `POST /auth/device/token` |
| Media | `POST /media/upload-url`, `POST /media/complete`, `GET /media`, `GET /media/:id`, `GET /media/:id/transcript`, `GET /media/:id/analytics`, `POST /media/:id/reprocess` |
| Devices | `GET /devices`, `GET /devices/:id`, `GET /devices/:id/videos`, `GET /devices/stats/summary`, `POST /devices/:id/heartbeat` |
| Videos | `GET /videos`, `GET /videos/:id`, `GET /videos/by-date/grouped`, `GET /videos/by-device/grouped` |
| Workflows | `GET /workflows`, `GET /workflows/:id`, `POST /workflows`, `PUT /workflows/:id`, `DELETE /workflows/:id`, `POST /workflows/:id/run`, `POST /workflows/:id/execute`, `GET /workflows/node-types/all` |
| Transcription | `GET /transcriptions/:videoId` |
| Insights | `GET /insights/:videoId`, `GET /insights/summary/all` |
| Agents | `GET /agents`, `GET /agents/:id`, `POST /agents/:id/toggle` |
| Processing | `POST /process/videos` |
| Reports | `POST /reports/generate` |
| Stats | `GET /stats`, `GET /stats/daily` |
| Day Summary | `GET /day-summary/:day`, `POST /day-summary/:day/generate` |
| Health | `GET /health-summary`, `GET /health-log` |
| Skills | Supabase direct: `skills` table CRUD + `extract-skill` edge function |
| Streaming | Supabase direct: `stream_sessions` table + `livekit-join-token`, `livekit-sync` edge functions |
| Feeds | Supabase Storage: `recordings` bucket listing + signed URLs |
| Q&A | `POST /ask-life` |

### Indian AI Smart Glasses Competitors

| Company | Product | Focus |
|---------|---------|-------|
| Focally | focally.in | AR wearables and smart glasses |
| HUMBL | AI Smart Glasses | "India's First AI Smart Glasses with Camera" |
| Vayu | vayuglasses.in | "India's Most Advanced AI Glasses" |
| Dash Glasses | dashglasses.com | "India's #1 Smart Bluetooth Glasses" |
| Fire-Boltt | Smart glasses line | Major Indian wearable brand |
| SHG Technologies | AI glasses | AI smart glasses for visually impaired |

---

## Security Vulnerability Audit

> Conducted 2026-04-15 against extracted source code (51 files, 508KB)
> Severity: CRITICAL > HIGH > MEDIUM > LOW > INFO

### CRITICAL

#### 1. Source Map Publicly Exposed
- **File:** `https://www.glassflow.in/static/js/main.5b01c0bb.js.map`
- **Impact:** Full unminified source code (1,324 files, 8.7MB) including all business logic, API client code, Supabase queries, auth flows, and internal architecture
- **Exploitability:** Trivial — append `.map` to any JS bundle URL
- **Evidence:** Successfully extracted 51 application files with original variable names, comments, and file paths
- **Remediation:** Remove `.map` files from production builds (`GENERATE_SOURCEMAP=false` in `.env`)

#### 2. No Role-Based Access Control (RBAC)
- **File:** `context/AuthContext.js:43`
- **Code:** `role: 'admin'` — hardcoded for ALL authenticated users in Clerk mode
- **Legacy fallback** at line 152: `role: data.user?.role || 'admin'` — defaults to admin if backend returns no role
- **Impact:** Every single authenticated user has full admin privileges — no distinction between viewer, operator, or admin
- **Exploitability:** Create any Clerk account -> immediate admin access to all devices, streams, recordings, workflows
- **Evidence:** The `ProtectedRoute` component only checks `isAuthenticated` (boolean), never checks role

#### 3. Client-Side Authorization Bypass
- **File:** `lib/api.js:310-313`
- **Code:**
  ```js
  const ADMIN_EMAIL = 'gnikhil335@gmail.com';
  if (params.creator_identity && params.creator_identity !== ADMIN_EMAIL) {
    query = query.or(`creator_identity.eq.${params.creator_identity},creator_identity.is.null`);
  }
  ```
- **Impact:** Admin check is a hardcoded email comparison in client-side JavaScript. Any user can:
  - Pass `creator_identity` as `gnikhil335@gmail.com` to bypass all data isolation
  - Omit `creator_identity` entirely to fetch unfiltered data
  - Modify the Supabase query directly since the anon key has full table read access
- **Same pattern repeated** at line 373 for feeds authorization
- **Exploitability:** Open browser DevTools -> modify any API call parameter -> access all data

### HIGH

#### 4. Supabase Anon Key Exposed in Client Bundle
- **File:** `lib/api.js:10`
- **Code:** `const SUPABASE_ANON_KEY = process.env.REACT_APP_SUPABASE_ANON_KEY || '';`
- **Impact:** The anon key is baked into the JS bundle sent to every client. Combined with the Supabase URL (`spuvklhxmojkntvqfohk.supabase.co`), anyone can:
  - Query all public tables directly via Supabase REST API
  - List storage bucket contents
  - Invoke edge functions
  - Insert/update/delete rows in any table where RLS is misconfigured
- **Exploitability:** Extract key from bundle -> use `supabase-js` or direct REST calls

#### 5. No Input Sanitization on Any API Call
- **File:** `lib/api.js` (all 54 endpoints)
- **Evidence:** Every endpoint passes user input directly to axios or Supabase without validation:
  - `askQuestion(question)` — raw text to `/ask-life` endpoint
  - `createWorkflow(workflow)` — arbitrary object to `/workflows`
  - `triggerSkillExtraction({ ... })` — arbitrary parameters to Supabase edge function
  - Supabase queries use `params.creator_identity` directly in `.eq()` and `.or()` filters without sanitization
- **Impact:** Potential for SQL injection (via Supabase filter operators), stored XSS (via workflow names/content), and command injection (via edge function parameters)

#### 6. Clerk Test Mode in Production
- **Evidence:** Network capture shows `"test": true` in Clerk session claims
- **Impact:** Clerk test mode means:
  - No email verification enforced
  - Weak session security
  - Rate limits are lower, easier to brute-force
  - Webhook signatures use test keys
- **Remediation:** Switch to production Clerk keys before going live

#### 7. Signed URLs with 1-Hour Expiry for Recordings
- **File:** `lib/api.js:426`
- **Code:** `.createSignedUrl(key, 3600)` — 3600 seconds = 1 hour
- **Impact:** Any signed URL is valid for 60 minutes. If leaked (browser history, referrer headers, logs), recordings are accessible for the full duration
- **Severity:** Medium-High since recordings may contain sensitive field worker video

### MEDIUM

#### 8. Viewer Email Spoofing for Live Stream Join Tokens
- **File:** `lib/api.js:350-360`
- **Code:** `getStreamJoinToken(sessionId, viewerEmail)` — `viewerEmail` comes from client
- **Impact:** Client controls which email is sent to the `livekit-join-token` edge function. If the edge function doesn't independently verify the caller's identity, any user can join any session as any email
- **Exploitability:** Pass arbitrary `viewerEmail` to impersonate other users in LiveKit rooms

#### 9. Token Stored in localStorage (XSS Vector)
- **File:** `lib/api.js:6,33`
- **Code:** `localStorage.setItem(TOKEN_STORAGE_KEY, token)`
- **Also:** `context/AuthContext.js:7` — `USER_STORAGE_KEY = 'glassflow_user'`
- **Impact:** Auth tokens in localStorage are accessible to any XSS attack. If any component renders unescaped user content, the token is exfiltratable
- **Remediation:** Use httpOnly cookies for token storage

#### 10. No CSRF Protection
- **Evidence:** No CSRF tokens visible in any API request. Axios client uses `Authorization` header which provides some protection, but state-changing operations (POST/PUT/DELETE) are still vulnerable if token is present

#### 11. Cloudflare Turnstile Keys Exposed
- **Keys found:** `0x4AAAAAAAWXJGBD7bONzLBd` and `0x4AAAAAAAFV93qQdS0ycilX`
- **Impact:** Sitekeys are public by design (used in client HTML), but the second key's purpose is unclear — if it's a secret key, it shouldn't be in the bundle
- **Severity:** Low-Medium (Turnstile sitekeys are designed to be public)

### LOW

#### 12. Admin Email Hardcoded
- **File:** `lib/api.js:310,373`
- **Value:** `gnikhil335@gmail.com`
- **Impact:** Reveals the admin's personal email. Useful for social engineering, targeted phishing, or credential stuffing
- **Note:** This is also the Clerk admin account

#### 13. Verbose Error Handling Leaks Internals
- **Evidence:** Multiple `console.error(error)` calls in page components. Network errors may expose backend URLs, stack traces, and Supabase error messages to the browser console

#### 14. No Content Security Policy (CSP) Headers
- **Evidence:** No CSP headers detected in network responses. The app loads scripts from Vercel CDN, Clerk, and LiveKit without restriction

### INFO

#### 15. Demo Data Mixed with Production Code
- **File:** `lib/demoData.js` (825 lines of fabricated data)
- **Impact:** Not a security issue, but demo data functions (`isDemoDeviceId()`, `isDemoVideoId()`) run alongside production queries — potential for demo IDs to collide with real device IDs

#### 16. Dual Auth System Increases Attack Surface
- **File:** `context/AuthContext.js` — two complete auth paths (Clerk + Legacy FastAPI)
- **Impact:** The legacy username/password path is still fully functional if `REACT_APP_CLERK_PUBLISHABLE_KEY` is unset. This doubles the auth attack surface

### Vulnerability Summary

| Severity | Count | Key Issues |
|----------|-------|------------|
| CRITICAL | 3 | Source map exposure, no RBAC, client-side auth bypass |
| HIGH | 4 | Supabase key exposed, no input sanitization, Clerk test mode, signed URL expiry |
| MEDIUM | 4 | Viewer email spoofing, localStorage tokens, no CSRF, Turnstile keys |
| LOW | 3 | Admin email leaked, verbose errors, no CSP |
| INFO | 2 | Demo data mixing, dual auth system |
| **Total** | **16** | |

### Attack Chain Example

The most dangerous attack chain combines multiple vulnerabilities:

1. **Source map** reveals all internal architecture and API patterns
2. **No RBAC** means any Clerk account gets admin role
3. **Client-side auth bypass** — pass `gnikhil335@gmail.com` as `creator_identity` to access all sessions
4. **Supabase anon key** enables direct database queries bypassing the app entirely
5. **Result:** Full read/write access to all devices, streams, recordings, skills, and workflows without any server-side authorization check

### Additional Findings (Deep Bundle Extraction)

#### Exposed Credentials from Bundle

| Secret | Value | Risk |
|--------|-------|------|
| Supabase Anon Key (full JWT) | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNwdXZrbGh4bW9qa250dnFmb2hrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxMDA3NDQsImV4cCI6MjA4OTY3Njc0NH0.GRYJDIAp8_duhiDDxB07MeqMPqTENRIZIVO3_CzrWq8` | Key-valid, expires 2036 |
| Supabase Project Ref | `spuvklhxmojkntvqfohk` | Direct backend access |
| Clerk Test Key | `pk_test_YnJhdmUtYm9hLTQ5LmNsZXJrLmFjY291bnRzLmRldiQ` (decodes: `brave-boa-49.clerk.accounts.dev`) | Confirms test/dev mode |
| Vercel Deployment ID | `dpl_CbgRixCdwn8y1Q97NAH5CBD8rhgV` | Targeted attack vector |
| Vercel Project ID | `prj_RmKaZ5XkITSxmfU5JwXlIdZf2FxP` | Targeted attack vector |
| Developer Email | `gnikhil335@gmail.com` | PII / social engineering |
| GitHub Username | `Nikhi-l` (user ID: `1159079547`) | PII / account targeting |
| SHA Hash | `be1cdaf14d71d4584835c3455e6bec8779564601` | Possible token fingerprint |
| Vercel App Name | `render_glass` | Internal project name |
| Vercel Internal URL | `render-glass-59qwswuyi-nikhils-projects-39873240.vercel.app` | Direct deployment access |

#### Hidden Admin Routes (Not in Source Map)

| Route | Purpose |
|-------|---------|
| `/admin/users` | User administration |
| `/admin/users/:id` | Individual user management |
| `/admin/oauth/clients` | OAuth client management |
| `/admin/oauth/clients/:id` | Individual OAuth client management |
| `/admin/generate_link` | Admin link generation |
| `/namespaces` | Supabase namespace management |
| `/tables` | Supabase table management |
| `/rpc/:id` | Direct RPC execution |
| `/bucket` | Storage bucket management |

These routes suggest a Supabase-like admin interface is bundled into the app.

#### Payment Integration (Stripe)
- `StripeUtilsContext`, `PaymentElementContext`, `PortalProvider` found in bundle
- If Stripe integration is active, payment data flows through the same client with no server-side validation visible
- Stripe Customer Portal accessible — potential for subscription manipulation if auth is bypassed

#### Web3 Auth Surface
The Clerk integration supports: `authenticateWithMetamask`, `authenticateWithCoinbaseWallet`, `authenticateWithOKXWallet`, `authenticateWithSolana`, `authenticateWithWeb3`
- Each adds additional attack surface for authentication bypass
- SIWE (Sign-In with Ethereum) protocol support

#### LiveKit Egress Configuration
Egress supports upload to: S3, Azure Blob, GCP, Alibaba OSS
- If any cloud storage credentials are configured server-side, compromised admin access could redirect recordings to attacker-controlled storage

### Remediation Priority

1. **Immediate:** Remove source maps from production, enable Clerk production mode, rotate Supabase anon key
2. **Short-term:** Implement server-side RBAC (Row Level Security policies in Supabase), add input validation, move auth to httpOnly cookies, secure admin routes
3. **Medium-term:** Add CSP headers, CSRF protection, rate limiting, server-side admin checks, audit Stripe integration
4. **Long-term:** Audit Supabase RLS policies, implement API gateway with auth middleware, add security monitoring, disable Web3 auth if unused, remove admin panel from production bundle
