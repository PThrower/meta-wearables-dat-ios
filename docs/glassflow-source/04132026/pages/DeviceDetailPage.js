import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Glasses, Battery, Wifi, HardDrive, Clock, MapPin, FolderOpen,
  Activity, Signal, ChevronLeft, Video, Play, Settings, Zap,
  RefreshCw, Download, Trash2, Power, Check, AlertCircle,
  Calendar, User, Cpu, Server, Radio
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { getDevice, getDeviceVideos } from '@/lib/api';
import { toast } from 'sonner';
import { getDemoDeviceById, getDemoVideosByDeviceId, isDemoDeviceId } from '@/lib/demoData';

export default function DeviceDetailPage() {
  const { deviceId } = useParams();
  const [device, setDevice] = useState(null);
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchData();
  }, [deviceId]);

  const fetchData = async () => {
    setLoading(true);
    if (isDemoDeviceId(deviceId)) {
      setDevice(getDemoDeviceById(deviceId));
      setVideos(getDemoVideosByDeviceId(deviceId));
      setLoading(false);
      return;
    }

    try {
      const [deviceData, videosData] = await Promise.all([
        getDevice(deviceId),
        getDeviceVideos(deviceId)
      ]);
      setDevice(deviceData);
      setVideos(Array.isArray(videosData) ? videosData : []);
    } catch (error) {
      toast.error('Failed to load device details');
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const getStatusBadge = (status) => {
    switch (status) {
      case 'online': return 'bg-[#E0FF00]/15 text-[#E0FF00] border-[#E0FF00]/30';
      case 'syncing': return 'bg-sky-500/20 text-sky-600 dark:text-sky-400 border-sky-500/30';
      case 'charging': return 'bg-amber-500/20 text-amber-600 dark:text-amber-400 border-amber-500/30';
      case 'offline': return 'bg-red-500/20 text-red-600 dark:text-red-400 border-red-500/30';
      default: return 'bg-muted text-muted-foreground border-border';
    }
  };

  const getGuidanceModeBadge = (mode) => {
    switch (mode) {
      case 'Active': return 'bg-[#E0FF00]/15 text-[#E0FF00] border-[#E0FF00]/30';
      case 'Standby': return 'bg-amber-500/20 text-amber-600 dark:text-amber-400 border-amber-500/30';
      default: return 'bg-muted text-muted-foreground border-border';
    }
  };

  const getBatteryColor = (level) => {
    if (level > 60) return 'text-[#E0FF00]';
    if (level > 30) return 'text-amber-500';
    return 'text-red-500';
  };

  const formatDuration = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <Header />
        <main className="px-4 sm:px-6 py-6">
          <div className="animate-pulse">
            <div className="h-8 w-64 bg-muted rounded mb-4" />
            <div className="h-4 w-96 bg-muted rounded mb-8" />
            <div className="grid md:grid-cols-3 gap-6">
              <div className="md:col-span-2 clip-chamfer border border-border bg-card p-6">
                <div className="h-6 w-32 bg-muted rounded mb-4" />
                <div className="space-y-4">
                  {[...Array(4)].map((_, i) => (
                    <div key={i} className="h-4 bg-muted rounded" />
                  ))}
                </div>
              </div>
              <div className="clip-chamfer border border-border bg-card p-6">
                <div className="h-6 w-24 bg-muted clip-chamfer-sm mb-4" />
                <div className="space-y-4">
                  {[...Array(6)].map((_, i) => (
                    <div key={i} className="h-4 bg-muted rounded" />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (!device) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <Header />
        <main className="px-4 sm:px-6 py-6">
          <div className="text-center py-12">
            <AlertCircle className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h2 className="text-xl font-semibold text-foreground mb-2">Device not found</h2>
            <p className="text-muted-foreground mb-4">The device you're looking for doesn't exist.</p>
            <Link to="/devices">
              <Button variant="hex">
                <ChevronLeft className="h-4 w-4 mr-2" />
                Back to Devices
              </Button>
            </Link>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground" data-testid="device-detail-page">
      {/* Background */}
      <div className="fixed inset-0 -z-10 pointer-events-none">
        <div
          className="absolute inset-0"
          style={{
            background: 'radial-gradient(60% 50% at 10% 5%, rgba(224,255,0,0.12) 0%, rgba(0,0,0,0) 50%)'
          }}
        />
      </div>

      <Header />

      <main className="px-4 sm:px-6 py-6">
        {/* Back Button & Header */}
        <div className="mb-6">
          <Link to="/devices" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
            <ChevronLeft className="h-4 w-4" strokeWidth={1.5} />
            Back to Fleet
          </Link>

          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
            <div className="flex items-start gap-4">
              <div className="h-14 w-14 clip-hex bg-[#E0FF00]/15 border border-[#E0FF00]/30 flex items-center justify-center">
                <Glasses className="h-7 w-7 text-[#E0FF00]" strokeWidth={1.5} />
              </div>
              <div>
                <div className="flex items-center gap-3 mb-1">
                  <h1 className="text-2xl font-semibold text-foreground">{device.name}</h1>
                  <Badge className={`text-xs border ${getStatusBadge(device.status)}`}>
                    {device.status}
                  </Badge>
                  {device.guidance_mode && (
                    <Badge className={`text-xs border ${getGuidanceModeBadge(device.guidance_mode)}`}>
                      {device.guidance_mode}
                    </Badge>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">{device.serial_number} • {device.model}</p>
                {/* Worker info */}
                <div className="flex items-center gap-3 mt-1.5">
                  <div className="flex items-center gap-1.5 text-sm">
                    <User className="h-3.5 w-3.5 text-[#E0FF00]" strokeWidth={1.5} />
                    <span className="font-medium text-foreground">{device.assigned_to}</span>
                  </div>
                  {device.current_task && (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Zap className="h-3 w-3 text-[#E0FF00]/70" strokeWidth={1.5} />
                      <span>{device.current_task}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="hex-outline">
                <Settings className="h-4 w-4 mr-2" strokeWidth={1.5} />
                Settings
              </Button>
              <Button variant="hex">
                <RefreshCw className="h-4 w-4 mr-2" strokeWidth={1.5} />
                Sync Now
              </Button>
            </div>
          </div>
        </div>

        <div className="grid lg:grid-cols-3 gap-6">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-6">
            {/* Status Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="clip-chamfer border border-border bg-card p-4"
              >
                <Battery className={`h-5 w-5 mb-2 ${getBatteryColor(device.battery_level)}`} strokeWidth={1.5} />
                <div className="text-xs text-muted-foreground">Battery</div>
                <div className="text-xl font-semibold text-foreground">{device.battery_level}%</div>
                <Progress value={device.battery_level} className="h-1.5 mt-2" />
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 }}
                className="clip-chamfer border border-border bg-card p-4"
              >
                <HardDrive className="h-5 w-5 mb-2 text-muted-foreground" strokeWidth={1.5} />
                <div className="text-xs text-muted-foreground">Storage</div>
                <div className="text-xl font-semibold text-foreground">{device.storage_used_gb}GB</div>
                <Progress value={(device.storage_used_gb / device.storage_total_gb) * 100} className="h-1.5 mt-2" />
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
                className="clip-chamfer border border-border bg-card p-4"
              >
                <Signal className="h-5 w-5 mb-2 text-muted-foreground" strokeWidth={1.5} />
                <div className="text-xs text-muted-foreground">Signal</div>
                <div className="text-xl font-semibold text-foreground">{device.signal_strength}%</div>
                <Progress value={device.signal_strength} className="h-1.5 mt-2" />
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15 }}
                className="clip-chamfer border border-border bg-card p-4"
              >
                <Activity className="h-5 w-5 mb-2 text-muted-foreground" strokeWidth={1.5} />
                <div className="text-xs text-muted-foreground">Latency</div>
                <div className="text-xl font-semibold text-foreground">{device.network_latency_ms}ms</div>
                <div className="text-xs text-muted-foreground mt-2">Jitter: {device.server_jitter_ms}ms</div>
              </motion.div>
            </div>

            {/* Tabs: Live Status | Session History | Performance */}
            <Tabs defaultValue="live" className="w-full">
              <TabsList className="bg-card border border-border clip-chamfer-sm">
                <TabsTrigger value="live" className="data-[state=active]:bg-[#E0FF00]/15 data-[state=active]:text-[#E0FF00]">
                  <Radio className="h-4 w-4 mr-2" strokeWidth={1.5} />
                  Live Status
                </TabsTrigger>
                <TabsTrigger value="sessions" className="data-[state=active]:bg-[#E0FF00]/15 data-[state=active]:text-[#E0FF00]">
                  <Video className="h-4 w-4 mr-2" strokeWidth={1.5} />
                  Session History ({videos.length})
                </TabsTrigger>
                <TabsTrigger value="performance" className="data-[state=active]:bg-[#E0FF00]/15 data-[state=active]:text-[#E0FF00]">
                  <Activity className="h-4 w-4 mr-2" strokeWidth={1.5} />
                  Performance
                </TabsTrigger>
              </TabsList>

              <TabsContent value="live" className="mt-4">
                <div className="clip-chamfer border border-border bg-card p-6 space-y-4">
                  <h3 className="text-sm font-medium text-foreground mb-4">Live Device Status</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-xs text-muted-foreground">Guidance Mode</div>
                      <div className="mt-1">
                        <Badge className={`text-xs border ${getGuidanceModeBadge(device.guidance_mode || 'Idle')}`}>
                          {device.guidance_mode || 'Idle'}
                        </Badge>
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Current Task</div>
                      <div className="text-sm font-medium text-foreground mt-1">{device.current_task || 'None'}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Guidance Events Today</div>
                      <div className="text-lg font-semibold text-[#E0FF00]">{device.guidance_events_today || 0}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Worker</div>
                      <div className="text-sm font-medium text-foreground mt-1">{device.assigned_to}</div>
                    </div>
                  </div>
                  <div className="pt-4 border-t border-border">
                    <div className="text-xs text-muted-foreground mb-2">Location</div>
                    <div className="flex items-center gap-2">
                      <MapPin className="h-4 w-4 text-[#E0FF00]" strokeWidth={1.5} />
                      <span className="text-sm text-foreground">{device.last_location}</span>
                    </div>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="sessions" className="mt-4">
                {videos.length > 0 ? (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {videos.map((video) => (
                      <motion.div
                        key={video.id}
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="clip-chamfer-sm overflow-hidden border border-border bg-card group cursor-pointer hover:border-[#E0FF00]/50 transition-all hover:scale-[1.02]"
                      >
                        <div className="aspect-video relative">
                          <img
                            src={video.thumbnail_url}
                            alt={video.filename}
                            className="w-full h-full object-cover"
                          />
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <Play className="h-8 w-8 text-white" strokeWidth={1.5} />
                          </div>
                          <div className="absolute bottom-2 right-2 px-1.5 py-0.5 clip-chamfer-sm bg-black/70 text-[10px] text-white">
                            {formatDuration(video.duration_seconds)}
                          </div>
                        </div>
                        <div className="p-2">
                          <div className="text-xs font-medium text-foreground truncate">{video.worker || video.participant}</div>
                          <div className="text-[10px] text-muted-foreground">{video.task_name || video.feedback_label}</div>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                ) : (
                  <div className="clip-chamfer border border-border bg-card p-8 text-center">
                    <Video className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" strokeWidth={1.5} />
                    <p className="text-sm text-muted-foreground">No sessions recorded with this device yet</p>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="performance" className="mt-4">
                <div className="clip-chamfer border border-border bg-card p-6">
                  <h3 className="text-sm font-medium text-foreground mb-4">Device Performance</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-xs text-muted-foreground">Total Session Hours</div>
                      <div className="text-lg font-semibold text-foreground">{device.total_recording_hours}h</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Sessions Recorded</div>
                      <div className="text-lg font-semibold text-foreground">{device.video_count}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Firmware Version</div>
                      <div className="text-lg font-semibold text-foreground">v{device.firmware_version}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Guidance Events Today</div>
                      <div className="text-lg font-semibold text-[#E0FF00]">{device.guidance_events_today || 0}</div>
                    </div>
                  </div>
                </div>
              </TabsContent>
            </Tabs>
          </div>

          {/* Sidebar */}
          <div className="space-y-4">
            {/* Current Assignment */}
            {device.current_task && (
              <motion.div
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                className="clip-chamfer hex-card-accent border border-[#E0FF00]/20 bg-[#E0FF00]/5 p-5"
              >
                <h3 className="text-sm font-medium text-foreground mb-3">Current Assignment</h3>
                <div className="space-y-3">
                  <div>
                    <div className="text-xs text-muted-foreground">Task</div>
                    <div className="text-sm font-medium text-foreground">{device.current_task}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Worker</div>
                    <div className="text-sm text-foreground">{device.assigned_to}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Mode</div>
                    <Badge className={`text-xs border mt-1 ${getGuidanceModeBadge(device.guidance_mode || 'Idle')}`}>
                      {device.guidance_mode || 'Idle'}
                    </Badge>
                  </div>
                </div>
              </motion.div>
            )}

            {/* Device Info */}
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              className="clip-chamfer border border-border bg-card p-5"
            >
              <h3 className="text-sm font-medium text-foreground mb-4">Device Information</h3>
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <MapPin className="h-4 w-4 text-muted-foreground mt-0.5" strokeWidth={1.5} />
                  <div>
                    <div className="text-xs text-muted-foreground">Last Location</div>
                    <div className="text-sm text-foreground">{device.last_location}</div>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <FolderOpen className="h-4 w-4 text-muted-foreground mt-0.5" strokeWidth={1.5} />
                  <div>
                    <div className="text-xs text-muted-foreground">Last Project</div>
                    <div className="text-sm text-foreground">{device.last_project}</div>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <Clock className="h-4 w-4 text-muted-foreground mt-0.5" strokeWidth={1.5} />
                  <div>
                    <div className="text-xs text-muted-foreground">Last Sync</div>
                    <div className="text-sm text-foreground">{new Date(device.last_sync).toLocaleString()}</div>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <User className="h-4 w-4 text-muted-foreground mt-0.5" strokeWidth={1.5} />
                  <div>
                    <div className="text-xs text-muted-foreground">Assigned To</div>
                    <div className="text-sm text-foreground">{device.assigned_to}</div>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <Calendar className="h-4 w-4 text-muted-foreground mt-0.5" strokeWidth={1.5} />
                  <div>
                    <div className="text-xs text-muted-foreground">Registered</div>
                    <div className="text-sm text-foreground">{new Date(device.created_at).toLocaleDateString()}</div>
                  </div>
                </div>
              </div>
            </motion.div>

            {/* Network Info */}
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.1 }}
              className="clip-chamfer border border-border bg-card p-5"
            >
              <h3 className="text-sm font-medium text-foreground mb-4">Network Status</h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Latency</span>
                  <span className="text-sm text-foreground">{device.network_latency_ms}ms</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Server Jitter</span>
                  <span className="text-sm text-foreground">{device.server_jitter_ms}ms</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Signal Strength</span>
                  <span className="text-sm text-foreground">{device.signal_strength}%</span>
                </div>
              </div>
            </motion.div>

            {/* Quick Actions */}
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.15 }}
              className="clip-chamfer border border-border bg-card p-5"
            >
              <h3 className="text-sm font-medium text-foreground mb-4">Quick Actions</h3>
              <div className="space-y-2">
                <Button variant="hex-outline" className="w-full justify-start">
                  <Download className="h-4 w-4 mr-2" strokeWidth={1.5} />
                  Export Session Logs
                </Button>
                <Button variant="hex-outline" className="w-full justify-start">
                  <Cpu className="h-4 w-4 mr-2" strokeWidth={1.5} />
                  Update Firmware
                </Button>
                <Button variant="ghost" className="w-full justify-start text-red-500 hover:text-red-600 hover:bg-red-500/10 clip-chamfer-sm border border-border">
                  <Power className="h-4 w-4 mr-2" strokeWidth={1.5} />
                  Remote Restart
                </Button>
              </div>
            </motion.div>
          </div>
        </div>
      </main>
    </div>
  );
}
