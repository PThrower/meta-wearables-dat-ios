import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell, AlertTriangle, Flag, Eye, Clock, MapPin, Radio, Bot,
  Zap, Plus, MoreHorizontal, Search, Filter, BarChart3, Download,
  Loader2, Check, MessageSquare,
} from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { useAuth } from '@/context/AuthContext';
import {
  getStats, getInsightsSummary, getAgents, toggleAgent,
  generateReport, getStreamSessions, getVideos, supabase,
} from '@/lib/api';
import {
  DEMO_AGENTS,
  DEMO_STATS,
  DEMO_ACTIVE_SESSIONS,
  DEMO_GUIDANCE_EVENTS,
  DEMO_REPORTS,
} from '@/lib/demoData';

const toArray = (v) => Array.isArray(v) ? v : Array.isArray(v?.items) ? v.items : Array.isArray(v?.data) ? v.data : [];

const toStreamFormat = (d) => ({
  id: d.id,
  device_name: d.device_name,
  status: 'active',
  started_at: d.started_at,
  participant_count: 1,
  metadata_json: { technician: d.worker, job_type: d.task },
});

const timeAgo = (iso) => {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

// ============ Greeting ============
const Greeting = ({ user, stats, attentionCount }) => {
  const now = new Date();
  const hr = now.getHours();
  const greet =
    hr < 5 ? 'Still up'
    : hr < 12 ? 'Good morning'
    : hr < 17 ? 'Good afternoon'
    : hr < 21 ? 'Good evening'
    : 'Good night';
  const name = user?.firstName || user?.username || 'Operator';
  const live = stats?.active_workers ?? stats?.active_glasses ?? 0;
  const total = stats?.total_devices ?? stats?.fleet_total ?? live;
  const steady = attentionCount === 0;
  const dateStr = now.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const timeStr = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.18em] mb-2" style={{ color: 'var(--gf-text-faint)' }}>
        {dateStr} · {timeStr}
      </div>
      <h1 className="text-[38px] leading-[1.05] tracking-tight font-medium" style={{ color: 'var(--gf-text)' }}>
        {greet}, {name}.{' '}
        <span className="font-serif-i" style={{ color: 'var(--lime)' }}>
          {steady ? 'Fleet is steady.' : 'Fleet needs a look.'}
        </span>
      </h1>
      <p className="text-[14px] mt-2 max-w-[620px]" style={{ color: 'var(--gf-text-dim)' }}>
        {live} of {total || live} glasses are live.
        {attentionCount > 0 ? ` ${attentionCount} thread${attentionCount === 1 ? '' : 's'} need your attention.` : ' All threads are calm.'}
      </p>
    </div>
  );
};

// ============ Pulse Strip ============
const PulseCard = ({ label, value, sub, accent, footer, children }) => (
  <div
    className="rounded-2xl border hairline p-5 relative overflow-hidden"
    style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
  >
    <div className="flex items-center justify-between gap-2">
      <div className="text-[11px] uppercase tracking-[0.16em] whitespace-nowrap truncate" style={{ color: 'var(--gf-text-dim)' }}>
        {label}
      </div>
      {accent && (
        <div
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{ background: accent, boxShadow: `0 0 0 4px ${accent}22` }}
        />
      )}
    </div>
    <div className="mt-3 flex items-baseline gap-2">
      <span className="num text-[44px] font-medium leading-none" style={{ color: 'var(--gf-text)' }}>{value}</span>
      {sub && <span className="text-[13px]" style={{ color: 'var(--gf-text-dim)' }}>{sub}</span>}
    </div>
    {children}
    {footer && (
      <div className="mt-4 pt-3 border-t hairline text-[11px]" style={{ borderTopColor: 'var(--gf-line)', color: 'var(--gf-text-dim)' }}>
        {footer}
      </div>
    )}
  </div>
);

const PulseStrip = ({ stats, activeSessionsCount, attentionCount, insights }) => {
  const live = activeSessionsCount;
  const total = stats?.total_devices ?? Math.max(live, 6);
  const attention = attentionCount;
  const guidance = stats?.guidance_events_today ?? 0;
  const avgResp = stats?.avg_response_time ?? '14s';
  const calls = stats?.service_calls_today ?? 0;
  const completed = stats?.tasks_completed ?? 0;
  const planned = stats?.tasks_today ?? Math.max(completed, 1);
  const compliance = insights?.safety_compliance ?? stats?.guidance_compliance_pct ?? 94;

  // Mini ring: live / total
  const ring = (() => {
    const r = 28;
    const c = Math.PI * 2 * r;
    const frac = total > 0 ? live / total : 0;
    return (
      <svg width="72" height="72" viewBox="0 0 72 72" className="absolute top-4 right-4 opacity-90">
        <circle cx="36" cy="36" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="6" />
        <circle
          cx="36" cy="36" r={r} fill="none"
          stroke="var(--lime)" strokeWidth="6"
          strokeDasharray={`${frac * c} ${c}`}
          strokeLinecap="round"
          transform="rotate(-90 36 36)"
        />
        <text x="36" y="41" textAnchor="middle" fill="currentColor" fontSize="14" fontWeight="600" style={{ color: 'var(--gf-text)' }}>
          {live}/{total}
        </text>
      </svg>
    );
  })();

  const donePct = planned > 0 ? Math.round((completed / planned) * 100) : 0;
  const bars = [3, 5, 2, 6, 4, 3]; // visual only

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <PulseCard
        label="Live now" value={live} sub="glasses broadcasting" accent="#D4FF3A"
        footer={<span>Fleet of <span style={{ color: 'var(--gf-text)' }}>{total}</span> · {Math.max(total - live, 0)} idle or offline</span>}
      >
        {ring}
      </PulseCard>

      <PulseCard
        label="Attention" value={attention} sub="open threads" accent="#FFB547"
        footer={
          <span style={{ color: 'var(--amber)' }}>
            {attention === 0 ? 'All quiet' : `${attention} open thread${attention === 1 ? '' : 's'}`}
          </span>
        }
      >
        <div className="mt-4 text-[11px]" style={{ color: 'var(--gf-text-dim)' }}>
          {attention > 0 ? 'Scroll down to review' : 'Nothing needs you right now'}
        </div>
      </PulseCard>

      <PulseCard
        label="Guidance today" value={guidance} sub="events delivered" accent="#7FB7FF"
        footer={
          <span>
            avg response <span className="gf-mono" style={{ color: 'var(--gf-text)' }}>{avgResp}</span> · calls <span className="gf-mono" style={{ color: 'var(--gf-text)' }}>{calls}</span>
          </span>
        }
      >
        <div className="mt-4 flex items-end gap-1.5 h-8">
          {bars.map((b, i) => (
            <div
              key={i}
              className="flex-1 rounded-sm"
              style={{ height: `${b * 13}%`, background: 'var(--lime)', opacity: 0.3 + i * 0.12 }}
            />
          ))}
        </div>
      </PulseCard>

      <PulseCard
        label="Tasks today" value={completed} sub={`/ ${planned} today`} accent="#5FE3B0"
        footer={<span style={{ color: 'var(--mint)' }}>On pace · {compliance}% compliance</span>}
      >
        <div className="mt-4 h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
          <div
            className="h-full rounded-full"
            style={{ width: `${donePct}%`, background: 'linear-gradient(90deg, var(--lime), var(--mint))' }}
          />
        </div>
        <div className="mt-2 flex justify-between text-[10px] gf-mono" style={{ color: 'var(--gf-text-faint)' }}>
          <span>{donePct}%</span><span>{Math.max(planned - completed, 0)} remaining</span>
        </div>
      </PulseCard>
    </div>
  );
};

// ============ Attention Queue ============
const AttentionQueue = ({ items }) => {
  const color = (s) => (s === 'alert' || s === 'high' ? '#FF6B5E' : s === 'warn' || s === 'medium' ? '#FFB547' : '#7FB7FF');
  const label = (s) => (s === 'alert' || s === 'high' ? 'ALERT' : s === 'warn' || s === 'medium' ? 'WARNING' : 'INFO');
  const icon = (s) =>
    s === 'alert' || s === 'high' ? <AlertTriangle className="h-3.5 w-3.5" strokeWidth={1.5} /> :
    s === 'warn' || s === 'medium' ? <Flag className="h-3.5 w-3.5" strokeWidth={1.5} /> :
    <Eye className="h-3.5 w-3.5" strokeWidth={1.5} />;

  return (
    <section className="rounded-2xl border hairline overflow-hidden" style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}>
      <header className="flex items-center justify-between px-5 py-4 border-b hairline" style={{ borderBottomColor: 'var(--gf-line)' }}>
        <div className="flex items-center gap-2.5">
          <Bell className="h-4 w-4" strokeWidth={1.5} />
          <h3 className="text-[14px] font-semibold" style={{ color: 'var(--gf-text)' }}>Needs your attention</h3>
          <span className="gf-badge gf-badge-warn">{items.length} open</span>
        </div>
        <button className="text-[11px]" style={{ color: 'var(--gf-text-dim)' }}>View all threads</button>
      </header>
      {items.length === 0 ? (
        <div className="px-5 py-8 text-center text-[12px]" style={{ color: 'var(--gf-text-faint)' }}>
          All clear. No open safety or attention threads.
        </div>
      ) : (
        <div>
          {items.map((it, i) => (
            <div
              key={i}
              className="px-5 py-4 border-b hairline last:border-b-0 transition"
              style={{ borderBottomColor: 'var(--gf-line)' }}
            >
              <div className="flex items-start gap-3">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                  style={{ background: `${color(it.severity)}1F`, color: color(it.severity) }}
                >
                  {icon(it.severity)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] gf-mono font-semibold tracking-wider" style={{ color: color(it.severity) }}>
                      {label(it.severity)}
                    </span>
                    <span className="text-[13px] font-medium" style={{ color: 'var(--gf-text)' }}>{it.title}</span>
                  </div>
                  <div className="text-[12px] mt-0.5" style={{ color: 'var(--gf-text-dim)' }}>
                    {it.who} · {it.at}
                  </div>
                  <p className="text-[13px] mt-2 leading-relaxed" style={{ color: 'var(--gf-text)' }}>{it.body}</p>
                  <div className="mt-3 flex gap-2 flex-wrap">
                    {it.actions.map((a, j) => (
                      <button
                        key={j}
                        onClick={a.onClick}
                        className={`text-[11.5px] px-3 h-7 rounded-md whitespace-nowrap ${j === 0 ? 'btn-lime font-medium' : 'btn-ghost'}`}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

// ============ Activity Feed ============
const ActivityFeed = ({ events, onOpen }) => (
  <section className="rounded-2xl border hairline overflow-hidden" style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}>
    <header className="flex items-center justify-between px-5 py-4 border-b hairline" style={{ borderBottomColor: 'var(--gf-line)' }}>
      <div className="flex items-center gap-2.5">
        <Radio className="h-4 w-4" strokeWidth={1.5} />
        <h3 className="text-[14px] font-semibold" style={{ color: 'var(--gf-text)' }}>Guidance feed</h3>
        <span className="live-dot ml-1" />
        <span className="text-[10px] gf-mono" style={{ color: 'var(--gf-text-faint)' }}>LIVE</span>
      </div>
      <button onClick={onOpen} className="text-[11px]" style={{ color: 'var(--gf-text-dim)' }}>Open streams →</button>
    </header>
    <div className="max-h-[340px] overflow-y-auto scroll-area divide-y hairline">
      {events.length === 0 ? (
        <div className="px-5 py-8 text-center text-[12px]" style={{ color: 'var(--gf-text-faint)' }}>
          No guidance events yet today.
        </div>
      ) : (
        events.map((g, i) => {
          const c =
            g.severity === 'high' || g.severity === 'alert' ? '#FF6B5E' :
            g.severity === 'medium' || g.severity === 'warn' ? '#FFB547' :
            g.severity === 'ok' ? '#5FE3B0' : '#7FB7FF';
          const when = g.timestamp
            ? new Date(g.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : g.t || '';
          return (
            <div key={g.id || i} className="px-5 py-3.5 flex items-start gap-3">
              <div className="w-10 text-[10px] gf-mono pt-0.5" style={{ color: 'var(--gf-text-faint)' }}>{when}</div>
              <div className="w-1 rounded-full self-stretch" style={{ background: c }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-0.5">
                  <span className="text-[12px] font-medium" style={{ color: 'var(--gf-text)' }}>{g.worker || g.participant || '—'}</span>
                  {g.device_id && <span className="text-[10px] gf-mono" style={{ color: 'var(--gf-text-faint)' }}>{g.device_id}</span>}
                  {g.skill && <span className="gf-badge" style={{ background: `${c}1A`, color: c }}>{g.skill}</span>}
                </div>
                <div className="text-[12.5px] leading-snug" style={{ color: 'var(--gf-text)' }}>
                  {g.message || g.text}
                </div>
              </div>
              <button className="shrink-0" style={{ color: 'var(--gf-text-faint)' }}>
                <MoreHorizontal className="h-3.5 w-3.5" strokeWidth={1.5} />
              </button>
            </div>
          );
        })
      )}
    </div>
  </section>
);

// ============ Field Map ============
const FleetMap = ({ sessions }) => {
  const pins = sessions.slice(0, 6).map((s, i) => {
    const positions = [
      { x: 22, y: 38 }, { x: 62, y: 28 }, { x: 48, y: 55 },
      { x: 32, y: 70 }, { x: 78, y: 62 }, { x: 70, y: 80 },
    ];
    return {
      ...positions[i],
      color: s.status === 'attention' ? '#FFB547' : s.status === 'offline' ? '#5B6068' : '#D4FF3A',
      label: (s.metadata_json?.technician || s.device_name || '—').split(' ')[0],
    };
  });

  // Default placeholder pins if no data
  const fallback = [
    { x: 22, y: 38, color: '#D4FF3A', label: '—' },
    { x: 62, y: 28, color: '#D4FF3A', label: '—' },
  ];
  const display = pins.length > 0 ? pins : fallback;

  return (
    <section className="rounded-2xl border hairline overflow-hidden" style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}>
      <header className="flex items-center justify-between px-5 py-4 border-b hairline" style={{ borderBottomColor: 'var(--gf-line)' }}>
        <div className="flex items-center gap-2.5">
          <MapPin className="h-[15px] w-[15px]" strokeWidth={1.5} />
          <h3 className="text-[14px] font-semibold" style={{ color: 'var(--gf-text)' }}>Field map</h3>
        </div>
        <div className="flex items-center gap-1 text-[10px] gf-mono" style={{ color: 'var(--gf-text-dim)' }}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--lime)' }} /><span>live</span>
          <span className="w-1.5 h-1.5 rounded-full ml-2" style={{ background: 'var(--amber)' }} /><span>attn</span>
          <span className="w-1.5 h-1.5 rounded-full ml-2" style={{ background: 'var(--gf-text-faint)' }} /><span>off</span>
        </div>
      </header>
      <div className="map-bg relative h-[260px] dot-grid">
        <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
          <path d="M0,30 Q30,40 50,32 T100,35" stroke="rgba(255,255,255,0.05)" strokeWidth="0.25" fill="none" />
          <path d="M0,60 Q40,55 60,65 T100,62" stroke="rgba(255,255,255,0.05)" strokeWidth="0.25" fill="none" />
          <path d="M20,0 Q25,50 30,100" stroke="rgba(255,255,255,0.04)" strokeWidth="0.2" fill="none" />
          <path d="M70,0 Q75,40 72,100" stroke="rgba(255,255,255,0.04)" strokeWidth="0.2" fill="none" />
        </svg>
        {display.map((p, i) => (
          <div key={i} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${p.x}%`, top: `${p.y}%` }}>
            <div className="relative">
              <div
                className="w-2 h-2 rounded-full"
                style={{ background: p.color, boxShadow: `0 0 0 4px ${p.color}22, 0 0 0 8px ${p.color}11` }}
              />
              <div
                className="absolute top-3 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] gf-mono"
                style={{ color: 'var(--gf-text-dim)' }}
              >
                {p.label}
              </div>
            </div>
          </div>
        ))}
        <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between text-[10px] gf-mono" style={{ color: 'var(--gf-text-faint)' }}>
          <span>LIVE MAP</span>
          <span>{sessions.length} device{sessions.length === 1 ? '' : 's'}</span>
        </div>
      </div>
    </section>
  );
};

// ============ Up Next ============
const UpNext = ({ items }) => (
  <section className="rounded-2xl border hairline overflow-hidden" style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}>
    <header className="flex items-center justify-between px-5 py-4 border-b hairline" style={{ borderBottomColor: 'var(--gf-line)' }}>
      <div className="flex items-center gap-2.5">
        <Clock className="h-[15px] w-[15px]" strokeWidth={1.5} />
        <h3 className="text-[14px] font-semibold" style={{ color: 'var(--gf-text)' }}>Up next today</h3>
      </div>
      <span className="text-[11px] gf-mono" style={{ color: 'var(--gf-text-dim)' }}>{items.length} scheduled</span>
    </header>
    {items.length === 0 ? (
      <div className="px-5 py-8 text-center text-[12px]" style={{ color: 'var(--gf-text-faint)' }}>
        Nothing scheduled yet.
      </div>
    ) : (
      <ul>
        {items.map((it, i) => (
          <li
            key={i}
            className="flex items-center gap-4 px-5 py-3 border-b hairline last:border-b-0"
            style={{ borderBottomColor: 'var(--gf-line)' }}
          >
            <div className="w-12 gf-mono text-[12px] tabular-nums" style={{ color: 'var(--gf-text-dim)' }}>{it.t}</div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium truncate" style={{ color: 'var(--gf-text)' }}>{it.task}</div>
              <div className="text-[11px] truncate" style={{ color: 'var(--gf-text-faint)' }}>{it.who} · {it.agent}</div>
            </div>
            <div className="text-[11px] gf-mono" style={{ color: 'var(--gf-text-dim)' }}>{it.eta}</div>
          </li>
        ))}
      </ul>
    )}
  </section>
);

// ============ Agent Summary ============
const AgentSummary = ({ agents, onToggle }) => (
  <section className="rounded-2xl border hairline overflow-hidden" style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}>
    <header className="flex items-center justify-between px-5 py-4 border-b hairline" style={{ borderBottomColor: 'var(--gf-line)' }}>
      <div className="flex items-center gap-2.5">
        <Bot className="h-[15px] w-[15px]" strokeWidth={1.5} />
        <h3 className="text-[14px] font-semibold" style={{ color: 'var(--gf-text)' }}>Agents deployed</h3>
        <span className="text-[11px] gf-mono" style={{ color: 'var(--gf-text-dim)' }}>{agents.length} total</span>
      </div>
      <button className="btn-ghost text-[11px] px-3 h-7 rounded-md flex items-center gap-1.5">
        <Plus className="h-3 w-3" strokeWidth={1.5} /> New agent
      </button>
    </header>
    <div>
      {agents.length === 0 ? (
        <div className="px-5 py-6 text-center text-[12px]" style={{ color: 'var(--gf-text-faint)' }}>
          No agents deployed yet.
        </div>
      ) : agents.slice(0, 6).map((a) => {
        const deployed = a.status === 'deployed' || a.status === 'active';
        return (
          <div
            key={a.id || a.name}
            className="px-5 py-3 border-b hairline last:border-b-0 flex items-center gap-4 cursor-pointer"
            style={{ borderBottomColor: 'var(--gf-line)' }}
            onClick={() => onToggle && onToggle(a)}
          >
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center text-[11px] gf-mono"
              style={{
                background: deployed ? 'var(--lime-soft)' : 'rgba(255,255,255,0.04)',
                color: deployed ? 'var(--lime)' : 'var(--gf-text-faint)',
              }}
            >
              <Zap className="h-3.5 w-3.5" strokeWidth={1.5} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium" style={{ color: 'var(--gf-text)' }}>{a.name}</div>
              <div className="text-[11px]" style={{ color: 'var(--gf-text-faint)' }}>
                {a.skills ?? a.skills_count ?? '—'} skills · edited {a.lastEdit || a.last_edit || 'recently'}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[11px] gf-mono" style={{ color: 'var(--gf-text-dim)' }}>{a.assigned ?? 0}</div>
              <div className="text-[10px]" style={{ color: 'var(--gf-text-faint)' }}>assigned</div>
            </div>
            <span className={`gf-badge ${deployed ? 'gf-badge-active' : 'gf-badge-idle'}`}>{a.status || 'idle'}</span>
          </div>
        );
      })}
    </div>
  </section>
);

// ============ Main Page ============
export default function HomePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [stats, setStats] = useState(null);
  const [insights, setInsights] = useState(null);
  const [agents, setAgents] = useState([]);
  const [activeSessions, setActiveSessions] = useState([]);
  const [guidanceEvents, setGuidanceEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generatingReport, setGeneratingReport] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [report, setReport] = useState(null);

  const fetchActive = useCallback(async () => {
    try {
      const data = await getStreamSessions({ status: 'active', creator_identity: user?.email });
      const sessions = toArray(data);
      if (sessions.length > 0) {
        setActiveSessions(sessions);
      } else if (!supabase) {
        setActiveSessions(DEMO_ACTIVE_SESSIONS.slice(0, 4).map(toStreamFormat));
      } else {
        setActiveSessions([]);
      }
    } catch {
      if (!supabase) setActiveSessions(DEMO_ACTIVE_SESSIONS.slice(0, 4).map(toStreamFormat));
    }
  }, [user?.email]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);
      try {
        const [s, ins, ag, vids] = await Promise.all([
          getStats().catch(() => null),
          getInsightsSummary().catch(() => null),
          getAgents().catch(() => []),
          getVideos({ limit: 10 }).catch(() => null),
        ]);
        if (!mounted) return;
        let normalizedStats = s && typeof s === 'object' ? s : null;
        let normalizedAgents = toArray(ag);

        if (!normalizedStats) normalizedStats = DEMO_STATS;
        if (normalizedAgents.length === 0) normalizedAgents = DEMO_AGENTS.slice(0, 5);

        setStats(normalizedStats);
        setInsights(ins);
        setAgents(normalizedAgents);

        // Build guidance feed from videos' insights if available, else use demo (small)
        const videos = toArray(vids);
        const events = videos
          .flatMap((v) => (v.guidance_events_list || v.events || []).map((e) => ({
            id: e.id || `${v.id}-${e.timestamp || Math.random()}`,
            worker: v.worker || v.participant,
            device_id: v.device_id,
            severity: e.severity || 'info',
            message: e.message || e.text,
            skill: e.skill || e.category,
            timestamp: e.timestamp || v.recorded_at,
          })))
          .slice(0, 8);
        setGuidanceEvents(events.length > 0 ? events : DEMO_GUIDANCE_EVENTS.slice(0, 5));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    fetchActive();
    const id = setInterval(fetchActive, 15000);
    return () => { mounted = false; clearInterval(id); };
  }, [fetchActive]);

  const handleToggleAgent = async (agent) => {
    if (!agent?.id) return;
    try {
      const res = await toggleAgent(agent.id);
      toast.success(res?.message || 'Agent updated');
      setAgents((prev) => prev.map((a) => a.id === agent.id ? { ...a, status: res?.status || a.status } : a));
    } catch {
      toast.error('Failed to toggle agent');
    }
  };

  const handleReport = async (period) => {
    setGeneratingReport(true);
    try {
      const data = await generateReport({ period });
      setReport(data);
      setReportOpen(true);
    } catch {
      setReport(DEMO_REPORTS[period] || DEMO_REPORTS.weekly);
      setReportOpen(true);
      toast.info('Showing demo report');
    } finally {
      setGeneratingReport(false);
    }
  };

  // Build attention queue from offline/attention sessions + high-severity events
  const attentionItems = [];
  activeSessions.forEach((s) => {
    if (s.status === 'attention' || s.attention) {
      attentionItems.push({
        severity: 'warn',
        title: s.attentionReason || 'Device needs attention',
        who: `${s.metadata_json?.technician || s.device_name} · ${s.device_id || ''}`,
        at: timeAgo(s.started_at),
        body: s.attentionReason || 'Please review this device session.',
        actions: [
          { label: 'Open stream', onClick: () => navigate(`/live?session=${s.id}`) },
          { label: 'Ping device', onClick: () => toast.info('Ping sent') },
        ],
      });
    }
  });
  guidanceEvents.filter((e) => e.severity === 'high' || e.severity === 'alert').slice(0, 3).forEach((e) => {
    attentionItems.push({
      severity: 'alert',
      title: e.message?.split('.')?.[0] || 'Safety alert',
      who: `${e.worker} · ${e.device_id || ''}`,
      at: e.timestamp ? timeAgo(e.timestamp) : 'recently',
      body: e.message,
      actions: [
        { label: 'Push to talk', onClick: () => navigate('/live') },
        { label: 'Review clip', onClick: () => navigate('/feeds') },
      ],
    });
  });

  const upNext = [
    { t: '15:00', task: 'Chiller coil inspection', who: 'Scheduled', agent: 'HVAC Diagnostics', eta: 'in 28m' },
    { t: '15:30', task: 'Fiber terminal QA pass', who: 'Scheduled', agent: 'Fiber Splice', eta: 'in 1h' },
    { t: '17:00', task: 'End-of-day sync', who: 'All workers', agent: '—', eta: 'in 3h' },
  ];

  return (
    <div className="gf-page min-h-screen" data-testid="seeit-dashboard" style={{ background: 'var(--gf-bg)' }}>
      <main className="max-w-[1400px] mx-auto p-6 sm:p-8 space-y-6">

        {/* Greeting + top actions */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <Greeting user={user} stats={stats} attentionCount={attentionItems.length} />
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleReport('daily')}
              disabled={generatingReport}
              className="btn-ghost h-9 px-3 rounded-md text-[12px] flex items-center gap-1.5 disabled:opacity-50"
            >
              {generatingReport ? <Loader2 className="h-3 w-3 animate-spin" /> : <BarChart3 className="h-3 w-3" strokeWidth={1.5} />}
              Report
            </button>
            <button
              onClick={() => navigate('/live')}
              className="btn-lime h-9 px-4 rounded-md text-[12.5px] font-medium flex items-center gap-1.5"
            >
              <Radio className="h-3 w-3" strokeWidth={1.5} /> Open streams
            </button>
          </div>
        </div>

        {/* Pulse strip */}
        <PulseStrip
          stats={stats}
          activeSessionsCount={activeSessions.length}
          attentionCount={attentionItems.length}
          insights={insights}
        />

        {/* 2-column layout */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-8 space-y-6">
            <AttentionQueue items={attentionItems} />
            <ActivityFeed events={guidanceEvents} onOpen={() => navigate('/live')} />
          </div>
          <div className="lg:col-span-4 space-y-6">
            <FleetMap sessions={activeSessions} />
            <UpNext items={upNext} />
            <AgentSummary agents={agents} onToggle={handleToggleAgent} />
          </div>
        </div>
      </main>

      {/* Report Modal */}
      <Dialog open={reportOpen} onOpenChange={setReportOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4" strokeWidth={1.5} />
              {report?.period || 'Daily'} Report
            </DialogTitle>
            <DialogDescription>{report?.date_range || 'Current period'}</DialogDescription>
          </DialogHeader>
          {report && (
            <div className="space-y-4 py-2 max-h-[60vh] overflow-y-auto scroll-area">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  { k: 'Sessions', v: report.summary?.total_sessions ?? '—' },
                  { k: 'Analyzed', v: report.summary?.analyzed ?? '—' },
                  { k: 'Workers', v: report.summary?.unique_workers ?? '—' },
                  { k: 'Duration', v: report.summary?.total_duration ?? '—' },
                ].map((s) => (
                  <div key={s.k} className="rounded-lg border hairline p-2 text-center" style={{ background: 'var(--gf-surface-2)' }}>
                    <div className="num text-[20px] font-medium">{s.v}</div>
                    <div className="text-[10px]" style={{ color: 'var(--gf-text-dim)' }}>{s.k}</div>
                  </div>
                ))}
              </div>
              {report.key_findings?.length > 0 && (
                <div className="rounded-lg border hairline p-3" style={{ background: 'var(--gf-surface-2)' }}>
                  <h3 className="text-xs font-medium mb-2">Key Findings</h3>
                  <ul className="space-y-1.5">
                    {report.key_findings.map((f, i) => (
                      <li key={i} className="text-sm flex items-start gap-1.5" style={{ color: 'var(--gf-text-dim)' }}>
                        <Check className="h-3.5 w-3.5 mt-0.5 shrink-0" style={{ color: 'var(--lime)' }} strokeWidth={1.5} />
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {report.recommendations?.length > 0 && (
                <div className="rounded-lg border p-3" style={{ background: 'var(--lime-soft)', borderColor: 'rgba(212,255,58,0.22)' }}>
                  <h3 className="text-xs font-medium mb-2" style={{ color: 'var(--lime)' }}>Recommendations</h3>
                  <ul className="space-y-1.5">
                    {report.recommendations.map((r, i) => (
                      <li key={i} className="text-sm flex items-start gap-1.5" style={{ color: 'var(--gf-text-dim)' }}>
                        <MessageSquare className="h-3.5 w-3.5 mt-0.5 shrink-0" style={{ color: 'var(--lime)' }} strokeWidth={1.5} />
                        {r}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
