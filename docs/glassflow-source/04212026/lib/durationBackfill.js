// Probes real video durations from MP4 metadata and writes them back to
// media_assets.duration_ms. Used by FeedsPage to self-heal recordings
// whose duration is missing or obviously wrong (the LiveKit egress
// webhook drops it for a significant fraction of uploads).

import { supabase } from './api';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ONE_DAY_MS = 86_400_000;
const PROBE_TIMEOUT_MS = 25_000;

export const isSuspiciousDuration = (ms) =>
  ms == null || ms <= 0 || ms < 1_000 || ms > ONE_DAY_MS;

// Probe duration from an MP4. LiveKit egress often writes fragmented
// MP4 where the moov atom reports a partial/incorrect duration — or
// Infinity. The reliable trick is to seek past the end; the browser
// clamps to true end-of-file, firing durationchange with the real
// value. Works for both finalized and fragmented MP4.
const probeVideoDuration = (url) =>
  new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.style.cssText = 'position:absolute;width:0;height:0;visibility:hidden';

    let settled = false;
    let seekSent = false;

    const cleanup = () => {
      try {
        video.src = '';
        video.removeAttribute('src');
        video.load();
      } catch { /* ignore */ }
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(err);
    };
    const succeed = (secs) => {
      if (settled) return;
      if (!Number.isFinite(secs) || secs <= 0) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(Math.round(secs * 1000));
    };
    const timer = setTimeout(() => fail(new Error('probe timeout')), PROBE_TIMEOUT_MS);

    video.addEventListener('loadedmetadata', () => {
      if (seekSent) return;
      seekSent = true;
      // Force browser to resolve actual end of stream. For a finalized
      // MP4 the duration is already correct and the seek clamps
      // instantly; for FMP4 this triggers index parsing.
      try { video.currentTime = 1e101; } catch { /* some browsers throw */ }
      // Safety net: if no further event fires in a reasonable window,
      // accept whatever value the element reports.
      setTimeout(() => succeed(video.duration), 3000);
    });

    // After the seek clamps, duration is known. Accept on either
    // durationchange (fragmented MP4) or seeked (finalized MP4).
    const maybeAccept = () => {
      if (seekSent && Number.isFinite(video.duration) && video.duration > 0) {
        succeed(video.duration);
      }
    };
    video.addEventListener('durationchange', maybeAccept);
    video.addEventListener('seeked', maybeAccept);

    video.addEventListener('error', () => fail(new Error('video element load error')));

    video.src = url;
  });

// Writes a probed duration to media_assets via the SECURITY DEFINER RPC.
// Returns true if the DB row was updated.
export const persistRecordingDuration = async (assetId, durationMs) => {
  if (!supabase || !assetId || !UUID_RE.test(String(assetId))) return false;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return false;
  const { data, error } = await supabase.rpc('update_recording_duration', {
    p_asset_id: assetId,
    p_duration_ms: Math.round(durationMs),
  });
  if (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[durationBackfill] rpc failed', error);
    }
    return false;
  }
  return data === true;
};

// Probes and persists duration for a single feed. Returns the probed
// duration in ms, or null if anything failed.
const healOneFeed = async (feed) => {
  if (!feed?.file_key) return null;
  if (!UUID_RE.test(String(feed.id || ''))) return null;

  try {
    const { data: urlData, error: urlErr } = await supabase.storage
      .from('recordings')
      .createSignedUrl(feed.file_key, 900);
    if (urlErr || !urlData?.signedUrl) return null;

    const durationMs = await probeVideoDuration(urlData.signedUrl);
    await persistRecordingDuration(feed.id, durationMs);
    return durationMs;
  } catch {
    return null;
  }
};

// Walk through feeds and heal suspicious durations. Calls onFeedHealed
// with (feedId, durationMs) after each successful probe so the UI can
// update progressively. First kicks the server-side probe-durations
// edge function (which parses MP4 moov via HTTP Range), then falls
// back to client-side <video> probes for anything still unresolved.
export const backfillFeedDurations = async (feeds, onFeedHealed) => {
  if (!Array.isArray(feeds) || feeds.length === 0 || !supabase) return;
  const suspicious = feeds.filter((f) =>
    isSuspiciousDuration(f.duration_ms) && f.file_key && UUID_RE.test(String(f.id || ''))
  );
  if (suspicious.length === 0) return;

  // Try the server-side edge function first — fast, reliable (parses
  // the real MP4 moov atom), and updates the DB in one round trip.
  try {
    const { data } = await supabase.functions.invoke('probe-durations', {
      body: { limit: Math.min(suspicious.length, 30) },
    });
    const healedFromServer = new Set();
    for (const r of (data?.results || [])) {
      if (r?.id && Number.isFinite(r.duration_ms) && r.duration_ms > 0) {
        healedFromServer.add(r.id);
        if (onFeedHealed) {
          try { onFeedHealed(r.id, r.duration_ms); } catch { /* ignore */ }
        }
      }
    }
    // Anything the server couldn't probe falls through to client probe.
    const remaining = suspicious.filter((f) => !healedFromServer.has(f.id));
    if (remaining.length === 0) return;
    suspicious.length = 0;
    suspicious.push(...remaining);
  } catch {
    // Edge function unreachable; fall back entirely to client probes.
  }

  const CONCURRENCY = 2;
  let cursor = 0;
  const worker = async () => {
    while (cursor < suspicious.length) {
      const idx = cursor++;
      const feed = suspicious[idx];
      const ms = await healOneFeed(feed);
      if (ms && onFeedHealed) {
        try { onFeedHealed(feed.id, ms); } catch { /* ignore */ }
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, suspicious.length) }, worker),
  );
};
