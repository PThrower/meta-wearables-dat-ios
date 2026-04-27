import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  Glasses, Battery, HardDrive, Clock, MapPin, FolderOpen,
  Activity, Signal, ChevronLeft, Video, Play, Settings, Zap,
  RefreshCw, Download, Power, AlertCircle,
  Calendar, User, Cpu, Radio,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { getDevice, getDeviceVideos } from '@/lib/api';
import { toast } from 'sonner';
import { getDemoDeviceById, getDemoVideosByDeviceId, isDemoDeviceId } from '@/lib/demoData';

const STATUS_TONE = {
  online: { label: 'live', cls: 'gf-badge-active', color: 'var(--lime)' },
  syncing: { label: 'syncing', cls: 'gf-badge-idle', color: 'var(--sky)' },
  charging: { label: 'charging', cls: 'gf-badge-warn', color: 'var(--amber)' },
  offline: { label: 'offline', cls: 'gf-badge-idle', color: 'var(--gf-text-faint)' },
};

const MODE_TONE = {
  Active: 'gf-badge-active',
  Standby: 'gf-badge-warn',
};

export default function DeviceDetailPage() {
  const { deviceId } = useParams();
  const [device, setDevice] = useState(null);
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { fetchData(); }, [deviceId]);

  const fetchData = async () => {
    setLoading(true);
    if (isDemoDeviceId(deviceId)) {
      setDevice(getDemoDeviceById(deviceId));
      setVideos(getDemoVideosByDeviceId(deviceId));
      setLoading(false);
      return;
    }
    try {
      const [d, v] = await Promise.all([getDevice(deviceId), getDeviceVideos(deviceId)]);
      setDevice(d);
      setVideos(Array.isArray(v) ? v : []);
    } catch {
      toast.error('Failed to load device details');
    } finally {
      setLoading(false);
    }
  };

  const batteryColor = (level) => level > 60 ? 'var(--lime)' : level > 30 ? 'var(--amber)' : 'var(--red)';

  const formatDuration = (seconds) => {
    const m = Math.floor((seconds || 0) / 60);
    const s = (seconds || 0) % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  if (loading) {
    return (
      <div className="gf-page min-h-screen" style={{ background: 'var(--gf-bg)' }}>
        <main className="max-w-[1400px] mx-auto p-6 sm:p-8">
          <div className="animate-pulse space-y-4">
            <div className="h-8 w-64 rounded" style={{ background: 'var(--gf-surface-2)' }} />
            <div className="h-4 w-96 rounded" style={{ background: 'var(--gf-surface-2)' }} />
            <div className="grid md:grid-cols-3 gap-6 mt-6">
              <div className="md:col-span-2 rounded-2xl border hairline p-6 h-72" style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }} />
              <div className="rounded-2xl border hairline p-6 h-72" style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }} />
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (!device) {
    return (
      <div className="gf-page min-h-screen" style={{ background: 'var(--gf-bg)' }}>
        <main className="max-w-[1400px] mx-auto p-6 sm:p-8 text-center py-20">
          <AlertCircle className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--gf-text)' }}>Device not found</h2>
          <p className="text-sm mb-4" style={{ color: 'var(--gf-text-dim)' }}>The device you're looking for doesn't exist.</p>
          <Link to="/devices" className="btn-lime h-9 px-4 rounded-md text-[12.5px] font-medium inline-flex items-center gap-1.5">
            <ChevronLeft className="h-4 w-4" /> Back to Fleet
          </Link>
        </main>
      </div>
    );
  }

  const status = STATUS_TONE[device.status] || STATUS_TONE.offline;

  return (
    <div className="gf-page min-h-screen" data-testid="device-detail-page" style={{ background: 'var(--gf-bg)' }}>
      <main className="max-w-[1400px] mx-auto p-6 sm:p-8 space-y-6">
        {/* Back link */}
        <Link
          to="/devices"
          className="inline-flex items-center gap-1 text-[12px] hover:underline"
          style={{ color: 'var(--gf-text-dim)' }}
        >
          <ChevronLeft className="h-3.5 w-3.5" strokeWidth={1.5} /> Back to Fleet
        </Link>

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div className="flex items-start gap-4">
            <div
              className="h-14 w-14 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: 'var(--lime-soft)', border: '1px solid rgba(212,255,58,0.3)' }}
            >
              <Glasses className="h-7 w-7" style={{ color: 'var(--lime)' }} strokeWidth={1.5} />
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.18em] mb-1" style={{ color: 'var(--gf-text-faint)' }}>Devices</div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-[26px] font-semibold tracking-tight" style={{ color: 'var(--gf-text)' }}>{device.name}</h1>
                <span className={`gf-badge ${status.cls}`}>
                  {device.status === 'online' && <span className="live-dot" />}
                  {status.label}
                </span>
                {device.guidance_mode && device.guidance_mode !== 'Idle' && (
                  <span className={`gf-badge ${MODE_TONE[device.guidance_mode] || 'gf-badge-idle'}`}>
                    {device.guidance_mode}
                  </span>
                )}
              </div>
              <p className="text-[13px] mt-1" style={{ color: 'var(--gf-text-dim)' }}>
                {device.serial_number} · {device.model}
              </p>
              <div className="flex items-center gap-3 mt-2 flex-wrap">
                <div className="flex items-center gap-1.5 text-[12.5px]">
                  <User className="h-3.5 w-3.5" style={{ color: 'var(--lime)' }} strokeWidth={1.5} />
                  <span style={{ color: 'var(--gf-text)' }}>{device.assigned_to || 'Unassigned'}</span>
                </div>
                {device.current_task && (
                  <div className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--gf-text-dim)' }}>
                    <Zap className="h-3 w-3" style={{ color: 'var(--lime)' }} strokeWidth={1.5} />
                    <span>{device.current_task}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <button className="btn-ghost h-9 px-3 rounded-md text-[12px] flex items-center gap-1.5">
              <Settings className="h-3.5 w-3.5" strokeWidth={1.5} /> Settings
            </button>
            <button onClick={fetchData} className="btn-lime h-9 px-4 rounded-md text-[12.5px] font-medium flex items-center gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.5} /> Sync now
            </button>
          </div>
        </div>

        <div className="grid lg:grid-cols-3 gap-6">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-6">
            {/* Status Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { icon: Battery, label: 'Battery', value: `${device.battery_level || 0}%`, accent: batteryColor(device.battery_level || 0), pct: device.battery_level || 0 },
                { icon: HardDrive, label: 'Storage', value: `${device.storage_used_gb || 0}GB`, accent: 'var(--gf-text-dim)', pct: ((device.storage_used_gb || 0) / (device.storage_total_gb || 1)) * 100 },
                { icon: Signal, label: 'Signal', value: `${device.signal_strength || 0}%`, accent: 'var(--gf-text-dim)', pct: device.signal_strength || 0 },
                { icon: Activity, label: 'Latency', value: `${device.network_latency_ms || 0}ms`, accent: 'var(--gf-text-dim)', sub: `Jitter ${device.server_jitter_ms || 0}ms` },
              ].map((s) => (
                <div
                  key={s.label}
                  className="rounded-xl border hairline p-4"
                  style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
                >
                  <s.icon className="h-5 w-5 mb-2" style={{ color: s.accent }} strokeWidth={1.5} />
                  <div className="text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--gf-text-faint)' }}>{s.label}</div>
                  <div className="num text-[22px] font-medium" style={{ color: 'var(--gf-text)' }}>{s.value}</div>
                  {s.pct != null && (
                    <div className="h-1 mt-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                      <div className="h-full rounded-full" style={{ width: `${Math.min(100, s.pct)}%`, background: s.accent }} />
                    </div>
                  )}
                  {s.sub && <div className="text-[10px] mt-1.5" style={{ color: 'var(--gf-text-dim)' }}>{s.sub}</div>}
                </div>
              ))}
            </div>

            {/* Tabs */}
            <Tabs defaultValue="live" className="w-full">
              <TabsList
                className="rounded-md border hairline p-0.5"
                style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
              >
                {[
                  { v: 'live', icon: Radio, label: 'Live status' },
                  { v: 'sessions', icon: Video, label: `Sessions (${videos.length})` },
                  { v: 'performance', icon: Activity, label: 'Performance' },
                ].map((t) => (
                  <TabsTrigger
                    key={t.v}
                    value={t.v}
                    className="text-[12px] data-[state=active]:bg-[color:var(--lime-soft)] data-[state=active]:text-[color:var(--lime)]"
                  >
                    <t.icon className="h-3.5 w-3.5 mr-1.5" strokeWidth={1.5} />{t.label}
                  </TabsTrigger>
                ))}
              </TabsList>

              <TabsContent value="live" className="mt-4">
                <div
                  className="rounded-2xl border hairline p-6 space-y-4"
                  style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
                >
                  <h3 className="text-[14px] font-semibold" style={{ color: 'var(--gf-text)' }}>Live device status</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--gf-text-faint)' }}>Guidance mode</div>
                      <div className="mt-1">
                        <span className={`gf-badge ${MODE_TONE[device.guidance_mode] || 'gf-badge-idle'}`}>
                          {device.guidance_mode || 'Idle'}
                        </span>
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--gf-text-faint)' }}>Current task</div>
                      <div className="text-[13px] font-medium mt-1" style={{ color: 'var(--gf-text)' }}>{device.current_task || 'None'}</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--gf-text-faint)' }}>Guidance events today</div>
                      <div className="num text-[18px] font-semibold" style={{ color: 'var(--lime)' }}>{device.guidance_events_today || 0}</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--gf-text-faint)' }}>Worker</div>
                      <div className="text-[13px] font-medium mt-1" style={{ color: 'var(--gf-text)' }}>{device.assigned_to || '—'}</div>
                    </div>
                  </div>
                  <div className="pt-4 border-t hairline" style={{ borderTopColor: 'var(--gf-line)' }}>
                    <div className="text-[10px] uppercase tracking-[0.16em] mb-2" style={{ color: 'var(--gf-text-faint)' }}>Location</div>
                    <div className="flex items-center gap-2 text-[13px]" style={{ color: 'var(--gf-text)' }}>
                      <MapPin className="h-3.5 w-3.5" style={{ color: 'var(--lime)' }} strokeWidth={1.5} />
                      {device.last_location || '—'}
                    </div>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="sessions" className="mt-4">
                {videos.length > 0 ? (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {videos.map((video) => (
                      <div
                        key={video.id}
                        className="rounded-xl border hairline overflow-hidden cursor-pointer transition group"
                        style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
                      >
                        <div className="aspect-video relative" style={{ background: '#000' }}>
                          {video.thumbnail_url ? (
                            <img src={video.thumbnail_url} alt={video.filename} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center" style={{ color: 'var(--gf-text-faint)' }}>
                              <Video className="h-8 w-8" strokeWidth={1.5} />
                            </div>
                          )}
                          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition" style={{ background: 'rgba(0,0,0,0.4)' }}>
                            <Play className="h-8 w-8 text-white" strokeWidth={1.5} />
                          </div>
                          <div
                            className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded text-[10px] gf-mono"
                            style={{ background: 'rgba(0,0,0,0.7)', color: '#fff' }}
                          >
                            {formatDuration(video.duration_seconds)}
                          </div>
                        </div>
                        <div className="p-2.5">
                          <div className="text-[12px] font-medium truncate" style={{ color: 'var(--gf-text)' }}>
                            {video.worker || video.participant || 'Session'}
                          </div>
                          <div className="text-[10.5px] truncate" style={{ color: 'var(--gf-text-faint)' }}>
                            {video.task_name || video.feedback_label || ''}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div
                    className="rounded-xl border hairline p-8 text-center"
                    style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
                  >
                    <Video className="h-10 w-10 mx-auto mb-3 opacity-30" strokeWidth={1.5} />
                    <p className="text-sm" style={{ color: 'var(--gf-text-dim)' }}>No sessions recorded yet</p>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="performance" className="mt-4">
                <div
                  className="rounded-2xl border hairline p-6"
                  style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
                >
                  <h3 className="text-[14px] font-semibold mb-4" style={{ color: 'var(--gf-text)' }}>Device performance</h3>
                  <div className="grid grid-cols-2 gap-4">
                    {[
                      { k: 'Total session hours', v: `${device.total_recording_hours || 0}h` },
                      { k: 'Sessions recorded', v: device.video_count || 0 },
                      { k: 'Firmware version', v: `v${device.firmware_version || '—'}` },
                      { k: 'Guidance events today', v: device.guidance_events_today || 0, lime: true },
                    ].map((s) => (
                      <div key={s.k}>
                        <div className="text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--gf-text-faint)' }}>{s.k}</div>
                        <div className="num text-[18px] font-semibold mt-1" style={{ color: s.lime ? 'var(--lime)' : 'var(--gf-text)' }}>
                          {s.v}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </TabsContent>
            </Tabs>
          </div>

          {/* Sidebar */}
          <div className="space-y-4">
            {device.current_task && (
              <div
                className="rounded-2xl border p-5"
                style={{ background: 'var(--lime-soft)', borderColor: 'rgba(212,255,58,0.22)' }}
              >
                <h3 className="text-[14px] font-semibold mb-3" style={{ color: 'var(--gf-text)' }}>Current assignment</h3>
                <div className="space-y-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--gf-text-faint)' }}>Task</div>
                    <div className="text-[13px] font-medium" style={{ color: 'var(--gf-text)' }}>{device.current_task}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--gf-text-faint)' }}>Worker</div>
                    <div className="text-[13px]" style={{ color: 'var(--gf-text)' }}>{device.assigned_to || '—'}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--gf-text-faint)' }}>Mode</div>
                    <span className={`gf-badge mt-1 ${MODE_TONE[device.guidance_mode] || 'gf-badge-idle'}`}>
                      {device.guidance_mode || 'Idle'}
                    </span>
                  </div>
                </div>
              </div>
            )}

            <div
              className="rounded-2xl border hairline p-5"
              style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
            >
              <h3 className="text-[14px] font-semibold mb-4" style={{ color: 'var(--gf-text)' }}>Device information</h3>
              <div className="space-y-3">
                {[
                  { icon: MapPin, k: 'Last location', v: device.last_location },
                  { icon: FolderOpen, k: 'Last project', v: device.last_project },
                  { icon: Clock, k: 'Last sync', v: device.last_sync ? new Date(device.last_sync).toLocaleString() : '—' },
                  { icon: User, k: 'Assigned to', v: device.assigned_to },
                  { icon: Calendar, k: 'Registered', v: device.created_at ? new Date(device.created_at).toLocaleDateString() : '—' },
                ].map((row) => (
                  <div key={row.k} className="flex items-start gap-3">
                    <row.icon className="h-3.5 w-3.5 mt-1 shrink-0" style={{ color: 'var(--gf-text-faint)' }} strokeWidth={1.5} />
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--gf-text-faint)' }}>{row.k}</div>
                      <div className="text-[13px]" style={{ color: 'var(--gf-text)' }}>{row.v || '—'}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div
              className="rounded-2xl border hairline p-5"
              style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
            >
              <h3 className="text-[14px] font-semibold mb-4" style={{ color: 'var(--gf-text)' }}>Network status</h3>
              <div className="space-y-3 text-[13px]">
                {[
                  { k: 'Latency', v: `${device.network_latency_ms || 0}ms` },
                  { k: 'Server jitter', v: `${device.server_jitter_ms || 0}ms` },
                  { k: 'Signal strength', v: `${device.signal_strength || 0}%` },
                ].map((r) => (
                  <div key={r.k} className="flex items-center justify-between">
                    <span className="text-[12px]" style={{ color: 'var(--gf-text-dim)' }}>{r.k}</span>
                    <span className="gf-mono" style={{ color: 'var(--gf-text)' }}>{r.v}</span>
                  </div>
                ))}
              </div>
            </div>

            <div
              className="rounded-2xl border hairline p-5"
              style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
            >
              <h3 className="text-[14px] font-semibold mb-4" style={{ color: 'var(--gf-text)' }}>Quick actions</h3>
              <div className="space-y-2">
                <button className="btn-ghost w-full h-8 px-3 rounded-md text-[12px] flex items-center justify-start gap-2">
                  <Download className="h-3.5 w-3.5" strokeWidth={1.5} /> Export session logs
                </button>
                <button className="btn-ghost w-full h-8 px-3 rounded-md text-[12px] flex items-center justify-start gap-2">
                  <Cpu className="h-3.5 w-3.5" strokeWidth={1.5} /> Update firmware
                </button>
                <button
                  className="w-full h-8 px-3 rounded-md text-[12px] flex items-center justify-start gap-2 border hairline transition"
                  style={{ color: 'var(--red)', background: 'transparent', borderColor: 'var(--gf-line)' }}
                >
                  <Power className="h-3.5 w-3.5" strokeWidth={1.5} /> Remote restart
                </button>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
