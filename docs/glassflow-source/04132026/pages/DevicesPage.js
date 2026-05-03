import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Glasses, Battery, Wifi, HardDrive, Clock, MapPin, FolderOpen,
  Activity, Signal, ChevronRight, Search, Filter, RefreshCw,
  Plus, Settings, Video, Zap, AlertCircle, CheckCircle2, Loader2,
  Radio, User, Wrench, Phone
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { getDevices, getDevicesSummary } from '@/lib/api';
import { toast } from 'sonner';
import { DEMO_DEVICES, DEMO_DEVICES_SUMMARY, summarizeDevices } from '@/lib/demoData';

const toArray = (value) => {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.results)) return value.results;
  return [];
};

const normalizeSummary = (value) => {
  if (Array.isArray(value)) return value[0] || {};
  if (value && typeof value === 'object') {
    if (value.summary && typeof value.summary === 'object') return value.summary;
    if (value.data && typeof value.data === 'object' && !Array.isArray(value.data)) return value.data;
    return value;
  }
  return {};
};

export default function DevicesPage() {
  const [devices, setDevices] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [devicesData, summaryData] = await Promise.all([
        getDevices(),
        getDevicesSummary()
      ]);
      const normalizedDevices = toArray(devicesData);
      const normalizedSummary = normalizeSummary(summaryData);
      const devicesToShow = normalizedDevices.length > 0 ? normalizedDevices : DEMO_DEVICES;
      const summaryToShow =
        Object.keys(normalizedSummary || {}).length > 0
          ? normalizedSummary
          : summarizeDevices(devicesToShow);

      setDevices(devicesToShow);
      setSummary(summaryToShow);
    } catch (error) {
      setDevices(DEMO_DEVICES);
      setSummary(DEMO_DEVICES_SUMMARY);
      toast.info('Showing demo devices');
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const filteredDevices = devices.filter((device) => {
    const query = searchQuery.toLowerCase();
    const matchesSearch = (
      `${device?.name || ''}`.toLowerCase().includes(query) ||
      `${device?.serial_number || ''}`.toLowerCase().includes(query) ||
      `${device?.assigned_to || ''}`.toLowerCase().includes(query) ||
      `${device?.last_location || ''}`.toLowerCase().includes(query) ||
      `${device?.current_task || ''}`.toLowerCase().includes(query)
    );
    const matchesStatus = statusFilter === 'all' || device?.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const getStatusColor = (status) => {
    switch (status) {
      case 'online': return 'bg-[#E0FF00]';
      case 'syncing': return 'bg-sky-500 animate-pulse';
      case 'charging': return 'bg-amber-500';
      case 'offline': return 'bg-red-500';
      default: return 'bg-muted-foreground';
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

  return (
    <div className="min-h-screen bg-background text-foreground" data-testid="devices-page">
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
        {/* Page Header */}
        <div className="mb-8">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <h1 className="text-2xl font-semibold tracking-tight" data-testid="devices-title">
                  <span className="text-foreground">Fleet</span>{' '}
                  <span className="text-[#E0FF00]">Management</span>
                </h1>
                <Badge variant="outline" className="text-xs">{devices.length} devices</Badge>
              </div>
              <p className="text-sm text-muted-foreground max-w-xl">
                Monitor and manage your GlassFlow fleet. Track active sessions, guidance events, and worker assignments.
              </p>
            </div>
            <Button variant="hex">
              <Plus className="h-4 w-4 mr-2" strokeWidth={1.5} />
              Add Device
            </Button>
          </div>
        </div>

        {/* Summary Stats */}
        {summary && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="clip-chamfer bg-card border border-border p-4"
            >
              <div className="flex items-center justify-between mb-2">
                <Glasses className="h-5 w-5 text-muted-foreground" strokeWidth={1.5} />
                <span className={`h-2 w-2 clip-hex ${summary.online > 0 ? 'bg-[#E0FF00]' : 'bg-muted-foreground'}`} />
              </div>
              <div className="text-xs text-muted-foreground">Total Devices</div>
              <div className="text-xl font-semibold text-foreground">{summary.total_devices}</div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
              className="clip-chamfer border border-[#E0FF00]/20 bg-[#E0FF00]/5 p-4"
            >
              <div className="flex items-center justify-between mb-2">
                <Radio className="h-5 w-5 text-[#E0FF00] animate-pulse" strokeWidth={1.5} />
              </div>
              <div className="text-xs text-muted-foreground">Active Sessions</div>
              <div className="text-xl font-semibold text-[#E0FF00]">{summary.active_sessions || 0}</div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="clip-chamfer bg-card border border-border p-4"
            >
              <div className="flex items-center justify-between mb-2">
                <Zap className="h-5 w-5 text-muted-foreground" strokeWidth={1.5} />
              </div>
              <div className="text-xs text-muted-foreground">Guidance Events Today</div>
              <div className="text-xl font-semibold text-foreground">{summary.guidance_events_today || 0}</div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 }}
              className="clip-chamfer bg-card border border-border p-4"
            >
              <div className="flex items-center justify-between mb-2">
                <CheckCircle2 className="h-5 w-5 text-muted-foreground" strokeWidth={1.5} />
              </div>
              <div className="text-xs text-muted-foreground">Tasks Completed</div>
              <div className="text-xl font-semibold text-foreground">{summary.total_videos}</div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="clip-chamfer bg-card border border-border p-4"
            >
              <div className="flex items-center justify-between mb-2">
                <Phone className="h-5 w-5 text-muted-foreground" strokeWidth={1.5} />
              </div>
              <div className="text-xs text-muted-foreground">Service Calls Today</div>
              <div className="text-xl font-semibold text-foreground">{summary.service_calls_today || 0}</div>
            </motion.div>
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
            <Input
              placeholder="Search devices, workers, tasks..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 bg-card border-border clip-chamfer-sm"
              data-testid="device-search"
            />
          </div>
          <div className="flex gap-2">
            {['all', 'online', 'syncing', 'charging', 'offline'].map((status) => (
              <Button
                key={status}
                variant="ghost"
                size="sm"
                onClick={() => setStatusFilter(status)}
                className={`px-3 capitalize clip-chamfer-sm ${statusFilter === status ? 'bg-[#E0FF00]/15 text-[#E0FF00]' : 'text-muted-foreground'}`}
              >
                {status}
              </Button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={fetchData}
            disabled={loading}
            className="text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.5} />
            Refresh
          </Button>
        </div>

        {/* Devices Grid */}
        {loading ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="clip-chamfer border border-border bg-card p-5 animate-pulse">
                <div className="h-6 w-3/4 bg-muted clip-chamfer-sm mb-4" />
                <div className="h-4 w-1/2 bg-muted clip-chamfer-sm mb-2" />
                <div className="h-4 w-2/3 bg-muted clip-chamfer-sm" />
              </div>
            ))}
          </div>
        ) : filteredDevices.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filteredDevices.map((device, i) => (
              <motion.div
                key={device.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
              >
                <Link
                  to={`/devices/${device.id}`}
                  className="block clip-chamfer border border-border bg-card p-5 hover:border-[#E0FF00]/50 hover:shadow-lg hover:shadow-[#E0FF00]/5 transition-all group hover:scale-[1.02]"
                  data-testid={`device-card-${device.id}`}
                >
                  {/* Header: Device name, model, status */}
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 clip-hex bg-[#E0FF00]/15 border border-[#E0FF00]/30 flex items-center justify-center">
                        <Glasses className="h-5 w-5 text-[#E0FF00]" strokeWidth={1.5} />
                      </div>
                      <div>
                        <h3 className="font-medium text-foreground group-hover:text-[#E0FF00] transition-colors">{device.name}</h3>
                        <p className="text-[10px] text-muted-foreground font-mono">{device.model_variant || device.model}</p>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Badge className={`text-[10px] border ${getStatusBadge(device.status)}`}>
                        {device.status}
                      </Badge>
                      {device.guidance_mode && device.guidance_mode !== 'Idle' && (
                        <Badge className={`text-[9px] border ${getGuidanceModeBadge(device.guidance_mode)}`}>
                          {device.guidance_mode}
                        </Badge>
                      )}
                    </div>
                  </div>

                  {/* Worker & Role */}
                  <div className="mb-3 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-sm">
                        <User className="h-3.5 w-3.5 text-[#E0FF00]" strokeWidth={1.5} />
                        <span className="font-medium text-foreground">{device.assigned_to}</span>
                      </div>
                      {device.worker_role && (
                        <span className="text-[10px] text-muted-foreground">{device.worker_role}</span>
                      )}
                    </div>
                    {device.current_task ? (
                      <div className="flex items-center gap-2 text-xs">
                        <Wrench className="h-3 w-3 text-[#E0FF00]/70" strokeWidth={1.5} />
                        <span className="truncate text-foreground/80">{device.current_task}</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground/50">
                        <Wrench className="h-3 w-3" strokeWidth={1.5} />
                        <span>No active task</span>
                      </div>
                    )}
                  </div>

                  <div className="space-y-3">
                    {/* Battery & Storage */}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-muted-foreground">Battery</span>
                          <span className={`text-xs font-medium ${getBatteryColor(device.battery_level)}`}>{device.battery_level}%</span>
                        </div>
                        <Progress value={device.battery_level} className="h-1.5" />
                      </div>
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-muted-foreground">Storage</span>
                          <span className="text-xs font-medium text-foreground">{device.storage_used_gb}/{device.storage_total_gb}GB</span>
                        </div>
                        <Progress value={(device.storage_used_gb / device.storage_total_gb) * 100} className="h-1.5" />
                      </div>
                    </div>

                    {/* Location */}
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <MapPin className="h-3 w-3" strokeWidth={1.5} />
                      <span className="truncate">{device.last_location}</span>
                    </div>

                    {/* Stats Row */}
                    <div className="flex items-center justify-between pt-3 border-t border-border">
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Zap className="h-3 w-3" strokeWidth={1.5} />
                        <span>{device.guidance_events_today || 0} events</span>
                      </div>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Phone className="h-3 w-3" strokeWidth={1.5} />
                        <span>{device.service_calls_today || 0} calls</span>
                      </div>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Signal className="h-3 w-3" strokeWidth={1.5} />
                        <span>{device.signal_strength}%</span>
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex items-center justify-between">
                    <span className="text-[10px] text-muted-foreground font-mono">{device.serial_number}</span>
                    <span className="text-xs text-[#E0FF00] group-hover:translate-x-1 transition-transform inline-flex items-center gap-1">
                      View Details
                      <ChevronRight className="h-3 w-3" strokeWidth={1.5} />
                    </span>
                  </div>
                </Link>
              </motion.div>
            ))}
          </div>
        ) : (
          <div className="clip-chamfer border border-border bg-card p-12 text-center">
            <Glasses className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" strokeWidth={1.5} />
            <h3 className="text-lg font-medium text-foreground/80 mb-2">No devices found</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {searchQuery || statusFilter !== 'all'
                ? 'Try adjusting your search or filters'
                : 'Add your first GlassFlow device to get started'}
            </p>
            <Button variant="hex">
              <Plus className="h-4 w-4 mr-2" strokeWidth={1.5} />
              Add Device
            </Button>
          </div>
        )}
      </main>
    </div>
  );
}
