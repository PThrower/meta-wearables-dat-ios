import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Film, Play, Clock, HardDrive, RefreshCw,
  X, ChevronDown, ChevronRight, Loader2, Users,
  Calendar, Radio, AlertCircle, GraduationCap, Sparkles, Send, Layers, Database
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';
import { getFeeds, getFeed, getFeedRooms, getStreamSessions, triggerSkillExtraction, getSkill } from '@/lib/api';
import { backfillFeedDurations, persistRecordingDuration, isSuspiciousDuration } from '@/lib/durationBackfill';
import { useAuth } from '@/context/AuthContext';
import { toast } from 'sonner';

const formatBytes = (bytes) => {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

const formatDuration = (ms) => {
  if (!ms) return null;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

const formatDate = (iso) => {
  if (!iso) return '--';
  try {
    const d = new Date(iso);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const isYesterday = d.toDateString() === new Date(now - 86400000).toDateString();
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (isToday) return `Today, ${time}`;
    if (isYesterday) return `Yesterday, ${time}`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + `, ${time}`;
  } catch {
    return '--';
  }
};

const formatHours = (ms) => {
  if (!ms) return '0h';
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
};

// Monday of the week containing `d`
const startOfWeek = (d) => {
  const copy = new Date(d);
  const day = copy.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  copy.setDate(copy.getDate() + diff);
  copy.setHours(0, 0, 0, 0);
  return copy;
};

const getBucket = (iso, mode) => {
  const d = iso ? new Date(iso) : new Date();
  if (mode === 'week') {
    const start = startOfWeek(d);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const key = `W-${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
    const sameMonth = start.getMonth() === end.getMonth();
    const label = sameMonth
      ? `${start.toLocaleDateString(undefined, { month: 'short' })} ${start.getDate()}–${end.getDate()}`
      : `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    const sub = start.getFullYear() === new Date().getFullYear() ? 'this year' : String(start.getFullYear());
    return { key, label, sub, sortTs: start.getTime() };
  }
  const key = `M-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const label = d.toLocaleDateString(undefined, { month: 'long' });
  const sub = String(d.getFullYear());
  const sortTs = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  return { key, label, sub, sortTs };
};

const shortenRoomName = (name) => {
  if (!name) return '--';
  // "sbx-2ywlxt-AybEDU6QP88jH665VpsNcf" → last segment
  const parts = name.split('-');
  if (parts.length >= 3) return parts.slice(2).join('-').slice(0, 12);
  return name.slice(0, 16);
};

export default function FeedsPage() {
  const { user } = useAuth();
  const [feeds, setFeeds] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [sessionMap, setSessionMap] = useState({});
  const [selectedRoom, setSelectedRoom] = useState('');
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const [expandedDetail, setExpandedDetail] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [extractPrompt, setExtractPrompt] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [bucketMode, setBucketMode] = useState('week'); // 'week' | 'month'
  const [selectedBucketKey, setSelectedBucketKey] = useState(null);

  const ADMIN_EMAILS = ['gnikhil335@gmail.com'];
  const isAdmin = ADMIN_EMAILS.includes(user?.email);

  const fetchFeeds = useCallback(async () => {
    setLoading(true);
    try {
      // Admins see all feeds; regular users are scoped to their own sessions
      const params = isAdmin ? {} : { creator_identity: user?.email };
      if (selectedRoom) params.room = selectedRoom;
      const [feedData, sessionData] = await Promise.all([
        getFeeds(params),
        getStreamSessions(isAdmin ? {} : { creator_identity: user?.email }),
      ]);
      const feedList = Array.isArray(feedData) ? feedData : [];
      setFeeds(feedList);

      // Build room → session lookup for enriching feeds with session metadata
      const map = {};
      const sessions = Array.isArray(sessionData) ? sessionData : [];
      for (const s of sessions) {
        if (s.livekit_room_name) map[s.livekit_room_name] = s;
      }
      setSessionMap(map);
    } catch (err) {
      toast.error('Failed to load feeds');
      setFeeds([]);
    } finally {
      setLoading(false);
    }
  }, [selectedRoom, user?.email]);

  const fetchRooms = useCallback(async () => {
    try {
      const data = await getFeedRooms(user?.email);
      setRooms(Array.isArray(data) ? data : []);
    } catch {
      setRooms([]);
    }
  }, [user?.email]);

  useEffect(() => { fetchRooms(); }, [fetchRooms]);
  useEffect(() => { fetchFeeds(); }, [fetchFeeds]);

  // Self-heal missing/bogus durations by probing the MP4 metadata and
  // writing the true value back to media_assets via RPC. Runs once per
  // unique set of fetched IDs — the ref prevents re-trigger loops when
  // applyHeal updates feeds in place.
  const backfillKeyRef = useRef('');
  useEffect(() => {
    if (loading || feeds.length === 0) return;
    const key = feeds.map((f) => f.id).sort().join('|');
    if (backfillKeyRef.current === key) return;
    backfillKeyRef.current = key;

    let cancelled = false;
    const applyHeal = (feedId, ms) => {
      if (cancelled) return;
      setFeeds((prev) => {
        let changed = false;
        const next = prev.map((f) => {
          if (f.id === feedId && isSuspiciousDuration(f.duration_ms)) {
            changed = true;
            return { ...f, duration_ms: ms };
          }
          return f;
        });
        return changed ? next : prev;
      });
    };
    backfillFeedDurations(feeds, applyHeal);
    return () => { cancelled = true; };
  }, [feeds, loading]);

  const navigate = useNavigate();

  // Pick the best-known duration for a feed. Prefer the asset's own
  // value (validated by client-side probe), fall back to the session's
  // total_duration_ms only if the asset value is missing or bogus.
  const resolveDurationMs = (f) => {
    const assetMs = f.duration_ms;
    if (!isSuspiciousDuration(assetMs)) return assetMs;
    const session = sessionMap[f.room_name];
    const sessMs = session?.total_duration_ms;
    if (!isSuspiciousDuration(sessMs)) return sessMs;
    return 0;
  };

  // Compute overall gist stats (across all feeds, not just selected bucket)
  const gist = useMemo(() => {
    let totalMs = 0;
    let totalBytes = 0;
    const rooms = new Set();
    for (const f of feeds) {
      totalMs += resolveDurationMs(f);
      totalBytes += (f.size_bytes || 0);
      if (f.room_name) rooms.add(f.room_name);
    }
    return { count: feeds.length, totalMs, totalBytes, rooms: rooms.size };
  }, [feeds, sessionMap]);

  // Group feeds into buckets (monthly or weekly)
  const buckets = useMemo(() => {
    const byKey = new Map();
    for (const f of feeds) {
      const b = getBucket(f.last_modified, bucketMode);
      const existing = byKey.get(b.key);
      const ms = resolveDurationMs(f);
      const bytes = f.size_bytes || 0;
      if (existing) {
        existing.feeds.push(f);
        existing.totalMs += ms;
        existing.totalBytes += bytes;
      } else {
        byKey.set(b.key, { ...b, feeds: [f], totalMs: ms, totalBytes: bytes });
      }
    }
    return Array.from(byKey.values()).sort((a, b) => b.sortTs - a.sortTs);
  }, [feeds, sessionMap, bucketMode]);

  // Auto-select the newest bucket when data (or mode) changes
  useEffect(() => {
    if (buckets.length === 0) {
      setSelectedBucketKey(null);
      return;
    }
    if (!buckets.find((b) => b.key === selectedBucketKey)) {
      setSelectedBucketKey(buckets[0].key);
    }
  }, [buckets, selectedBucketKey]);

  const activeBucket = buckets.find((b) => b.key === selectedBucketKey);
  const visibleFeeds = activeBucket ? activeBucket.feeds : [];

  const handleExtractSkill = async (feed) => {
    if (!extractPrompt.trim()) {
      toast.error('Describe what skill to extract from this recording');
      return;
    }
    setExtracting(true);
    try {
      const result = await triggerSkillExtraction({
        bucket: 'recordings',
        objectPath: feed.file_key,
        customPrompt: extractPrompt.trim(),
        creatorIdentity: user?.email,
      });
      const skillId = result?.skill_id;
      toast.success('Skill extraction started — processing with Gemini 3.1 Pro...');
      setExtractPrompt('');

      // Poll for completion (background processing)
      if (skillId) {
        const pollInterval = setInterval(async () => {
          try {
            const skill = await getSkill(skillId);
            if (skill?.extraction_status === 'completed') {
              clearInterval(pollInterval);
              setExtracting(false);
              toast.success(`Skill "${skill.name}" extracted!`, {
                action: { label: 'View', onClick: () => navigate('/skills') },
              });
            } else if (skill?.extraction_status === 'failed') {
              clearInterval(pollInterval);
              setExtracting(false);
              toast.error(`Extraction failed: ${skill.extraction_error || 'Unknown error'}`);
            }
          } catch { /* keep polling */ }
        }, 5000);
        // Stop polling after 5 minutes
        setTimeout(() => { clearInterval(pollInterval); setExtracting(false); }, 300000);
      }
    } catch (err) {
      toast.error(`Extraction failed: ${err.message || 'Unknown error'}`);
      setExtracting(false);
    }
  };

  const toggleExpand = async (feed) => {
    const feedId = feed.id || feed.egress_id;
    if (expandedId === feedId) {
      setExpandedId(null);
      setExpandedDetail(null);
      setExtractPrompt('');
      return;
    }
    setExpandedId(feedId);
    setExtractPrompt('');
    setLoadingDetail(true);
    try {
      const detail = await getFeed(feedId);
      setExpandedDetail(detail);
    } catch {
      setExpandedDetail(feed);
    } finally {
      setLoadingDetail(false);
    }
  };

  return (
    <div className="gf-page min-h-screen" data-testid="feeds-page" style={{ background: 'var(--gf-bg)' }}>

      <main className="max-w-[1400px] mx-auto p-6 sm:p-8 space-y-5">
        {/* Page header */}
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] mb-1.5" style={{ color: 'var(--gf-text-faint)' }}>Archive</div>
            <h1 className="text-[28px] font-semibold tracking-tight" style={{ color: 'var(--gf-text)' }}>Recorded feeds</h1>
            <p className="text-[13px] mt-1" style={{ color: 'var(--gf-text-dim)' }}>
              {gist.count} recording{gist.count !== 1 ? 's' : ''} · {formatHours(gist.totalMs)} captured · {formatBytes(gist.totalBytes)} stored
              {selectedRoom ? ` · ${shortenRoomName(selectedRoom)}` : ''}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative">
              <select
                value={selectedRoom}
                onChange={(e) => setSelectedRoom(e.target.value)}
                className="appearance-none h-9 rounded-md px-3 pr-8 text-[12px] outline-none focus:outline-none"
                style={{
                  background: 'var(--gf-surface)',
                  color: 'var(--gf-text-dim)',
                  border: '1px solid var(--gf-line)',
                }}
                data-testid="room-filter"
              >
                <option value="">All rooms</option>
                {rooms.map((room) => (
                  <option key={room} value={room}>{room}</option>
                ))}
              </select>
              <ChevronDown
                className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 pointer-events-none"
                style={{ color: 'var(--gf-text-faint)' }}
              />
            </div>

            <button
              onClick={fetchFeeds}
              className="btn-ghost h-9 px-3 rounded-md text-[12px] flex items-center gap-1.5"
              data-testid="refresh-feeds"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.5} />
            </button>
          </div>
        </div>

        {/* Gist stats — overview of the archive */}
        {!loading && feeds.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <StatCard icon={Film} label="Recordings" value={String(gist.count)} />
            <StatCard icon={Clock} label="Total runtime" value={formatHours(gist.totalMs)} />
            <StatCard icon={Database} label="Storage used" value={formatBytes(gist.totalBytes)} />
            <StatCard icon={Radio} label="Unique rooms" value={String(gist.rooms)} />
          </div>
        )}

        {/* Bucket navigation — stacked periods */}
        {!loading && buckets.length > 0 && (
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5" style={{ color: 'var(--gf-text-faint)' }} strokeWidth={1.5} />
                <span
                  className="text-[11px] uppercase tracking-[0.16em]"
                  style={{ color: 'var(--gf-text-faint)' }}
                >
                  Browse by period
                </span>
              </div>
              <div
                className="inline-flex rounded-md p-0.5"
                style={{ background: 'var(--gf-surface)', border: '1px solid var(--gf-line)' }}
              >
                {['week', 'month'].map((m) => (
                  <button
                    key={m}
                    onClick={() => setBucketMode(m)}
                    className="px-3 h-6 rounded text-[11px] font-medium capitalize transition-colors"
                    style={{
                      background: bucketMode === m ? 'var(--lime-soft)' : 'transparent',
                      color: bucketMode === m ? 'var(--lime)' : 'var(--gf-text-dim)',
                    }}
                    data-testid={`bucket-mode-${m}`}
                  >
                    {m === 'month' ? 'Monthly' : 'Weekly'}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex gap-3 overflow-x-auto overflow-y-visible pt-2 pb-3 -mx-1 px-1 scroll-area">
              {buckets.map((b) => {
                const active = b.key === selectedBucketKey;
                return (
                  <BucketCard
                    key={b.key}
                    bucket={b}
                    active={active}
                    onClick={() => setSelectedBucketKey(b.key)}
                  />
                );
              })}
            </div>
          </div>
        )}

        {/* Feed list */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin" style={{ color: 'var(--lime)' }} />
          </div>
        ) : feeds.length === 0 ? (
          <div
            className="rounded-xl border hairline p-12 text-center"
            style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
          >
            <Film className="h-10 w-10 mx-auto mb-3 opacity-30" strokeWidth={1} />
            <p className="text-sm" style={{ color: 'var(--gf-text)' }}>No recordings found</p>
            {selectedRoom && (
              <button
                onClick={() => setSelectedRoom('')}
                className="mt-2 text-xs hover:underline"
                style={{ color: 'var(--lime)' }}
              >
                Clear room filter
              </button>
            )}
          </div>
        ) : (
          <div
            className="rounded-xl border hairline overflow-hidden"
            style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
          >
            {/* Bucket heading */}
            {activeBucket && (
              <div
                className="flex items-center justify-between px-4 py-2.5 border-b hairline"
                style={{ background: 'var(--gf-surface-2)', borderBottomColor: 'var(--gf-line)' }}
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-[13px] font-semibold" style={{ color: 'var(--gf-text)' }}>
                    {activeBucket.label}
                  </span>
                  <span className="text-[11px]" style={{ color: 'var(--gf-text-faint)' }}>
                    {activeBucket.sub}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-[11px] gf-mono" style={{ color: 'var(--gf-text-dim)' }}>
                  <span>{activeBucket.feeds.length} rec</span>
                  <span>·</span>
                  <span>{formatHours(activeBucket.totalMs)}</span>
                  <span>·</span>
                  <span>{formatBytes(activeBucket.totalBytes)}</span>
                </div>
              </div>
            )}

            {/* Table header */}
            <div
              className="grid grid-cols-[2rem_1fr_8rem_5rem_5rem_4rem] sm:grid-cols-[2rem_1fr_10rem_6rem_5rem_5rem] gap-2 px-3 py-2 border-b hairline text-[10px] gf-mono uppercase tracking-wider"
              style={{ background: 'var(--gf-surface-2)', borderBottomColor: 'var(--gf-line)', color: 'var(--gf-text-faint)' }}
            >
              <span />
              <span>Recording</span>
              <span>Date</span>
              <span className="hidden sm:block">Duration</span>
              <span>Size</span>
              <span>Users</span>
            </div>

            {/* Rows */}
            {visibleFeeds.map((feed, idx) => {
              const feedId = feed.id || feed.egress_id;
              const isExpanded = expandedId === feedId;
              const session = sessionMap[feed.room_name];
              const duration = formatDuration(resolveDurationMs(feed));
              const participants = session?.participant_count;

              return (
                <div key={feedId} data-testid={`feed-row-${feedId}`}>
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: idx * 0.02 }}
                    className="grid grid-cols-[2rem_1fr_8rem_5rem_5rem_4rem] sm:grid-cols-[2rem_1fr_10rem_6rem_5rem_5rem] gap-2 px-3 py-2.5 items-center cursor-pointer transition-colors border-l-2"
                    style={{
                      background: isExpanded ? 'var(--lime-soft)' : 'transparent',
                      borderLeftColor: isExpanded ? 'var(--lime)' : 'transparent',
                      borderTop: idx > 0 ? '1px solid var(--gf-line)' : 'none',
                    }}
                    onClick={() => toggleExpand(feed)}
                  >
                    {/* Expand icon */}
                    <span className="flex items-center justify-center">
                      <ChevronRight
                        className={`h-3.5 w-3.5 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                        style={{ color: isExpanded ? 'var(--lime)' : 'var(--gf-text-faint)' }}
                        strokeWidth={1.5}
                      />
                    </span>

                    {/* Recording name */}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className="flex items-center justify-center h-6 w-6 rounded shrink-0"
                          style={{ background: 'rgba(255,255,255,0.04)' }}
                        >
                          <Play className="h-3 w-3" style={{ color: 'var(--lime)' }} strokeWidth={2} />
                        </span>
                        <div className="min-w-0">
                          <p className="text-xs font-medium truncate" style={{ color: 'var(--gf-text)' }}>
                            {shortenRoomName(feed.room_name)}
                          </p>
                          <p className="text-[10px] gf-mono truncate" style={{ color: 'var(--gf-text-faint)' }}>
                            {feed.file_name}
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* Date */}
                    <span className="text-xs flex items-center gap-1" style={{ color: 'var(--gf-text-dim)' }}>
                      <Calendar className="h-3 w-3 shrink-0" strokeWidth={1.5} />
                      {formatDate(feed.last_modified)}
                    </span>

                    {/* Duration */}
                    <span className="text-xs hidden sm:flex items-center gap-1" style={{ color: 'var(--gf-text-dim)' }}>
                      <Clock className="h-3 w-3 shrink-0" strokeWidth={1.5} />
                      {duration || '--:--'}
                    </span>

                    {/* Size */}
                    <span className="text-xs flex items-center gap-1" style={{ color: 'var(--gf-text-dim)' }}>
                      <HardDrive className="h-3 w-3 shrink-0" strokeWidth={1.5} />
                      {formatBytes(feed.size_bytes)}
                    </span>

                    {/* Participants */}
                    <span className="text-xs flex items-center gap-1" style={{ color: 'var(--gf-text-dim)' }}>
                      <Users className="h-3 w-3 shrink-0" strokeWidth={1.5} />
                      {participants != null ? participants : '--'}
                    </span>
                  </motion.div>

                  {/* Expanded detail */}
                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden border-t hairline"
                        style={{ borderTopColor: 'var(--gf-line)' }}
                      >
                        <div className="p-4" style={{ background: 'var(--gf-surface-2)' }}>
                          <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
                            {/* Video player */}
                            <div
                              className="aspect-video rounded-lg overflow-hidden border hairline"
                              style={{ background: '#000', borderColor: 'var(--gf-line)' }}
                            >
                              {loadingDetail ? (
                                <div className="w-full h-full flex items-center justify-center">
                                  <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--lime)' }} />
                                </div>
                              ) : expandedDetail?.playback_url ? (
                                <video
                                  src={expandedDetail.playback_url}
                                  controls
                                  autoPlay
                                  className="w-full h-full"
                                  data-testid="feed-video-player"
                                  onLoadedMetadata={(e) => {
                                    const secs = e.currentTarget.duration;
                                    if (!Number.isFinite(secs) || secs <= 0) return;
                                    const ms = Math.round(secs * 1000);
                                    const current = expandedDetail?.duration_ms;
                                    const drifted = current == null || Math.abs(current - ms) > 60_000;
                                    if (!drifted) return;
                                    persistRecordingDuration(expandedDetail.id, ms).then((ok) => {
                                      if (!ok) return;
                                      setExpandedDetail((d) => d ? { ...d, duration_ms: ms } : d);
                                      setFeeds((prev) => prev.map((f) =>
                                        f.id === expandedDetail.id ? { ...f, duration_ms: ms } : f
                                      ));
                                    });
                                  }}
                                />
                              ) : (
                                <div
                                  className="w-full h-full flex flex-col items-center justify-center"
                                  style={{ color: 'var(--gf-text-faint)' }}
                                >
                                  <AlertCircle className="h-8 w-8 mb-2" strokeWidth={1} />
                                  <p className="text-xs">Playback unavailable</p>
                                </div>
                              )}
                            </div>

                            {/* Session info sidebar */}
                            <div className="space-y-3">
                              <h3
                                className="text-xs font-semibold uppercase tracking-wider"
                                style={{ color: 'var(--gf-text-dim)' }}
                              >
                                Session details
                              </h3>

                              <div className="space-y-2">
                                <DetailRow label="Room" value={feed.room_name} mono />
                                <DetailRow label="Date" value={formatDate(feed.last_modified)} />
                                <DetailRow label="Duration" value={duration || 'Unknown'} />
                                <DetailRow label="File size" value={formatBytes(feed.size_bytes)} />
                                <DetailRow label="Participants" value={participants != null ? String(participants) : 'Unknown'} />
                                <DetailRow label="Status" value={session?.status || 'recorded'} badge />
                                {feed.file_name && (
                                  <DetailRow label="File" value={feed.file_name} mono small />
                                )}
                              </div>

                              {/* Skill extraction */}
                              <div className="mt-4 pt-4 border-t hairline" style={{ borderTopColor: 'var(--gf-line)' }}>
                                <h3
                                  className="text-xs font-semibold uppercase tracking-wider mb-2 flex items-center gap-1.5"
                                  style={{ color: 'var(--gf-text-dim)' }}
                                >
                                  <Sparkles className="h-3 w-3" style={{ color: 'var(--lime)' }} strokeWidth={1.5} />
                                  Extract skill
                                </h3>
                                <textarea
                                  value={extractPrompt}
                                  onChange={(e) => setExtractPrompt(e.target.value)}
                                  placeholder="What skill should be extracted? e.g., 'Steps for replacing a printer cartridge, including paper jam handling'"
                                  className="w-full rounded-md px-2.5 py-2 text-xs resize-none focus:outline-none h-20"
                                  style={{
                                    background: 'rgba(255,255,255,0.04)',
                                    border: '1px solid var(--gf-line)',
                                    color: 'var(--gf-text)',
                                  }}
                                  disabled={extracting}
                                />
                                <button
                                  onClick={() => handleExtractSkill(feed)}
                                  disabled={extracting || !extractPrompt.trim()}
                                  className="btn-lime mt-2 w-full h-8 rounded-md text-xs font-medium flex items-center justify-center gap-1.5 disabled:opacity-40"
                                >
                                  {extracting ? (
                                    <><Loader2 className="h-3 w-3 animate-spin" /> Extracting…</>
                                  ) : (
                                    <><GraduationCap className="h-3 w-3" strokeWidth={1.5} /> Extract skill with Gemini</>
                                  )}
                                </button>
                              </div>

                              {/* Session log placeholder */}
                              {session?.ai_session_log?.length > 0 && (
                                <div>
                                  <h3
                                    className="text-xs font-semibold uppercase tracking-wider mb-2 mt-4"
                                    style={{ color: 'var(--gf-text-dim)' }}
                                  >
                                    Conversation
                                  </h3>
                                  <div className="space-y-1.5 max-h-48 overflow-y-auto scroll-area pr-1">
                                    {session.ai_session_log.map((entry, i) => (
                                      <div
                                        key={i}
                                        className="text-[11px] rounded px-2 py-1.5"
                                        style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--gf-text-dim)' }}
                                      >
                                        {typeof entry === 'string' ? entry : (entry.text || entry.message || JSON.stringify(entry))}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}

function StatCard({ icon: Icon, label, value }) {
  return (
    <div
      className="rounded-lg border hairline px-3.5 py-3"
      style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
    >
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon className="h-3 w-3" style={{ color: 'var(--gf-text-faint)' }} strokeWidth={1.5} />
        <span
          className="text-[10px] uppercase tracking-[0.14em]"
          style={{ color: 'var(--gf-text-faint)' }}
        >
          {label}
        </span>
      </div>
      <div className="text-[20px] font-semibold tracking-tight" style={{ color: 'var(--gf-text)' }}>
        {value}
      </div>
    </div>
  );
}

function BucketCard({ bucket, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className="relative shrink-0 w-[180px] text-left transition-transform"
      style={{ transform: active ? 'translateY(-2px)' : 'none' }}
      data-testid={`bucket-${bucket.key}`}
    >
      {/* stacked shadow cards behind */}
      <div
        className="absolute inset-0 rounded-lg translate-x-1.5 translate-y-1.5"
        style={{
          background: 'var(--gf-surface)',
          border: '1px solid var(--gf-line)',
          opacity: 0.5,
        }}
      />
      <div
        className="absolute inset-0 rounded-lg translate-x-[3px] translate-y-[3px]"
        style={{
          background: 'var(--gf-surface)',
          border: '1px solid var(--gf-line)',
          opacity: 0.75,
        }}
      />
      {/* top card */}
      <div
        className="relative rounded-lg px-3.5 py-3"
        style={{
          background: active ? 'var(--lime-soft)' : 'var(--gf-surface)',
          border: `1px solid ${active ? 'var(--lime)' : 'var(--gf-line)'}`,
          boxShadow: active ? '0 4px 18px rgba(0,0,0,0.25)' : 'none',
        }}
      >
        <div className="flex items-start justify-between mb-2">
          <div>
            <div
              className="text-[14px] font-semibold leading-tight"
              style={{ color: active ? 'var(--lime)' : 'var(--gf-text)' }}
            >
              {bucket.label}
            </div>
            <div
              className="text-[10px] uppercase tracking-[0.14em] mt-0.5"
              style={{ color: 'var(--gf-text-faint)' }}
            >
              {bucket.sub}
            </div>
          </div>
          <span
            className="text-[10px] gf-mono px-1.5 py-0.5 rounded"
            style={{
              background: active ? 'rgba(212,255,58,0.18)' : 'rgba(255,255,255,0.05)',
              color: active ? 'var(--lime)' : 'var(--gf-text-dim)',
            }}
          >
            {bucket.feeds.length}
          </span>
        </div>
        <div className="flex items-center gap-2.5 text-[10px]" style={{ color: 'var(--gf-text-dim)' }}>
          <span className="flex items-center gap-1">
            <Clock className="h-2.5 w-2.5" strokeWidth={1.5} />
            {formatHours(bucket.totalMs)}
          </span>
          <span className="flex items-center gap-1">
            <HardDrive className="h-2.5 w-2.5" strokeWidth={1.5} />
            {formatBytes(bucket.totalBytes)}
          </span>
        </div>
      </div>
    </button>
  );
}

function DetailRow({ label, value, mono, small, badge }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="text-[10px] uppercase tracking-wider shrink-0" style={{ color: 'var(--gf-text-faint)' }}>{label}</span>
      {badge ? (
        <span
          className={`gf-badge ${
            value === 'completed' ? 'gf-badge-ok' :
            value === 'active' ? 'gf-badge-active' :
            'gf-badge-idle'
          }`}
        >
          {value}
        </span>
      ) : (
        <span
          className={`text-right truncate ${mono ? 'gf-mono' : ''} ${small ? 'text-[10px]' : 'text-xs'}`}
          style={{ color: small ? 'var(--gf-text-faint)' : 'var(--gf-text-dim)' }}
          title={value}
        >
          {value}
        </span>
      )}
    </div>
  );
}
