const dayString = (daysAgo = 0) => {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
};

const withTime = (day, hour, minute) =>
  `${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`;

const D0 = dayString(0);
const D1 = dayString(1);
const D2 = dayString(2);

/* ── Session (formerly "video") builder ────────────────────────────── */
const makeSession = ({
  id,
  day,
  hour,
  minute,
  status,
  worker,
  task_name,
  location,
  duration,
  deviceId,
  deviceName,
  thumbnail_url,
  video_url,
  guidance_events = 0,
}) => ({
  id,
  day,
  recorded_at: withTime(day, hour, minute),
  status,
  participant: worker,
  worker,
  feedback_label: task_name,
  task_name,
  location,
  duration_seconds: duration,
  device_id: deviceId,
  device_name: deviceName,
  filename: `${id}.mp4`,
  thumbnail_url,
  video_url,
  guidance_events,
});

export const DEMO_VIDEOS = [
  /* ── Aarav Patel — HVAC rooftop unit service ── */
  makeSession({
    id: 'demo-video-1',
    day: D0,
    hour: 9,
    minute: 12,
    status: 'processed',
    worker: 'Aarav Patel',
    task_name: 'RTU Compressor Replacement',
    location: '1420 Market St - Rooftop',
    duration: 2340,
    deviceId: 'demo-device-1',
    deviceName: 'Meta Ray-Ban Gen 2',
    thumbnail_url: '/assets/videos/demos/session-1-thumb.jpg',
    video_url: '/assets/videos/demos/session-1.mp4',
    guidance_events: 5,
  }),
  makeSession({
    id: 'demo-video-2',
    day: D1,
    hour: 8,
    minute: 45,
    status: 'processed',
    worker: 'Aarav Patel',
    task_name: 'Ductwork Leak Inspection',
    location: 'Westfield Mall - Mech Room B',
    duration: 1860,
    deviceId: 'demo-device-1',
    deviceName: 'Meta Ray-Ban Gen 2',
    thumbnail_url: '/assets/videos/demos/session-2-thumb.jpg',
    video_url: '/assets/videos/demos/session-2.mp4',
    guidance_events: 4,
  }),
  makeSession({
    id: 'demo-video-3',
    day: D2,
    hour: 10,
    minute: 30,
    status: 'processed',
    worker: 'Aarav Patel',
    task_name: 'Thermostat Calibration',
    location: '550 Pine Ave - Suite 301',
    duration: 1200,
    deviceId: 'demo-device-1',
    deviceName: 'Meta Ray-Ban Gen 2',
    thumbnail_url: '/assets/videos/demos/session-3-thumb.jpg',
    video_url: '/assets/videos/demos/session-3.mp4',
    guidance_events: 7,
  }),
  /* ── Sophia Lee — Telecom fiber installation ── */
  makeSession({
    id: 'demo-video-4',
    day: D0,
    hour: 10,
    minute: 48,
    status: 'processing',
    worker: 'Sophia Lee',
    task_name: 'Fiber Splice - Node 47',
    location: 'Elm St Junction Box #12',
    duration: 2700,
    deviceId: 'demo-device-2',
    deviceName: 'K900 Pro',
    thumbnail_url: '/assets/videos/demos/session-4-thumb.jpg',
    video_url: '/assets/videos/demos/session-4.mp4',
    guidance_events: 3,
  }),
  makeSession({
    id: 'demo-video-5',
    day: D1,
    hour: 14,
    minute: 15,
    status: 'processed',
    worker: 'Sophia Lee',
    task_name: 'ONT Installation - Residential',
    location: '2815 Oak Ridge Dr',
    duration: 1980,
    deviceId: 'demo-device-2',
    deviceName: 'K900 Pro',
    thumbnail_url: '/assets/videos/demos/session-5-thumb.jpg',
    video_url: '/assets/videos/demos/session-5.mp4',
    guidance_events: 6,
  }),
  /* ── Lucas Brown — Electrical panel work ── */
  makeSession({
    id: 'demo-video-6',
    day: D0,
    hour: 13,
    minute: 5,
    status: 'pending',
    worker: 'Lucas Brown',
    task_name: 'Panel Upgrade - 200A Service',
    location: '789 Industrial Blvd - Unit C',
    duration: 3600,
    deviceId: 'demo-device-3',
    deviceName: 'XY Smart Gen 1',
    thumbnail_url: '/assets/videos/demos/session-6-thumb.jpg',
    video_url: '/assets/videos/demos/session-6.mp4',
    guidance_events: 2,
  }),
  makeSession({
    id: 'demo-video-7',
    day: D1,
    hour: 11,
    minute: 20,
    status: 'processed',
    worker: 'Lucas Brown',
    task_name: 'Emergency Breaker Replacement',
    location: 'Sunrise Apartments - Bldg 4',
    duration: 1500,
    deviceId: 'demo-device-3',
    deviceName: 'XY Smart Gen 1',
    thumbnail_url: '/assets/videos/demos/session-7-thumb.jpg',
    video_url: '/assets/videos/demos/session-7.mp4',
    guidance_events: 3,
  }),
  /* ── Emma Chen — Plumbing & water heater service ── */
  makeSession({
    id: 'demo-video-8',
    day: D0,
    hour: 8,
    minute: 25,
    status: 'processed',
    worker: 'Emma Chen',
    task_name: 'Tankless Water Heater Install',
    location: '112 Cedar Ln - Basement',
    duration: 2880,
    deviceId: 'demo-device-4',
    deviceName: 'Meta Ray-Ban Gen 1',
    thumbnail_url: '/assets/videos/demos/session-8-thumb.jpg',
    video_url: '/assets/videos/demos/session-8.mp4',
    guidance_events: 4,
  }),
  makeSession({
    id: 'demo-video-9',
    day: D1,
    hour: 15,
    minute: 40,
    status: 'processed',
    worker: 'Emma Chen',
    task_name: 'Backflow Preventer Test',
    location: 'Riverdale Office Park - Utility',
    duration: 1440,
    deviceId: 'demo-device-4',
    deviceName: 'Meta Ray-Ban Gen 1',
    thumbnail_url: '/assets/videos/demos/session-9-thumb.jpg',
    video_url: '/assets/videos/demos/session-9.mp4',
    guidance_events: 5,
  }),
];

// Backward-compat alias
export const DEMO_SESSIONS = DEMO_VIDEOS;

export const DEMO_VIDEO_GROUPS = [D0, D1, D2].map((day) => {
  const videos = DEMO_VIDEOS.filter((video) => video.day === day).sort(
    (a, b) => (a.recorded_at < b.recorded_at ? 1 : -1),
  );
  return { date: day, count: videos.length, videos };
});

/* ── Command-center stats ──────────────────────────────────────────── */
export const DEMO_STATS = {
  active_workers: 4,
  active_glasses: 4,
  guidance_events_today: 23,
  tasks_completed: 7,
  tasks_today: 12,
  safety_alerts: 2,
  service_calls_today: 8,
  videos_processing: 2,
  videos_processed_today: 6,
  // AI Guidance breakdown
  safety_alerts_high: 2,
  error_corrections_today: 2,
  step_instructions_today: 4,
  tool_identifications_today: 1,
  avg_time_saved_pct: 18,
  guidance_compliance_pct: 94,
  // Backward-compat
  total_videos: DEMO_VIDEOS.length,
  processed_videos: DEMO_VIDEOS.filter((video) => video.status === 'processed').length,
  unique_participants: new Set(DEMO_VIDEOS.map((video) => video.participant)).size,
  total_duration_minutes: Math.round(
    DEMO_VIDEOS.reduce((sum, video) => sum + (video.duration_seconds || 0), 0) / 60,
  ),
  total_transcriptions: DEMO_VIDEOS.filter((video) => video.status !== 'pending').length,
};

/* ── Active sessions (live workers) ────────────────────────────────── */
export const DEMO_ACTIVE_SESSIONS = [
  {
    id: 'active-1',
    worker: 'Aarav Patel',
    device_id: 'demo-device-1',
    device_name: 'Meta Ray-Ban Gen 2',
    task: 'RTU Compressor Replacement',
    location: '1420 Market St - Rooftop',
    progress: 72,
    guidance_mode: 'Active',
    started_at: withTime(D0, 8, 30),
    last_guidance: 'Step 12: Verify refrigerant charge before sealing service valve',
  },
  {
    id: 'active-2',
    worker: 'Sophia Lee',
    device_id: 'demo-device-2',
    device_name: 'K900 Pro',
    task: 'Fiber Splice - Node 47',
    location: 'Elm St Junction Box #12',
    progress: 45,
    guidance_mode: 'Active',
    started_at: withTime(D0, 9, 15),
    last_guidance: 'Fiber attenuation at -2.1dB - within spec, proceed to splice',
  },
  {
    id: 'active-3',
    worker: 'Lucas Brown',
    device_id: 'demo-device-3',
    device_name: 'XY Smart Gen 1',
    task: 'Panel Upgrade - 200A Service',
    location: '789 Industrial Blvd - Unit C',
    progress: 88,
    guidance_mode: 'Standby',
    started_at: withTime(D0, 10, 0),
    last_guidance: 'All breakers seated correctly - proceed to cover plate',
  },
];

/* ── Guidance events feed ──────────────────────────────────────────── */
export const DEMO_GUIDANCE_EVENTS = [
  {
    id: 'ge-1',
    type: 'safety_alert',
    worker: 'Aarav Patel',
    message: 'Bare hands entering an energized 240V panel - stop and put on Class 0 dielectric gloves before reaching in',
    timestamp: withTime(D0, 9, 42),
    severity: 'high',
  },
  {
    id: 'ge-2',
    type: 'step_instruction',
    worker: 'Sophia Lee',
    message: 'Step 6: Clean fiber ends with IPA wipe before inserting into fusion splicer',
    timestamp: withTime(D0, 10, 15),
    severity: 'info',
  },
  {
    id: 'ge-3',
    type: 'error_correction',
    worker: 'Lucas Brown',
    message: 'Wire gauge mismatch on circuit 14 - use 10 AWG for 30A breaker, not 12 AWG',
    timestamp: withTime(D0, 10, 22),
    severity: 'medium',
  },
  {
    id: 'ge-4',
    type: 'tool_id',
    worker: 'Aarav Patel',
    message: 'Detected: Refrigerant recovery machine (R-410A) - correct for this unit type',
    timestamp: withTime(D0, 10, 35),
    severity: 'info',
  },
  {
    id: 'ge-5',
    type: 'safety_alert',
    worker: 'Emma Chen',
    message: 'Gas line pressure above threshold - shut supply valve before continuing',
    timestamp: withTime(D0, 10, 48),
    severity: 'high',
  },
  {
    id: 'ge-6',
    type: 'step_instruction',
    worker: 'Aarav Patel',
    message: 'Step 12: Verify refrigerant charge at 118 PSI before sealing service valve',
    timestamp: withTime(D0, 11, 5),
    severity: 'info',
  },
  {
    id: 'ge-7',
    type: 'error_correction',
    worker: 'Emma Chen',
    message: 'Incorrect flare fitting on gas line - use 3/4" not 1/2" for this model',
    timestamp: withTime(D0, 11, 18),
    severity: 'medium',
  },
  {
    id: 'ge-8',
    type: 'step_instruction',
    worker: 'Lucas Brown',
    message: 'Final step: Apply torque to main lugs at 250 in-lbs per manufacturer spec',
    timestamp: withTime(D0, 11, 30),
    severity: 'info',
  },
];

/* ── Insights summary (reframed) ───────────────────────────────────── */
export const DEMO_INSIGHTS_SUMMARY = {
  total_analyzed: DEMO_VIDEOS.filter((video) => video.status === 'processed').length,
  average_sentiment_score: 0.76,
  guidance_effectiveness: 91,
  task_completion_rate: 87,
  safety_compliance: 96,
  sentiment_breakdown: {
    positive: 5,
    neutral: 2,
    mixed: 1,
    negative: 0,
  },
  top_topics: [
    ['hvac-repair', 8],
    ['fiber-install', 6],
    ['electrical-panel', 5],
    ['plumbing', 4],
    ['safety-compliance', 4],
    ['equipment-diagnosis', 3],
    ['wiring', 3],
    ['water-heater', 2],
  ],
};

/* ── Agents (reframed as AI Guidance Engine) ───────────────────────── */
export const DEMO_AGENTS = [
  {
    id: 'demo-agent-1',
    name: 'AI Guidance Engine',
    status: 'active',
    processed_count: DEMO_STATS.processed_videos,
  },
];

const sentimentForVideo = (status) => {
  if (status === 'processed') return 'positive';
  if (status === 'processing') return 'mixed';
  return 'neutral';
};

export const DEMO_VIDEO_DETAILS = Object.fromEntries(
  DEMO_VIDEOS.map((video) => [
    video.id,
    {
      transcription: {
        text:
          `Session log for ${video.worker}: ` +
          `Guided task "${video.task_name}" at ${video.location}. ` +
          `${video.guidance_events} guidance events issued. Worker followed instructions with minimal deviation.`,
      },
      insight: {
        sentiment: sentimentForVideo(video.status),
        key_points: [
          'Worker completed the task with AI-guided steps and real-time corrections.',
          'Safety compliance was maintained throughout the session.',
          'Guidance overlays reduced task completion time by ~18%.',
        ],
      },
    },
  ]),
);

/* ── Devices (realistic glasses models for field service) ─────────── */
export const DEMO_DEVICES = [
  {
    id: 'demo-device-1',
    name: 'Meta Ray-Ban Gen 2',
    serial_number: 'MRB2-4A71-0092',
    model: 'Meta Ray-Ban',
    model_variant: 'Gen 2 - Wayfarer',
    status: 'online',
    battery_level: 86,
    storage_used_gb: 24,
    storage_total_gb: 32,
    last_location: '1420 Market St - Rooftop',
    last_project: 'HVAC Service',
    video_count: 18,
    signal_strength: 94,
    server_jitter_ms: 12,
    network_latency_ms: 48,
    total_recording_hours: 36,
    firmware_version: '6.2.1',
    assigned_to: 'Aarav Patel',
    worker_role: 'HVAC Technician',
    last_sync: withTime(D0, 15, 20),
    created_at: withTime(D2, 9, 0),
    current_task: 'RTU Compressor Replacement',
    guidance_mode: 'Active',
    guidance_events_today: 8,
    service_calls_today: 3,
  },
  {
    id: 'demo-device-2',
    name: 'K900 Pro',
    serial_number: 'K9P-7B23-0148',
    model: 'K900',
    model_variant: 'Pro - Industrial',
    status: 'syncing',
    battery_level: 72,
    storage_used_gb: 48,
    storage_total_gb: 64,
    last_location: 'Elm St Junction Box #12',
    last_project: 'Fiber Network Expansion',
    video_count: 14,
    signal_strength: 88,
    server_jitter_ms: 16,
    network_latency_ms: 54,
    total_recording_hours: 29,
    firmware_version: '3.1.4',
    assigned_to: 'Sophia Lee',
    worker_role: 'Telecom Installer',
    last_sync: withTime(D0, 15, 18),
    created_at: withTime(D2, 9, 30),
    current_task: 'Fiber Splice - Node 47',
    guidance_mode: 'Active',
    guidance_events_today: 6,
    service_calls_today: 2,
  },
  {
    id: 'demo-device-3',
    name: 'XY Smart Gen 1',
    serial_number: 'XYS1-3C45-0076',
    model: 'XY Smart',
    model_variant: 'Gen 1 - Standard',
    status: 'online',
    battery_level: 42,
    storage_used_gb: 12,
    storage_total_gb: 32,
    last_location: '789 Industrial Blvd - Unit C',
    last_project: 'Commercial Electrical',
    video_count: 9,
    signal_strength: 79,
    server_jitter_ms: 23,
    network_latency_ms: 67,
    total_recording_hours: 17,
    firmware_version: '1.8.2',
    assigned_to: 'Lucas Brown',
    worker_role: 'Electrician',
    last_sync: withTime(D0, 14, 52),
    created_at: withTime(D2, 10, 0),
    current_task: 'Panel Upgrade - 200A Service',
    guidance_mode: 'Standby',
    guidance_events_today: 4,
    service_calls_today: 2,
  },
  {
    id: 'demo-device-4',
    name: 'Meta Ray-Ban Gen 1',
    serial_number: 'MRB1-2D89-0034',
    model: 'Meta Ray-Ban',
    model_variant: 'Gen 1 - Stories',
    status: 'online',
    battery_level: 91,
    storage_used_gb: 18,
    storage_total_gb: 32,
    last_location: '112 Cedar Ln - Basement',
    last_project: 'Residential Plumbing',
    video_count: 27,
    signal_strength: 96,
    server_jitter_ms: 11,
    network_latency_ms: 43,
    total_recording_hours: 52,
    firmware_version: '5.4.0',
    assigned_to: 'Emma Chen',
    worker_role: 'Plumber',
    last_sync: withTime(D0, 15, 21),
    created_at: withTime(D2, 8, 40),
    current_task: 'Tankless Water Heater Install',
    guidance_mode: 'Active',
    guidance_events_today: 3,
    service_calls_today: 2,
  },
  {
    id: 'demo-device-5',
    name: 'XY Smart Gen 2',
    serial_number: 'XYS2-8E12-0201',
    model: 'XY Smart',
    model_variant: 'Gen 2 - Rugged',
    status: 'offline',
    battery_level: 19,
    storage_used_gb: 28,
    storage_total_gb: 64,
    last_location: 'Denver Site B - Rooftop',
    last_project: 'Solar Panel Installation',
    video_count: 11,
    signal_strength: 52,
    server_jitter_ms: 34,
    network_latency_ms: 92,
    total_recording_hours: 21,
    firmware_version: '2.0.1',
    assigned_to: 'Mason Clark',
    worker_role: 'Solar Technician',
    last_sync: withTime(D1, 19, 8),
    created_at: withTime(D2, 10, 25),
    current_task: null,
    guidance_mode: 'Idle',
    guidance_events_today: 0,
    service_calls_today: 0,
  },
  {
    id: 'demo-device-6',
    name: 'Meta Oakley',
    serial_number: 'MOK-5F67-0115',
    model: 'Meta Oakley',
    model_variant: 'Holbrook - Sport',
    status: 'online',
    battery_level: 67,
    storage_used_gb: 20,
    storage_total_gb: 32,
    last_location: 'Lakewood Industrial - Bay 7',
    last_project: 'CNC Maintenance',
    video_count: 8,
    signal_strength: 84,
    server_jitter_ms: 19,
    network_latency_ms: 61,
    total_recording_hours: 14,
    firmware_version: '4.1.0',
    assigned_to: 'Mia Anderson',
    worker_role: 'Maintenance Tech',
    last_sync: withTime(D0, 15, 4),
    created_at: withTime(D2, 11, 10),
    current_task: 'CNC Spindle Bearing Replacement',
    guidance_mode: 'Active',
    guidance_events_today: 2,
    service_calls_today: 1,
  },
];

export const summarizeDevices = (devices) => {
  const list = Array.isArray(devices) ? devices : [];
  const totalDevices = list.length;
  const online = list.filter((device) => device.status === 'online').length;
  const totalVideos = list.reduce((sum, device) => sum + (device.video_count || 0), 0);
  const activeSessions = list.filter((device) => device.guidance_mode === 'Active').length;
  const guidanceEventsToday = list.reduce((sum, device) => sum + (device.guidance_events_today || 0), 0);
  const serviceCallsToday = list.reduce((sum, device) => sum + (device.service_calls_today || 0), 0);

  return {
    total_devices: totalDevices,
    online,
    total_videos: totalVideos,
    active_sessions: activeSessions,
    guidance_events_today: guidanceEventsToday,
    service_calls_today: serviceCallsToday,
  };
};

export const DEMO_DEVICES_SUMMARY = summarizeDevices(DEMO_DEVICES);

/* ── Demo report (daily / weekly / monthly) ───────────────────────── */
export const DEMO_REPORTS = {
  daily: {
    period: 'Daily',
    date_range: D0,
    summary: {
      total_sessions: 4,
      analyzed: 3,
      unique_workers: 4,
      total_duration: '3h 24m',
      service_calls: 8,
      tasks_completed: 7,
      avg_response_time: '18m',
    },
    key_findings: [
      'RTU compressor replacement completed 15% faster with guided refrigerant charge verification',
      'Fiber splice loss measured at -0.08dB - well under 0.1dB threshold with AI alignment assist',
      'Gas line pressure alert prevented potential safety incident during water heater install',
      'Wire gauge mismatch caught early on panel upgrade - avoided code violation',
    ],
    recommendations: [
      'Schedule follow-up inspection for Denver rooftop solar array (device offline)',
      'Update lockout/tagout guidance prompts for HVAC high-voltage disconnect procedures',
      'Enable fiber attenuation auto-check on all telecom splice sessions',
    ],
  },
  weekly: {
    period: 'Weekly',
    date_range: `${dayString(6)} to ${D0}`,
    summary: {
      total_sessions: 28,
      analyzed: 24,
      unique_workers: 6,
      total_duration: '22h 45m',
      service_calls: 42,
      tasks_completed: 38,
      avg_response_time: '22m',
    },
    key_findings: [
      'HVAC first-fix rate improved from 74% to 89% with real-time diagnostic guidance',
      'Telecom installation time reduced by 26% across fiber splice and ONT tasks',
      'Safety compliance maintained at 96% - zero workplace incidents this week',
      'Electrical panel upgrades averaging 40min faster with AI-guided wire routing',
      'Water heater callbacks dropped from 8% to 2% with installation verification steps',
    ],
    recommendations: [
      'Deploy updated HVAC refrigerant tables for R-454B transition (effective next month)',
      'Add 5G signal strength checks to telecom pre-splice workflow',
      'Schedule quarterly recertification for 3 electricians due next week',
      'Expand guided diagnostics to commercial plumbing backflow testing',
    ],
  },
  monthly: {
    period: 'Monthly',
    date_range: `${dayString(29)} to ${D0}`,
    summary: {
      total_sessions: 112,
      analyzed: 98,
      unique_workers: 6,
      total_duration: '94h 30m',
      service_calls: 168,
      tasks_completed: 152,
      avg_response_time: '24m',
    },
    key_findings: [
      'Overall task completion rate: 91% (up from 82% last month)',
      'Average service call duration reduced by 22% across all trades',
      'Top performing worker: Emma Chen - 98% task completion, zero safety flags',
      'Equipment misidentification errors dropped 67% with AI tool recognition',
      'Customer satisfaction scores averaging 4.7/5 for guided service calls',
      'Total distance covered by field workers: 1,847 miles across 168 service calls',
    ],
    recommendations: [
      'Expand fleet with 2 additional Meta Ray-Ban Gen 2 units for HVAC team',
      'Implement predictive maintenance alerts based on equipment age data',
      'Create specialized guidance workflows for solar panel installations',
      'Roll out peer review feature for complex electrical panel work',
      'Schedule XY Smart Gen 2 firmware update for rugged environment improvements',
    ],
  },
};

// Backward-compat
export const DEMO_REPORT = DEMO_REPORTS.weekly;

/* ── Demo analytics data (fallback for AnalyticsPage) ─────────────── */
export const DEMO_ANALYTICS_OVERVIEW = {
  total_sessions: 112,
  active_sessions: 4,
  avg_duration_ms: 2040000,
  task_completion_pct: 91,
  safety_flags_count: 3,
  customer_satisfaction_avg: 0.87,
};

export const DEMO_ANALYTICS_WORKERS = [
  {
    worker_id: 'w-1',
    worker_name: 'Aarav Patel',
    worker_role: 'HVAC Technician',
    total_sessions: 32,
    avg_duration_ms: 2100000,
    task_completion_rate: 94,
    customer_satisfaction: 0.91,
    safety_flags: 0,
    tasks_this_week: 8,
    distance_miles: 127,
    calories_burned: 4820,
    avg_response_time_min: 16,
    on_time_pct: 96,
  },
  {
    worker_id: 'w-2',
    worker_name: 'Sophia Lee',
    worker_role: 'Telecom Installer',
    total_sessions: 24,
    avg_duration_ms: 2340000,
    task_completion_rate: 88,
    customer_satisfaction: 0.84,
    safety_flags: 1,
    tasks_this_week: 6,
    distance_miles: 98,
    calories_burned: 3640,
    avg_response_time_min: 22,
    on_time_pct: 88,
  },
  {
    worker_id: 'w-3',
    worker_name: 'Lucas Brown',
    worker_role: 'Electrician',
    total_sessions: 18,
    avg_duration_ms: 2550000,
    task_completion_rate: 83,
    customer_satisfaction: 0.79,
    safety_flags: 2,
    tasks_this_week: 5,
    distance_miles: 84,
    calories_burned: 3210,
    avg_response_time_min: 28,
    on_time_pct: 82,
  },
  {
    worker_id: 'w-4',
    worker_name: 'Emma Chen',
    worker_role: 'Plumber',
    total_sessions: 27,
    avg_duration_ms: 2160000,
    task_completion_rate: 98,
    customer_satisfaction: 0.93,
    safety_flags: 0,
    tasks_this_week: 7,
    distance_miles: 112,
    calories_burned: 4150,
    avg_response_time_min: 14,
    on_time_pct: 98,
  },
  {
    worker_id: 'w-5',
    worker_name: 'Mason Clark',
    worker_role: 'Solar Technician',
    total_sessions: 11,
    avg_duration_ms: 3000000,
    task_completion_rate: 76,
    customer_satisfaction: 0.72,
    safety_flags: 0,
    tasks_this_week: 3,
    distance_miles: 156,
    calories_burned: 5480,
    avg_response_time_min: 32,
    on_time_pct: 74,
  },
  {
    worker_id: 'w-6',
    worker_name: 'Mia Anderson',
    worker_role: 'Maintenance Tech',
    total_sessions: 8,
    avg_duration_ms: 1800000,
    task_completion_rate: 92,
    customer_satisfaction: 0.88,
    safety_flags: 0,
    tasks_this_week: 4,
    distance_miles: 42,
    calories_burned: 2680,
    avg_response_time_min: 20,
    on_time_pct: 92,
  },
];

const generateTimeSeries = (days) => {
  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = dayString(i);
    const base = i === 0 ? 4 : Math.floor(Math.random() * 5) + 2;
    result.push({ date: d, sessions: base + Math.floor(Math.random() * 3) });
  }
  return result;
};

export const DEMO_ANALYTICS_TIME_SERIES = generateTimeSeries(30);

export const DEMO_ANALYTICS_TOPICS = [
  { topic: 'HVAC Repair', count: 28 },
  { topic: 'Fiber Installation', count: 22 },
  { topic: 'Electrical Panel', count: 18 },
  { topic: 'Plumbing Service', count: 16 },
  { topic: 'Equipment Diagnosis', count: 14 },
  { topic: 'Safety Compliance', count: 12 },
  { topic: 'Water Heater', count: 10 },
  { topic: 'Solar Installation', count: 8 },
  { topic: 'CNC Maintenance', count: 6 },
  { topic: 'Preventive Maintenance', count: 4 },
];

export const DEMO_ANALYTICS_COMPLIANCE = {
  rates: {
    safety_gear: 97,
    lockout_tagout: 94,
    permit_verification: 91,
    code_compliance: 96,
    documentation: 88,
  },
  total_sessions_checked: 98,
};

export const isDemoVideoId = (id) => String(id || '').startsWith('demo-video-');
export const isDemoDeviceId = (id) => String(id || '').startsWith('demo-device-');
export const getDemoDeviceById = (id) => DEMO_DEVICES.find((device) => device.id === id) || null;
export const getDemoVideosByDeviceId = (id) => DEMO_VIDEOS.filter((video) => video.device_id === id);
