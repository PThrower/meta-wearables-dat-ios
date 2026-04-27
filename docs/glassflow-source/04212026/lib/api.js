import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import { getClerkSupabaseToken } from './clerkSupabaseBridge';

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || '';
const API_BASE = BACKEND_URL ? `${BACKEND_URL}/api` : '/api';
const TOKEN_STORAGE_KEY = 'glassflow_access_token';

// Supabase client for direct DB access (streaming, feeds, analytics).
// `accessToken` is called on every request. While signed in it returns
// the Clerk-minted Supabase JWT (role=authenticated); signed out it
// returns null and the request runs as anon. RLS enforces the rest.
const SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.REACT_APP_SUPABASE_ANON_KEY || '';
export const supabase = SUPABASE_URL && SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      accessToken: getClerkSupabaseToken,
    })
  : null;

export const api = axios.create({
  baseURL: API_BASE,
  headers: {
    'Content-Type': 'application/json',
  },
});

export const getAuthToken = () => {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
};

export const setAuthToken = (token) => {
  if (token) {
    try {
      localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } catch {
      // no-op
    }
    api.defaults.headers.common.Authorization = `Bearer ${token}`;
  } else {
    try {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      // no-op
    }
    delete api.defaults.headers.common.Authorization;
  }
};

const bootstrapToken = getAuthToken();
if (bootstrapToken) {
  api.defaults.headers.common.Authorization = `Bearer ${bootstrapToken}`;
}

// Auth
export const loginDashboard = async (username, password) => {
  const response = await api.post('/auth/login', { username, password });
  return response.data;
};

export const getCurrentUser = async () => {
  const response = await api.get('/auth/me');
  return response.data;
};

// Device auth/bootstrap
export const registerDevice = async (payload) => {
  const response = await api.post('/auth/device/register', payload);
  return response.data;
};

export const issueDeviceToken = async (deviceId, deviceSecret) => {
  const response = await api.post('/auth/device/token', {
    device_id: deviceId,
    device_secret: deviceSecret,
  });
  return response.data;
};

// Media ingestion
export const createUploadUrl = async (payload) => {
  const response = await api.post('/media/upload-url', payload);
  return response.data;
};

export const completeUpload = async (payload) => {
  const response = await api.post('/media/complete', payload);
  return response.data;
};

export const listMedia = async (params = {}) => {
  const response = await api.get('/media', { params });
  return response.data;
};

export const getMedia = async (assetId) => {
  const response = await api.get(`/media/${assetId}`);
  return response.data;
};

export const getMediaTranscript = async (assetId) => {
  const response = await api.get(`/media/${assetId}/transcript`);
  return response.data;
};

export const getMediaAnalytics = async (assetId) => {
  const response = await api.get(`/media/${assetId}/analytics`);
  return response.data;
};

export const reprocessMedia = async (assetId) => {
  const response = await api.post(`/media/${assetId}/reprocess`);
  return response.data;
};

// Device endpoints
export const getDevices = async (params = {}) => {
  const response = await api.get('/devices', { params });
  return response.data;
};

export const getDevice = async (deviceId) => {
  const response = await api.get(`/devices/${deviceId}`);
  return response.data;
};

export const getDeviceVideos = async (deviceId) => {
  const response = await api.get(`/devices/${deviceId}/videos`);
  return response.data;
};

export const getDevicesSummary = async () => {
  const response = await api.get('/devices/stats/summary');
  return response.data;
};

export const postDeviceHeartbeat = async (deviceId, payload) => {
  const response = await api.post(`/devices/${deviceId}/heartbeat`, payload);
  return response.data;
};

// Video endpoints
export const getVideos = async (params = {}) => {
  const response = await api.get('/videos', { params });
  return response.data;
};

export const getVideo = async (videoId) => {
  const response = await api.get(`/videos/${videoId}`);
  return response.data;
};

export const getVideosGroupedByDate = async (deviceId = null) => {
  const params = deviceId ? { device_id: deviceId } : {};
  const response = await api.get('/videos/by-date/grouped', { params });
  return response.data;
};

export const getVideosGroupedByDevice = async () => {
  const response = await api.get('/videos/by-device/grouped');
  return response.data;
};

// Workflow endpoints
export const getWorkflows = async () => {
  const response = await api.get('/workflows');
  return response.data;
};

export const getWorkflow = async (workflowId) => {
  const response = await api.get(`/workflows/${workflowId}`);
  return response.data;
};

export const createWorkflow = async (workflow) => {
  const response = await api.post('/workflows', workflow);
  return response.data;
};

export const updateWorkflow = async (workflowId, workflow) => {
  const response = await api.put(`/workflows/${workflowId}`, workflow);
  return response.data;
};

export const deleteWorkflow = async (workflowId) => {
  const response = await api.delete(`/workflows/${workflowId}`);
  return response.data;
};

export const runWorkflow = async (workflowId) => {
  const response = await api.post(`/workflows/${workflowId}/run`);
  return response.data;
};

export const executeWorkflow = async (workflowId, assetId) => {
  const response = await api.post(`/workflows/${workflowId}/execute`, { asset_id: assetId });
  return response.data;
};

export const getNodeTypes = async () => {
  const response = await api.get('/workflows/node-types/all');
  return response.data;
};

// Transcription endpoints
export const getTranscription = async (videoId) => {
  const response = await api.get(`/transcriptions/${videoId}`);
  return response.data;
};

// Insights endpoints
export const getInsight = async (videoId) => {
  const response = await api.get(`/insights/${videoId}`);
  return response.data;
};

export const getInsightsSummary = async () => {
  const response = await api.get('/insights/summary/all');
  return response.data;
};

// Agent endpoints — Supabase-backed so the dashboard can fully
// configure agents without going through the FastAPI backend.
const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001';

export const getAgents = async () => {
  if (supabase) {
    const { data, error } = await supabase
      .from('agents')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }
  const response = await api.get('/agents');
  return response.data;
};

export const getAgent = async (agentId) => {
  if (supabase) {
    const { data, error } = await supabase
      .from('agents')
      .select('*')
      .eq('id', agentId)
      .single();
    if (error) throw error;
    return data;
  }
  const response = await api.get(`/agents/${agentId}`);
  return response.data;
};

export const createAgent = async (agent = {}) => {
  if (!supabase) throw new Error('Supabase not configured');
  const payload = {
    org_id: DEFAULT_ORG_ID,
    name: agent.name || 'New agent',
    description: agent.description || '',
    avatar_emoji: agent.avatar_emoji || null,
    model: agent.model || 'gemini-2.5-flash-native-audio-preview-12-2025',
    temperature: agent.temperature ?? 0.7,
    voice: agent.voice || 'Aoede',
    language: agent.language || 'en-US',
    system_prompt: agent.system_prompt || '',
    tools: agent.tools || [],
    skill_ids: agent.skill_ids || [],
    max_response_seconds: agent.max_response_seconds ?? 15,
    response_style: agent.response_style || 'concise',
    interrupt_on_user: agent.interrupt_on_user ?? true,
    auto_pause_on_anomaly: agent.auto_pause_on_anomaly ?? true,
    status: agent.status || 'draft',
  };
  const { data, error } = await supabase.from('agents').insert(payload).select().single();
  if (error) throw error;
  return data;
};

export const updateAgent = async (agentId, updates) => {
  if (!supabase) throw new Error('Supabase not configured');
  const { data, error } = await supabase
    .from('agents')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', agentId)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const deleteAgent = async (agentId) => {
  if (!supabase) throw new Error('Supabase not configured');
  const { error } = await supabase.from('agents').delete().eq('id', agentId);
  if (error) throw error;
};

export const duplicateAgent = async (agentId) => {
  const source = await getAgent(agentId);
  if (!source) throw new Error('Agent not found');
  const { id, created_at, updated_at, ...fields } = source;
  return createAgent({ ...fields, name: `${fields.name} (copy)`, status: 'draft' });
};

export const toggleAgent = async (agentId) => {
  if (supabase) {
    const agent = await getAgent(agentId);
    const nextStatus = (agent?.status === 'deployed') ? 'paused' : 'deployed';
    const updated = await updateAgent(agentId, { status: nextStatus });
    return { status: updated.status, message: `${updated.name} is now ${updated.status}` };
  }
  const response = await api.post(`/agents/${agentId}/toggle`);
  return response.data;
};

// Knowledge base endpoints — reusable reference docs agents attach
export const getKnowledgeBases = async () => {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('knowledge_bases')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
};

export const getKnowledgeBase = async (id) => {
  if (!supabase) throw new Error('Supabase not configured');
  const { data, error } = await supabase
    .from('knowledge_bases').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
};

export const createKnowledgeBase = async (kb = {}) => {
  if (!supabase) throw new Error('Supabase not configured');
  const payload = {
    org_id: DEFAULT_ORG_ID,
    name: kb.name || 'Untitled document',
    description: kb.description || '',
    source_url: kb.source_url || null,
    content: kb.content || '',
    tags: kb.tags || [],
  };
  const { data, error } = await supabase
    .from('knowledge_bases').insert(payload).select().single();
  if (error) throw error;
  return data;
};

export const updateKnowledgeBase = async (id, updates) => {
  if (!supabase) throw new Error('Supabase not configured');
  const { data, error } = await supabase
    .from('knowledge_bases')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id).select().single();
  if (error) throw error;
  return data;
};

export const deleteKnowledgeBase = async (id) => {
  if (!supabase) throw new Error('Supabase not configured');
  const { error } = await supabase.from('knowledge_bases').delete().eq('id', id);
  if (error) throw error;
};

// Processing endpoints
export const processVideos = async (videoIds) => {
  const response = await api.post('/process/videos', { video_ids: videoIds });
  return response.data;
};

// Report endpoints
export const generateReport = async (params = {}) => {
  const response = await api.post('/reports/generate', params);
  return response.data;
};

// Stats endpoints
export const getStats = async () => {
  const response = await api.get('/stats');
  return response.data;
};

export const getDailyStats = async () => {
  const response = await api.get('/stats/daily');
  return response.data;
};

// Legacy compatibility wrappers
export const getTimeline = async (params = {}) => getVideos(params);

export const getDailySummaries = async () => getDailyStats();

export const getDaySummary = async (day) => {
  const response = await api.get(`/day-summary/${day}`);
  return response.data;
};

export const generateDaySummary = async (day) => {
  const response = await api.post(`/day-summary/${day}/generate`);
  return response.data;
};

export const getHealthSummary = async (date) => {
  const response = await api.get('/health-summary', { params: { date } });
  return response.data;
};

export const getHealthLog = async (limit = 10) => {
  const response = await api.get('/health-log', { params: { limit } });
  return response.data;
};

export const getImageDetail = async (imageId) => getVideo(imageId);

export const askQuestion = async (question) => {
  const response = await api.post('/ask-life', { question });
  const payload = response.data || {};
  return {
    answer: payload.answer || '',
    referenced_images: payload.referenced_images || payload.referencedImages || [],
    question: payload.question || question,
  };
};

export const getAllTags = async () => {
  const summary = await getInsightsSummary();
  return (summary.top_topics || []).map(([topic]) => topic);
};

export const processImage = async (assetId) => reprocessMedia(assetId);

// Streaming session endpoints — Supabase direct with backend fallback
export const getStreamSessions = async (params = {}) => {
  if (supabase) {
    let query = supabase.from('stream_sessions').select('*, devices(id, name, model, device_id)').order('created_at', { ascending: false });
    if (params.status) query = query.eq('status', params.status);
    if (params.limit) query = query.limit(params.limit);
    // Auth filter: admin sees all, others see own + unclaimed sessions
    const ADMIN_EMAIL = 'gnikhil335@gmail.com';
    if (params.creator_identity && params.creator_identity !== ADMIN_EMAIL) {
      query = query.or(`creator_identity.eq.${params.creator_identity},creator_identity.is.null`);
    }
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }
  const response = await api.get('/stream/sessions', { params });
  return response.data;
};

export const getStreamSession = async (sessionId) => {
  if (supabase) {
    const { data, error } = await supabase
      .from('stream_sessions')
      .select('*')
      .eq('id', sessionId)
      .single();
    if (error) throw error;
    return data;
  }
  const response = await api.get(`/stream/sessions/${sessionId}`);
  return response.data;
};

export const getStreamPlayback = async (sessionId) => {
  if (supabase) {
    const { data, error } = await supabase
      .from('stream_sessions')
      .select('*, media_assets(*)')
      .eq('id', sessionId)
      .single();
    if (error) throw error;
    return data;
  }
  const response = await api.get(`/stream/sessions/${sessionId}/playback`);
  return response.data;
};

export const getStreamJoinToken = async (sessionId, viewerEmail) => {
  if (supabase) {
    const { data, error } = await supabase.functions.invoke('livekit-join-token', {
      body: { session_id: sessionId, viewer_email: viewerEmail },
    });
    if (error) throw error;
    return data;
  }
  const response = await api.post(`/stream/sessions/${sessionId}/join-token`);
  return response.data;
};

// Feed endpoints — Supabase Storage with backend fallback
const extractRoomName = (filename) => {
  // "sbx-2ywlxt-EwWBJqXV9V3KK8K5ZDAX2K-2026-03-21T181342.mp4" → room name is everything before the date
  const noExt = filename.replace(/\.mp4$/, '');
  const match = noExt.match(/^(.+)-\d{4}-\d{2}-\d{2}T/);
  return match ? match[1] : noExt;
};

// Fallback: list recordings directly from storage (for recordings that predate media_assets population).
// allowedRoomNames = string[] to filter by (null = no filter, [] = filter out all).
const getFeeds_storageListFallback = async (params = {}, allowedRoomNames = null) => {
  if (!supabase) return [];
  const { data: files, error } = await supabase.storage.from('recordings').list('sessions', {
    limit: 200,
    sortBy: { column: 'created_at', order: 'desc' },
  });
  if (error || !files) return [];

  let results = files
    .filter(f => f.name?.endsWith('.mp4'))
    .map(f => {
      const roomName = extractRoomName(f.name);
      const objectPath = `sessions/${f.name}`;
      return {
        id: objectPath,  // path-based id so getFeed() can look up by object_path
        file_key: objectPath,
        file_name: f.name,
        size_bytes: f.metadata?.size || 0,
        last_modified: f.updated_at || f.created_at,
        room_name: roomName,
        egress_id: '',
        duration_ms: null,
        status: 'completed',
        device_id: null,
      };
    });

  // Filter by allowed room names if we have them
  if (allowedRoomNames !== null && allowedRoomNames.length > 0) {
    results = results.filter(f => allowedRoomNames.includes(f.room_name));
  }

  if (params.room) {
    results = results.filter(f => f.room_name === params.room);
  }

  return results;
};

export const getFeeds = async (params = {}) => {
  if (supabase) {
    // Fetch the creator's allowed room names from stream_sessions.
    // Only filter if we actually get room names back — if stream_sessions is
    // empty (historical data), fall through and show all livekit_egress assets.
    let allowedRoomNames = null;
    if (params.creator_identity) {
      const { data: sessions } = await supabase
        .from('stream_sessions')
        .select('livekit_room_name')
        .eq('creator_identity', params.creator_identity);
      const names = (sessions || []).map(s => s.livekit_room_name).filter(Boolean);
      if (names.length > 0) allowedRoomNames = names;
    }

    let query = supabase
      .from('media_assets')
      .select('id, object_path, file_size_bytes, duration_ms, created_at, source_metadata, device_id, status')
      .eq('bucket', 'recordings')
      .eq('source', 'livekit_egress')
      .order('created_at', { ascending: false })
      .limit(100);

    if (params.room) {
      query = query.filter('source_metadata->>room_name', 'eq', params.room);
    }

    const { data, error } = await query;
    if (error) throw error;

    let assets = data || [];

    // Supabase JS .in() doesn't support JSONB arrow operators — filter in JS.
    if (allowedRoomNames !== null) {
      assets = assets.filter(asset =>
        allowedRoomNames.includes(asset.source_metadata?.room_name)
      );
    }

    // If media_assets has no results (recordings predate webhook population),
    // fall back to storage listing with JS-side creator_identity filtering.
    if (assets.length === 0) {
      return getFeeds_storageListFallback(params, allowedRoomNames);
    }

    return assets.map(asset => ({
      id: asset.id,
      file_key: asset.object_path,
      file_name: asset.object_path?.split('/').pop() || asset.id,
      size_bytes: asset.file_size_bytes || 0,
      last_modified: asset.created_at,
      room_name: asset.source_metadata?.room_name || extractRoomName(asset.object_path?.split('/').pop() || ''),
      egress_id: asset.source_metadata?.egress_id || '',
      duration_ms: asset.duration_ms,
      status: asset.status,
      device_id: asset.device_id,
    }));
  }
  const response = await api.get('/feeds', { params });
  return response.data;
};

export const getFeed = async (feedId) => {
  if (supabase) {
    // Verify ownership via media_assets (RLS ensures only org-owned assets are returned).
    // feedId can be a UUID (media_assets.id) or an object_path (from storage fallback).
    const isPath = feedId.includes('/');
    const assetQuery = supabase
      .from('media_assets')
      .select('id, object_path, file_size_bytes, duration_ms, created_at, source_metadata')
      .eq('bucket', 'recordings')
      .eq(isPath ? 'object_path' : 'id', feedId)
      .single();

    const { data: asset, error: assetErr } = await assetQuery;

    if (assetErr || !asset) throw new Error('Recording not found or access denied');

    const objectPath = asset.object_path;
    const { data: urlData, error: urlErr } = await supabase.storage
      .from('recordings')
      .createSignedUrl(objectPath, 900); // 15 min — short-lived, org ownership verified above

    if (urlErr || !urlData?.signedUrl) throw new Error('Could not generate playback URL');

    return {
      id: asset.id,
      file_key: objectPath,
      file_name: objectPath?.split('/').pop() || feedId,
      room_name: asset.source_metadata?.room_name || extractRoomName(objectPath?.split('/').pop() || ''),
      egress_id: asset.source_metadata?.egress_id || '',
      playback_url: urlData.signedUrl,
      size_bytes: asset.file_size_bytes || 0,
      duration_ms: asset.duration_ms,
      last_modified: asset.created_at,
    };
  }
  const response = await api.get(`/feeds/${feedId}`);
  return response.data;
};

export const getFeedRooms = async (creatorIdentity) => {
  if (supabase) {
    const feeds = await getFeeds({ creator_identity: creatorIdentity });
    return [...new Set(feeds.map(f => f.room_name).filter(Boolean))];
  }
  const response = await api.get('/feeds/rooms');
  return response.data;
};

// Skills endpoints
export const getSkills = async (params = {}) => {
  if (supabase) {
    let query = supabase.from('skills').select('*').order('created_at', { ascending: false });
    if (params.creator_identity) {
      query = query.eq('creator_identity', params.creator_identity);
    }
    if (params.extraction_status) {
      query = query.eq('extraction_status', params.extraction_status);
    }
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }
  return [];
};

export const getSkill = async (id) => {
  if (supabase) {
    const { data, error } = await supabase.from('skills').select('*').eq('id', id).single();
    if (error) throw error;
    return data;
  }
  return null;
};

export const updateSkill = async (id, updates) => {
  if (supabase) {
    const { data, error } = await supabase.from('skills').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }
  return null;
};

export const deleteSkill = async (id) => {
  if (supabase) {
    const { error } = await supabase.from('skills').delete().eq('id', id);
    if (error) throw error;
  }
};

export const triggerSkillExtraction = async ({ bucket, objectPath, customPrompt, creatorIdentity, sessionId, mediaAssetId }) => {
  if (supabase) {
    const { data, error } = await supabase.functions.invoke('extract-skill', {
      body: {
        bucket: bucket || 'recordings',
        object_path: objectPath,
        custom_prompt: customPrompt,
        creator_identity: creatorIdentity,
        session_id: sessionId,
        media_asset_id: mediaAssetId,
      },
    });
    if (error) throw error;
    return data;
  }
  throw new Error('Supabase not configured');
};

// Analytics endpoints
export const getAnalyticsOverview = async () => {
  const response = await api.get('/analytics/overview');
  return response.data;
};

export const getAnalyticsWorkers = async () => {
  const response = await api.get('/analytics/workers');
  return response.data;
};

export const getAnalyticsSessionsOverTime = async (days = 30) => {
  const response = await api.get('/analytics/sessions-over-time', { params: { days } });
  return response.data;
};

export const getAnalyticsTopics = async () => {
  const response = await api.get('/analytics/topics');
  return response.data;
};

export const getAnalyticsCompliance = async () => {
  const response = await api.get('/analytics/compliance');
  return response.data;
};
