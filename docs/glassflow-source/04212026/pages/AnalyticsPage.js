import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Loader2 } from 'lucide-react';
import {
  getAnalyticsOverview, getAnalyticsWorkers,
  getAnalyticsSessionsOverTime, getAnalyticsTopics,
  getAnalyticsCompliance,
} from '@/lib/api';
import {
  DEMO_ANALYTICS_OVERVIEW, DEMO_ANALYTICS_WORKERS,
  DEMO_ANALYTICS_TIME_SERIES, DEMO_ANALYTICS_TOPICS,
  DEMO_ANALYTICS_COMPLIANCE,
} from '@/lib/demoData';
import { toast } from 'sonner';

const formatDurationMin = (ms) => {
  if (!ms) return '0m';
  const m = Math.floor(ms / 60000);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}m`;
};

const CATEGORY_COLORS = ['var(--lime)', '#7FB7FF', '#B794FF', 'var(--mint)', 'var(--amber)', '#FF6B5E', '#FFB547'];

export default function AnalyticsPage() {
  const [overview, setOverview] = useState(null);
  const [workers, setWorkers] = useState([]);
  const [timeSeries, setTimeSeries] = useState([]);
  const [topics, setTopics] = useState([]);
  const [compliance, setCompliance] = useState(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState('Week');
  const [workerTab, setWorkerTab] = useState('performance');

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const days = period === 'Day' ? 1 : period === 'Week' ? 7 : 30;
      const [ov, wk, ts, tp, cp] = await Promise.all([
        getAnalyticsOverview().catch(() => null),
        getAnalyticsWorkers().catch(() => []),
        getAnalyticsSessionsOverTime(days).catch(() => []),
        getAnalyticsTopics().catch(() => []),
        getAnalyticsCompliance().catch(() => null),
      ]);
      const hasOv = ov && typeof ov === 'object' && ov.total_sessions != null;
      const hasCp = cp && typeof cp === 'object' && cp.rates && Object.keys(cp.rates).length > 0;
      setOverview(hasOv ? ov : DEMO_ANALYTICS_OVERVIEW);
      setWorkers(Array.isArray(wk) && wk.length > 0 ? wk : DEMO_ANALYTICS_WORKERS);
      setTimeSeries(Array.isArray(ts) && ts.length > 0 ? ts : DEMO_ANALYTICS_TIME_SERIES.slice(-days));
      setTopics(Array.isArray(tp) && tp.length > 0 ? tp : DEMO_ANALYTICS_TOPICS);
      setCompliance(hasCp ? cp : DEMO_ANALYTICS_COMPLIANCE);
      if (!hasOv && (!Array.isArray(wk) || wk.length === 0)) toast.info('Showing demo analytics');
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
  }, [period]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // KPIs
  const avgDuration = formatDurationMin(overview?.avg_duration_ms);
  const safetyFlags = overview?.safety_flags_count ?? 0;
  const satisfactionPct = overview?.customer_satisfaction_avg != null
    ? Math.round(overview.customer_satisfaction_avg * 100)
    : 0;

  const kpis = [
    { k: 'Sessions', v: overview?.total_sessions ?? '—' },
    { k: 'Avg duration', v: avgDuration },
    { k: 'Completion', v: `${overview?.task_completion_pct ?? 0}%` },
    { k: 'Safety flags', v: safetyFlags },
    { k: 'Satisfaction', v: `${satisfactionPct}%` },
  ];

  // Time-series chart
  const maxSessions = timeSeries.reduce((m, d) => Math.max(m, d.sessions || 0), 0) || 1;
  const chartW = 640;
  const chartH = 240;
  const padL = 40;
  const padR = 16;
  const padT = 20;
  const padB = 30;
  const innerW = chartW - padL - padR;
  const innerH = chartH - padT - padB;
  const step = timeSeries.length > 1 ? innerW / (timeSeries.length - 1) : innerW;

  const topicsMax = topics.reduce((m, t) => Math.max(m, t.count || 0), 0) || 1;

  return (
    <div className="gf-page min-h-screen" data-testid="analytics-page" style={{ background: 'var(--gf-bg)' }}>
      <main className="max-w-[1400px] mx-auto p-6 sm:p-8 space-y-5">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] mb-1.5" style={{ color: 'var(--gf-text-faint)' }}>Insights</div>
            <h1 className="text-[28px] font-semibold tracking-tight" style={{ color: 'var(--gf-text)' }}>Analytics</h1>
            <p className="text-[13px] mt-1" style={{ color: 'var(--gf-text-dim)' }}>
              Cross-session KPIs, trends, and worker performance · {timeSeries.length} day{timeSeries.length === 1 ? '' : 's'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div
              className="flex items-center gap-1 rounded-md border hairline p-0.5"
              style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
            >
              {['Day', 'Week', 'Month'].map((p) => {
                const active = period === p;
                return (
                  <button
                    key={p}
                    onClick={() => setPeriod(p)}
                    className="h-7 px-3 rounded text-[11.5px]"
                    style={{
                      background: active ? 'var(--lime-soft)' : 'transparent',
                      color: active ? 'var(--lime)' : 'var(--gf-text-dim)',
                    }}
                  >
                    {p}
                  </button>
                );
              })}
            </div>
            <button
              onClick={fetchAll}
              className="btn-ghost h-9 px-3 rounded-md text-[12px] flex items-center gap-1.5"
            >
              <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.5} />
            </button>
          </div>
        </div>

        {loading && !overview ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin" style={{ color: 'var(--lime)' }} />
          </div>
        ) : (
          <>
            {/* KPI strip */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {kpis.map((k) => (
                <div
                  key={k.k}
                  className="rounded-xl border hairline p-4"
                  style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
                >
                  <div className="text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--gf-text-faint)' }}>{k.k}</div>
                  <div className="num text-[26px] font-medium mt-1" style={{ color: 'var(--gf-text)' }}>{k.v}</div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
              {/* Sessions over time */}
              <div
                className="lg:col-span-8 rounded-2xl border hairline p-5"
                style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
              >
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-[14px] font-semibold" style={{ color: 'var(--gf-text)' }}>Sessions over time</h3>
                    <div className="text-[11px]" style={{ color: 'var(--gf-text-dim)' }}>Guided sessions per day</div>
                  </div>
                  <div className="flex items-center gap-3 text-[10px] gf-mono" style={{ color: 'var(--gf-text-dim)' }}>
                    <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-sm" style={{ background: 'var(--lime)' }} />Sessions</div>
                  </div>
                </div>
                <svg viewBox={`0 0 ${chartW} ${chartH}`} className="w-full h-[240px]" preserveAspectRatio="none">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <line
                      key={i}
                      x1={padL}
                      x2={chartW - padR}
                      y1={padT + i * (innerH / 4)}
                      y2={padT + i * (innerH / 4)}
                      stroke="rgba(255,255,255,0.05)"
                      strokeWidth="1"
                    />
                  ))}
                  {timeSeries.map((d, i) => {
                    const v = d.sessions || 0;
                    const h = (v / maxSessions) * innerH;
                    const x = padL + i * step;
                    return (
                      <g key={i}>
                        <rect x={x - 6} y={padT + innerH - h} width="12" height={h} fill="var(--lime)" rx="2" opacity="0.85" />
                      </g>
                    );
                  })}
                  {/* connect line */}
                  {timeSeries.length > 1 && (
                    <path
                      d={timeSeries.map((d, i) => {
                        const v = d.sessions || 0;
                        const x = padL + i * step;
                        const y = padT + innerH - (v / maxSessions) * innerH;
                        return `${i === 0 ? 'M' : 'L'}${x},${y}`;
                      }).join(' ')}
                      stroke="var(--lime)"
                      strokeWidth="1.5"
                      fill="none"
                      opacity="0.5"
                    />
                  )}
                  {/* y-axis labels */}
                  {[0, 1, 2, 3, 4].map((i) => {
                    const v = Math.round((maxSessions / 4) * (4 - i));
                    return (
                      <text
                        key={i}
                        x={padL - 6}
                        y={padT + i * (innerH / 4) + 3}
                        textAnchor="end"
                        fontSize="9"
                        fill="rgba(255,255,255,0.3)"
                        fontFamily="monospace"
                      >
                        {v}
                      </text>
                    );
                  })}
                  {/* x-axis labels */}
                  {timeSeries.map((d, i) => {
                    if (timeSeries.length > 12 && i % Math.ceil(timeSeries.length / 12) !== 0) return null;
                    const lbl = String(d.date || '').slice(-5);
                    return (
                      <text
                        key={i}
                        x={padL + i * step}
                        y={chartH - 12}
                        textAnchor="middle"
                        fontSize="9"
                        fill="rgba(255,255,255,0.35)"
                        fontFamily="monospace"
                      >
                        {lbl}
                      </text>
                    );
                  })}
                </svg>
              </div>

              {/* Service categories */}
              <div
                className="lg:col-span-4 rounded-2xl border hairline p-5"
                style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
              >
                <h3 className="text-[14px] font-semibold mb-1" style={{ color: 'var(--gf-text)' }}>Service categories</h3>
                <div className="text-[11px] mb-4" style={{ color: 'var(--gf-text-dim)' }}>Sessions this period</div>
                <div className="space-y-2.5">
                  {topics.slice(0, 8).map((t, i) => (
                    <div key={i} className="grid grid-cols-[110px_1fr_32px] items-center gap-2 text-[11.5px]">
                      <div className="truncate" style={{ color: 'var(--gf-text-dim)' }}>{t.topic}</div>
                      <div className="h-4 rounded-sm overflow-hidden" style={{ background: 'rgba(255,255,255,0.04)' }}>
                        <div
                          className="h-full rounded-sm"
                          style={{ width: `${((t.count || 0) / topicsMax) * 100}%`, background: CATEGORY_COLORS[i % CATEGORY_COLORS.length] }}
                        />
                      </div>
                      <div className="text-[10px] gf-mono text-right" style={{ color: 'var(--gf-text-dim)' }}>{t.count}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Worker performance table */}
            <div
              className="rounded-2xl border hairline overflow-hidden"
              style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
            >
              <div className="px-5 py-4 border-b hairline flex items-center justify-between" style={{ borderBottomColor: 'var(--gf-line)' }}>
                <div>
                  <h3 className="text-[14px] font-semibold" style={{ color: 'var(--gf-text)' }}>Worker performance</h3>
                  <div className="text-[11px]" style={{ color: 'var(--gf-text-dim)' }}>Per-worker breakdown</div>
                </div>
                <div className="flex gap-1 text-[11px]">
                  {['performance', 'activity'].map((t) => {
                    const active = workerTab === t;
                    return (
                      <button
                        key={t}
                        onClick={() => setWorkerTab(t)}
                        className="h-7 px-3 rounded capitalize"
                        style={{
                          background: active ? 'var(--lime-soft)' : 'transparent',
                          color: active ? 'var(--lime)' : 'var(--gf-text-dim)',
                        }}
                      >
                        {t}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="text-[10px] gf-mono uppercase tracking-wider" style={{ color: 'var(--gf-text-faint)' }}>
                      <th className="text-left px-5 py-2.5">Worker</th>
                      <th className="text-left px-3 py-2.5">Role</th>
                      <th className="text-right px-3 py-2.5">Sessions</th>
                      {workerTab === 'performance' ? (
                        <>
                          <th className="text-right px-3 py-2.5">Completion</th>
                          <th className="text-right px-3 py-2.5">On-time</th>
                          <th className="text-right px-3 py-2.5">Satisfaction</th>
                          <th className="text-right px-5 py-2.5">Safety</th>
                        </>
                      ) : (
                        <>
                          <th className="text-right px-3 py-2.5">This week</th>
                          <th className="text-right px-3 py-2.5">Avg response</th>
                          <th className="text-right px-3 py-2.5">Distance</th>
                          <th className="text-right px-5 py-2.5">Calories</th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {workers.map((w) => (
                      <tr
                        key={w.worker_id}
                        className="border-t hairline"
                        style={{ borderTopColor: 'var(--gf-line)' }}
                      >
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2.5">
                            <div
                              className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-semibold text-black shrink-0"
                              style={{ background: 'linear-gradient(135deg, #7FB7FF, #B794FF)' }}
                            >
                              {(w.worker_name || '—').split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase()}
                            </div>
                            <span className="font-medium" style={{ color: 'var(--gf-text)' }}>{w.worker_name}</span>
                          </div>
                        </td>
                        <td className="px-3 py-3 truncate" style={{ color: 'var(--gf-text-dim)' }}>{w.worker_role}</td>
                        <td className="px-3 py-3 gf-mono text-right" style={{ color: 'var(--gf-text)' }}>{w.total_sessions}</td>
                        {workerTab === 'performance' ? (
                          <>
                            <td className="px-3 py-3 gf-mono text-right" style={{ color: 'var(--mint)' }}>{w.task_completion_rate}%</td>
                            <td className="px-3 py-3 gf-mono text-right" style={{ color: 'var(--gf-text-dim)' }}>{w.on_time_pct}%</td>
                            <td className="px-3 py-3 gf-mono text-right" style={{ color: 'var(--gf-text-dim)' }}>{Math.round((w.customer_satisfaction || 0) * 100)}%</td>
                            <td className="px-5 py-3 gf-mono text-right" style={{ color: w.safety_flags === 0 ? 'var(--mint)' : 'var(--amber)' }}>{w.safety_flags}</td>
                          </>
                        ) : (
                          <>
                            <td className="px-3 py-3 gf-mono text-right" style={{ color: 'var(--gf-text)' }}>{w.tasks_this_week}</td>
                            <td className="px-3 py-3 gf-mono text-right" style={{ color: 'var(--gf-text-dim)' }}>{w.avg_response_time_min}m</td>
                            <td className="px-3 py-3 gf-mono text-right" style={{ color: 'var(--gf-text-dim)' }}>{w.distance_miles}mi</td>
                            <td className="px-5 py-3 gf-mono text-right" style={{ color: 'var(--gf-text-dim)' }}>{w.calories_burned}</td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Compliance */}
            {compliance?.rates && (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                {Object.entries(compliance.rates).slice(0, 5).map(([k, v]) => (
                  <div
                    key={k}
                    className="rounded-xl border hairline p-4"
                    style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
                  >
                    <div className="text-[10px] uppercase tracking-[0.16em] capitalize" style={{ color: 'var(--gf-text-faint)' }}>
                      {k.replace(/_/g, ' ')}
                    </div>
                    <div className="num text-[22px] font-medium mt-1" style={{ color: Number(v) >= 90 ? 'var(--mint)' : Number(v) >= 70 ? 'var(--amber)' : 'var(--red)' }}>
                      {v}%
                    </div>
                    <div className="mt-1.5 h-1 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${Math.min(100, Number(v) || 0)}%`, background: 'var(--lime)' }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
