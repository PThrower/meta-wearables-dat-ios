import React, { useState, useEffect, useCallback } from 'react';
import { Zap, Plus, Check, Loader2 } from 'lucide-react';
import { getAgents, getAgent, toggleAgent } from '@/lib/api';
import { toast } from 'sonner';
import { DEMO_AGENTS } from '@/lib/demoData';

const toArray = (v) => Array.isArray(v) ? v : Array.isArray(v?.items) ? v.items : Array.isArray(v?.data) ? v.data : [];

export default function AgentsPage() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);

  const fetchAgents = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getAgents();
      const list = toArray(data);
      const final = list.length > 0 ? list : DEMO_AGENTS;
      setAgents(final);
      if (final[0]) setSelectedId(final[0].id || final[0].name);
    } catch {
      setAgents(DEMO_AGENTS);
      if (DEMO_AGENTS[0]) setSelectedId(DEMO_AGENTS[0].id || DEMO_AGENTS[0].name);
      toast.info('Showing demo agents');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAgents(); }, [fetchAgents]);

  useEffect(() => {
    if (!selectedId) return;
    const inline = agents.find((a) => (a.id || a.name) === selectedId);
    setDetail(inline || null);
    if (!inline?.id) return;
    (async () => {
      try {
        const full = await getAgent(inline.id);
        if (full) setDetail({ ...inline, ...full });
      } catch { /* keep inline */ }
    })();
  }, [selectedId, agents]);

  const handleToggle = async (agent) => {
    if (!agent?.id) return;
    try {
      const res = await toggleAgent(agent.id);
      toast.success(res?.message || 'Agent updated');
      setAgents((prev) => prev.map((a) => a.id === agent.id ? { ...a, status: res?.status || a.status } : a));
    } catch {
      toast.error('Failed to toggle agent');
    }
  };

  const skills = Array.isArray(detail?.skills) && detail.skills.length > 0
    ? detail.skills.map((s) => (typeof s === 'string' ? { n: s, ok: true } : { n: s.name || s.n || 'Skill', ok: s.active ?? s.ok ?? true }))
    : [
        { n: 'Verify conditions before action', ok: true },
        { n: 'Flag safety anomalies', ok: true },
        { n: 'Capture checkpoint photos', ok: true },
        { n: 'Log step progress', ok: true },
      ];

  return (
    <div className="gf-page min-h-screen" data-testid="agents-page" style={{ background: 'var(--gf-bg)' }}>
      <main className="max-w-[1400px] mx-auto p-6 sm:p-8 space-y-6">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] mb-1.5" style={{ color: 'var(--gf-text-faint)' }}>Physical AI</div>
            <h1 className="text-[28px] font-semibold tracking-tight" style={{ color: 'var(--gf-text)' }}>Agents</h1>
            <p className="text-[13px] mt-1" style={{ color: 'var(--gf-text-dim)' }}>
              Configure AI personas deployed to glasses. Each agent is a set of skills + instructions + tools.
            </p>
          </div>
          <button className="btn-lime h-9 px-4 rounded-md text-[12.5px] font-medium flex items-center gap-1.5">
            <Plus className="h-3 w-3" strokeWidth={1.5} /> New agent
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin" style={{ color: 'var(--lime)' }} />
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* List */}
            <div className="lg:col-span-4 space-y-2">
              <div className="text-[10px] uppercase tracking-[0.16em] px-2" style={{ color: 'var(--gf-text-faint)' }}>
                {agents.length} agents
              </div>
              {agents.map((a) => {
                const id = a.id || a.name;
                const deployed = a.status === 'deployed' || a.status === 'active';
                const active = selectedId === id;
                return (
                  <button
                    key={id}
                    onClick={() => setSelectedId(id)}
                    className="w-full text-left rounded-xl border p-4 transition"
                    style={{
                      background: active ? 'var(--lime-soft)' : 'var(--gf-surface)',
                      borderColor: active ? 'var(--lime)' : 'var(--gf-line)',
                    }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2.5 min-w-0 flex-1">
                        <div
                          className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                          style={{
                            background: deployed ? 'var(--lime-soft)' : 'rgba(255,255,255,0.04)',
                            color: deployed ? 'var(--lime)' : 'var(--gf-text-faint)',
                          }}
                        >
                          <Zap className="h-3.5 w-3.5" strokeWidth={1.5} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-[12.5px] font-semibold leading-tight" style={{ color: 'var(--gf-text)' }}>
                            {a.name}
                          </div>
                          <div className="text-[10.5px] mt-0.5" style={{ color: 'var(--gf-text-faint)' }}>
                            {a.skills ?? a.skills_count ?? '—'} skills · {a.assigned ?? 0} assigned
                          </div>
                        </div>
                      </div>
                      <span className={`gf-badge shrink-0 ${deployed ? 'gf-badge-active' : 'gf-badge-idle'}`}>
                        {a.status || 'idle'}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Detail */}
            <div className="lg:col-span-8 space-y-4">
              {detail && (
                <>
                  <div
                    className="rounded-2xl border hairline p-6"
                    style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
                  >
                    <div className="flex items-start justify-between gap-4 flex-wrap">
                      <div>
                        <div className="text-[11px] uppercase tracking-[0.16em]" style={{ color: 'var(--gf-text-faint)' }}>
                          Configuration
                        </div>
                        <h2 className="text-[22px] font-semibold tracking-tight mt-1" style={{ color: 'var(--gf-text)' }}>
                          {detail.name}
                        </h2>
                        <div className="text-[12px] mt-1" style={{ color: 'var(--gf-text-dim)' }}>
                          Last edited {detail.lastEdit || detail.last_edit || 'recently'} · {detail.assigned ?? 0} glasses running this agent
                        </div>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button className="btn-ghost h-8 px-3 rounded-md text-[11.5px]">Duplicate</button>
                        <button
                          onClick={() => handleToggle(detail)}
                          className="btn-lime h-8 px-4 rounded-md text-[11.5px] font-medium"
                        >
                          {detail.status === 'deployed' || detail.status === 'active' ? 'Pause' : 'Deploy'}
                        </button>
                      </div>
                    </div>

                    <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <div className="text-[10px] uppercase tracking-[0.14em] mb-2" style={{ color: 'var(--gf-text-faint)' }}>
                          System prompt
                        </div>
                        <div
                          className="rounded-lg border hairline p-3 text-[12px] leading-relaxed h-[140px] overflow-hidden font-mono"
                          style={{ background: 'var(--gf-surface-2)', borderColor: 'var(--gf-line)', color: 'var(--gf-text-dim)' }}
                        >
                          {detail.system_prompt || detail.prompt ||
                            `You are ${detail.name}, embedded in the worker's glasses. Before any step, verify safety conditions. Use concise voice responses under 2 sentences. Flag anomalies immediately and pause the task until the operator acknowledges.`}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-[0.14em] mb-2" style={{ color: 'var(--gf-text-faint)' }}>
                          Active tools
                        </div>
                        <div
                          className="rounded-lg border hairline p-3 h-[140px] overflow-y-auto scroll-area text-[12px] font-mono space-y-1.5"
                          style={{ background: 'var(--gf-surface-2)', borderColor: 'var(--gf-line)' }}
                        >
                          {(detail.tools || ['scene_analyzer', 'read_pressure_gauge', 'look_up_manual', 'capture_photo', 'remember_fact', 'notify_operator', 'end_session']).map((t, i) => (
                            <div key={i} className="flex items-center gap-2">
                              <span style={{ color: 'var(--lime)' }}>›</span>
                              <span style={{ color: 'var(--gf-text-dim)' }}>{typeof t === 'string' ? t : t.name || 'tool'}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Skills */}
                  <div
                    className="rounded-2xl border hairline p-6"
                    style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
                  >
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-[14px] font-semibold" style={{ color: 'var(--gf-text)' }}>
                        Skills ({skills.length})
                      </h3>
                      <button className="text-[11px] hover:underline" style={{ color: 'var(--lime)' }}>+ Add skill</button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {skills.map((s, i) => (
                        <div
                          key={i}
                          className="flex items-center gap-2.5 rounded-lg border hairline p-3"
                          style={{ background: 'var(--gf-surface-2)', borderColor: 'var(--gf-line)' }}
                        >
                          <div
                            className="w-6 h-6 rounded-md flex items-center justify-center"
                            style={{
                              background: s.ok ? 'var(--lime-soft)' : 'rgba(255,255,255,0.04)',
                              color: s.ok ? 'var(--lime)' : 'var(--gf-text-faint)',
                            }}
                          >
                            <Check className="h-3 w-3" strokeWidth={2} />
                          </div>
                          <span className="text-[12.5px] flex-1" style={{ color: 'var(--gf-text)' }}>{s.n}</span>
                          <span
                            className="text-[10px] gf-mono"
                            style={{ color: s.ok ? 'var(--mint)' : 'var(--gf-text-faint)' }}
                          >
                            {s.ok ? 'active' : 'draft'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Performance + Deployed to */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div
                      className="rounded-2xl border hairline p-5"
                      style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
                    >
                      <div className="text-[11px] uppercase tracking-[0.16em] mb-3" style={{ color: 'var(--gf-text-faint)' }}>
                        Performance · last 7 days
                      </div>
                      <div className="grid grid-cols-3 gap-4">
                        <div>
                          <div className="num text-[22px] font-medium" style={{ color: 'var(--gf-text)' }}>
                            {detail.events_7d ?? 142}
                          </div>
                          <div className="text-[10px]" style={{ color: 'var(--gf-text-dim)' }}>events</div>
                        </div>
                        <div>
                          <div className="num text-[22px] font-medium" style={{ color: 'var(--mint)' }}>
                            {detail.accuracy_pct ?? 96}%
                          </div>
                          <div className="text-[10px]" style={{ color: 'var(--gf-text-dim)' }}>accuracy</div>
                        </div>
                        <div>
                          <div className="num text-[22px] font-medium" style={{ color: 'var(--gf-text)' }}>
                            {detail.avg_response ?? '12s'}
                          </div>
                          <div className="text-[10px]" style={{ color: 'var(--gf-text-dim)' }}>avg response</div>
                        </div>
                      </div>
                    </div>
                    <div
                      className="rounded-2xl border hairline p-5"
                      style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
                    >
                      <div className="text-[11px] uppercase tracking-[0.16em] mb-3" style={{ color: 'var(--gf-text-faint)' }}>
                        Deployed to
                      </div>
                      <div className="space-y-1.5">
                        {(detail.deployed_to || []).length > 0 ? (
                          detail.deployed_to.map((d, i) => (
                            <div key={i} className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--gf-text)' }}>
                              <div className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--lime)' }} />
                              {d.worker || d.name || d}
                              {d.device_id && <span className="gf-mono" style={{ color: 'var(--gf-text-faint)' }}>· {d.device_id}</span>}
                            </div>
                          ))
                        ) : (
                          <div className="text-[12px]" style={{ color: 'var(--gf-text-faint)' }}>
                            {(detail.assigned ?? 0) > 0
                              ? `${detail.assigned} glasses running this agent`
                              : 'Not currently deployed'}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
