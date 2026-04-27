import React, { useState, useEffect, useCallback } from 'react';
import {
  BarChart3, TrendingUp, Users, Shield, Clock,
  CheckCircle2, AlertTriangle, Smile, RefreshCw, Loader2,
  Activity, Target, Zap, MapPin, Flame, Route, Timer
} from 'lucide-react';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell
} from 'recharts';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/button';
import {
  getAnalyticsOverview, getAnalyticsWorkers,
  getAnalyticsSessionsOverTime, getAnalyticsTopics,
  getAnalyticsCompliance
} from '@/lib/api';
import {
  DEMO_ANALYTICS_OVERVIEW, DEMO_ANALYTICS_WORKERS,
  DEMO_ANALYTICS_TIME_SERIES, DEMO_ANALYTICS_TOPICS,
  DEMO_ANALYTICS_COMPLIANCE
} from '@/lib/demoData';
import { toast } from 'sonner';

const formatDuration = (ms) => {
  if (!ms) return '0m';
  const minutes = Math.floor(ms / 60000);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}m`;
};

const BAR_COLORS = ['#10b981', '#16b6df', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4', '#84cc16', '#ef4444'];

export default function AnalyticsPage() {
  const [overview, setOverview] = useState(null);
  const [workers, setWorkers] = useState([]);
  const [timeSeries, setTimeSeries] = useState([]);
  const [topics, setTopics] = useState([]);
  const [compliance, setCompliance] = useState(null);
  const [loading, setLoading] = useState(true);
  const [timePeriod, setTimePeriod] = useState('week');
  const [workerTab, setWorkerTab] = useState('performance');

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const days = timePeriod === 'day' ? 1 : timePeriod === 'week' ? 7 : 30;
      const [ov, wk, ts, tp, cp] = await Promise.all([
        getAnalyticsOverview().catch(() => null),
        getAnalyticsWorkers().catch(() => []),
        getAnalyticsSessionsOverTime(days).catch(() => []),
        getAnalyticsTopics().catch(() => []),
        getAnalyticsCompliance().catch(() => null),
      ]);

      const hasOverview = ov && typeof ov === 'object' && ov.total_sessions != null;
      const hasCompliance = cp && typeof cp === 'object' && cp.rates && Object.keys(cp.rates).length > 0;

      setOverview(hasOverview ? ov : DEMO_ANALYTICS_OVERVIEW);
      setWorkers(Array.isArray(wk) && wk.length > 0 ? wk : DEMO_ANALYTICS_WORKERS);
      setTimeSeries(Array.isArray(ts) && ts.length > 0 ? ts : DEMO_ANALYTICS_TIME_SERIES.slice(-days));
      setTopics(Array.isArray(tp) && tp.length > 0 ? tp : DEMO_ANALYTICS_TOPICS);
      setCompliance(hasCompliance ? cp : DEMO_ANALYTICS_COMPLIANCE);

      if (!hasOverview && (!Array.isArray(wk) || wk.length === 0)) {
        toast.info('Showing demo analytics');
      }
    } catch {
      setOverview(DEMO_ANALYTICS_OVERVIEW);
      setWorkers(DEMO_ANALYTICS_WORKERS);
      setTimeSeries(DEMO_ANALYTICS_TIME_SERIES);
      setTopics(DEMO_ANALYTICS_TOPICS);
      setCompliance(DEMO_ANALYTICS_COMPLIANCE);
      toast.info('Showing demo analytics');
    } finally {
      setLoading(false);
    }
  }, [timePeriod]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <div className="flex items-center justify-center py-32">
          <Loader2 className="h-8 w-8 text-[#E0FF00] animate-spin" />
        </div>
      </div>
    );
  }

  const kpis = overview ? [
    {
      label: 'Total Sessions',
      value: overview.total_sessions,
      icon: Activity,
      color: 'text-emerald-400',
      bgColor: 'bg-emerald-400/10',
    },
    {
      label: 'Active Now',
      value: overview.active_sessions,
      icon: Zap,
      color: 'text-[#E0FF00]',
      bgColor: 'bg-[#E0FF00]/10',
    },
    {
      label: 'Avg Duration',
      value: formatDuration(overview.avg_duration_ms),
      icon: Clock,
      color: 'text-cyan-400',
      bgColor: 'bg-cyan-400/10',
    },
    {
      label: 'Task Completion',
      value: `${overview.task_completion_pct}%`,
      icon: Target,
      color: 'text-violet-400',
      bgColor: 'bg-violet-400/10',
    },
    {
      label: 'Safety Flags',
      value: overview.safety_flags_count,
      icon: AlertTriangle,
      color: overview.safety_flags_count > 5 ? 'text-red-400' : 'text-amber-400',
      bgColor: overview.safety_flags_count > 5 ? 'bg-red-400/10' : 'bg-amber-400/10',
    },
    {
      label: 'Satisfaction',
      value: overview.customer_satisfaction_avg ? `${(overview.customer_satisfaction_avg * 100).toFixed(0)}%` : '--',
      icon: Smile,
      color: 'text-emerald-400',
      bgColor: 'bg-emerald-400/10',
    },
  ] : [];

  const complianceItems = compliance?.rates ? Object.entries(compliance.rates).map(([key, pct]) => ({
    label: key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    pct,
  })) : [];

  const periodLabel = timePeriod === 'day' ? 'Today' : timePeriod === 'week' ? '7 Days' : '30 Days';

  return (
    <div className="min-h-screen bg-background" data-testid="analytics-page">
      <Header />

      <main className="px-4 sm:px-6 py-6 space-y-6">
        {/* Page header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-[#E0FF00]" strokeWidth={1.5} />
              Analytics
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Cross-session KPIs, trends, and worker performance
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Time period selector */}
            <div className="flex rounded-lg border border-white/10 overflow-hidden">
              {['day', 'week', 'month'].map((period) => (
                <button
                  key={period}
                  onClick={() => setTimePeriod(period)}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                    timePeriod === period
                      ? 'bg-[#E0FF00]/15 text-[#E0FF00]'
                      : 'text-white/40 hover:text-white/60'
                  }`}
                  data-testid={`period-${period}`}
                >
                  {period === 'day' ? 'Day' : period === 'week' ? 'Week' : 'Month'}
                </button>
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={fetchAll}
              className="border-white/10 text-white/60 hover:text-white h-8"
              data-testid="refresh-analytics"
            >
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" strokeWidth={1.5} />
              Refresh
            </Button>
          </div>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3" data-testid="kpi-cards">
          {kpis.map((kpi) => (
            <div
              key={kpi.label}
              className="bg-white/5 border border-white/10 rounded-lg p-4 space-y-2"
            >
              <div className="flex items-center gap-2">
                <span className={`p-1.5 rounded-md ${kpi.bgColor}`}>
                  <kpi.icon className={`h-3.5 w-3.5 ${kpi.color}`} strokeWidth={1.5} />
                </span>
                <span className="text-[10px] text-white/40 uppercase tracking-wider">{kpi.label}</span>
              </div>
              <p className="text-2xl font-semibold text-foreground">{kpi.value}</p>
            </div>
          ))}
        </div>

        {/* Charts row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Sessions over time */}
          <div className="bg-white/5 border border-white/10 rounded-lg p-4" data-testid="sessions-chart">
            <h2 className="text-sm font-medium text-foreground mb-4 flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-emerald-400" strokeWidth={1.5} />
              Sessions Over Time ({periodLabel})
            </h2>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={timeSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: 'rgba(255,255,255,0.3)', fontSize: 10 }}
                    tickFormatter={(d) => d.slice(5)}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fill: 'rgba(255,255,255,0.3)', fontSize: 10 }}
                    allowDecimals={false}
                  />
                  <Tooltip
                    contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px' }}
                    labelStyle={{ color: 'rgba(255,255,255,0.6)' }}
                    itemStyle={{ color: '#10b981' }}
                  />
                  <Line
                    type="monotone"
                    dataKey="sessions"
                    stroke="#10b981"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, fill: '#10b981' }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Topics bar chart */}
          <div className="bg-white/5 border border-white/10 rounded-lg p-4" data-testid="topics-chart">
            <h2 className="text-sm font-medium text-foreground mb-4 flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-cyan-400" strokeWidth={1.5} />
              Service Categories
            </h2>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topics.slice(0, 10)} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis
                    type="number"
                    tick={{ fill: 'rgba(255,255,255,0.3)', fontSize: 10 }}
                    allowDecimals={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="topic"
                    tick={{ fill: 'rgba(255,255,255,0.5)', fontSize: 11 }}
                    width={120}
                  />
                  <Tooltip
                    contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px' }}
                    labelStyle={{ color: 'rgba(255,255,255,0.6)' }}
                  />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                    {topics.slice(0, 10).map((_, i) => (
                      <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} fillOpacity={0.8} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* Worker Performance Section */}
        <div className="bg-white/5 border border-white/10 rounded-lg p-4" data-testid="workers-section">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-medium text-foreground flex items-center gap-2">
              <Users className="h-4 w-4 text-violet-400" strokeWidth={1.5} />
              Worker Performance
            </h2>
            <div className="flex rounded-lg border border-white/10 overflow-hidden">
              {[
                { key: 'performance', label: 'Performance' },
                { key: 'activity', label: 'Activity & Wellness' },
              ].map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setWorkerTab(tab.key)}
                  className={`px-3 py-1 text-[11px] font-medium transition-colors ${
                    workerTab === tab.key
                      ? 'bg-[#E0FF00]/15 text-[#E0FF00]'
                      : 'text-white/40 hover:text-white/60'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {workers.length === 0 ? (
            <p className="text-xs text-white/30 py-4 text-center">No worker data available</p>
          ) : workerTab === 'performance' ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-white/40 border-b border-white/10">
                    <th className="text-left py-2 pr-4 font-medium">Worker</th>
                    <th className="text-left py-2 px-3 font-medium">Role</th>
                    <th className="text-right py-2 px-3 font-medium">Sessions</th>
                    <th className="text-right py-2 px-3 font-medium">Tasks/Week</th>
                    <th className="text-right py-2 px-3 font-medium">Completion</th>
                    <th className="text-right py-2 px-3 font-medium">On-Time</th>
                    <th className="text-right py-2 px-3 font-medium">Avg Response</th>
                    <th className="text-right py-2 px-3 font-medium">Satisfaction</th>
                    <th className="text-right py-2 pl-3 font-medium">Safety</th>
                  </tr>
                </thead>
                <tbody>
                  {workers.map((w) => (
                    <tr key={w.worker_id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                      <td className="py-2.5 pr-4 text-white/80 font-medium">{w.worker_name}</td>
                      <td className="py-2.5 px-3 text-white/50">{w.worker_role || '--'}</td>
                      <td className="text-right py-2.5 px-3 text-white/60">{w.total_sessions}</td>
                      <td className="text-right py-2.5 px-3 text-white/60">{w.tasks_this_week || '--'}</td>
                      <td className="text-right py-2.5 px-3">
                        <span className={w.task_completion_rate >= 80 ? 'text-emerald-400' : w.task_completion_rate >= 50 ? 'text-amber-400' : 'text-red-400'}>
                          {w.task_completion_rate}%
                        </span>
                      </td>
                      <td className="text-right py-2.5 px-3">
                        <span className={(w.on_time_pct || 0) >= 90 ? 'text-emerald-400' : (w.on_time_pct || 0) >= 75 ? 'text-amber-400' : 'text-red-400'}>
                          {w.on_time_pct ? `${w.on_time_pct}%` : '--'}
                        </span>
                      </td>
                      <td className="text-right py-2.5 px-3 text-white/60">
                        {w.avg_response_time_min ? `${w.avg_response_time_min}m` : '--'}
                      </td>
                      <td className="text-right py-2.5 px-3">
                        <span className={w.customer_satisfaction >= 0.7 ? 'text-emerald-400' : 'text-amber-400'}>
                          {w.customer_satisfaction ? `${(w.customer_satisfaction * 100).toFixed(0)}%` : '--'}
                        </span>
                      </td>
                      <td className="text-right py-2.5 pl-3">
                        <span className={w.safety_flags > 3 ? 'text-red-400' : w.safety_flags > 0 ? 'text-amber-400' : 'text-emerald-400'}>
                          {w.safety_flags}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-white/40 border-b border-white/10">
                    <th className="text-left py-2 pr-4 font-medium">Worker</th>
                    <th className="text-left py-2 px-3 font-medium">Role</th>
                    <th className="text-right py-2 px-3 font-medium">
                      <span className="inline-flex items-center gap-1"><Route className="h-3 w-3" />Distance</span>
                    </th>
                    <th className="text-right py-2 px-3 font-medium">
                      <span className="inline-flex items-center gap-1"><Flame className="h-3 w-3" />Calories</span>
                    </th>
                    <th className="text-right py-2 px-3 font-medium">
                      <span className="inline-flex items-center gap-1"><Timer className="h-3 w-3" />Avg Duration</span>
                    </th>
                    <th className="text-right py-2 px-3 font-medium">Sessions</th>
                    <th className="text-right py-2 pl-3 font-medium">Tasks/Week</th>
                  </tr>
                </thead>
                <tbody>
                  {workers.map((w) => (
                    <tr key={w.worker_id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                      <td className="py-2.5 pr-4 text-white/80 font-medium">{w.worker_name}</td>
                      <td className="py-2.5 px-3 text-white/50">{w.worker_role || '--'}</td>
                      <td className="text-right py-2.5 px-3">
                        <span className="text-cyan-400">{w.distance_miles ? `${w.distance_miles} mi` : '--'}</span>
                      </td>
                      <td className="text-right py-2.5 px-3">
                        <span className="text-orange-400">{w.calories_burned ? w.calories_burned.toLocaleString() : '--'}</span>
                      </td>
                      <td className="text-right py-2.5 px-3 text-white/60">{formatDuration(w.avg_duration_ms)}</td>
                      <td className="text-right py-2.5 px-3 text-white/60">{w.total_sessions}</td>
                      <td className="text-right py-2.5 pl-3 text-white/60">{w.tasks_this_week || '--'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {/* Summary row */}
              <div className="mt-3 pt-3 border-t border-white/10 flex items-center gap-6 text-[11px]">
                <div className="flex items-center gap-1.5">
                  <Route className="h-3.5 w-3.5 text-cyan-400" strokeWidth={1.5} />
                  <span className="text-white/50">Total Distance:</span>
                  <span className="text-cyan-400 font-medium">
                    {workers.reduce((sum, w) => sum + (w.distance_miles || 0), 0)} mi
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Flame className="h-3.5 w-3.5 text-orange-400" strokeWidth={1.5} />
                  <span className="text-white/50">Total Calories:</span>
                  <span className="text-orange-400 font-medium">
                    {workers.reduce((sum, w) => sum + (w.calories_burned || 0), 0).toLocaleString()}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Compliance panel */}
        <div className="bg-white/5 border border-white/10 rounded-lg p-4" data-testid="compliance-panel">
          <h2 className="text-sm font-medium text-foreground mb-4 flex items-center gap-2">
            <Shield className="h-4 w-4 text-amber-400" strokeWidth={1.5} />
            Compliance Rates
          </h2>
          {complianceItems.length === 0 ? (
            <p className="text-xs text-white/30 py-4 text-center">No compliance data available</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
              {complianceItems.map((item) => (
                <div key={item.label}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs text-white/60">{item.label}</span>
                    <span className={`text-xs font-medium ${item.pct >= 80 ? 'text-emerald-400' : item.pct >= 50 ? 'text-amber-400' : 'text-red-400'}`}>
                      {item.pct}%
                    </span>
                  </div>
                  <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        item.pct >= 80 ? 'bg-emerald-400' : item.pct >= 50 ? 'bg-amber-400' : 'bg-red-400'
                      }`}
                      style={{ width: `${Math.min(item.pct, 100)}%` }}
                    />
                  </div>
                </div>
              ))}
              {compliance?.total_sessions_checked > 0 && (
                <p className="text-[10px] text-white/30 sm:col-span-2 lg:col-span-5 pt-2 border-t border-white/10">
                  Based on {compliance.total_sessions_checked} analyzed sessions
                </p>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
