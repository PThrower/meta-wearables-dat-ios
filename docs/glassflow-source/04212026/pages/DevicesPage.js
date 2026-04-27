import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  Glasses, MapPin, Signal, Search, Filter, RefreshCw,
  Plus, Phone, Zap, Wrench,
} from 'lucide-react';
import { getDevices, getDevicesSummary } from '@/lib/api';
import { toast } from 'sonner';
import { DEMO_DEVICES, DEMO_DEVICES_SUMMARY, summarizeDevices } from '@/lib/demoData';

const toArray = (v) => Array.isArray(v) ? v : Array.isArray(v?.items) ? v.items : Array.isArray(v?.data) ? v.data : [];

const normalizeStatus = (s) => {
  if (!s) return 'offline';
  if (s === 'online' || s === 'live' || s === 'streaming') return 'live';
  if (s === 'attention' || s === 'warning') return 'attention';
  if (s === 'offline' || s === 'idle') return 'offline';
  return s;
};

const STAT_COLORS = {
  live: 'var(--lime)',
  attention: 'var(--amber)',
  offline: 'var(--gf-text-faint)',
  syncing: 'var(--sky)',
  charging: 'var(--amber)',
};

export default function DevicesPage() {
  const [devices, setDevices] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [d, s] = await Promise.all([getDevices(), getDevicesSummary()]);
      const list = toArray(d);
      const sum = (() => {
        if (Array.isArray(s)) return s[0] || {};
        if (s?.summary) return s.summary;
        if (s?.data && !Array.isArray(s.data)) return s.data;
        return s || {};
      })();
      const devicesToShow = list.length > 0 ? list : DEMO_DEVICES.slice(0, 6);
      const summaryToShow = Object.keys(sum).length > 0 ? sum : summarizeDevices(devicesToShow);
      setDevices(devicesToShow);
      setSummary(summaryToShow);
    } catch (e) {
      setDevices(DEMO_DEVICES.slice(0, 6));
      setSummary(DEMO_DEVICES_SUMMARY);
      toast.info('Showing demo devices');
    } finally {
      setLoading(false);
    }
  };

  const statusFilters = [
    { k: 'all', label: 'All' },
    { k: 'live', label: 'Live' },
    { k: 'attention', label: 'Attention' },
    { k: 'offline', label: 'Offline' },
  ];

  const normalized = devices.map((d) => ({ ...d, _status: normalizeStatus(d.status) }));
  const filtered = normalized.filter((d) => {
    const q = searchQuery.toLowerCase();
    const matchS = !q ||
      (d.name || '').toLowerCase().includes(q) ||
      (d.serial_number || '').toLowerCase().includes(q) ||
      (d.assigned_to || '').toLowerCase().includes(q) ||
      (d.last_location || '').toLowerCase().includes(q) ||
      (d.current_task || '').toLowerCase().includes(q);
    const matchF = statusFilter === 'all' || d._status === statusFilter;
    return matchS && matchF;
  });

  const counts = {
    all: normalized.length,
    live: normalized.filter((d) => d._status === 'live').length,
    attention: normalized.filter((d) => d._status === 'attention').length,
    offline: normalized.filter((d) => d._status === 'offline').length,
  };

  const avgBattery = normalized.length > 0
    ? Math.round(normalized.reduce((a, d) => a + (d.battery_level || 0), 0) / normalized.length)
    : 0;
  const avgSignal = normalized.length > 0
    ? (normalized.reduce((a, d) => a + (Number(d.signal_strength) || 0), 0) / normalized.length / 25).toFixed(1)
    : '—';

  const statCards = [
    { k: 'Total', v: summary?.total_devices ?? counts.all, sub: 'in fleet' },
    { k: 'Live now', v: counts.live, sub: 'broadcasting', tone: 'lime' },
    { k: 'Avg battery', v: `${avgBattery}%`, sub: 'across fleet' },
    { k: 'Avg signal', v: `${avgSignal}`, sub: 'of 4 bars' },
  ];

  return (
    <div className="gf-page min-h-screen" data-testid="devices-page" style={{ background: 'var(--gf-bg)' }}>
      <main className="max-w-[1400px] mx-auto p-6 sm:p-8 space-y-6">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] mb-1.5" style={{ color: 'var(--gf-text-faint)' }}>Devices</div>
            <h1 className="text-[28px] font-semibold tracking-tight" data-testid="devices-title" style={{ color: 'var(--gf-text)' }}>
              Fleet Management
            </h1>
            <p className="text-[13px] mt-1" style={{ color: 'var(--gf-text-dim)' }}>
              {counts.all} glasses · {counts.live} live · {counts.attention} need attention · {counts.offline} offline
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn-ghost h-9 px-3 rounded-md text-[12px] flex items-center gap-1.5">
              <Filter className="h-3 w-3" strokeWidth={1.5} /> Filters
            </button>
            <button className="btn-lime h-9 px-4 rounded-md text-[12.5px] font-medium flex items-center gap-1.5">
              <Plus className="h-3 w-3" strokeWidth={1.5} /> Add device
            </button>
          </div>
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {statCards.map((s) => (
            <div key={s.k} className="rounded-xl border hairline p-4" style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}>
              <div className="text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--gf-text-faint)' }}>{s.k}</div>
              <div className="num text-[26px] font-medium mt-1" style={{ color: s.tone === 'lime' ? 'var(--lime)' : 'var(--gf-text)' }}>
                {s.v}
              </div>
              <div className="text-[11px]" style={{ color: 'var(--gf-text-dim)' }}>{s.sub}</div>
            </div>
          ))}
        </div>

        {/* Search + filters row */}
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="flex items-center gap-2 h-9 px-3 rounded-md border hairline flex-1 min-w-[200px]"
            style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
          >
            <Search className="h-3.5 w-3.5" style={{ color: 'var(--gf-text-faint)' }} strokeWidth={1.5} />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search devices, workers, tasks…"
              data-testid="device-search"
              className="flex-1 bg-transparent text-[12.5px] outline-none"
              style={{ color: 'var(--gf-text)' }}
            />
          </div>
          <div className="flex items-center gap-1.5">
            {statusFilters.map((f) => {
              const active = statusFilter === f.k;
              const c = counts[f.k] ?? 0;
              return (
                <button
                  key={f.k}
                  onClick={() => setStatusFilter(f.k)}
                  className="h-8 px-3 rounded-md text-[12px] flex items-center gap-1.5 transition"
                  style={{
                    background: active ? 'var(--lime-soft)' : 'transparent',
                    color: active ? 'var(--lime)' : 'var(--gf-text-dim)',
                    border: `1px solid ${active ? 'rgba(212,255,58,0.4)' : 'var(--gf-line)'}`,
                  }}
                >
                  {f.label} <span className="text-[10px] gf-mono opacity-70">{c}</span>
                </button>
              );
            })}
          </div>
          <button
            onClick={fetchData}
            disabled={loading}
            className="btn-ghost h-8 px-3 rounded-md text-[12px] flex items-center gap-1.5"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.5} /> Refresh
          </button>
        </div>

        {/* Devices grid */}
        {loading ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[...Array(6)].map((_, i) => (
              <div
                key={i}
                className="rounded-xl border hairline p-5 h-[260px] animate-pulse"
                style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
              />
            ))}
          </div>
        ) : filtered.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filtered.map((d) => {
              const status = d._status;
              const statColor = STAT_COLORS[status] || STAT_COLORS[d.status] || 'var(--gf-text-faint)';
              const batt = d.battery_level ?? 0;
              const battColor = batt > 50 ? 'var(--lime)' : batt > 25 ? 'var(--amber)' : 'var(--red)';
              const storeUsed = d.storage_used_gb ?? 0;
              const storeMax = d.storage_total_gb ?? 32;
              const signalN = Math.max(1, Math.min(4, Math.round((d.signal_strength ?? 50) / 25)));
              return (
                <Link
                  key={d.id}
                  to={`/devices/${d.id}`}
                  data-testid={`device-card-${d.id}`}
                  className="rounded-xl border hairline p-5 transition block"
                  style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      <div
                        className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                        style={{ background: 'rgba(255,255,255,0.04)' }}
                      >
                        <Glasses className="h-4 w-4" strokeWidth={1.5} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-semibold leading-tight" style={{ color: 'var(--gf-text)' }}>{d.name}</div>
                        <div className="text-[10px] gf-mono truncate mt-0.5" style={{ color: 'var(--gf-text-faint)' }}>
                          {d.model_variant || d.model || '—'}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {status === 'live' && <span className="live-dot" />}
                      <span className="text-[9.5px] gf-mono uppercase tracking-wider whitespace-nowrap" style={{ color: statColor }}>
                        {status === 'attention' ? 'ATTN' : status}
                      </span>
                    </div>
                  </div>

                  <div className="mt-4 pt-4 border-t hairline flex items-center gap-2" style={{ borderTopColor: 'var(--gf-line)' }}>
                    <div
                      className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold text-black"
                      style={{ background: 'linear-gradient(135deg, #7FB7FF, #B794FF)' }}
                    >
                      {(d.assigned_to || '—').slice(0, 2).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[12.5px] font-medium truncate" style={{ color: 'var(--gf-text)' }}>{d.assigned_to || 'Unassigned'}</div>
                      <div className="text-[10.5px] truncate" style={{ color: 'var(--gf-text-faint)' }}>
                        {d.worker_role || '—'}{d.guidance_mode ? ` · ${d.guidance_mode}` : ''}
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 text-[12px] truncate flex items-center gap-1.5" style={{ color: 'var(--gf-text)' }}>
                    <Wrench className="h-3 w-3 shrink-0" style={{ color: 'var(--gf-text-faint)' }} strokeWidth={1.5} />
                    {d.current_task || 'No active task'}
                  </div>
                  {d.last_location && (
                    <div className="text-[10.5px] mt-0.5 truncate flex items-center gap-1" style={{ color: 'var(--gf-text-faint)' }}>
                      <MapPin className="h-3 w-3" strokeWidth={1.5} />{d.last_location}
                    </div>
                  )}

                  <div className="mt-3 grid grid-cols-2 gap-3 text-[10px] gf-mono">
                    <div>
                      <div className="flex justify-between" style={{ color: 'var(--gf-text-faint)' }}>
                        <span>BATTERY</span><span style={{ color: 'var(--gf-text)' }}>{batt}%</span>
                      </div>
                      <div className="h-1.5 mt-1 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                        <div className="h-full rounded-full" style={{ width: `${batt}%`, background: battColor }} />
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between" style={{ color: 'var(--gf-text-faint)' }}>
                        <span>STORAGE</span><span style={{ color: 'var(--gf-text)' }}>{storeUsed}/{storeMax}G</span>
                      </div>
                      <div className="h-1.5 mt-1 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                        <div className="h-full rounded-full" style={{ width: `${Math.min(100, (storeUsed / storeMax) * 100)}%`, background: 'rgba(255,255,255,0.4)' }} />
                      </div>
                    </div>
                  </div>

                  <div
                    className="mt-4 pt-3 border-t hairline flex items-center justify-between text-[10.5px] gf-mono"
                    style={{ borderTopColor: 'var(--gf-line)', color: 'var(--gf-text-dim)' }}
                  >
                    <span className="flex items-center gap-1"><Zap className="h-3 w-3" strokeWidth={1.5} />{d.guidance_events_today || 0}</span>
                    <span className="flex items-center gap-1"><Phone className="h-3 w-3" strokeWidth={1.5} />{d.service_calls_today || 0}</span>
                    <span className="flex items-center gap-1"><Signal className="h-3 w-3" strokeWidth={1.5} />{signalN}/4</span>
                    <span style={{ color: 'var(--lime)' }}>Details →</span>
                  </div>
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="rounded-xl border hairline p-12 text-center" style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}>
            <Glasses className="h-10 w-10 mx-auto mb-3 opacity-30" strokeWidth={1.5} />
            <h3 className="text-sm font-medium mb-1" style={{ color: 'var(--gf-text)' }}>No devices found</h3>
            <p className="text-xs mb-4" style={{ color: 'var(--gf-text-dim)' }}>
              {searchQuery || statusFilter !== 'all' ? 'Try adjusting your search or filters' : 'Add your first GlassFlow device to get started'}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
