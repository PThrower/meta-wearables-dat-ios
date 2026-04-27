import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  GraduationCap, RefreshCw, Loader2, Clock, Copy, Trash2,
  ListChecks, Filter, Plus, AlertCircle, XCircle,
} from 'lucide-react';
import { getSkills, deleteSkill } from '@/lib/api';
import { toast } from 'sonner';

const CATEGORY_COLORS = {
  DIAGNOSTIC: '#7FB7FF',
  SAFETY: '#FFB547',
  INSTALL: '#B794FF',
  SERVICE: 'var(--mint)',
  MAINTENANCE: 'var(--lime)',
};

const statusLabel = (s) => ({
  completed: 'active',
  processing: 'processing',
  pending: 'pending',
  failed: 'failed',
}[s] || s || 'idle');

const statusBadgeClass = (s) => ({
  completed: 'gf-badge-active',
  processing: 'gf-badge-warn',
  pending: 'gf-badge-warn',
  failed: 'gf-badge-fail',
}[s] || 'gf-badge-idle');

const displayName = (s) => {
  const n = (s.name || '').trim();
  if (!n || n === 'Processing...') return 'Untitled skill';
  return n;
};

const formatShortDate = (iso) => {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch { return ''; }
};

export default function SkillsPage() {
  const navigate = useNavigate();
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchSkills = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getSkills();
      setSkills(Array.isArray(data) ? data : []);
    } catch {
      toast.error('Failed to load skills');
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSkills(); }, [fetchSkills]);

  const handleDelete = async (skill, e) => {
    e?.stopPropagation();
    if (!window.confirm(`Delete "${displayName(skill)}"?`)) return;
    try {
      await deleteSkill(skill.id);
      setSkills((prev) => prev.filter((s) => s.id !== skill.id));
      toast.success('Skill deleted');
    } catch (err) {
      toast.error(`Delete failed: ${err.message || err}`);
    }
  };

  const handleClearFailed = async () => {
    const failedSkills = skills.filter((s) => s.extraction_status === 'failed');
    if (failedSkills.length === 0) return;
    if (!window.confirm(`Delete all ${failedSkills.length} failed skill${failedSkills.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    const results = await Promise.allSettled(failedSkills.map((s) => deleteSkill(s.id)));
    const okIds = new Set(
      failedSkills.filter((_, i) => results[i].status === 'fulfilled').map((s) => s.id)
    );
    setSkills((prev) => prev.filter((s) => !okIds.has(s.id)));
    const failed = failedSkills.length - okIds.size;
    if (failed === 0) toast.success(`Cleared ${okIds.size} failed skill${okIds.size === 1 ? '' : 's'}`);
    else toast.error(`Cleared ${okIds.size}, ${failed} failed to delete`);
  };

  const handleCopyPrompt = (prompt, e) => {
    e?.stopPropagation();
    if (!prompt) return;
    navigator.clipboard.writeText(prompt);
    toast.success('Agent prompt copied');
  };

  const total = skills.length;
  const active = skills.filter((s) => s.extraction_status === 'completed').length;
  const processing = skills.filter((s) => s.extraction_status === 'processing' || s.extraction_status === 'pending').length;
  const failed = skills.filter((s) => s.extraction_status === 'failed').length;

  return (
    <div className="gf-page min-h-screen" data-testid="skills-page" style={{ background: 'var(--gf-bg)' }}>
      <main className="max-w-[1400px] mx-auto p-6 sm:p-8 space-y-5">
        <div className="flex items-end justify-between flex-wrap gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] mb-1.5" style={{ color: 'var(--gf-text-faint)' }}>Knowledge</div>
            <h1 className="text-[28px] font-semibold tracking-tight" style={{ color: 'var(--gf-text)' }}>Skills library</h1>
            <p className="text-[13px] mt-1" style={{ color: 'var(--gf-text-dim)' }}>
              {active} active · {processing} processing · {failed} failed · {total} total
            </p>
          </div>
          <div className="flex gap-2">
            {failed > 0 && (
              <button
                onClick={handleClearFailed}
                className="btn-ghost h-9 px-3 rounded-md text-[12px] flex items-center gap-1.5"
                style={{ color: '#FF9A90' }}
                title={`Delete all ${failed} failed skill${failed === 1 ? '' : 's'}`}
              >
                <XCircle className="h-3 w-3" strokeWidth={1.5} /> Clear failed ({failed})
              </button>
            )}
            <button className="btn-ghost h-9 px-3 rounded-md text-[12px] flex items-center gap-1.5">
              <Filter className="h-3 w-3" strokeWidth={1.5} /> All categories
            </button>
            <button
              onClick={fetchSkills}
              className="btn-ghost h-9 px-3 rounded-md text-[12px] flex items-center gap-1.5"
              title="Refresh"
            >
              <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.5} />
            </button>
            <button className="btn-lime h-9 px-4 rounded-md text-[12.5px] font-medium flex items-center gap-1.5">
              <Plus className="h-3 w-3" strokeWidth={1.5} /> Import
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin" style={{ color: 'var(--lime)' }} />
          </div>
        ) : skills.length === 0 ? (
          <div
            className="rounded-xl border hairline p-12 text-center"
            style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
          >
            <GraduationCap className="h-10 w-10 mx-auto mb-3 opacity-30" strokeWidth={1.5} />
            <h3 className="text-sm font-medium mb-1" style={{ color: 'var(--gf-text)' }}>No skills extracted yet</h3>
            <p className="text-xs" style={{ color: 'var(--gf-text-dim)' }}>
              Go to Feeds, expand a recording, and click "Extract Skill"
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {skills.map((s) => {
              const steps = Array.isArray(s.steps) ? s.steps : [];
              const category = (s.category || '').toUpperCase();
              const color = CATEGORY_COLORS[category] || '#7FB7FF';
              const statusKey = s.extraction_status || 'pending';
              const isFailed = statusKey === 'failed';
              const isProcessing = statusKey === 'processing' || statusKey === 'pending';

              return (
                <div
                  key={s.id}
                  data-testid={`skill-${s.id}`}
                  onClick={() => navigate(`/skills/${s.id}`)}
                  className="rounded-xl border hairline p-5 transition flex flex-col cursor-pointer hover:border-white/20"
                  style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: `${color}22` }}>
                      <GraduationCap className="h-[15px] w-[15px]" style={{ color }} strokeWidth={1.5} />
                    </div>
                    <span className={`gf-badge ${statusBadgeClass(statusKey)}`}>
                      {statusLabel(statusKey)}
                    </span>
                  </div>

                  {category && <div className="text-[10px] gf-mono tracking-wider mb-1" style={{ color }}>{category}</div>}
                  <div className="text-[15px] font-semibold leading-tight" style={{ color: 'var(--gf-text)' }}>
                    {displayName(s)}
                  </div>
                  {(isFailed || !category) && (
                    <div className="text-[10.5px] mt-0.5" style={{ color: 'var(--gf-text-faint)' }}>
                      {formatShortDate(s.created_at)}
                    </div>
                  )}

                  {isFailed ? (
                    <div className="mt-3 flex-1 flex items-start">
                      <div
                        className="flex items-center gap-1.5 text-[11px]"
                        style={{ color: '#FF9A90' }}
                      >
                        <AlertCircle className="h-3 w-3 shrink-0" strokeWidth={1.5} />
                        <span>Extraction failed — click to retry</span>
                      </div>
                    </div>
                  ) : steps.length > 0 ? (
                    <div className="mt-3 space-y-1 flex-1">
                      {steps.slice(0, 4).map((st, j) => (
                        <div key={j} className="flex items-center gap-2 text-[11.5px]" style={{ color: 'var(--gf-text-dim)' }}>
                          <span
                            className="w-4 h-4 rounded-full text-[9px] gf-mono flex items-center justify-center"
                            style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--gf-text-faint)' }}
                          >
                            {st.step_num || j + 1}
                          </span>
                          <span className="truncate">{st.title || st.instruction}</span>
                        </div>
                      ))}
                      {steps.length > 4 && (
                        <div className="text-[10px] pl-6" style={{ color: 'var(--gf-text-faint)' }}>+ {steps.length - 4} more…</div>
                      )}
                    </div>
                  ) : (
                    <div
                      className="mt-3 flex-1 flex items-center justify-center text-[11px] italic rounded-md py-4 border-dashed border hairline"
                      style={{ color: 'var(--gf-text-faint)', borderColor: 'var(--gf-line)' }}
                    >
                      {isProcessing ? 'Extracting from recording…' : 'No steps yet'}
                    </div>
                  )}

                  <div className="mt-4 pt-3 border-t hairline" style={{ borderTopColor: 'var(--gf-line)' }}>
                    <div className="flex items-center justify-between text-[11px] gf-mono" style={{ color: 'var(--gf-text-dim)' }}>
                      <span className="flex items-center gap-1">
                        <ListChecks className="h-3 w-3" strokeWidth={1.5} />
                        {steps.length || '—'} steps
                      </span>
                      {s.estimated_duration_minutes && (
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" strokeWidth={1.5} /> ~{s.estimated_duration_minutes}m
                        </span>
                      )}
                      <div className="flex items-center gap-1.5">
                        {s.agent_prompt && (
                          <button
                            onClick={(e) => handleCopyPrompt(s.agent_prompt, e)}
                            title="Copy agent prompt"
                            className="transition-colors"
                            style={{ color: 'var(--gf-text-faint)' }}
                          >
                            <Copy className="h-3 w-3" strokeWidth={1.5} />
                          </button>
                        )}
                        <button
                          onClick={(e) => handleDelete(s, e)}
                          title="Delete skill"
                          className="transition-colors"
                          style={{ color: 'var(--gf-text-faint)' }}
                        >
                          <Trash2 className="h-3 w-3" strokeWidth={1.5} />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
