import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Play, Zap, Eye, Brain, RefreshCw, Check, ArrowRight, Download, Search,
  CheckCircle2, TrendingUp, Bot, MessageSquare, BarChart3,
  Loader2, List, Grid3X3,
  Activity, Shield, AlertTriangle, Radio, Users,
  Glasses, Phone, Wrench, Video, Clock, FileText, Calendar
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { HexDonut } from '@/components/ui/hex-donut';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { useAuth } from '@/context/AuthContext';
import {
  getVideos, getVideosGroupedByDate, getStats, getInsightsSummary,
  getAgents, toggleAgent, processVideos, generateReport, getTranscription, getInsight,
  getStreamSessions, supabase
} from '@/lib/api';
import {
  DEMO_AGENTS,
  DEMO_INSIGHTS_SUMMARY,
  DEMO_STATS,
  DEMO_VIDEO_DETAILS,
  DEMO_VIDEO_GROUPS,
  DEMO_ACTIVE_SESSIONS,
  DEMO_GUIDANCE_EVENTS,
  DEMO_REPORTS,
  isDemoVideoId,
} from '@/lib/demoData';

const toStreamFormat = (demoSession) => ({
  id: demoSession.id,
  device_name: demoSession.device_name,
  status: 'active',
  started_at: demoSession.started_at,
  participant_count: 1,
  metadata_json: {
    technician: demoSession.worker,
    job_type: demoSession.task,
  },
});

const toArray = (value) => {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.results)) return value.results;
  return [];
};

const normalizeVideoGroups = (value) => {
  const raw = toArray(value);
  if (raw.length === 0) return [];

  const looksGrouped = raw.some((item) => Array.isArray(item?.videos));
  if (looksGrouped) {
    return raw.map((group) => ({
      date: group?.date || group?.day || '',
      count: typeof group?.count === 'number' ? group.count : toArray(group?.videos).length,
      videos: toArray(group?.videos),
    }));
  }

  const looksFlatVideos = raw.some((item) => item?.recorded_at || item?.day);
  if (looksFlatVideos) {
    const byDay = new Map();
    raw.forEach((video) => {
      const day = video?.day || String(video?.recorded_at || '').slice(0, 10);
      if (!day) return;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(video);
    });
    return Array.from(byDay.entries())
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([date, videos]) => ({ date, count: videos.length, videos }));
  }

  return [];
};

export default function HomePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [stats, setStats] = useState(null);
  const [videoGroups, setVideoGroups] = useState([]);
  const [allVideos, setAllVideos] = useState([]);
  const [insightsSummary, setInsightsSummary] = useState(null);
  const [agents, setAgents] = useState([]);
  const [activeSessions, setActiveSessions] = useState([]);
  const [guidanceEvents, setGuidanceEvents] = useState(DEMO_GUIDANCE_EVENTS);
  const [loading, setLoading] = useState(true);
  const [selectedVideos, setSelectedVideos] = useState([]);
  const [videoDetailOpen, setVideoDetailOpen] = useState(false);
  const [selectedVideo, setSelectedVideo] = useState(null);
  const [videoDetail, setVideoDetail] = useState({ transcription: null, insight: null });
  const [reportOpen, setReportOpen] = useState(false);
  const [report, setReport] = useState(null);
  const [reportPeriod, setReportPeriod] = useState('weekly');
  const [generatingReport, setGeneratingReport] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [viewMode, setViewMode] = useState('list');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState('all');

  const fetchActiveSessions = useCallback(async () => {
    try {
      const data = await getStreamSessions({ status: 'active', creator_identity: user?.email });
      const sessions = Array.isArray(data) ? data : (data?.items || data?.data || []);
      if (sessions.length > 0) {
        setActiveSessions(sessions);
      } else if (!supabase) {
        setActiveSessions(DEMO_ACTIVE_SESSIONS.map(toStreamFormat));
      } else {
        setActiveSessions([]);
      }
    } catch {
      if (!supabase) {
        setActiveSessions(DEMO_ACTIVE_SESSIONS.map(toStreamFormat));
      } else {
        setActiveSessions([]);
      }
    }
  }, [user?.email]);

  useEffect(() => {
    fetchDashboardData();
    fetchActiveSessions();
    const interval = setInterval(fetchActiveSessions, 10000);
    return () => clearInterval(interval);
  }, [fetchActiveSessions]);

  const fetchDashboardData = async () => {
    setLoading(true);
    try {
      const [statsData, groupedVideos, insights, agentsData] = await Promise.all([
        getStats(),
        getVideosGroupedByDate(),
        getInsightsSummary().catch(() => null),
        getAgents().catch(() => [])
      ]);
      let normalizedGroups = normalizeVideoGroups(groupedVideos);
      let normalizedAgents = toArray(agentsData);
      let normalizedStats = statsData && typeof statsData === 'object' ? statsData : {};
      let normalizedInsights = insights && typeof insights === 'object' ? insights : null;

      const shouldUseDemo = normalizedGroups.length === 0;
      if (shouldUseDemo) {
        normalizedGroups = DEMO_VIDEO_GROUPS;
        if (!normalizedStats?.total_videos) normalizedStats = DEMO_STATS;
        if (!normalizedInsights) normalizedInsights = DEMO_INSIGHTS_SUMMARY;
        if (normalizedAgents.length === 0) normalizedAgents = DEMO_AGENTS;
      }

      setStats(normalizedStats || {});
      setVideoGroups(normalizedGroups);
      setInsightsSummary(normalizedInsights || null);
      setAgents(normalizedAgents);

      const flatVideos = normalizedGroups.flatMap((group) => group.videos);
      setAllVideos(flatVideos);
    } catch (error) {
      console.error('Error fetching dashboard data:', error);
      setStats(DEMO_STATS);
      setVideoGroups(DEMO_VIDEO_GROUPS);
      setInsightsSummary(DEMO_INSIGHTS_SUMMARY);
      setAgents(DEMO_AGENTS);
      setAllVideos(DEMO_VIDEO_GROUPS.flatMap((group) => group.videos));
      toast.info('Showing demo dashboard data');
    } finally {
      setLoading(false);
    }
  };

  const handleVideoSelect = (videoId) => {
    setSelectedVideos(prev =>
      prev.includes(videoId)
        ? prev.filter(id => id !== videoId)
        : [...prev, videoId]
    );
  };

  const handleProcessSelected = async () => {
    if (selectedVideos.length === 0) {
      toast.error('Please select sessions to process');
      return;
    }

    const isDemoSelection = selectedVideos.every((videoId) => isDemoVideoId(videoId));
    if (isDemoSelection) {
      toast.success('Demo sessions queued for processing');
      setSelectedVideos([]);
      return;
    }

    setProcessing(true);
    try {
      const result = await processVideos(selectedVideos);
      toast.success(result.message);
      setSelectedVideos([]);
      fetchDashboardData();
    } catch (error) {
      toast.error('Failed to process sessions');
    } finally {
      setProcessing(false);
    }
  };

  const handleToggleAgent = async (agentId) => {
    try {
      const result = await toggleAgent(agentId);
      toast.success(result.message);
      setAgents(prev => prev.map(a =>
        a.id === agentId ? { ...a, status: result.status } : a
      ));
    } catch (error) {
      toast.error('Failed to toggle agent');
    }
  };

  const handleVideoClick = async (video) => {
    setSelectedVideo(video);
    setVideoDetailOpen(true);
    setVideoDetail({ transcription: null, insight: null });

    if (isDemoVideoId(video.id)) {
      const demoDetail = DEMO_VIDEO_DETAILS[video.id];
      if (demoDetail) {
        setVideoDetail(demoDetail);
        return;
      }
    }

    try {
      const [transcription, insight] = await Promise.all([
        getTranscription(video.id).catch(() => null),
        getInsight(video.id).catch(() => null)
      ]);
      setVideoDetail({
        transcription: transcription || { text: 'No session log available yet.' },
        insight: insight || null,
      });
    } catch (error) {
      console.error('Error fetching session details:', error);
      setVideoDetail({
        transcription: { text: 'Unable to load session log right now.' },
        insight: null,
      });
    }
  };

  const handleGenerateReport = async (period = 'weekly') => {
    setGeneratingReport(true);
    setReportPeriod(period);
    try {
      const reportData = await generateReport({ period });
      setReport(reportData);
      setReportOpen(true);
    } catch (error) {
      setReport(DEMO_REPORTS[period] || DEMO_REPORTS.weekly);
      setReportOpen(true);
      toast.info('Showing demo report data');
    } finally {
      setGeneratingReport(false);
    }
  };

  const handleExportData = () => {
    const data = {
      exported_at: new Date().toISOString(),
      sessions: allVideos,
      stats,
      insights: insightsSummary,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'glassflow-export.json';
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Data exported successfully');
  };

  const handleExportPDF = () => {
    if (!report) return;
    const lines = [
      'GlassFlow Guidance Report',
      '========================',
      '',
      `Sessions: ${report.summary?.total_sessions ?? report.summary?.total_videos ?? '-'}`,
      `Analyzed: ${report.summary?.analyzed ?? report.summary?.total_analyzed ?? '-'}`,
      `Workers: ${report.summary?.unique_workers ?? report.summary?.unique_participants ?? '-'}`,
      `Duration: ${report.summary?.total_duration ?? report.summary?.total_duration_minutes + 'm' ?? '-'}`,
      '',
      'Key Findings:',
      ...(report.key_findings || []).map((f, i) => `  ${i + 1}. ${f}`),
      '',
      'Recommendations:',
      ...(report.recommendations || []).map((r, i) => `  ${i + 1}. ${r}`),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'glassflow-report.txt';
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Report exported');
  };

  const formatDuration = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const formatDate = (dateStr) => {
    const date = new Date(dateStr);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };

  const formatTime = (dateStr) => {
    return new Date(dateStr).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'processed': return 'bg-[#E0FF00]/15 text-[#E0FF00] border-[#E0FF00]/30';
      case 'processing': return 'bg-amber-500/20 text-amber-400 border-amber-500/30';
      case 'pending': return 'bg-muted text-muted-foreground border-border';
      default: return 'bg-muted text-muted-foreground border-border';
    }
  };

  const getGuidanceEventIcon = (type) => {
    switch (type) {
      case 'safety_alert': return <Shield className="h-3 w-3 text-red-500" strokeWidth={1.5} />;
      case 'step_instruction': return <ArrowRight className="h-3 w-3 text-[#E0FF00]" strokeWidth={1.5} />;
      case 'error_correction': return <AlertTriangle className="h-3 w-3 text-amber-500" strokeWidth={1.5} />;
      case 'tool_id': return <Eye className="h-3 w-3 text-sky-500" strokeWidth={1.5} />;
      default: return <Zap className="h-3 w-3 text-muted-foreground" strokeWidth={1.5} />;
    }
  };

  const getGuidanceEventColor = (severity) => {
    switch (severity) {
      case 'high': return 'border-l-red-500 bg-red-500/5';
      case 'medium': return 'border-l-amber-500 bg-amber-500/5';
      default: return 'border-l-[#E0FF00]/50 bg-transparent';
    }
  };

  const getGuidanceModeColor = (mode) => {
    switch (mode) {
      case 'Active': return 'bg-[#E0FF00]/15 text-[#E0FF00] border-[#E0FF00]/30';
      case 'Standby': return 'bg-amber-500/20 text-amber-400 border-amber-500/30';
      default: return 'bg-muted text-muted-foreground border-border';
    }
  };

  // Filter sessions
  const filteredVideos = allVideos.filter(video => {
    const matchesSearch = !searchQuery ||
      (video.worker || video.participant || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      (video.task_name || video.feedback_label || '').toLowerCase().includes(searchQuery.toLowerCase());
    const matchesFilter = filterType === 'all' || video.status === filterType;
    return matchesSearch && matchesFilter;
  });

  return (
    <div className="min-h-screen bg-background text-foreground" data-testid="seeit-dashboard">
      {/* Subtle Background */}
      <div className="fixed inset-0 -z-10 pointer-events-none">
        <div className="absolute inset-0" style={{
          background: 'radial-gradient(60% 50% at 10% 5%, rgba(224,255,0,0.08) 0%, transparent 50%)'
        }} />
      </div>

      <Header />

      <main className="px-4 sm:px-6 py-5">
        {/* Top Bar Stats */}
        <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-semibold" data-testid="dashboard-title">
              <span className="text-foreground">Command</span>{' '}
              <span className="text-[#E0FF00]">Center</span>
            </h1>

            {/* Inline Stats */}
            <div className="hidden md:flex items-center gap-3 text-sm">
              <div className="flex items-center gap-1.5 px-2 py-1 clip-chamfer-sm bg-[#E0FF00]/10 border border-[#E0FF00]/20">
                <Radio className="h-3.5 w-3.5 text-[#E0FF00] animate-pulse" strokeWidth={1.5} />
                <span className="font-medium text-[#E0FF00]">{stats?.active_workers || 0}</span>
                <span className="text-[#E0FF00]/60">active workers</span>
              </div>
              <div className="flex items-center gap-1.5 px-2 py-1 clip-chamfer-sm bg-card border border-border">
                <Zap className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.5} />
                <span className="font-medium text-foreground">{stats?.guidance_events_today || 0}</span>
                <span className="text-muted-foreground">events</span>
              </div>
              <div className="flex items-center gap-1.5 px-2 py-1 clip-chamfer-sm bg-card border border-border">
                <CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.5} />
                <span className="font-medium text-foreground">{stats?.tasks_completed || 0}</span>
                <span className="text-muted-foreground">completed</span>
              </div>
              <div className="flex items-center gap-1.5 px-2 py-1 clip-chamfer-sm bg-red-500/10 border border-red-500/20">
                <Shield className="h-3.5 w-3.5 text-red-500" strokeWidth={1.5} />
                <span className="font-medium text-red-400">{stats?.safety_alerts || 0}</span>
                <span className="text-red-400/70">alerts</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              onClick={() => handleGenerateReport('daily')}
              disabled={generatingReport}
              variant="hex-outline"
              size="sm"
              className="h-8 px-3"
            >
              {generatingReport ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <BarChart3 className="h-3.5 w-3.5 mr-1.5" strokeWidth={1.5} />}
              Report
            </Button>
            <Button
              onClick={handleProcessSelected}
              disabled={selectedVideos.length === 0 || processing}
              variant="hex"
              size="sm"
              className="h-8 px-3 disabled:opacity-50"
            >
              {processing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Zap className="h-3.5 w-3.5 mr-1.5" strokeWidth={1.5} />}
              Process {selectedVideos.length > 0 && `(${selectedVideos.length})`}
            </Button>
          </div>
        </div>

        {/* Mobile Stats */}
        <div className="md:hidden grid grid-cols-4 gap-2 mb-4">
          <div className="clip-chamfer-sm border border-[#E0FF00]/20 bg-[#E0FF00]/10 p-2 text-center">
            <div className="text-lg font-semibold text-[#E0FF00]">{stats?.active_workers || 0}</div>
            <div className="text-[9px] text-[#E0FF00]/60">Active</div>
          </div>
          <div className="clip-chamfer-sm border border-border bg-card p-2 text-center">
            <div className="text-lg font-semibold text-foreground">{stats?.guidance_events_today || 0}</div>
            <div className="text-[9px] text-muted-foreground">Events</div>
          </div>
          <div className="clip-chamfer-sm border border-border bg-card p-2 text-center">
            <div className="text-lg font-semibold text-foreground">{stats?.tasks_completed || 0}</div>
            <div className="text-[9px] text-muted-foreground">Done</div>
          </div>
          <div className="clip-chamfer-sm border border-red-500/20 bg-red-500/10 p-2 text-center">
            <div className="text-lg font-semibold text-red-500">{stats?.safety_alerts || 0}</div>
            <div className="text-[9px] text-red-400/70">Alerts</div>
          </div>
        </div>

        {/* Main Content - 3 Column Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr_340px] gap-5">

          {/* Left Column - Active Sessions & AI Engine */}
          <div className="space-y-5 lg:order-1 order-2">
            {/* Active Sessions */}
            <div className="clip-chamfer bg-card border border-border overflow-hidden">
              <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Radio className="h-3.5 w-3.5 text-[#E0FF00] animate-pulse" strokeWidth={1.5} />
                  <span className="text-sm font-medium text-foreground">Active Sessions</span>
                </div>
                <Badge variant="hex-outline" className="text-[9px]">{activeSessions.length} live</Badge>
              </div>
              <div className="p-4 space-y-2">
                {activeSessions.map((session) => (
                  <div
                    key={session.id}
                    className="clip-chamfer-sm border border-border p-2.5 hover:border-[#E0FF00]/30 transition-colors cursor-pointer"
                    onClick={() => navigate(`/live?session=${session.id}`)}
                    data-testid={`active-session-${session.id}`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[11px] font-medium text-foreground truncate">
                        {session.metadata_json?.technician || session.device_name || session.device_id}
                      </span>
                      <Badge className="text-[8px] px-1.5 py-0 border bg-[#E0FF00]/15 text-[#E0FF00] border-[#E0FF00]/30">
                        <span className="h-1.5 w-1.5 rounded-full bg-[#E0FF00] animate-pulse mr-1 inline-block" />
                        Live
                      </Badge>
                    </div>
                    <div className="text-[10px] text-muted-foreground mb-1.5">
                      {session.metadata_json?.job_type || 'Live Stream'}
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-[9px] text-muted-foreground">
                        {session.participant_count > 0 && (
                          <span className="flex items-center gap-0.5">
                            <Users className="h-2.5 w-2.5" />
                            {session.participant_count}
                          </span>
                        )}
                      </div>
                      <span className="text-[9px] font-medium text-[#E0FF00] flex items-center gap-0.5">
                        Watch <ArrowRight className="h-2.5 w-2.5" />
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Operations Overview */}
            <div className="clip-chamfer bg-card border border-border overflow-hidden">
              <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Activity className="h-3.5 w-3.5 text-[#E0FF00]" strokeWidth={1.5} />
                  <span className="text-sm font-medium text-foreground">Operations Overview</span>
                </div>
                {agents.length > 0 && (
                  <div className="flex items-center gap-1.5">
                    <div className={`h-1.5 w-1.5 rounded-full ${agents[0].status === 'active' ? 'bg-[#E0FF00] animate-pulse' : 'bg-muted-foreground/30'}`} />
                    <span className="text-[9px] text-muted-foreground">{agents[0].status === 'active' ? 'AI Active' : 'AI Paused'}</span>
                    <Switch
                      checked={agents[0]?.status === 'active'}
                      onCheckedChange={() => handleToggleAgent(agents[0]?.id)}
                      className="scale-[0.6]"
                    />
                  </div>
                )}
              </div>
              <div className="p-4 space-y-3">
                {/* Key operational metrics */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="clip-chamfer-sm border border-[#E0FF00]/20 bg-[#E0FF00]/5 p-2.5">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Glasses className="h-3 w-3 text-[#E0FF00]" strokeWidth={1.5} />
                      <span className="text-[9px] text-[#E0FF00]/70">Active Glasses</span>
                    </div>
                    <div className="text-xl font-semibold text-[#E0FF00]">{stats?.active_glasses || activeSessions.length}</div>
                  </div>
                  <div className="clip-chamfer-sm border border-border bg-card p-2.5">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Users className="h-3 w-3 text-muted-foreground" strokeWidth={1.5} />
                      <span className="text-[9px] text-muted-foreground">Active Workers</span>
                    </div>
                    <div className="text-xl font-semibold text-foreground">{stats?.active_workers || 0}</div>
                  </div>
                  <div className="clip-chamfer-sm border border-border bg-card p-2.5">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Wrench className="h-3 w-3 text-muted-foreground" strokeWidth={1.5} />
                      <span className="text-[9px] text-muted-foreground">Tasks Today</span>
                    </div>
                    <div className="text-xl font-semibold text-foreground">{stats?.tasks_today || 0}</div>
                  </div>
                  <div className="clip-chamfer-sm border border-border bg-card p-2.5">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Phone className="h-3 w-3 text-muted-foreground" strokeWidth={1.5} />
                      <span className="text-[9px] text-muted-foreground">Service Calls</span>
                    </div>
                    <div className="text-xl font-semibold text-foreground">{stats?.service_calls_today || 0}</div>
                  </div>
                </div>

                {/* Data processing status */}
                <div className="pt-2 border-t border-border">
                  <div className="flex items-center gap-1.5 mb-2">
                    <Video className="h-3 w-3 text-muted-foreground" strokeWidth={1.5} />
                    <span className="text-xs text-muted-foreground">Data Processing</span>
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-foreground/70">Videos processed today</span>
                      <span className="font-medium text-[#E0FF00]">{stats?.videos_processed_today || 0}</span>
                    </div>
                    <div className="flex items-center justify-between text-[11px]">
                      <div className="flex items-center gap-1">
                        <span className="text-foreground/70">Currently processing</span>
                        {(stats?.videos_processing || 0) > 0 && (
                          <Loader2 className="h-2.5 w-2.5 text-amber-400 animate-spin" strokeWidth={2} />
                        )}
                      </div>
                      <span className="font-medium text-amber-400">{stats?.videos_processing || 0}</span>
                    </div>
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-foreground/70">Tasks completed</span>
                      <span className="font-medium text-foreground">{stats?.tasks_completed || 0} / {stats?.tasks_today || 0}</span>
                    </div>
                  </div>
                </div>

                {/* Safety & Compliance compact */}
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <div className="clip-chamfer-sm border border-red-500/20 bg-red-500/5 p-2 text-center">
                    <div className="text-lg font-semibold text-red-400">{stats?.safety_alerts || 0}</div>
                    <div className="text-[9px] text-red-400/60">Safety Alerts</div>
                  </div>
                  <div className="clip-chamfer-sm border border-border bg-card p-2 text-center">
                    <div className="text-lg font-semibold text-foreground">{stats?.guidance_compliance_pct || 94}%</div>
                    <div className="text-[9px] text-muted-foreground">Compliance</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Center Column - Session Recordings */}
          <div className="lg:order-2 order-1">
            {/* Search & Filter Bar */}
            <div className="flex gap-2 mb-3">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.5} />
                <Input
                  placeholder="Search sessions, workers, tasks..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="h-8 pl-8 text-sm bg-card border-border clip-chamfer-sm"
                />
              </div>
              <Select value={filterType} onValueChange={setFilterType}>
                <SelectTrigger className="w-[110px] h-8 text-xs bg-card border-border clip-chamfer-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="processed">Completed</SelectItem>
                  <SelectItem value="processing">Active</SelectItem>
                  <SelectItem value="pending">Reviewing</SelectItem>
                </SelectContent>
              </Select>
              <div className="flex clip-chamfer-sm border border-border bg-card overflow-hidden">
                <Button variant="ghost" size="sm" onClick={() => setViewMode('grid')} className={`h-8 w-8 p-0 rounded-none ${viewMode === 'grid' ? 'bg-[#E0FF00]/15 text-[#E0FF00]' : 'text-muted-foreground'}`}>
                  <Grid3X3 className="h-3.5 w-3.5" strokeWidth={1.5} />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setViewMode('list')} className={`h-8 w-8 p-0 rounded-none border-l border-border ${viewMode === 'list' ? 'bg-[#E0FF00]/15 text-[#E0FF00]' : 'text-muted-foreground'}`}>
                  <List className="h-3.5 w-3.5" strokeWidth={1.5} />
                </Button>
              </div>
              <Button variant="ghost" size="sm" onClick={fetchDashboardData} disabled={loading} className="h-8 w-8 p-0 border border-border clip-chamfer-sm">
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.5} />
              </Button>
            </div>

            {/* Session Count */}
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">{filteredVideos.length} sessions</span>
              </div>
              {selectedVideos.length > 0 && (
                <button onClick={() => setSelectedVideos([])} className="text-xs text-muted-foreground hover:text-foreground">
                  Clear selection ({selectedVideos.length})
                </button>
              )}
            </div>

            {/* Session Grid */}
            {loading ? (
              <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 gap-4">
                {[...Array(9)].map((_, i) => (
                  <div key={i} className="clip-chamfer-sm bg-muted animate-pulse aspect-video" />
                ))}
              </div>
            ) : filteredVideos.length > 0 ? (
              <div className={viewMode === 'grid' ? 'grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 gap-4' : 'space-y-2'}>
                {filteredVideos.map((video, index) => (
                  <motion.div
                    key={video.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.02 }}
                    className={`group relative clip-chamfer-sm overflow-hidden border-2 transition-all cursor-pointer hover:scale-[1.02] ${
                      selectedVideos.includes(video.id)
                        ? 'border-[#E0FF00] shadow-lg shadow-[#E0FF00]/20'
                        : 'border-transparent hover:border-border'
                    } ${viewMode === 'list' ? 'flex bg-card border border-border' : ''}`}
                    onClick={() => handleVideoClick(video)}
                    data-testid={`video-card-${video.id}`}
                  >
                    {viewMode === 'grid' ? (
                      <>
                        <div className="aspect-video bg-muted relative">
                          <img src={video.thumbnail_url} alt={video.filename} className="w-full h-full object-cover" />
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <Play className="h-8 w-8 text-white" strokeWidth={1.5} />
                          </div>
                          <div className={`absolute top-1.5 left-1.5 px-2.5 py-0.5 clip-parallelogram text-[9px] font-medium border ${getStatusColor(video.status)}`}>
                            {video.status === 'processed' ? 'completed' : video.status === 'processing' ? 'active' : 'reviewing'}
                          </div>
                          <div className="absolute bottom-1.5 right-1.5 px-1 py-0.5 clip-chamfer-sm bg-black/70 text-[9px] text-white/90">
                            {formatDuration(video.duration_seconds)}
                          </div>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleVideoSelect(video.id); }}
                            className={`absolute top-1.5 right-1.5 h-4 w-4 clip-hex border-2 flex items-center justify-center transition-all ${
                              selectedVideos.includes(video.id) ? 'bg-[#E0FF00] border-[#E0FF00]' : 'bg-black/50 border-white/40'
                            }`}
                          >
                            {selectedVideos.includes(video.id) && <Check className="h-2.5 w-2.5 text-white" strokeWidth={2} />}
                          </button>
                        </div>
                        <div className="p-2.5 bg-card">
                          <div className="text-sm font-medium text-foreground truncate">{video.worker || video.participant}</div>
                          <div className="flex items-center justify-between">
                            <div className="text-xs text-muted-foreground truncate flex-1">{video.task_name || video.feedback_label}</div>
                            {video.guidance_events > 0 && (
                              <span className="text-[8px] text-[#E0FF00] ml-1">{video.guidance_events} events</span>
                            )}
                          </div>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="w-32 h-20 flex-shrink-0 relative">
                          <img src={video.thumbnail_url} alt={video.filename} className="w-full h-full object-cover" />
                          <div className="absolute bottom-1 right-1 px-1 py-0.5 clip-chamfer-sm bg-black/70 text-[9px] text-white/90">
                            {formatDuration(video.duration_seconds)}
                          </div>
                        </div>
                        <div className="flex-1 p-2 flex flex-col justify-center min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-foreground truncate">{video.worker || video.participant}</span>
                            <Badge className={`text-[9px] ${getStatusColor(video.status)}`}>
                              {video.status === 'processed' ? 'completed' : video.status === 'processing' ? 'active' : 'reviewing'}
                            </Badge>
                          </div>
                          <div className="text-xs text-muted-foreground truncate">{video.task_name || video.feedback_label}</div>
                          <div className="text-[10px] text-muted-foreground mt-0.5">
                            {video.location} • {formatDate(video.recorded_at)}
                            {video.guidance_events > 0 && <span className="text-[#E0FF00] ml-1">• {video.guidance_events} events</span>}
                          </div>
                        </div>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleVideoSelect(video.id); }}
                          className={`m-2 h-5 w-5 clip-hex border-2 flex items-center justify-center transition-all flex-shrink-0 ${
                            selectedVideos.includes(video.id) ? 'bg-[#E0FF00] border-[#E0FF00]' : 'border-border hover:border-[#E0FF00]'
                          }`}
                        >
                          {selectedVideos.includes(video.id) && <Check className="h-3 w-3 text-white" strokeWidth={2} />}
                        </button>
                      </>
                    )}
                  </motion.div>
                ))}
              </div>
            ) : (
              <div className="clip-chamfer border border-border bg-card p-8 text-center">
                <Activity className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" strokeWidth={1.5} />
                <h3 className="text-sm font-medium text-foreground/80 mb-1">
                  {searchQuery ? 'No matching sessions' : 'No sessions yet'}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {searchQuery ? 'Try adjusting your filters' : 'Sessions will appear here once workers begin guided tasks'}
                </p>
              </div>
            )}
          </div>

          {/* Right Column - Guidance Feed & Performance */}
          <div className="space-y-5 lg:order-3 order-3">
            {/* Guidance Feed */}
            <div className="clip-chamfer bg-card border border-border overflow-hidden">
              <div className="px-4 py-3 border-b border-border">
                <div className="flex items-center gap-1.5">
                  <Zap className="h-3.5 w-3.5 text-[#E0FF00]" strokeWidth={1.5} />
                  <span className="text-sm font-medium text-foreground">Guidance Feed</span>
                </div>
              </div>
              <ScrollArea className="h-[320px]">
                <div className="p-2 space-y-1">
                  {guidanceEvents.map((event) => (
                    <div
                      key={event.id}
                      className={`clip-chamfer-sm border-l-2 p-2 ${getGuidanceEventColor(event.severity)}`}
                    >
                      <div className="flex items-center gap-1.5 mb-0.5">
                        {getGuidanceEventIcon(event.type)}
                        <span className="text-[10px] font-medium text-foreground">{event.worker}</span>
                        <span className="text-[8px] text-muted-foreground ml-auto">{formatTime(event.timestamp)}</span>
                      </div>
                      <p className="text-[10px] text-foreground/70 leading-snug">{event.message}</p>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>

            {/* Performance Metrics */}
            {insightsSummary && (
              <div className="clip-chamfer bg-card border border-border overflow-hidden">
                <div className="px-4 py-3 border-b border-border">
                  <div className="flex items-center gap-1.5">
                    <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.5} />
                    <span className="text-sm font-medium text-foreground">Performance Metrics</span>
                  </div>
                </div>
                <div className="p-4 space-y-3">
                  {/* Donut charts */}
                  <div className="flex items-center justify-around">
                    <HexDonut value={insightsSummary.task_completion_rate || 87} size={72} color="#00BFFF" label="Completion" />
                    <HexDonut value={insightsSummary.safety_compliance || 96} size={72} color="#00FF88" label="Safety" />
                    <HexDonut value={insightsSummary.guidance_effectiveness || 91} size={72} color="#E0FF00" label="Efficiency" />
                  </div>

                  {/* Task timing breakdown */}
                  <div className="pt-3 border-t border-border space-y-2">
                    <div className="flex items-center justify-between text-[11px]">
                      <div className="flex items-center gap-1.5">
                        <CheckCircle2 className="h-3 w-3 text-emerald-400" strokeWidth={1.5} />
                        <span className="text-foreground/70">Tasks on time</span>
                      </div>
                      <span className="font-medium text-emerald-400">{stats?.tasks_completed || 5} / {stats?.tasks_today || 12}</span>
                    </div>
                    <div className="flex items-center justify-between text-[11px]">
                      <div className="flex items-center gap-1.5">
                        <Clock className="h-3 w-3 text-amber-400" strokeWidth={1.5} />
                        <span className="text-foreground/70">Avg time saved</span>
                      </div>
                      <span className="font-medium text-[#E0FF00]">{stats?.avg_time_saved_pct || 18}%</span>
                    </div>
                    <div className="flex items-center justify-between text-[11px]">
                      <div className="flex items-center gap-1.5">
                        <AlertTriangle className="h-3 w-3 text-amber-400" strokeWidth={1.5} />
                        <span className="text-foreground/70">Delayed tasks</span>
                      </div>
                      <span className="font-medium text-amber-400">2</span>
                    </div>
                    <div className="flex items-center justify-between text-[11px]">
                      <div className="flex items-center gap-1.5">
                        <Shield className="h-3 w-3 text-red-400" strokeWidth={1.5} />
                        <span className="text-foreground/70">Safety incidents</span>
                      </div>
                      <span className="font-medium text-red-400">{stats?.safety_alerts || 0}</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Reports */}
            <div className="clip-chamfer bg-card border border-border overflow-hidden">
              <div className="px-4 py-3 border-b border-border">
                <div className="flex items-center gap-1.5">
                  <FileText className="h-3.5 w-3.5 text-[#E0FF00]" strokeWidth={1.5} />
                  <span className="text-sm font-medium text-foreground">Reports</span>
                </div>
              </div>
              <div className="p-3 space-y-1.5">
                <Button
                  onClick={() => handleGenerateReport('daily')}
                  disabled={generatingReport}
                  variant="hex"
                  size="sm"
                  className="w-full h-8 justify-start px-2 text-xs"
                >
                  {generatingReport && reportPeriod === 'daily' ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : <Calendar className="h-3.5 w-3.5 mr-2" strokeWidth={1.5} />}
                  Daily Report
                </Button>
                <Button
                  onClick={() => handleGenerateReport('weekly')}
                  disabled={generatingReport}
                  variant="hex-outline"
                  size="sm"
                  className="w-full h-8 justify-start px-2 text-xs"
                >
                  {generatingReport && reportPeriod === 'weekly' ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : <Calendar className="h-3.5 w-3.5 mr-2" strokeWidth={1.5} />}
                  Weekly Report
                </Button>
                <Button
                  onClick={() => handleGenerateReport('monthly')}
                  disabled={generatingReport}
                  variant="hex-outline"
                  size="sm"
                  className="w-full h-8 justify-start px-2 text-xs"
                >
                  {generatingReport && reportPeriod === 'monthly' ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : <Calendar className="h-3.5 w-3.5 mr-2" strokeWidth={1.5} />}
                  Monthly Report
                </Button>
                <div className="pt-1.5 border-t border-border mt-1.5">
                  <Button variant="ghost" size="sm" className="w-full h-8 justify-start px-2 text-xs text-muted-foreground" onClick={handleExportData}>
                    <Download className="h-3.5 w-3.5 mr-2" strokeWidth={1.5} />
                    Export Raw Data
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Session Detail Modal */}
      <Dialog open={videoDetailOpen} onOpenChange={setVideoDetailOpen}>
        <DialogContent className="max-w-2xl clip-chamfer-lg bg-background border-border p-0 overflow-hidden">
          {selectedVideo && (
            <div>
              <div className="relative aspect-video bg-black">
                {selectedVideo.video_url ? (
                  <video
                    src={selectedVideo.video_url}
                    poster={selectedVideo.thumbnail_url}
                    controls
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <>
                    <img src={selectedVideo.thumbnail_url} alt={selectedVideo.filename} className="w-full h-full object-cover" />
                    <div className="absolute inset-0 flex items-center justify-center">
                      <button className="h-14 w-14 clip-hex bg-white/20 backdrop-blur flex items-center justify-center hover:bg-white/30 transition-colors">
                        <Play className="h-7 w-7 text-white ml-0.5" strokeWidth={1.5} />
                      </button>
                    </div>
                  </>
                )}
                <div className={`absolute top-3 left-3 px-3 py-0.5 clip-parallelogram text-xs font-medium border ${getStatusColor(selectedVideo.status)}`}>
                  {selectedVideo.status === 'processed' ? 'completed' : selectedVideo.status === 'processing' ? 'active' : 'reviewing'}
                </div>
              </div>
              <div className="p-5">
                <DialogHeader>
                  <DialogTitle className="text-lg font-semibold text-foreground flex items-center gap-2">
                    {selectedVideo.worker || selectedVideo.participant}
                    <Badge variant="outline" className="text-xs">{selectedVideo.task_name || selectedVideo.feedback_label}</Badge>
                  </DialogTitle>
                  <DialogDescription className="text-sm text-muted-foreground">
                    {new Date(selectedVideo.recorded_at).toLocaleString()} • {selectedVideo.location} • {formatDuration(selectedVideo.duration_seconds)}
                    {selectedVideo.guidance_events > 0 && ` • ${selectedVideo.guidance_events} guidance events`}
                  </DialogDescription>
                </DialogHeader>
                <div className="mt-4 space-y-3">
                  <div className="clip-chamfer-sm border border-border bg-card p-3">
                    <div className="flex items-center gap-1.5 mb-2">
                      <MessageSquare className="h-3.5 w-3.5 text-[#E0FF00]" strokeWidth={1.5} />
                      <span className="text-xs font-medium text-foreground">Session Log</span>
                    </div>
                    {videoDetail.transcription ? (
                      <p className="text-sm text-foreground/70 leading-relaxed">{videoDetail.transcription.text}</p>
                    ) : (
                      <p className="text-sm text-muted-foreground">Loading...</p>
                    )}
                  </div>
                  <div className="clip-chamfer-sm border border-border bg-card p-3">
                    <div className="flex items-center gap-1.5 mb-2">
                      <Brain className="h-3.5 w-3.5 text-amber-500" strokeWidth={1.5} />
                      <span className="text-xs font-medium text-foreground">Guidance Summary</span>
                    </div>
                    {videoDetail.insight ? (
                      <div className="space-y-2">
                        <div className="space-y-1">
                          {videoDetail.insight.key_points?.map((point, i) => (
                            <div key={i} className="text-sm text-foreground/70 flex items-start gap-1.5">
                              <Check className="h-3 w-3 text-[#E0FF00] mt-0.5 flex-shrink-0" strokeWidth={2} />
                              {point}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">Loading...</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Report Modal */}
      <Dialog open={reportOpen} onOpenChange={setReportOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] clip-chamfer-lg bg-background border-border overflow-hidden">
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold text-foreground flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-[#E0FF00]" strokeWidth={1.5} />
              {report?.period || 'Weekly'} Report
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {report?.date_range || 'Current period'}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="h-[50vh] pr-4">
            {report && (
              <div className="space-y-4 py-2">
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                  {[
                    { label: 'Sessions', value: report.summary?.total_sessions ?? '-' },
                    { label: 'Analyzed', value: report.summary?.analyzed ?? '-' },
                    { label: 'Workers', value: report.summary?.unique_workers ?? '-' },
                    { label: 'Duration', value: report.summary?.total_duration ?? '-' },
                    { label: 'Service Calls', value: report.summary?.service_calls ?? '-' },
                    { label: 'Tasks Done', value: report.summary?.tasks_completed ?? '-' },
                    { label: 'Avg Response', value: report.summary?.avg_response_time ?? '-' },
                  ].filter(s => s.value !== '-').map((stat) => (
                    <div key={stat.label} className="clip-chamfer-sm border border-border bg-card p-2 text-center">
                      <div className="text-lg font-semibold text-foreground">{stat.value}</div>
                      <div className="text-[10px] text-muted-foreground">{stat.label}</div>
                    </div>
                  ))}
                </div>
                <div className="clip-chamfer-sm border border-border bg-card p-3">
                  <h3 className="text-xs font-medium text-foreground mb-2">Key Findings</h3>
                  <ul className="space-y-1.5">
                    {report.key_findings?.map((finding, i) => (
                      <li key={i} className="text-sm text-foreground/70 flex items-start gap-1.5">
                        <CheckCircle2 className="h-3.5 w-3.5 text-[#E0FF00] mt-0.5 flex-shrink-0" strokeWidth={1.5} />
                        {finding}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="clip-chamfer-sm border border-[#E0FF00]/20 bg-[#E0FF00]/10 p-3">
                  <h3 className="text-xs font-medium text-[#E0FF00] mb-2">Recommendations</h3>
                  <ul className="space-y-1.5">
                    {report.recommendations?.map((rec, i) => (
                      <li key={i} className="text-sm text-foreground/70 flex items-start gap-1.5">
                        <ArrowRight className="h-3.5 w-3.5 text-[#E0FF00] mt-0.5 flex-shrink-0" strokeWidth={1.5} />
                        {rec}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </ScrollArea>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="hex-outline" onClick={() => setReportOpen(false)} size="sm">Close</Button>
            <Button variant="hex" size="sm" onClick={handleExportPDF}>
              <Download className="h-3.5 w-3.5 mr-1.5" strokeWidth={1.5} />
              Export PDF
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
