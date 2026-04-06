# UX Stages - com.mwdat-ios

## Wireframe Flow Diagram

```mermaid
flowchart TD
    subgraph APP["com.mwdat-ios App Launch"]
        ENTRY["MainAppView\n(copies router)"]
    end

    ENTRY -->|registrationState != .registered\nAND no mock device| STAGE1
    ENTRY -->|registrationState == .registered\nOR has mock device| STAGE2

    subgraph STAGE1["STAGE 1: Onboarding / Registration"]
        direction TB
        HOME["HomeScreenView\n─────────────────\n┌─────────────────────┐\n│                     │\n│    [App Icon 120px]  │\n│                     │\n│  Video Capture       │\n│  Record from glasses │\n│                     │\n│  Open-Ear Audio      │\n│  Hear notifications  │\n│                     │\n│  Enjoy On-the-Go     │\n│  Stay hands-free     │\n│                     │\n│  Redirect to Meta AI │\n│  app to confirm      │\n│                     │\n│  [Connect my glasses]│\n│                     │\n└─────────────────────┘"]

        HOME -->|tap Connect| META["Meta AI App\n(OAuth redirect)\n─────────────────\nUser confirms\nglasses connection"]
        META -->|deep link callback| REG["RegistrationView\n(invisible - handles\nmetaWearablesAction\nURL callback)"]
        REG -->|registration complete| GETTING["GettingStartedSheet\n(bottom sheet)\n─────────────────\n┌─────────────────────┐\n│  Getting started    │\n│                     │\n│  Camera permission  │\n│  Capture photos     │\n│  LED indicator      │\n│                     │\n│  [Continue]         │\n└─────────────────────┘"]
    end

    GETTING -->|dismiss| STAGE2

    subgraph STAGE2["STAGE 2: Pre-Stream Setup (NonStreamView)"]
        direction TB
        PREP["NonStreamView\n───────────────────────┐\n│                    [gear] │\n│   Disconnect option       │\n│                           │\n│     [App Icon white]      │\n│                           │\n│  Stream Your Glasses      │\n│  Camera                   │\n│                           │\n│  Tap Start to stream...   │\n│                           │\n│  ── SELECT DEVICE ──      │\n│  Ray-Ban Meta  CONNECTED  │\n│  Oakley Meta    DISCONN   │\n│  Auto-select              │\n│                           │\n│  ── STREAM SETTINGS ──    │\n│  Resolution  HIGH MED LOW │\n│  Frame Rate  24   30   60 │\n│                           │\n│  Waiting for active dev   │\n│                           │\n│  [Start streaming]        │\n└───────────────────────────┘"]

        PREP -->|permission check\nthen start| STAGE3
    end

    subgraph STAGE3["STAGE 3: Live Streaming (StreamView)"]
        direction TB
        STREAM["StreamView\n───────────────────────────┐\n│                           │\n│  [Error Banner - if any]  │\n│                           │\n│                           │\n│                           │\n│    LIVE VIDEO FEED        │\n│    (full-screen fill)     │\n│                           │\n│                           │\n│                           │\n│                           │\n│ [Stop] [Record] [Relay] [Photo]\n└───────────────────────────┘"]

        STREAM -->|tap Photo| PHOTO["PhotoPreviewView\n(sheet overlay)\n───────────────────\n┌───────────────┐\n│  [x]          │\n│               │\n│  [Captured    │\n│   Photo]      │\n│               │\n│  [Share]      │\n└───────────────┘"]

        STREAM -->|tap Error Banner| ERRLOG["ErrorLogSheet\n(scrollable list of\ntimestamped errors)"]

        STREAM -->|tap Stop| PREP
    end

    subgraph DEBUG["DEBUG OVERLAYS (DEBUG builds only)"]
        HUD["TelemetryHUDView\n(top-right overlay)\n──────────────\nTELEMETRY\n──────────────\nSession: State\n        : Uptime\n        : TTFF\nFrames : FPS\n        : Jitter\n        : Count\n        : Drops\nConn   : Link\n        : Device\nErrors : Total"]

        DP["DebugPanel\n(bottom-left overlay)\n──────────────\nDEBUG\n──────────────\nRegistration: state\nDevices: N found\nActive: YES/NO\nSelected: device-id\n[per-device info]\n[recent errors]"]
    end

    STREAM -.->|overlay| HUD
    STREAM -.->|overlay| DP
```

## Summary of UX Stages

| Stage | View | Purpose |
|---|---|---|
| **1. Onboarding** | `HomeScreenView` | Welcome screen with feature highlights. "Connect my glasses" button redirects to Meta AI app for OAuth. |
| **1b. Registration** | `RegistrationView` (invisible) | Handles deep link callback from Meta AI app to complete registration. |
| **1c. Getting Started** | `GettingStartedSheet` (bottom sheet) | Post-registration tips about camera permissions, capture, and LED indicator. |
| **2. Pre-Stream Setup** | `NonStreamView` | Device picker (multi-device), stream config (resolution/frame rate), waiting for active device, and "Start streaming" button. |
| **3. Live Streaming** | `StreamView` | Full-screen video feed from glasses. Bottom controls: Stop, Record (toggle), Relay (toggle), Photo capture. |
| **3a. Photo Preview** | `PhotoPreviewView` (sheet) | Dismissible photo viewer with swipe-to-dismiss and share sheet. |
| **3b. Error Log** | `ErrorLogSheet` (sheet) | Timestamped error history. |
| **Debug** | `TelemetryHUDView` + `DebugPanel` | DEBUG-only overlays showing session metrics, frame stats, device info, and errors. |

The app is a single-flow linear progression: register -> configure -> stream. No tab bar or multi-screen navigation -- it's a focused camera streaming tool.
