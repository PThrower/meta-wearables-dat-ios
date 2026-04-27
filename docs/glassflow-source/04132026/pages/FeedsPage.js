import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Film, Play, Clock, HardDrive, RefreshCw,
  X, ChevronDown, ChevronRight, Loader2, Users,
  Calendar, Radio, AlertCircle, GraduationCap, Sparkles, Send
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';
import { getFeeds, getFeed, getFeedRooms, getStreamSessions, triggerSkillExtraction, getSkill } from '@/lib/api';
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

  const fetchFeeds = useCallback(async () => {
    setLoading(true);
    try {
      const params = { creator_identity: user?.email };
      if (selectedRoom) params.room = selectedRoom;
      const [feedData, sessionData] = await Promise.all([
        getFeeds(params),
        getStreamSessions({ creator_identity: user?.email }),
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

  const navigate = useNavigate();

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
    <div className="min-h-screen bg-background" data-testid="feeds-page">
      <Header />

      <main className="px-5 lg:px-8 py-6">
        {/* Page header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
          <div>
            <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
              <Film className="h-5 w-5 text-[#E0FF00]" strokeWidth={1.5} />
              Recorded Feeds
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {feeds.length} recording{feeds.length !== 1 ? 's' : ''}{selectedRoom ? ` in ${shortenRoomName(selectedRoom)}` : ''}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative">
              <select
                value={selectedRoom}
                onChange={(e) => setSelectedRoom(e.target.value)}
                className="appearance-none bg-white/5 border border-white/10 rounded-md px-3 py-1.5 pr-8 text-xs text-white/80 focus:outline-none focus:border-[#E0FF00]/50"
                data-testid="room-filter"
              >
                <option value="">All Rooms</option>
                {rooms.map((room) => (
                  <option key={room} value={room}>{room}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-white/40 pointer-events-none" />
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={fetchFeeds}
              className="border-white/10 text-white/60 hover:text-white h-8"
              data-testid="refresh-feeds"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.5} />
            </Button>
          </div>
        </div>

        {/* Feed list */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 text-[#E0FF00] animate-spin" />
          </div>
        ) : feeds.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-white/40">
            <Film className="h-12 w-12 mb-4" strokeWidth={1} />
            <p className="text-sm">No recordings found</p>
            {selectedRoom && (
              <button onClick={() => setSelectedRoom('')} className="mt-2 text-xs text-[#E0FF00] hover:underline">
                Clear room filter
              </button>
            )}
          </div>
        ) : (
          <div className="border border-white/10 rounded-lg overflow-hidden">
            {/* Table header */}
            <div className="grid grid-cols-[2rem_1fr_8rem_5rem_5rem_4rem] sm:grid-cols-[2rem_1fr_10rem_6rem_5rem_5rem] gap-2 px-3 py-2 bg-white/[0.03] border-b border-white/10 text-[10px] uppercase tracking-wider text-white/30">
              <span />
              <span>Recording</span>
              <span>Date</span>
              <span className="hidden sm:block">Duration</span>
              <span>Size</span>
              <span>Users</span>
            </div>

            {/* Rows */}
            {feeds.map((feed, idx) => {
              const feedId = feed.id || feed.egress_id;
              const isExpanded = expandedId === feedId;
              const session = sessionMap[feed.room_name];
              const duration = formatDuration(session?.total_duration_ms || feed.duration_ms);
              const participants = session?.participant_count;

              return (
                <div key={feedId} data-testid={`feed-row-${feedId}`}>
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: idx * 0.02 }}
                    className={`grid grid-cols-[2rem_1fr_8rem_5rem_5rem_4rem] sm:grid-cols-[2rem_1fr_10rem_6rem_5rem_5rem] gap-2 px-3 py-2.5 items-center cursor-pointer transition-colors ${
                      isExpanded
                        ? 'bg-[#E0FF00]/5 border-l-2 border-l-[#E0FF00]'
                        : 'hover:bg-white/[0.03] border-l-2 border-l-transparent'
                    } ${idx > 0 ? 'border-t border-white/5' : ''}`}
                    onClick={() => toggleExpand(feed)}
                  >
                    {/* Expand icon */}
                    <span className="flex items-center justify-center">
                      <ChevronRight className={`h-3.5 w-3.5 text-white/30 transition-transform ${isExpanded ? 'rotate-90 text-[#E0FF00]' : ''}`} strokeWidth={1.5} />
                    </span>

                    {/* Recording name */}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="flex items-center justify-center h-6 w-6 rounded bg-white/5 flex-shrink-0">
                          <Play className="h-3 w-3 text-[#E0FF00]" strokeWidth={2} />
                        </span>
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-white/90 truncate">
                            {shortenRoomName(feed.room_name)}
                          </p>
                          <p className="text-[10px] text-white/30 truncate font-mono">
                            {feed.file_name}
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* Date */}
                    <span className="text-xs text-white/50 flex items-center gap-1">
                      <Calendar className="h-3 w-3 flex-shrink-0" strokeWidth={1.5} />
                      {formatDate(feed.last_modified)}
                    </span>

                    {/* Duration */}
                    <span className="text-xs text-white/50 hidden sm:flex items-center gap-1">
                      <Clock className="h-3 w-3 flex-shrink-0" strokeWidth={1.5} />
                      {duration || '--:--'}
                    </span>

                    {/* Size */}
                    <span className="text-xs text-white/50 flex items-center gap-1">
                      <HardDrive className="h-3 w-3 flex-shrink-0" strokeWidth={1.5} />
                      {formatBytes(feed.size_bytes)}
                    </span>

                    {/* Participants */}
                    <span className="text-xs text-white/50 flex items-center gap-1">
                      <Users className="h-3 w-3 flex-shrink-0" strokeWidth={1.5} />
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
                        className="overflow-hidden border-t border-white/5"
                      >
                        <div className="p-4 bg-white/[0.02]">
                          <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
                            {/* Video player */}
                            <div className="aspect-video bg-black rounded-lg overflow-hidden border border-white/10">
                              {loadingDetail ? (
                                <div className="w-full h-full flex items-center justify-center">
                                  <Loader2 className="h-6 w-6 text-[#E0FF00] animate-spin" />
                                </div>
                              ) : expandedDetail?.playback_url ? (
                                <video
                                  src={expandedDetail.playback_url}
                                  controls
                                  autoPlay
                                  className="w-full h-full"
                                  data-testid="feed-video-player"
                                />
                              ) : (
                                <div className="w-full h-full flex flex-col items-center justify-center text-white/30">
                                  <AlertCircle className="h-8 w-8 mb-2" strokeWidth={1} />
                                  <p className="text-xs">Playback unavailable</p>
                                </div>
                              )}
                            </div>

                            {/* Session info sidebar */}
                            <div className="space-y-3">
                              <h3 className="text-xs font-semibold text-white/60 uppercase tracking-wider">Session Details</h3>

                              <div className="space-y-2">
                                <DetailRow label="Room" value={feed.room_name} mono />
                                <DetailRow label="Date" value={formatDate(feed.last_modified)} />
                                <DetailRow label="Duration" value={duration || 'Unknown'} />
                                <DetailRow label="File Size" value={formatBytes(feed.size_bytes)} />
                                <DetailRow label="Participants" value={participants != null ? String(participants) : 'Unknown'} />
                                <DetailRow label="Status" value={session?.status || 'recorded'} badge />
                                {feed.file_name && (
                                  <DetailRow label="File" value={feed.file_name} mono small />
                                )}
                              </div>

                              {/* Skill extraction */}
                              <div className="mt-4 pt-4 border-t border-white/10">
                                <h3 className="text-xs font-semibold text-white/60 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                                  <Sparkles className="h-3 w-3 text-[#E0FF00]" strokeWidth={1.5} />
                                  Extract Skill
                                </h3>
                                <textarea
                                  value={extractPrompt}
                                  onChange={(e) => setExtractPrompt(e.target.value)}
                                  placeholder="What skill should be extracted? e.g., 'Steps for replacing a printer cartridge, including paper jam handling'"
                                  className="w-full bg-white/5 border border-white/10 rounded-md px-2.5 py-2 text-xs text-white/80 placeholder:text-white/25 resize-none focus:outline-none focus:border-[#E0FF00]/50 h-20"
                                  disabled={extracting}
                                />
                                <Button
                                  size="sm"
                                  onClick={() => handleExtractSkill(feed)}
                                  disabled={extracting || !extractPrompt.trim()}
                                  className="mt-2 w-full bg-[#E0FF00]/10 border border-[#E0FF00]/30 text-[#E0FF00] hover:bg-[#E0FF00]/20 text-xs h-8"
                                >
                                  {extracting ? (
                                    <><Loader2 className="h-3 w-3 animate-spin mr-1.5" /> Extracting...</>
                                  ) : (
                                    <><GraduationCap className="h-3 w-3 mr-1.5" strokeWidth={1.5} /> Extract Skill with Gemini</>
                                  )}
                                </Button>
                              </div>

                              {/* Session log placeholder */}
                              {session?.ai_session_log?.length > 0 && (
                                <div>
                                  <h3 className="text-xs font-semibold text-white/60 uppercase tracking-wider mb-2 mt-4">Conversation</h3>
                                  <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                                    {session.ai_session_log.map((entry, i) => (
                                      <div key={i} className="text-[11px] text-white/60 bg-white/5 rounded px-2 py-1.5">
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

function DetailRow({ label, value, mono, small, badge }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="text-[10px] text-white/30 uppercase tracking-wider flex-shrink-0">{label}</span>
      {badge ? (
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
          value === 'completed' ? 'bg-emerald-500/15 text-emerald-400' :
          value === 'active' ? 'bg-[#E0FF00]/15 text-[#E0FF00]' :
          'bg-white/10 text-white/50'
        }`}>
          {value}
        </span>
      ) : (
        <span className={`text-right truncate ${mono ? 'font-mono' : ''} ${small ? 'text-[10px] text-white/40' : 'text-xs text-white/70'}`} title={value}>
          {value}
        </span>
      )}
    </div>
  );
}
