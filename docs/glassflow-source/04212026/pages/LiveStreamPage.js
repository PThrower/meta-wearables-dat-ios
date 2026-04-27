import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Radio, Video, Clock, ChevronRight, RefreshCw,
  Play, Square, Eye, MessageSquare, Loader2, Wifi, AlertCircle,
  CheckCircle2, Timer, Glasses, Mic, MicOff, Users, Shield,
  FileText, BarChart3, ArrowRight, X, Send, Bot, Volume2, VolumeX,
  RotateCcw, Languages, Wrench, Settings, Smartphone, Monitor
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { getStreamSessions, getStreamSession, getStreamPlayback, getStreamJoinToken, getSkills, supabase } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { TokenSource } from 'livekit-client';
import { toast } from 'sonner';
const LiveKitViewer = lazy(() => import('@/components/LiveKitViewer'));

const toArray = (value) => {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.data)) return value.data;
  return [];
};

const formatDuration = (ms) => {
  if (!ms) return '--:--';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

const formatTimestamp = (iso) => {
  if (!iso) return '--';
  try {
    const date = new Date(iso);
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '--';
  }
};

const formatTranscriptTime = (ms) => {
  if (!ms && ms !== 0) return '';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

const getStatusConfig = (status) => {
  switch (status) {
    case 'active':
      return {
        badge: 'gf-badge gf-badge-active',
        dot: 'bg-[color:var(--lime)] animate-pulse',
        label: 'Live',
        icon: Radio,
      };
    case 'paused':
      return {
        badge: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
        dot: 'bg-amber-400',
        label: 'Paused',
        icon: Timer,
      };
    case 'completed':
      return {
        badge: 'bg-sky-500/20 text-sky-400 border-sky-500/30',
        dot: 'bg-sky-400',
        label: 'Completed',
        icon: CheckCircle2,
      };
    case 'failed':
      return {
        badge: 'bg-red-500/20 text-red-400 border-red-500/30',
        dot: 'bg-red-400',
        label: 'Failed',
        icon: AlertCircle,
      };
    default:
      return {
        badge: 'bg-muted text-muted-foreground border-border',
        dot: 'bg-muted-foreground',
        label: status || 'Unknown',
        icon: Video,
      };
  }
};

// Transcript Panel Component
function TranscriptPanel({ transcript, isLive }) {
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current && isLive) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcript, isLive]);

  if (!transcript || transcript.length === 0) {
    return (
      <div className="text-center py-6">
        <FileText className="h-6 w-6 text-muted-foreground/40 mx-auto mb-2" />
        <p className="text-xs text-muted-foreground">No transcript available</p>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="space-y-1.5 max-h-80 overflow-y-auto pr-2">
      {transcript.map((seg, i) => (
        <div key={i} className="flex gap-2 text-xs">
          <span className="text-muted-foreground/60 font-mono w-10 flex-shrink-0 text-right">
            {formatTranscriptTime(seg.timestamp_ms)}
          </span>
          <span className={`font-medium w-8 flex-shrink-0 ${
            seg.speaker_id === 'S1' ? 'text-cyan-400' : 'text-amber-400'
          }`}>
            {seg.speaker_id || '?'}
          </span>
          <span className="text-foreground/90">{seg.text}</span>
        </div>
      ))}
      {isLive && (
        <div className="flex items-center gap-2 text-xs text-[color:var(--lime)] pt-1">
          <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--lime)] animate-pulse" />
          Listening...
        </div>
      )}
    </div>
  );
}

// Analysis Panel Component
function AnalysisPanel({ analysis }) {
  if (!analysis) {
    return (
      <div className="text-center py-6">
        <BarChart3 className="h-6 w-6 text-muted-foreground/40 mx-auto mb-2" />
        <p className="text-xs text-muted-foreground">Analysis will be available after processing</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Executive Summary */}
      {analysis.executive_summary && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Summary</div>
          <p className="text-sm text-foreground/90">{analysis.executive_summary}</p>
        </div>
      )}

      {/* Participants */}
      {analysis.participants && analysis.participants.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Participants</div>
          <div className="flex flex-wrap gap-2">
            {analysis.participants.map((p, i) => (
              <div key={i} className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/30 text-xs">
                <Users className="h-3 w-3 text-muted-foreground" />
                <span className="capitalize">{p.role}</span>
                <span className="text-muted-foreground">({p.speaking_time_pct}%)</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Action Items */}
      {analysis.action_items && analysis.action_items.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Action Items</div>
          <div className="space-y-1">
            {analysis.action_items.map((item, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <ArrowRight className="h-3 w-3 text-[color:var(--lime)] mt-0.5 flex-shrink-0" />
                <span className="text-foreground/90">{item.text}</span>
                {item.priority && (
                  <Badge variant="outline" className={`text-[9px] px-1 py-0 ml-auto flex-shrink-0 ${
                    item.priority === 'high' ? 'text-red-400 border-red-500/30' :
                    item.priority === 'medium' ? 'text-amber-400 border-amber-500/30' :
                    'text-muted-foreground border-border'
                  }`}>
                    {item.priority}
                  </Badge>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Safety Flags */}
      {analysis.safety_flags && analysis.safety_flags.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Safety Flags</div>
          <div className="space-y-1">
            {analysis.safety_flags.map((flag, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <Shield className={`h-3 w-3 mt-0.5 flex-shrink-0 ${
                  flag.severity === 'critical' ? 'text-red-400' :
                  flag.severity === 'warning' ? 'text-amber-400' : 'text-[color:var(--lime)]'
                }`} />
                <span className="text-foreground/90">{flag.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Customer Sentiment */}
      {analysis.customer_sentiment && (
        <div className="flex items-center gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Sentiment</div>
            <div className="flex items-center gap-2">
              <span className="text-sm capitalize">{analysis.customer_sentiment.overall}</span>
              <div className="h-2 w-20 bg-muted/50 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${
                    analysis.customer_sentiment.score >= 0.7 ? 'bg-[color:var(--lime)]' :
                    analysis.customer_sentiment.score >= 0.4 ? 'bg-amber-500' : 'bg-red-500'
                  }`}
                  style={{ width: `${analysis.customer_sentiment.score * 100}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Compliance */}
      {analysis.compliance_check && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Compliance</div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(analysis.compliance_check).map(([key, value]) => (
              <div key={key} className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] ${
                value ? 'bg-lime-10 text-[color:var(--lime)]' : 'bg-red-500/10 text-red-400'
              }`}>
                {value ? <CheckCircle2 className="h-2.5 w-2.5" /> : <AlertCircle className="h-2.5 w-2.5" />}
                {key.replace(/_/g, ' ')}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Topics */}
      {analysis.topics && analysis.topics.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Topics</div>
          <div className="flex flex-wrap gap-1">
            {analysis.topics.map((topic, i) => (
              <Badge key={i} variant="outline" className="text-[10px] px-1.5 py-0">
                {topic}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function LiveStreamPage() {
  const { user } = useAuth();
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedSession, setSelectedSession] = useState(null);
  const [selectedDetail, setSelectedDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [liveTurns, setLiveTurns] = useState({});
  const [liveTokenSource, setLiveTokenSource] = useState(null);
  const [liveRoomName, setLiveRoomName] = useState(null);
  const [joiningLive, setJoiningLive] = useState(false);
  const [liveMessages, setLiveMessages] = useState([]); // unified conversation log
  const adminMessagesRef = useRef([]); // admin-only messages (survive LiveKit rebuilds)
  const lastLkLenRef = useRef(0); // track LiveKit message count to avoid unnecessary rebuilds
  const sendChatFnRef = useRef(null);
  const sendInstructionFnRef = useRef(null);
  const [chatInput, setChatInput] = useState('');
  const [detailTab, setDetailTab] = useState('overview');
  const [preSelectedHandled, setPreSelectedHandled] = useState(false);
  const [agentMuted, setAgentMuted] = useState(false);
  const [adminMode, setAdminMode] = useState('agent');
  const [rightPanel, setRightPanel] = useState('conversation');
  const [agentMemory, setAgentMemory] = useState(null);
  const [videoOrientation, setVideoOrientation] = useState('landscape'); // 'landscape' (XY) or 'portrait' (Meta)
  const [agentTools, setAgentTools] = useState(null);
  const [agentConfig, setAgentConfig] = useState(null);
  const [extractedSkills, setExtractedSkills] = useState([]);
  const [activeSkillId, setActiveSkillId] = useState(null);
  const roomRef = useRef(null);

  // Stable callback for receiving room ref from LiveKitViewer
  const handleRoomRef = useCallback((room) => { roomRef.current = room; }, []);

  // Find the agent participant dynamically — identity defaults to "agent-<jobid>"
  const getAgentIdentity = useCallback(() => {
    if (!roomRef.current) return null;
    for (const [, p] of roomRef.current.remoteParticipants) {
      if (p.identity?.startsWith('agent-')) {
        return p.identity;
      }
    }
    return null;
  }, []);

  // RPC helper — calls methods on the LiveKit agent
  const callAgentRpc = useCallback(async (method, payload = {}) => {
    if (!roomRef.current?.localParticipant) return null;
    const agentId = getAgentIdentity();
    if (!agentId) {
      console.warn(`RPC ${method}: agent not found in room`);
      toast.error('Agent not found in room');
      return null;
    }
    try {
      const response = await roomRef.current.localParticipant.performRpc({
        destinationIdentity: agentId,
        method,
        payload: JSON.stringify(payload),
      });
      return JSON.parse(response);
    } catch (err) {
      console.error(`RPC ${method} to ${agentId} failed:`, err);
      toast.error(`Agent RPC failed: ${err.message || method}`);
      return null;
    }
  }, [getAgentIdentity]);
  // Fetch available skills once (for the Apply Skill dropdown)
  useEffect(() => {
    getSkills({ extraction_status: 'completed' })
      .then((data) => setExtractedSkills(Array.isArray(data) ? data : []))
      .catch(() => setExtractedSkills([]));
  }, []);

  // Apply an extracted skill to the current live session
  const applySkill = useCallback(async (skill) => {
    if (!skill?.agent_prompt) {
      toast.error('Skill has no agent prompt');
      return;
    }
    const result = await callAgentRpc('admin.restart', { system_prompt: skill.agent_prompt });
    if (result?.updated) {
      setActiveSkillId(skill.id);
      toast.success(`Applied skill: ${skill.name}`);
    }
  }, [callAgentRpc]);

  // Auto-fetch tools and config when joining a live session
  useEffect(() => {
    if (!liveTokenSource) return;
    const timer = setTimeout(async () => {
      const [tools, config] = await Promise.all([
        callAgentRpc('admin.getTools'),
        callAgentRpc('admin.getConfig'),
      ]);
      if (tools) setAgentTools(tools.tools);
      if (config) setAgentConfig(config);
    }, 3000);
    return () => clearTimeout(timer);
  }, [liveTokenSource, callAgentRpc]);

  const wsRef = useRef(null);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const preSelectedId = searchParams.get('session');

  const syncRooms = useCallback(async () => {
    if (supabase) {
      await supabase.functions.invoke('livekit-sync').catch(() => {});
    }
  }, []);

  const fetchSessions = useCallback(async () => {
    try {
      const data = await getStreamSessions({ status: 'active', limit: 50, creator_identity: user?.email });
      setSessions(toArray(data));
    } catch (error) {
      console.error('Failed to fetch stream sessions:', error);
      toast.error('Failed to load stream sessions');
    } finally {
      setLoading(false);
    }
  }, [user?.email]);

  useEffect(() => {
    syncRooms().then(fetchSessions);
  }, [syncRooms, fetchSessions]);

  // Auto-join pre-selected session from URL param (e.g. from Command Center)
  useEffect(() => {
    if (preSelectedId && !preSelectedHandled && sessions.length > 0) {
      const target = sessions.find(s => s.id === preSelectedId);
      if (target) {
        handleSessionClick(target);
        if (target.status === 'active') {
          handleJoinLive(target.id);
        }
        setPreSelectedHandled(true);
      }
    }
  }, [preSelectedId, sessions, preSelectedHandled]);

  // WebSocket for live transcript on active sessions
  useEffect(() => {
    if (!selectedSession) {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      return;
    }

    const session = sessions.find(s => s.id === selectedSession);
    if (!session || session.status !== 'active') return;

    const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:8001';
    const wsUrl = backendUrl.replace(/^http/, 'ws') + `/api/stream/sessions/${selectedSession}/ws`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'ai_turn' || data.type === 'transcript') {
          setLiveTurns(prev => ({
            ...prev,
            [data.session_id]: [...(prev[data.session_id] || []), data.turn || data],
          }));
        }
      } catch (e) {
        console.error('WS parse error:', e);
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [selectedSession, sessions]);

  const handleSessionClick = async (session) => {
    if (selectedSession === session.id) {
      setSelectedSession(null);
      setSelectedDetail(null);
      setDetailTab('overview');
      return;
    }
    setSelectedSession(session.id);
    setDetailLoading(true);
    setDetailTab('overview');
    try {
      const detail = await getStreamSession(session.id);
      setSelectedDetail(detail);
    } catch {
      setSelectedDetail(session);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleJoinLive = async (sessionId) => {
    setJoiningLive(true);
    try {
      // Get room name from the session
      const session = sessions.find(s => s.id === sessionId);
      const roomName = session?.livekit_room_name;
      if (!roomName) throw new Error('No room name');

      // Create a TokenSource.custom that calls our Edge Function
      const tokenSource = TokenSource.custom(async () => {
        const { data, error } = await supabase.functions.invoke('livekit-join-token', {
          body: { session_id: sessionId, viewer_email: user?.email },
        });
        if (error) throw error;
        return {
          serverUrl: data.livekit_url,
          participantToken: data.token,
        };
      });

      setLiveTokenSource(tokenSource);
      setLiveRoomName(roomName);
      setLiveMessages([]);
      adminMessagesRef.current = [];
      sendChatFnRef.current = null;
      sendInstructionFnRef.current = null;
      setDetailTab('live');
      toast.success('Joining live session...');
    } catch (err) {
      toast.error('Failed to join live session');
      console.error('Join error:', err);
    } finally {
      setJoiningLive(false);
    }
  };

  const handleLeaveLive = () => {
    setLiveTokenSource(null);
    setLiveRoomName(null);
    setLiveMessages([]);
    adminMessagesRef.current = [];
    lastLkLenRef.current = 0;
    sendChatFnRef.current = null;
    sendInstructionFnRef.current = null;
    setChatInput('');
    setDetailTab('overview');
  };

  // Rebuild unified conversation from LiveKit messages + admin messages
  // LiveKit gives us the FULL array each time, and message.text updates live as
  // transcription streams in — so we pass raw messages through and derive role on render
  // Store latest LiveKit messages in a ref (avoids re-render loop)
  const lkMessagesRef = useRef([]);

  const handleLiveKitMessages = useCallback((lkMessages) => {
    const lkArray = Array.isArray(lkMessages) ? lkMessages : [];
    lkMessagesRef.current = lkArray;

    // Map LiveKit messages — keep raw ref for live text updates
    const lkMapped = lkArray.map((msg, i) => {
      const identity = msg.from?.identity || '';
      const isLocal = msg.from?.isLocal === true;
      const isChat = msg.type === 'chat';
      const isAgentParticipant = identity.startsWith('agent-');

      let role;
      if (isChat && isLocal) {
        role = 'admin';
      } else if (isAgentParticipant) {
        role = 'agent';
      } else if (msg.type === 'userTranscript' || (!isAgentParticipant && !isLocal && !isChat)) {
        role = 'human';
      } else {
        role = 'system';
      }

      return {
        id: msg.id || `lk-${i}`,
        role,
        _lkMsg: msg,
        timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
      };
    });

    // Only update state if message count changed (prevents infinite render loop)
    const newLen = lkMapped.length + adminMessagesRef.current.length;
    if (newLen !== lastLkLenRef.current) {
      lastLkLenRef.current = newLen;
      const all = [...lkMapped, ...adminMessagesRef.current];
      all.sort((a, b) => a.timestamp - b.timestamp);
      setLiveMessages(all);
    }
  }, []);

  // Add admin instruction to conversation log
  const addAdminMessage = useCallback((text) => {
    adminMessagesRef.current.push({
      id: `admin-${Date.now()}`,
      role: 'admin',
      text,
      timestamp: Date.now(),
    });
    // Force re-render with admin message included
    setLiveMessages(prev => {
      const all = [...prev.filter(m => m.role !== 'admin'), ...adminMessagesRef.current];
      all.sort((a, b) => a.timestamp - b.timestamp);
      return all;
    });
  }, []);

  const handleSendChat = async () => {
    const text = chatInput.trim();
    if (!text) return;
    try {
      if (sendInstructionFnRef.current) {
        await sendInstructionFnRef.current(text);
        addAdminMessage(text);
      } else if (sendChatFnRef.current) {
        await sendChatFnRef.current(text);
      } else {
        return;
      }
      setChatInput('');
    } catch (err) {
      console.error('Send instruction error:', err);
    }
  };

  const totalParticipants = sessions.reduce((sum, s) => sum + (s.participant_count || 0), 0);
  const activeSession = liveTokenSource && selectedDetail ? sessions.find(s => s.id === selectedSession) : null;

  // Compute live duration
  // Live timer that updates every second
  const [liveTick, setLiveTick] = useState(0);
  useEffect(() => {
    if (!liveTokenSource) return;
    const interval = setInterval(() => setLiveTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, [liveTokenSource]);

  const liveDuration = activeSession?.started_at
    ? formatDuration(Date.now() - new Date(activeSession.started_at).getTime())
    : '--:--';

  // ─── LIVE PLAYER VIEW — Admin Control Panel ───
  if (activeSession && liveTokenSource) {
    return (
      <div className="min-h-screen bg-background text-foreground" data-testid="live-stream-page">
        <main className={`h-[calc(100vh-64px)] grid grid-cols-1 gap-3 p-3 ${
          videoOrientation === 'portrait'
            ? 'lg:grid-cols-[35%_30%_35%]'
            : 'lg:grid-cols-[30%_40%_30%]'
        }`}>
          {/* CENTER — Video Feed, full height, no borders (order-2 on desktop) */}
          <div className={`relative min-h-0 lg:order-2 overflow-hidden ${videoOrientation === 'landscape' ? 'xy-video-rotate' : ''}`}>
            {/* Orientation toggle */}
            <div className="absolute top-3 right-3 z-20 flex items-center gap-0.5 bg-black/60 backdrop-blur-sm rounded-md border border-white/10 p-0.5">
              <button
                onClick={() => setVideoOrientation('landscape')}
                className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors ${
                  videoOrientation === 'landscape'
                    ? 'bg-lime-15 text-[color:var(--lime)]'
                    : 'text-white/40 hover:text-white/70'
                }`}
                title="Landscape — XY / K900 Glasses"
              >
                <Monitor className="h-3 w-3" strokeWidth={1.5} />
                <span className="hidden sm:inline">XY</span>
              </button>
              <button
                onClick={() => setVideoOrientation('portrait')}
                className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors ${
                  videoOrientation === 'portrait'
                    ? 'bg-lime-15 text-[color:var(--lime)]'
                    : 'text-white/40 hover:text-white/70'
                }`}
                title="Portrait — Meta Ray-Bans"
              >
                <Smartphone className="h-3 w-3" strokeWidth={1.5} />
                <span className="hidden sm:inline">Meta</span>
              </button>
            </div>
            <Suspense fallback={
              <div className="absolute inset-0 flex items-center justify-center bg-black">
                <Loader2 className="h-6 w-6 animate-spin text-[color:var(--lime)]" />
              </div>
            }>
              <LiveKitViewer
                tokenSource={liveTokenSource}
                roomName={liveRoomName}
                onBack={handleLeaveLive}
                onMessages={handleLiveKitMessages}
                onSendChat={(fn) => { sendChatFnRef.current = fn; }}
                onSendInstruction={(fn) => { sendInstructionFnRef.current = fn; }}
                onRoom={handleRoomRef}
                className={`absolute inset-0 flex flex-col ${
                  videoOrientation === 'portrait'
                    ? '[&_video]:object-contain [&_video]:w-full [&_video]:h-full [&_video]:bg-black'
                    : ''
                }`}
              />
            </Suspense>
          </div>

          {/* LEFT — Transcript + Controls + Presets (order-1 on desktop) */}
          <div className="flex flex-col min-h-0 lg:order-1">
            {/* Transcript area */}
            <div className="flex-1 min-h-0 rounded-xl border hairline gf-surface-2 flex flex-col overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-2.5 border-b hairline flex-shrink-0">
                <MessageSquare className="h-3.5 w-3.5 text-cyan-400" strokeWidth={1.5} />
                <span className="text-[11px] font-semibold uppercase tracking-wider text-white/50">Live Transcript</span>
                {liveMessages.length > 0 && (
                  <span className="text-[10px] text-white/30 ml-auto">{liveMessages.length} messages</span>
                )}
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-pulse" />
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-2" ref={(el) => {
                if (el) el.scrollTop = el.scrollHeight;
              }}>
                {liveMessages.length > 0 ? (
                  liveMessages.map((msg, i) => {
                    const text = msg._lkMsg?.message || msg.text || '';
                    if (!text) return null;
                    const prevMsg = i > 0 ? liveMessages[i - 1] : null;
                    const sameSender = prevMsg && prevMsg.role === msg.role;
                    const labelMap = { agent: 'Agent', human: 'Human', admin: 'Admin', system: 'System' };
                    const colorMap = { agent: 'text-emerald-400', human: 'text-amber-400', admin: 'text-purple-400', system: 'text-white/50' };
                    const label = labelMap[msg.role] || 'System';
                    const color = colorMap[msg.role] || 'text-white/50';
                    return (
                      <div key={msg.id || i} className={sameSender ? 'pt-0' : 'pt-2'}>
                        {!sameSender && (
                          <span className={`text-[10px] font-semibold uppercase tracking-wider block mb-0.5 ${color}`}>{label}</span>
                        )}
                        <p className={`text-xs leading-relaxed whitespace-pre-line ${msg.role === 'agent' ? 'text-white/90' : msg.role === 'admin' ? 'text-purple-300/80' : 'text-white/70'}`}>{text}</p>
                      </div>
                    );
                  })
                ) : (
                  <div className="flex items-center justify-center h-full">
                    <p className="text-xs text-white/30">Conversation will appear here...</p>
                  </div>
                )}
              </div>
              {/* Instruction input */}
              <div className="border-t hairline p-3 flex-shrink-0">
                <div className="text-[10px] text-purple-400/70 mb-1.5 flex items-center gap-1">
                  <Bot className="h-3 w-3" />
                  Send instruction to agent (worker won't see this)
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSendChat()}
                    placeholder="e.g. Act like a teacher..."
                    className="flex-1 bg-white/5 border border-white/10 rounded px-3 py-2 text-xs text-white placeholder:text-white/20 focus:outline-none focus:border-purple-500/30"
                  />
                  <Button variant="outline" size="sm" onClick={handleSendChat} disabled={!chatInput.trim()} className="border-purple-500/30 text-purple-400 hover:bg-purple-500/20 disabled:opacity-25">
                    <Send className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>

            {/* Session info + controls below transcript */}
            <div className="mt-2 flex items-center justify-between px-1">
              <div className="flex items-center gap-2 text-[10px] text-white/40">
                <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
                <span>Live</span>
                <span>{liveDuration}</span>
                <span>{activeSession.metadata_json?.technician || 'Human'}</span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    const next = adminMode === 'agent' ? 'admin' : 'agent';
                    setAdminMode(next);
                    setAgentMuted(next === 'admin');
                    await callAgentRpc(next === 'admin' ? 'admin.muteAgent' : 'admin.unmuteAgent');
                    toast.info(next === 'admin' ? 'Agent muted' : 'Agent resumed');
                  }}
                  className={`text-[9px] py-1 px-2 ${adminMode === 'admin'
                    ? 'bg-purple-500/20 border-purple-500/30 text-purple-400'
                    : 'bg-emerald-500/20 border-emerald-500/30 text-emerald-400'
                  }`}
                >
                  {adminMode === 'admin' ? 'You Speaking' : 'AI Guiding'}
                </Button>
              </div>
            </div>

            {/* Skills */}
            <div className="mt-3 px-1">
              <div className="text-[9px] text-lime-50 font-semibold uppercase tracking-widest mb-2">Skills</div>
              <div className="space-y-1.5">
                <button
                  onClick={async () => {
                    const instructions = `You are a math teacher. Your student is wearing smart glasses. Teach them Euler's theorem interactively.

Start by explaining: "For any positive integer n and any integer a that is coprime to n, a^phi(n) ≡ 1 (mod n)."

Make the student write equations on paper. Guide them step by step:
1. First explain what coprime means with examples
2. Then explain Euler's totient function phi(n) with small numbers
3. Give a concrete example: compute 3^phi(10) mod 10
4. Ask them to write each step on paper
5. Check their work through the camera
6. Give them practice problems with remainders

Be encouraging, patient, and interactive. Ask questions, don't just lecture. Use objects in their environment as examples when possible.`;
                    if (sendInstructionFnRef.current) {
                      await sendInstructionFnRef.current(instructions);
                      addAdminMessage('[Skill: Math Teacher — Euler\'s Theorem]');
                      toast.success('Math Teacher skill enabled');
                    }
                  }}
                  className="w-full text-left bg-white/5 border border-white/10 rounded p-2 hover:border-lime-30 transition-colors"
                >
                  <div className="text-[10px] text-white/70 font-medium">Math Teacher</div>
                  <div className="text-[9px] text-white/30">Teach Euler's theorem interactively with paper exercises</div>
                </button>
                <button
                  onClick={async () => {
                    const instructions = `You are a Rubik's cube coach. Your student is wearing smart glasses and has a Rubik's cube in their hands.

Your goal: teach them to solve the FIRST LAYER (white cross + white corners) of a standard 3x3 Rubik's cube.

Step-by-step approach:
1. First, ask them to show you the cube through the camera so you can see its current state
2. Start with the white cross: guide them to get the 4 white edge pieces around the white center
   - Teach the "daisy" method: put white edges around the yellow center first, then flip them down
   - Use simple move notation: R (right clockwise), R' (right counter-clockwise), U (up), U', etc.
3. Then solve white corners: teach the "right hand algorithm" R U R' U' repeated until corner is in place
4. After each move, ask them to show the cube so you can verify
5. If they make a mistake, calmly guide them back

Important:
- Speak in short, clear sentences — they need to hold the cube while listening
- Reference colors they can see: "Find the white-red edge piece"
- Celebrate small wins
- If they get stuck, simplify: "Just focus on this one piece for now"
- Use the camera to check their progress after each step`;
                    if (sendInstructionFnRef.current) {
                      await sendInstructionFnRef.current(instructions);
                      addAdminMessage('[Skill: Rubik\'s Cube Coach — First Layer]');
                      toast.success('Rubik\'s Cube skill enabled');
                    }
                  }}
                  className="w-full text-left bg-white/5 border border-white/10 rounded p-2 hover:border-lime-30 transition-colors"
                >
                  <div className="text-[10px] text-white/70 font-medium">Rubik's Cube Coach</div>
                  <div className="text-[9px] text-white/30">Solve first layer step-by-step with camera verification</div>
                </button>
                <button
                  onClick={async () => {
                    const instructions = `You are Nurse Ada, an AI triage nurse by Dot Red Labs. You are conducting a patient assessment through smart glasses.

Your goal: perform a structured patient evaluation, document findings through the camera, and compile a preliminary assessment.

Assessment protocol — follow this order:

Step 1 — Introduction and chief complaint:
- Introduce yourself warmly: "Hi, I'm Nurse Ada. I'll be helping with your initial assessment today."
- Ask: "What brings you in today? What's your main concern?"
- Listen carefully. Ask follow-up questions using OLDCARTS: Onset, Location, Duration, Character, Aggravating factors, Relieving factors, Timing, Severity.

Step 2 — Pain assessment:
- Ask: "On a scale of zero to ten, how would you rate your pain right now?"
- Ask about pain location and type: sharp, dull, burning, throbbing, or aching.

Step 3 — Visual inspection:
- If the patient mentions a wound, cut, rash, swelling, or injury, say: "Can you show me the affected area through the camera? I'll document it for your records."
- When you see the injury through the camera, describe what you observe: size, color, swelling, bleeding, signs of infection.
- Say: "I've noted this in your record. Let me continue with a few more questions."

Step 4 — Vital signs:
- Ask: "Do you have a thermometer, pulse oximeter, or blood pressure cuff at home?"
- If yes, guide them to take readings and report the numbers.
- If no, ask: "How are you feeling overall? Any fever, chills, dizziness, or shortness of breath?"

Step 5 — Allergies and medications:
- Ask: "Do you have any known allergies to medications, food, or anything else?"
- Ask: "Are you currently taking any medications? If so, what are they?"

Step 6 — Medical history:
- Ask: "Do you have any chronic conditions like diabetes, high blood pressure, or asthma?"
- Ask: "Have you had any surgeries or hospitalizations in the past?"

Step 7 — Summary and next steps:
- Summarize your findings clearly: "Based on our assessment today..."
- Recommend appropriate next steps: "I would recommend seeing a doctor for further evaluation" or "This appears to be minor, but watch for these signs..."
- Use remember_this to save key findings about the patient.

Important rules:
- Be empathetic, patient, and professional at all times.
- Ask ONE question at a time. Wait for the answer before continuing.
- When examining through the camera, describe what you see objectively.
- NEVER diagnose. Say "this may suggest" or "I would recommend consulting a doctor."
- Save all patient-reported information using the remember tool.
- If the situation seems urgent like chest pain, difficulty breathing, or severe bleeding, immediately say: "This sounds like it could be serious. Please call emergency services or go to the nearest emergency room right away."`;
                    if (sendInstructionFnRef.current) {
                      await sendInstructionFnRef.current(instructions);
                      addAdminMessage('[Skill: Medical Nurse — Patient Assessment]');
                      toast.success('Medical Nurse skill enabled');
                    }
                  }}
                  className="w-full text-left bg-white/5 border border-white/10 rounded p-2 hover:border-lime-30 transition-colors"
                >
                  <div className="text-[10px] text-white/70 font-medium">Medical Nurse</div>
                  <div className="text-[9px] text-white/30">Patient assessment with visual wound documentation (OLDCARTS protocol)</div>
                </button>
              </div>
            </div>
          </div>

          {/* RIGHT — Session Controls (order-3 on desktop) */}
          <div className="flex flex-col min-h-0 overflow-y-auto lg:order-3">
            <div className="rounded-xl border hairline gf-surface-2 flex flex-col overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-2.5 border-b hairline flex-shrink-0">
                <Settings className="h-3.5 w-3.5 text-[color:var(--lime)]" strokeWidth={1.5} />
                <span className="text-[11px] font-semibold uppercase tracking-wider text-white/50">Session Controls</span>
              </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-4">

                  {/* ── APPLY EXTRACTED SKILL ── */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-[9px] text-lime-50 font-semibold uppercase tracking-widest">Apply Extracted Skill</div>
                      {activeSkillId && (
                        <span className="text-[9px] text-[color:var(--lime)] bg-lime-10 px-1.5 py-0.5 rounded">Active</span>
                      )}
                    </div>
                    {extractedSkills.length === 0 ? (
                      <p className="text-[10px] text-white/30">
                        No skills yet. Extract from a recording on the{' '}
                        <button onClick={() => navigate('/feeds')} className="text-lime-70 hover:text-[color:var(--lime)] underline">Feeds page</button>.
                      </p>
                    ) : (
                      <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                        {extractedSkills.map((skill) => (
                          <button
                            key={skill.id}
                            onClick={() => applySkill(skill)}
                            className={`w-full text-left rounded p-2 border transition-colors ${
                              activeSkillId === skill.id
                                ? 'bg-lime-10 border-lime-40'
                                : 'bg-white/5 border-white/10 hover:border-lime-30'
                            }`}
                            data-testid={`apply-skill-${skill.id}`}
                          >
                            <div className="text-[10px] text-white/80 font-medium truncate">{skill.name}</div>
                            <div className="text-[9px] text-white/30 truncate">
                              {Array.isArray(skill.steps) ? skill.steps.length : 0} steps
                              {skill.category && ` · ${skill.category}`}
                              {skill.difficulty && ` · ${skill.difficulty}`}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                    <p className="text-[9px] text-white/15 mt-1">Injects the skill's agent prompt via admin.restart</p>
                  </div>

                  {/* ── UPDATE INSTRUCTIONS (works mid-session via update_agent) ── */}
                  <div>
                    <div className="text-[9px] text-lime-50 font-semibold uppercase tracking-widest mb-2">Update Agent Instructions</div>
                    <textarea
                      id="system-prompt-input"
                      placeholder="Change the agent's behavior. e.g. You are an HVAC expert. Guide the technician through compressor diagnostics."
                      className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-xs text-white placeholder:text-white/15 focus:outline-none focus:border-lime-30 min-h-[70px] resize-y"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={async () => {
                        const text = document.getElementById('system-prompt-input')?.value?.trim();
                        if (!text) { toast.error('Enter instructions first'); return; }
                        const result = await callAgentRpc('admin.restart', { system_prompt: text });
                        if (result?.updated) toast.success('Agent instructions updated');
                      }}
                      className="w-full mt-2 border-lime-30 text-[color:var(--lime)] hover:bg-lime-10 text-[10px]"
                    >
                      Update Instructions
                    </Button>
                    <p className="text-[9px] text-white/15 mt-1">Uses update_agent() — no session restart needed</p>
                  </div>

                  {/* ── KNOWLEDGE UPLOAD (images + text context) ── */}
                  <div>
                    <div className="text-[9px] text-lime-50 font-semibold uppercase tracking-widest mb-2">Upload Knowledge</div>
                    <div className="space-y-3">
                      {/* Image upload */}
                      <div>
                        <label className="text-[10px] text-white/40 block mb-1">Reference Image</label>
                        <div className="flex gap-2">
                          <input
                            type="file"
                            accept="image/*"
                            id="admin-image-upload"
                            className="hidden"
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              if (!file || !roomRef.current) return;
                              const desc = document.getElementById('image-desc-input')?.value?.trim() || file.name;
                              try {
                                const arrayBuf = await file.arrayBuffer();
                                await roomRef.current.localParticipant.sendFile(
                                  new Uint8Array(arrayBuf),
                                  {
                                    topic: 'admin.images',
                                    mimeType: file.type,
                                    fileName: file.name,
                                    attributes: { description: desc },
                                  }
                                );
                                toast.success('Image sent to agent context');
                              } catch (err) {
                                console.error('Image upload failed:', err);
                                toast.error('Failed to upload image');
                              }
                              e.target.value = '';
                            }}
                          />
                          <input
                            id="image-desc-input"
                            type="text"
                            placeholder="Describe the image..."
                            className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1 text-[10px] text-white placeholder:text-white/15 focus:outline-none"
                          />
                          <button
                            onClick={() => document.getElementById('admin-image-upload')?.click()}
                            className="text-[10px] text-[color:var(--lime)] border border-lime-30 rounded px-3 py-1 hover:bg-lime-10"
                          >Upload</button>
                        </div>
                      </div>

                      {/* Text context */}
                      <div>
                        <label className="text-[10px] text-white/40 block mb-1">Text Context (manuals, specs, notes)</label>
                        <textarea
                          id="text-context-input"
                          placeholder="Paste equipment specs, operating instructions, or manual excerpts..."
                          className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-[10px] text-white placeholder:text-white/15 focus:outline-none min-h-[50px] resize-y"
                        />
                        <button
                          onClick={async () => {
                            const text = document.getElementById('text-context-input')?.value?.trim();
                            if (!text) { toast.error('Enter text first'); return; }
                            const result = await callAgentRpc('admin.addTextContext', { text });
                            if (result?.status === 'ok') {
                              document.getElementById('text-context-input').value = '';
                              toast.success('Context added to agent');
                            }
                          }}
                          className="mt-1 text-[10px] text-[color:var(--lime)] border border-lime-30 rounded px-3 py-1 hover:bg-lime-10 w-full"
                        >Add to Agent Context</button>
                      </div>
                    </div>
                    <p className="text-[9px] text-white/15 mt-1">Uploads are injected into the agent's chat context immediately</p>
                  </div>

                  {/* ── ACTIVE TOOLS (read-only view) ── */}
                  <div>
                    <div className="text-[9px] text-lime-50 font-semibold uppercase tracking-widest mb-2">Active Tools</div>
                    <div className="space-y-1">
                      {(agentTools || [
                        { name: 'remember_this', description: 'Remember facts about the user' },
                        { name: 'recall_memory', description: 'Search memory for information' },
                        { name: 'get_current_time', description: 'Get current date and time' },
                        { name: 'set_persona', description: 'Set custom persona' },
                        { name: 'start_recording', description: 'Start session recording' },
                        { name: 'stop_recording', description: 'Stop session recording' },
                      ]).map((tool) => (
                        <div key={tool.name} className="flex items-center gap-2 text-[10px]">
                          <Wrench className="h-3 w-3 text-lime-40" strokeWidth={1.5} />
                          <span className="text-white/60">{tool.name}</span>
                          <span className="text-white/20 ml-auto truncate max-w-[150px]">{tool.description}</span>
                        </div>
                      ))}
                    </div>
                    <p className="text-[9px] text-white/15 mt-1">Read-only. Tools are set at session creation.</p>
                  </div>

                  {/* ── AGENT MEMORY ── */}
                  <div>
                    <div className="text-[9px] text-cyan-400/50 font-semibold uppercase tracking-widest mb-2">Agent Memory</div>
                    <div className="bg-white/5 rounded p-3 space-y-3">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={async () => {
                          const result = await callAgentRpc('admin.getMemory');
                          if (result) {
                            setAgentMemory(result);
                            const count = result.facts?.length || 0;
                            toast.success(`Memory loaded — ${count} fact${count !== 1 ? 's' : ''}`);
                          }
                        }}
                        className="w-full border-cyan-400/20 text-cyan-400/70 hover:bg-cyan-400/10 text-[10px]"
                      >
                        Load Memory
                      </Button>
                      {agentMemory ? (
                        <div className="space-y-3">
                          <div className="text-[10px]">
                            <span className="text-white/30">User:</span> <span className="text-white/60">{agentMemory.user_name || agentMemory.user_id}</span>
                          </div>

                          {/* Persona */}
                          <div>
                            <span className="text-[10px] text-white/30 block mb-1">Persona</span>
                            <div className="flex gap-1">
                              <input
                                id="persona-input"
                                type="text"
                                defaultValue={agentMemory.persona || ''}
                                placeholder="e.g. HVAC expert, friendly teacher..."
                                className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1 text-[10px] text-white placeholder:text-white/15 focus:outline-none focus:border-cyan-400/30"
                              />
                              <button
                                onClick={async () => {
                                  const val = document.getElementById('persona-input')?.value?.trim();
                                  await callAgentRpc('admin.editMemory', { action: 'set_persona', persona: val || '' });
                                  toast.success('Persona updated');
                                }}
                                className="text-[9px] text-cyan-400 px-2 hover:bg-cyan-400/10 rounded"
                              >Save</button>
                            </div>
                          </div>

                          {/* Facts list */}
                          <div>
                            <span className="text-[10px] text-white/30 block mb-1">Facts ({agentMemory.facts?.length || 0})</span>
                            <div className="space-y-1 max-h-[150px] overflow-y-auto">
                              {(agentMemory.facts || []).map((fact, i) => (
                                <div key={i} className="flex items-start gap-1 group">
                                  <span className="text-[10px] text-white/50 flex-1">- {fact}</span>
                                  <button
                                    onClick={async () => {
                                      await callAgentRpc('admin.editMemory', { action: 'delete', fact });
                                      setAgentMemory(prev => ({ ...prev, facts: prev.facts.filter(f => f !== fact) }));
                                      toast.success('Fact deleted');
                                    }}
                                    className="text-[9px] text-red-400/50 hover:text-red-400 opacity-0 group-hover:opacity-100 px-1"
                                  >x</button>
                                </div>
                              ))}
                              {(!agentMemory.facts || agentMemory.facts.length === 0) && (
                                <p className="text-[10px] text-white/15">No facts stored</p>
                              )}
                            </div>
                          </div>

                          {/* Add fact */}
                          <div className="flex gap-1">
                            <input
                              id="new-fact-input"
                              type="text"
                              placeholder="Add a fact..."
                              className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1 text-[10px] text-white placeholder:text-white/15 focus:outline-none focus:border-cyan-400/30"
                              onKeyDown={async (e) => {
                                if (e.key === 'Enter') {
                                  const val = e.target.value.trim();
                                  if (!val) return;
                                  await callAgentRpc('admin.editMemory', { action: 'add', fact: val });
                                  setAgentMemory(prev => ({ ...prev, facts: [...(prev.facts || []), val] }));
                                  e.target.value = '';
                                  toast.success('Fact added');
                                }
                              }}
                            />
                          </div>

                          {/* Clear all */}
                          <button
                            onClick={async () => {
                              await callAgentRpc('admin.editMemory', { action: 'clear' });
                              setAgentMemory(prev => ({ ...prev, facts: [], persona: '' }));
                              toast.success('All memories cleared');
                            }}
                            className="text-[9px] text-red-400/40 hover:text-red-400 transition-colors"
                          >Clear all memories</button>
                        </div>
                      ) : (
                        <p className="text-[10px] text-white/20">Click Load Memory to view and edit</p>
                      )}
                    </div>
                  </div>

                  {/* ── CURRENT CONFIG (read-only) ── */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[9px] text-white/30 font-semibold uppercase tracking-widest">Current Session Config</span>
                      <button
                        onClick={async () => {
                          const [tools, config] = await Promise.all([
                            callAgentRpc('admin.getTools'),
                            callAgentRpc('admin.getConfig'),
                          ]);
                          if (tools) setAgentTools(tools.tools);
                          if (config) setAgentConfig(config);
                          toast.success('Config refreshed');
                        }}
                        className="text-[9px] text-white/30 hover:text-[color:var(--lime)] transition-colors"
                      >Refresh</button>
                    </div>
                    {agentConfig ? (
                      <div className="space-y-3">
                        {/* System Instructions */}
                        {agentConfig.system_instructions && (
                          <div className="bg-white/5 rounded p-2">
                            <span className="text-white/25 block text-[10px] mb-1">System Instructions</span>
                            <p className="text-white/50 text-[10px] whitespace-pre-line max-h-[80px] overflow-y-auto">{agentConfig.system_instructions}</p>
                          </div>
                        )}

                        {/* Config grid */}
                        <div className="grid grid-cols-2 gap-2 text-[10px]">
                          <div className="bg-white/5 rounded p-2"><span className="text-white/25 block">Model</span><span className="text-white/60">{agentConfig.model}</span></div>
                          <div className="bg-white/5 rounded p-2"><span className="text-white/25 block">Voice</span><span className="text-white/60">{agentConfig.voice || 'Puck'}</span></div>
                          <div className="bg-white/5 rounded p-2"><span className="text-white/25 block">Temperature</span><span className="text-white/60">{agentConfig.temperature}</span></div>
                          <div className="bg-white/5 rounded p-2"><span className="text-white/25 block">Thinking</span><span className="text-white/60">{agentConfig.thinking_level || 'high'}</span></div>
                          <div className="bg-white/5 rounded p-2"><span className="text-white/25 block">Video</span><span className="text-white/60">{agentConfig.video_input ? 'On' : 'Off'}</span></div>
                          <div className="bg-white/5 rounded p-2"><span className="text-white/25 block">Recording</span><span className="text-white/60">{agentConfig.egress_id ? 'Active' : 'Off'}</span></div>
                        </div>

                        {/* Chat Context */}
                        {agentConfig.context_messages && agentConfig.context_messages.length > 0 && (
                          <div className="bg-white/5 rounded p-2">
                            <span className="text-white/25 block text-[10px] mb-1">Chat Context ({agentConfig.context_message_count} messages)</span>
                            <div className="max-h-[120px] overflow-y-auto space-y-1">
                              {agentConfig.context_messages.map((msg, i) => (
                                <div key={i} className="text-[9px]">
                                  <span className={`font-semibold ${
                                    msg.role === 'assistant' ? 'text-emerald-400/60' :
                                    msg.role === 'user' ? 'text-amber-400/60' :
                                    msg.role === 'system' ? 'text-purple-400/60' : 'text-white/30'
                                  }`}>{msg.role}</span>
                                  <span className="text-white/30 ml-1">{msg.content}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={async () => {
                          const config = await callAgentRpc('admin.getConfig');
                          if (config) setAgentConfig(config);
                        }}
                        className="w-full text-[10px] border-white/10 text-white/40"
                      >
                        Load Config
                      </Button>
                    )}
                  </div>

                  {/* ── SESSION INFO ── */}
                  <div className="pt-3 border-t hairline">
                    <div className="text-[9px] text-white/30 font-semibold uppercase tracking-widest mb-2">Session Info</div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="bg-white/5 rounded p-2">
                        <span className="text-white/25 block text-[10px]">Room</span>
                        <span className="text-white/60 font-mono text-[10px] truncate block">{activeSession.livekit_room_name || '--'}</span>
                      </div>
                      <div className="bg-white/5 rounded p-2">
                        <span className="text-white/25 block text-[10px]">Device</span>
                        <span className="text-white/60 text-[10px] block">{activeSession.devices?.name || 'Smart Glasses'}</span>
                      </div>
                      <div className="bg-white/5 rounded p-2">
                        <span className="text-white/25 block text-[10px]">Worker</span>
                        <span className="text-white/60 text-[10px] block">{activeSession.metadata_json?.technician || 'Human'}</span>
                      </div>
                      <div className="bg-white/5 rounded p-2">
                        <span className="text-white/25 block text-[10px]">Job Type</span>
                        <span className="text-white/60 text-[10px] block">{activeSession.metadata_json?.job_type || 'Field Session'}</span>
                      </div>
                    </div>
                    {/* Video orientation setting */}
                    <div className="mt-2 bg-white/5 rounded p-2">
                      <span className="text-white/25 block text-[10px] mb-1.5">Video Format</span>
                      <div className="flex gap-1">
                        <button
                          onClick={() => setVideoOrientation('landscape')}
                          className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-[10px] transition-colors border ${
                            videoOrientation === 'landscape'
                              ? 'bg-lime-10 border-lime-30 text-[color:var(--lime)]'
                              : 'border-white/10 text-white/40 hover:text-white/60 hover:border-white/20'
                          }`}
                        >
                          <Monitor className="h-3 w-3" strokeWidth={1.5} />
                          XY / K900
                        </button>
                        <button
                          onClick={() => setVideoOrientation('portrait')}
                          className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-[10px] transition-colors border ${
                            videoOrientation === 'portrait'
                              ? 'bg-lime-10 border-lime-30 text-[color:var(--lime)]'
                              : 'border-white/10 text-white/40 hover:text-white/60 hover:border-white/20'
                          }`}
                        >
                          <Smartphone className="h-3 w-3" strokeWidth={1.5} />
                          Meta
                        </button>
                      </div>
                    </div>
                    <p className="text-[9px] text-white/15 mt-2">Audio: 15min | Video: 2min | 128K context</p>
                  </div>
                </div>
              </div>
          </div>
        </main>
      </div>
    );
  }

  // ─── SESSION LIST VIEW ───
  const liveSessions = sessions.filter((s) => s.status === 'active');
  const otherSessions = sessions.filter((s) => s.status !== 'active');
  const tileBgs = [
    'from-[#1A1D22] via-[#0C0E12] to-[#2A3140]',
    'from-[#1D2018] via-[#0C0E12] to-[#2F3A22]',
    'from-[#251A1A] via-[#0C0E12] to-[#3A2222]',
    'from-[#1E1A25] via-[#0C0E12] to-[#30253D]',
    'from-[#1A2025] via-[#0C0E12] to-[#223040]',
  ];

  return (
    <div className="gf-page min-h-screen" data-testid="live-stream-page" style={{ background: 'var(--gf-bg)' }}>
      <main className="max-w-[1400px] mx-auto p-6 sm:p-8 space-y-5">
        {/* Page Header */}
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] mb-1.5" style={{ color: 'var(--gf-text-faint)' }}>Streams</div>
            <h1
              className="text-[28px] font-semibold tracking-tight flex items-center gap-3"
              data-testid="live-stream-title"
              style={{ color: 'var(--gf-text)' }}
            >
              Live wall
              {liveSessions.length > 0 && (
                <span className="gf-badge gf-badge-live">
                  <span className="live-dot" /> {liveSessions.length} LIVE
                </span>
              )}
            </h1>
            <p className="text-[13px] mt-1" style={{ color: 'var(--gf-text-dim)' }}>
              Every active glass POV in one view. Click a tile to open its command session.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div
              className="flex items-center gap-1 rounded-md border hairline p-0.5"
              style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
            >
              <button className="btn-ghost h-7 px-2.5 rounded text-[11px]">2×3</button>
              <button
                className="h-7 px-2.5 rounded text-[11px]"
                style={{ background: 'var(--lime-soft)', color: 'var(--lime)' }}
              >
                3×2
              </button>
              <button className="btn-ghost h-7 px-2.5 rounded text-[11px]">Focus</button>
            </div>
            <button
              onClick={() => { setLoading(true); syncRooms().then(fetchSessions); }}
              data-testid="refresh-sessions"
              className="btn-ghost h-9 px-3 rounded-md text-[12px] flex items-center gap-1.5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.5} />
              Refresh
            </button>
          </div>
        </div>

        {/* Live wall */}
        {loading && sessions.length === 0 ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--lime)' }} />
          </div>
        ) : liveSessions.length === 0 && otherSessions.length === 0 ? (
          <div
            className="rounded-xl border hairline p-12 text-center"
            style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
          >
            <Glasses className="h-10 w-10 mx-auto mb-3 opacity-30" strokeWidth={1} />
            <h3 className="text-sm font-medium mb-1" style={{ color: 'var(--gf-text)' }}>
              No active streams right now
            </h3>
            <p className="text-xs mb-4" style={{ color: 'var(--gf-text-dim)' }}>
              Active streams will appear here when a technician starts a session.
            </p>
            <button
              onClick={() => navigate('/feeds')}
              className="btn-ghost h-8 px-3 rounded-md text-[12px] inline-flex items-center gap-1.5"
            >
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.5} /> View recordings
            </button>
          </div>
        ) : (
          <>
            {liveSessions.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {liveSessions.map((session, i) => {
                  const tech = session.metadata_json?.technician || session.devices?.assigned_to || session.device_name || 'Worker';
                  const initials = String(tech).split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase();
                  const task = session.metadata_json?.job_type || session.devices?.current_task || 'Live session';
                  const model = session.devices?.model || session.device_name || 'Glass POV';
                  return (
                    <div
                      key={session.id}
                      data-testid={`session-card-${session.id}`}
                      onClick={() => {
                        handleSessionClick(session);
                        handleJoinLive(session.id);
                      }}
                      className="rounded-xl border hairline overflow-hidden cursor-pointer transition group"
                      style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
                    >
                      <div className={`relative aspect-video bg-gradient-to-br ${tileBgs[i % tileBgs.length]} overflow-hidden`}>
                        <div
                          className="absolute inset-0"
                          style={{ backgroundImage: 'repeating-linear-gradient(0deg, rgba(255,255,255,0.03) 0 1px, transparent 1px 3px)' }}
                        />
                        <div className="absolute inset-0 flex items-center justify-center">
                          <div className="waveform" style={{ opacity: 0.8 }}>
                            <span /><span /><span /><span /><span />
                          </div>
                        </div>
                        <div className="absolute top-2 left-2 right-2 flex items-start justify-between">
                          <span className="gf-badge gf-badge-live text-[9px]">
                            <span className="live-dot" /> LIVE
                          </span>
                          {session.participant_count > 0 && (
                            <span
                              className="flex items-center gap-1 text-[9px] gf-mono px-1.5 py-0.5 rounded"
                              style={{ background: 'rgba(0,0,0,0.4)', color: 'rgba(255,255,255,0.7)' }}
                            >
                              <Users className="h-2.5 w-2.5" strokeWidth={1.5} />
                              {session.participant_count}
                            </span>
                          )}
                        </div>
                        <div
                          className="absolute bottom-0 left-0 right-0 p-2"
                          style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.85), transparent)' }}
                        >
                          <div className="text-[9px] gf-mono uppercase tracking-wider" style={{ color: 'rgba(255,255,255,0.5)' }}>
                            POV · {model}
                          </div>
                          <div className="text-[10.5px] truncate mt-0.5" style={{ color: 'rgba(255,255,255,0.9)' }}>
                            <span className="gf-mono mr-1" style={{ color: 'var(--lime)' }}>AGENT</span>
                            {session.last_agent_text || 'Streaming…'}
                          </div>
                        </div>
                        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition">
                          <div className="flex gap-1.5">
                            <button
                              className="w-9 h-9 rounded-full flex items-center justify-center"
                              style={{ background: 'var(--lime)', color: '#000' }}
                              title="Join"
                            >
                              <Mic className="h-3.5 w-3.5" strokeWidth={1.5} />
                            </button>
                            <button
                              className="w-9 h-9 rounded-full flex items-center justify-center border hairline"
                              style={{ background: 'rgba(0,0,0,0.7)', color: '#fff' }}
                              title="Open session"
                            >
                              <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.5} />
                            </button>
                          </div>
                        </div>
                      </div>
                      <div className="p-3 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <div
                            className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold text-black shrink-0"
                            style={{ background: 'linear-gradient(135deg, #7FB7FF, #B794FF)' }}
                          >
                            {initials}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-[12.5px] font-medium truncate" style={{ color: 'var(--gf-text)' }}>{tech}</div>
                            <div className="text-[10.5px] truncate" style={{ color: 'var(--gf-text-faint)' }}>{task}</div>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-[10px] gf-mono" style={{ color: 'var(--gf-text-faint)' }}>
                            {formatTimestamp(session.started_at)}
                          </div>
                          <div className="text-[9px] gf-mono" style={{ color: 'var(--mint)' }}>● running</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {otherSessions.length > 0 && (
              <section
                className="rounded-2xl border hairline overflow-hidden"
                style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
              >
                <header
                  className="flex items-center justify-between px-5 py-3 border-b hairline"
                  style={{ borderBottomColor: 'var(--gf-line)' }}
                >
                  <h3 className="text-[13px] font-semibold" style={{ color: 'var(--gf-text)' }}>
                    Recent sessions
                  </h3>
                  <span className="text-[10px] gf-mono" style={{ color: 'var(--gf-text-faint)' }}>
                    {otherSessions.length} item{otherSessions.length === 1 ? '' : 's'}
                  </span>
                </header>
                <div>
                  {otherSessions.map((session) => {
                    const sc = getStatusConfig(session.status);
                    return (
                      <div
                        key={session.id}
                        onClick={() => handleSessionClick(session)}
                        className="px-5 py-3 border-b hairline last:border-b-0 flex items-center gap-3 cursor-pointer transition"
                        style={{ borderBottomColor: 'var(--gf-line)' }}
                      >
                        <div
                          className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                          style={{ background: 'rgba(255,255,255,0.04)' }}
                        >
                          <sc.icon className="h-4 w-4" strokeWidth={1.5} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[12.5px] font-medium truncate" style={{ color: 'var(--gf-text)' }}>
                              {session.devices?.name || session.device_name || 'Unknown device'}
                            </span>
                            <span className={`gf-badge ${session.status === 'completed' ? 'gf-badge-ok' : session.status === 'paused' ? 'gf-badge-warn' : 'gf-badge-idle'}`}>
                              {sc.label}
                            </span>
                          </div>
                          <div className="flex items-center gap-3 mt-0.5 text-[10.5px] gf-mono" style={{ color: 'var(--gf-text-faint)' }}>
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" strokeWidth={1.5} />
                              {formatTimestamp(session.started_at)}
                            </span>
                            {session.devices?.device_id && <span>{session.devices.device_id}</span>}
                          </div>
                        </div>
                        <ChevronRight className="h-4 w-4 shrink-0" style={{ color: 'var(--gf-text-faint)' }} strokeWidth={1.5} />
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
