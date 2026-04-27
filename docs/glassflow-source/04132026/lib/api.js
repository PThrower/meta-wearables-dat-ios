import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || '';
const API_BASE = BACKEND_URL ? `${BACKEND_URL}/api` : '/api';
const TOKEN_STORAGE_KEY = 'glassflow_access_token';

// Supabase client for direct DB access (streaming, feeds, analytics)
const SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.REACT_APP_SUPABASE_ANON_KEY || '';
export const supabase = SUPABASE_URL && SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
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

// Agent endpoints
export const getAgents = async () => {
  const response = await api.get('/agents');
  return response.data;
};

export const getAgent = async (agentId) => {
  const response = await api.get(`/agents/${agentId}`);
  return response.data;
};

export const toggleAgent = async (agentId) => {
  const response = await api.post(`/agents/${agentId}/toggle`);
  return response.data;
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

export const getFeeds = async (params = {}) => {
  if (supabase) {
    // Build a set of allowed room names from the user's sessions (admin sees all)
    const ADMIN_EMAIL = 'gnikhil335@gmail.com';
    let allowedRooms = null;
    if (params.creator_identity && params.creator_identity !== ADMIN_EMAIL) {
      const { data: sessions } = await supabase
        .from('stream_sessions')
        .select('livekit_room_name')
        .eq('creator_identity', params.creator_identity);
      allowedRooms = new Set((sessions || []).map(s => s.livekit_room_name).filter(Boolean));
    }

    const prefixes = ['sessions', 'dotred'];
    const allFiles = [];
    for (const prefix of prefixes) {
      const { data: files, error } = await supabase.storage
        .from('recordings')
        .list(prefix, { limit: 100, sortBy: { column: 'created_at', order: 'desc' } });
      if (error || !files) continue;

      for (const f of files) {
        if (!f.name.endsWith('.mp4')) continue;
        const roomName = extractRoomName(f.name);
        if (params.room && roomName !== params.room) continue;
        // Skip recordings from sessions the user doesn't own
        if (allowedRooms && !allowedRooms.has(roomName)) continue;

        const sizeBytes = f.metadata?.size || f.metadata?.contentLength || 0;

        allFiles.push({
          id: f.name,
          file_key: `${prefix}/${f.name}`,
          file_name: f.name,
          size_bytes: sizeBytes,
          last_modified: f.metadata?.lastModified || f.updated_at || f.created_at,
          room_name: roomName,
          egress_id: f.name.replace('.mp4', ''),
          duration_ms: null,
        });
      }
    }
    allFiles.sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));
    return allFiles;
  }
  const response = await api.get('/feeds', { params });
  return response.data;
};

export const getFeed = async (feedId) => {
  if (supabase) {
    const prefixes = ['sessions', 'dotred'];
    for (const prefix of prefixes) {
      const key = `${prefix}/${feedId}`;
      const { data, error } = await supabase.storage
        .from('recordings')
        .createSignedUrl(key, 3600);
      if (!error && data?.signedUrl) {
        // Get file metadata for size
        const { data: files } = await supabase.storage
          .from('recordings')
          .list(prefix, { search: feedId });
        const fileMeta = files?.find(f => f.name === feedId);
        const sizeBytes = fileMeta?.metadata?.size || fileMeta?.metadata?.contentLength || 0;

        return {
          id: feedId,
          file_key: key,
          file_name: feedId,
          room_name: extractRoomName(feedId),
          egress_id: feedId.replace('.mp4', ''),
          playback_url: data.signedUrl,
          size_bytes: sizeBytes,
          duration_ms: null,
          last_modified: fileMeta?.metadata?.lastModified || fileMeta?.updated_at || null,
        };
      }
    }
    throw new Error('Recording not found');
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
