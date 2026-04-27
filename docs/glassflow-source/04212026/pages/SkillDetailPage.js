import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  GraduationCap, ArrowLeft, Pencil, Save, X, Plus, Trash2, Clock,
  Wrench, Shield, AlertTriangle, Zap, Copy, ListChecks, CheckCircle2,
  RefreshCw, Loader2, RotateCcw, Film, ExternalLink, HardDrive,
} from 'lucide-react';
import { getSkill, updateSkill, deleteSkill, getFeed, triggerSkillExtraction } from '@/lib/api';
import { toast } from 'sonner';

const CATEGORY_OPTIONS = [
  'maintenance', 'installation', 'repair', 'inspection',
  'troubleshooting', 'assembly', 'calibration', 'cooking',
];
const DIFFICULTY_OPTIONS = ['beginner', 'intermediate', 'advanced'];

const statusBadgeClass = (s) => ({
  completed: 'gf-badge-active',
  processing: 'gf-badge-warn',
  pending: 'gf-badge-warn',
  failed: 'gf-badge-fail',
}[s] || 'gf-badge-idle');

const formatBytes = (bytes) => {
  if (!bytes) return '';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

const formatMs = (ms) => {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}:${String(sec).padStart(2, '0')}`;
};

const formatFeedDate = (iso) => {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return ''; }
};

const shortenFileName = (name) => {
  if (!name) return '';
  const base = name.split('/').pop() || name;
  const noExt = base.replace(/\.mp4$/, '');
  // Trim the sbx-xxx-<room>-<date> format to just <date>
  const m = noExt.match(/(\d{4}-\d{2}-\d{2}T\d+)$/);
  return m ? m[1].replace('T', ' ') : noExt;
};

const emptyStep = () => ({ title: '', instruction: '', verification: '', estimated_seconds: 0 });
const emptyEdge = () => ({ scenario: '', resolution: '' });

export default function SkillDetailPage() {
  const { skillId } = useParams();
  const navigate = useNavigate();
  const [skill, setSkill] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sourceFeed, setSourceFeed] = useState(null);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await getSkill(skillId);
      setSkill(s);
      setDraft(null);
      if (s?.media_asset_id) {
        try {
          const feed = await getFeed(s.media_asset_id);
          setSourceFeed(feed || null);
        } catch { setSourceFeed(null); }
      } else {
        setSourceFeed(null);
      }
    } catch {
      toast.error('Could not load skill');
      setSkill(null);
    } finally {
      setLoading(false);
    }
  }, [skillId]);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh while a skill is still being extracted so the page
  // reflects completion without manual reload.
  useEffect(() => {
    if (!skill || skill.extraction_status !== 'processing') return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [skill, load]);

  const startEdit = () => {
    setDraft(JSON.parse(JSON.stringify(skill)));
    setIsEditing(true);
  };
  const cancelEdit = () => { setDraft(null); setIsEditing(false); };

  const save = async () => {
    setSaving(true);
    try {
      const updates = {
        name: draft.name,
        description: draft.description,
        category: draft.category,
        difficulty: draft.difficulty,
        estimated_duration_minutes: draft.estimated_duration_minutes
          ? Number(draft.estimated_duration_minutes)
          : null,
        steps: draft.steps || [],
        tools_required: draft.tools_required || [],
        prerequisites: draft.prerequisites || [],
        safety_notes: draft.safety_notes || [],
        edge_cases: draft.edge_cases || [],
        agent_prompt: draft.agent_prompt,
      };
      const saved = await updateSkill(skillId, updates);
      setSkill(saved);
      setIsEditing(false);
      setDraft(null);
      toast.success('Skill saved');
    } catch (err) {
      toast.error(`Save failed: ${err.message || err}`);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete "${skill.name}"? This cannot be undone.`)) return;
    try {
      await deleteSkill(skillId);
      toast.success('Skill deleted');
      navigate('/skills');
    } catch (err) {
      toast.error(`Delete failed: ${err.message || err}`);
    }
  };

  const retryExtraction = async () => {
    if (!skill.media_asset_id) {
      toast.error('No source recording linked — cannot retry');
      return;
    }
    setRetrying(true);
    try {
      await triggerSkillExtraction({
        mediaAssetId: skill.media_asset_id,
        creatorIdentity: skill.creator_identity,
      });
      toast.success('Extraction restarted — processing with Gemini');
      setTimeout(load, 2000);
    } catch (err) {
      toast.error(`Retry failed: ${err.message || err}`);
    } finally {
      setRetrying(false);
    }
  };

  const copyPrompt = () => {
    if (!skill?.agent_prompt) return;
    navigator.clipboard.writeText(skill.agent_prompt);
    toast.success('Agent prompt copied');
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--gf-bg)' }}>
        <Loader2 className="h-8 w-8 animate-spin" style={{ color: 'var(--lime)' }} />
      </div>
    );
  }
  if (!skill) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3" style={{ background: 'var(--gf-bg)' }}>
        <p className="text-sm" style={{ color: 'var(--gf-text-dim)' }}>Skill not found</p>
        <button onClick={() => navigate('/skills')} className="btn-ghost h-9 px-4 rounded-md text-[12.5px]">Back to library</button>
      </div>
    );
  }

  const view = isEditing ? draft : skill;
  const steps = Array.isArray(view.steps) ? view.steps : [];
  const edgeCases = Array.isArray(view.edge_cases) ? view.edge_cases : [];
  const isProcessing = skill.extraction_status === 'processing' || skill.extraction_status === 'pending';
  const isFailed = skill.extraction_status === 'failed';

  const patchDraft = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const patchStep = (i, k, v) => setDraft((d) => {
    const next = [...(d.steps || [])]; next[i] = { ...next[i], [k]: v }; return { ...d, steps: next };
  });
  const addStep = () => setDraft((d) => ({ ...d, steps: [...(d.steps || []), { ...emptyStep(), step_num: (d.steps?.length || 0) + 1 }] }));
  const removeStep = (i) => setDraft((d) => ({
    ...d,
    steps: (d.steps || []).filter((_, idx) => idx !== i).map((s, idx) => ({ ...s, step_num: idx + 1 })),
  }));
  const patchEdge = (i, k, v) => setDraft((d) => {
    const next = [...(d.edge_cases || [])]; next[i] = { ...next[i], [k]: v }; return { ...d, edge_cases: next };
  });
  const addEdge = () => setDraft((d) => ({ ...d, edge_cases: [...(d.edge_cases || []), emptyEdge()] }));
  const removeEdge = (i) => setDraft((d) => ({ ...d, edge_cases: (d.edge_cases || []).filter((_, idx) => idx !== i) }));

  return (
    <div className="gf-page min-h-screen" data-testid="skill-detail-page" style={{ background: 'var(--gf-bg)' }}>
      <main className="max-w-[1400px] mx-auto p-6 sm:p-8 space-y-5">
        {/* Header */}
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div className="min-w-0 flex-1">
            <button
              onClick={() => navigate('/skills')}
              className="flex items-center gap-1.5 text-[11.5px] mb-2"
              style={{ color: 'var(--gf-text-dim)' }}
            >
              <ArrowLeft className="h-3 w-3" strokeWidth={1.5} /> Back to library
            </button>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--lime-soft)' }}>
                <GraduationCap className="h-[17px] w-[17px]" style={{ color: 'var(--lime)' }} strokeWidth={1.5} />
              </div>
              {isEditing ? (
                <input
                  value={view.name || ''}
                  onChange={(e) => patchDraft('name', e.target.value)}
                  className="text-[24px] font-semibold tracking-tight bg-transparent outline-none border-b"
                  style={{ color: 'var(--gf-text)', borderColor: 'var(--gf-line)' }}
                  placeholder="Skill name"
                />
              ) : (
                <h1 className="text-[24px] font-semibold tracking-tight truncate" style={{ color: 'var(--gf-text)' }}>
                  {view.name}
                </h1>
              )}
              <span className={`gf-badge ${statusBadgeClass(skill.extraction_status)}`}>
                {skill.extraction_status}
              </span>
            </div>
          </div>

          <div className="flex gap-2 shrink-0">
            {isEditing ? (
              <>
                <button onClick={cancelEdit} className="btn-ghost h-9 px-3 rounded-md text-[12.5px] flex items-center gap-1.5">
                  <X className="h-3 w-3" strokeWidth={1.5} /> Cancel
                </button>
                <button
                  onClick={save}
                  disabled={saving}
                  className="btn-lime h-9 px-4 rounded-md text-[12.5px] font-medium flex items-center gap-1.5 disabled:opacity-40"
                >
                  {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" strokeWidth={1.5} />}
                  Save
                </button>
              </>
            ) : (
              <>
                {isFailed && skill.media_asset_id && (
                  <button
                    onClick={retryExtraction}
                    disabled={retrying}
                    className="btn-ghost h-9 px-3 rounded-md text-[12.5px] flex items-center gap-1.5 disabled:opacity-40"
                  >
                    {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" strokeWidth={1.5} />}
                    Retry extraction
                  </button>
                )}
                {!isProcessing && (
                  <button
                    onClick={startEdit}
                    className="btn-ghost h-9 px-3 rounded-md text-[12.5px] flex items-center gap-1.5"
                  >
                    <Pencil className="h-3 w-3" strokeWidth={1.5} /> Edit
                  </button>
                )}
                <button
                  onClick={remove}
                  className="btn-ghost h-9 px-3 rounded-md text-[12.5px] flex items-center gap-1.5"
                  style={{ color: 'var(--gf-text-dim)' }}
                >
                  <Trash2 className="h-3 w-3" strokeWidth={1.5} /> Delete
                </button>
              </>
            )}
          </div>
        </div>

        {/* Processing banner */}
        {isProcessing && (
          <div
            className="rounded-lg p-4 flex items-center gap-3"
            style={{ background: 'var(--gf-surface)', border: '1px solid var(--gf-line)' }}
          >
            <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--lime)' }} />
            <div className="flex-1">
              <p className="text-[13px]" style={{ color: 'var(--gf-text)' }}>Gemini is still analyzing the recording</p>
              <p className="text-[11px] mt-0.5" style={{ color: 'var(--gf-text-dim)' }}>
                This page refreshes every 5s · stuck extractions auto-fail after 15 min
              </p>
            </div>
            <button onClick={load} className="btn-ghost h-8 px-3 rounded-md text-[11px] flex items-center gap-1.5">
              <RefreshCw className="h-3 w-3" strokeWidth={1.5} /> Refresh
            </button>
          </div>
        )}

        {isFailed && skill.extraction_error && (
          <div
            className="rounded-lg p-3 text-[11.5px] font-mono whitespace-pre-wrap"
            style={{ background: 'rgba(255,80,80,0.06)', border: '1px solid rgba(255,80,80,0.18)', color: 'var(--gf-text-dim)' }}
          >
            {skill.extraction_error}
          </div>
        )}

        {/* Two-column workspace: left = source video + metadata/context; right = content */}
        <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-5 items-start">
          {/* ------- LEFT COLUMN ------- */}
          <div className="space-y-4 lg:sticky lg:top-6">
            {/* Source recording card */}
            <section
              className="rounded-xl border hairline overflow-hidden"
              style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
            >
              <div className="flex items-center gap-1.5 px-4 pt-3.5 pb-2">
                <Film className="h-3.5 w-3.5" style={{ color: 'var(--lime)' }} strokeWidth={1.5} />
                <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--gf-text-dim)' }}>
                  Source recording
                </span>
              </div>

              {sourceFeed?.playback_url ? (
                <div className="aspect-video bg-black">
                  <video src={sourceFeed.playback_url} controls className="w-full h-full" />
                </div>
              ) : skill.media_asset_id ? (
                <div
                  className="aspect-video flex items-center justify-center text-[11.5px]"
                  style={{ background: 'rgba(0,0,0,0.4)', color: 'var(--gf-text-faint)' }}
                >
                  <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading recording…
                </div>
              ) : (
                <div
                  className="aspect-video flex flex-col items-center justify-center gap-1 text-[11.5px]"
                  style={{ background: 'rgba(0,0,0,0.4)', color: 'var(--gf-text-faint)' }}
                >
                  <Film className="h-5 w-5 mb-1 opacity-40" strokeWidth={1.5} />
                  <span>Not linked to a recording</span>
                </div>
              )}

              {/* Source tag row */}
              <div className="px-4 py-3 space-y-1.5 border-t hairline" style={{ borderTopColor: 'var(--gf-line)' }}>
                <div className="flex items-center justify-between gap-2">
                  <span
                    className="text-[12px] font-medium truncate"
                    style={{ color: 'var(--gf-text)' }}
                    title={sourceFeed?.file_name || ''}
                  >
                    {sourceFeed ? (shortenFileName(sourceFeed.file_name) || 'Untitled clip')
                                : skill.media_asset_id ? '…' : 'No source'}
                  </span>
                  {sourceFeed && (
                    <button
                      onClick={() => navigate('/feeds')}
                      className="flex items-center gap-1 text-[10.5px] shrink-0"
                      style={{ color: 'var(--lime)' }}
                      title="Open in Feeds"
                    >
                      <ExternalLink className="h-3 w-3" strokeWidth={1.5} />
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10.5px]" style={{ color: 'var(--gf-text-dim)' }}>
                  {sourceFeed?.last_modified && (
                    <span className="flex items-center gap-1">
                      <Clock className="h-2.5 w-2.5" strokeWidth={1.5} />
                      {formatFeedDate(sourceFeed.last_modified)}
                    </span>
                  )}
                  {sourceFeed?.duration_ms && (
                    <span className="flex items-center gap-1">
                      <Film className="h-2.5 w-2.5" strokeWidth={1.5} />
                      {formatMs(sourceFeed.duration_ms)}
                    </span>
                  )}
                  {sourceFeed?.size_bytes && (
                    <span className="flex items-center gap-1">
                      <HardDrive className="h-2.5 w-2.5" strokeWidth={1.5} />
                      {formatBytes(sourceFeed.size_bytes)}
                    </span>
                  )}
                </div>
                {sourceFeed?.room_name && (
                  <div
                    className="text-[10px] gf-mono truncate pt-0.5"
                    style={{ color: 'var(--gf-text-faint)' }}
                    title={sourceFeed.room_name}
                  >
                    {sourceFeed.room_name}
                  </div>
                )}
              </div>
            </section>

            {/* Metadata grid */}
            <Section>
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="Category"
                  editing={isEditing}
                  view={view.category || '—'}
                  input={
                    <select
                      value={view.category || ''}
                      onChange={(e) => patchDraft('category', e.target.value)}
                      className="w-full h-8 rounded px-2 text-[12px] outline-none"
                      style={{ background: 'var(--gf-surface-2)', color: 'var(--gf-text)', border: '1px solid var(--gf-line)' }}
                    >
                      <option value="">—</option>
                      {CATEGORY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  }
                />
                <Field
                  label="Difficulty"
                  editing={isEditing}
                  view={view.difficulty || '—'}
                  input={
                    <select
                      value={view.difficulty || ''}
                      onChange={(e) => patchDraft('difficulty', e.target.value)}
                      className="w-full h-8 rounded px-2 text-[12px] outline-none"
                      style={{ background: 'var(--gf-surface-2)', color: 'var(--gf-text)', border: '1px solid var(--gf-line)' }}
                    >
                      <option value="">—</option>
                      {DIFFICULTY_OPTIONS.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                  }
                />
                <Field
                  label="Duration"
                  editing={isEditing}
                  view={view.estimated_duration_minutes ? `${view.estimated_duration_minutes} min` : '—'}
                  input={
                    <input
                      type="number"
                      min="0"
                      value={view.estimated_duration_minutes || ''}
                      onChange={(e) => patchDraft('estimated_duration_minutes', e.target.value)}
                      className="w-full h-8 rounded px-2 text-[12px] outline-none"
                      style={{ background: 'var(--gf-surface-2)', color: 'var(--gf-text)', border: '1px solid var(--gf-line)' }}
                      placeholder="minutes"
                    />
                  }
                />
                <Field
                  label="Steps"
                  editing={false}
                  view={`${steps.length} step${steps.length === 1 ? '' : 's'}`}
                />
              </div>
            </Section>

            {/* Context chips */}
            <ChipEditor
              icon={Wrench}
              title="Tools"
              value={view.tools_required || []}
              editing={isEditing}
              onChange={(arr) => patchDraft('tools_required', arr)}
            />
            <ChipEditor
              icon={Shield}
              title="Safety notes"
              value={view.safety_notes || []}
              editing={isEditing}
              onChange={(arr) => patchDraft('safety_notes', arr)}
              accent="amber"
            />
            <ChipEditor
              icon={ListChecks}
              title="Prerequisites"
              value={view.prerequisites || []}
              editing={isEditing}
              onChange={(arr) => patchDraft('prerequisites', arr)}
            />
          </div>

          {/* ------- RIGHT COLUMN ------- */}
          <div className="space-y-5 min-w-0">

        {/* Description */}
        <Section title="Description">
          {isEditing ? (
            <textarea
              value={view.description || ''}
              onChange={(e) => patchDraft('description', e.target.value)}
              rows={3}
              className="w-full rounded px-3 py-2 text-[12.5px] outline-none resize-y"
              style={{ background: 'var(--gf-surface-2)', color: 'var(--gf-text)', border: '1px solid var(--gf-line)' }}
            />
          ) : (
            <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--gf-text-dim)' }}>
              {view.description || <span style={{ color: 'var(--gf-text-faint)' }}>—</span>}
            </p>
          )}
        </Section>

        {/* Steps */}
        <Section
          title={<><ListChecks className="h-3.5 w-3.5 inline mr-1.5" style={{ color: 'var(--lime)' }} strokeWidth={1.5} />Procedure</>}
          action={isEditing && (
            <button onClick={addStep} className="text-[11px] flex items-center gap-1" style={{ color: 'var(--lime)' }}>
              <Plus className="h-3 w-3" strokeWidth={1.5} /> Add step
            </button>
          )}
        >
          {steps.length === 0 ? (
            <p className="text-[11.5px] italic" style={{ color: 'var(--gf-text-faint)' }}>No steps yet</p>
          ) : (
            <div className="space-y-2">
              {steps.map((st, i) => (
                <div
                  key={i}
                  className="flex gap-3 rounded-lg p-3"
                  style={{ background: 'var(--gf-surface-2)', border: '1px solid var(--gf-line)' }}
                >
                  <span
                    className="flex items-center justify-center h-6 w-6 rounded-full text-[10px] font-bold shrink-0"
                    style={{ background: 'var(--lime-soft)', color: 'var(--lime)' }}
                  >
                    {st.step_num || i + 1}
                  </span>
                  <div className="flex-1 min-w-0 space-y-1.5">
                    {isEditing ? (
                      <>
                        <input
                          value={st.title || ''}
                          onChange={(e) => patchStep(i, 'title', e.target.value)}
                          placeholder="Step title"
                          className="w-full bg-transparent text-[13px] font-medium outline-none border-b"
                          style={{ color: 'var(--gf-text)', borderColor: 'var(--gf-line)' }}
                        />
                        <textarea
                          value={st.instruction || ''}
                          onChange={(e) => patchStep(i, 'instruction', e.target.value)}
                          rows={2}
                          placeholder="Instruction"
                          className="w-full bg-transparent text-[11.5px] outline-none resize-y"
                          style={{ color: 'var(--gf-text-dim)' }}
                        />
                        <input
                          value={st.verification || ''}
                          onChange={(e) => patchStep(i, 'verification', e.target.value)}
                          placeholder="How to verify"
                          className="w-full bg-transparent text-[11px] outline-none"
                          style={{ color: 'var(--mint)' }}
                        />
                      </>
                    ) : (
                      <>
                        <p className="text-[13px] font-medium" style={{ color: 'var(--gf-text)' }}>{st.title}</p>
                        {st.instruction && (
                          <p className="text-[11.5px]" style={{ color: 'var(--gf-text-dim)' }}>{st.instruction}</p>
                        )}
                        {st.verification && (
                          <div
                            className="flex items-start gap-1.5 text-[10.5px] rounded px-2 py-1"
                            style={{ background: 'rgba(95,227,176,0.08)', color: 'var(--mint)' }}
                          >
                            <CheckCircle2 className="h-3 w-3 shrink-0 mt-0.5" strokeWidth={1.5} />
                            <span>Verify: {st.verification}</span>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  {isEditing && (
                    <button
                      onClick={() => removeStep(i)}
                      className="shrink-0 h-6 w-6 flex items-center justify-center rounded"
                      style={{ color: 'var(--gf-text-faint)' }}
                      title="Delete step"
                    >
                      <Trash2 className="h-3 w-3" strokeWidth={1.5} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Edge cases */}
        <Section
          title={<><AlertTriangle className="h-3.5 w-3.5 inline mr-1.5" style={{ color: 'var(--amber)' }} strokeWidth={1.5} />Edge cases</>}
          action={isEditing && (
            <button onClick={addEdge} className="text-[11px] flex items-center gap-1" style={{ color: 'var(--lime)' }}>
              <Plus className="h-3 w-3" strokeWidth={1.5} /> Add
            </button>
          )}
        >
          {edgeCases.length === 0 ? (
            <p className="text-[11.5px] italic" style={{ color: 'var(--gf-text-faint)' }}>None</p>
          ) : (
            <div className="space-y-2">
              {edgeCases.map((ec, i) => (
                <div
                  key={i}
                  className="rounded-lg p-3 flex gap-2"
                  style={{ background: 'var(--gf-surface-2)', border: '1px solid var(--gf-line)' }}
                >
                  <div className="flex-1 min-w-0 space-y-1">
                    {isEditing ? (
                      <>
                        <input
                          value={ec.scenario || ''}
                          onChange={(e) => patchEdge(i, 'scenario', e.target.value)}
                          placeholder="What could go wrong"
                          className="w-full bg-transparent text-[12px] outline-none border-b"
                          style={{ color: 'var(--gf-text)', borderColor: 'var(--gf-line)' }}
                        />
                        <input
                          value={ec.resolution || ''}
                          onChange={(e) => patchEdge(i, 'resolution', e.target.value)}
                          placeholder="How to handle it"
                          className="w-full bg-transparent text-[11.5px] outline-none"
                          style={{ color: 'var(--mint)' }}
                        />
                      </>
                    ) : (
                      <div className="text-[11.5px]">
                        <span style={{ color: 'var(--gf-text-dim)' }}>{ec.scenario}</span>
                        <span style={{ color: 'var(--gf-text-faint)' }}> → </span>
                        <span style={{ color: 'var(--mint)' }}>{ec.resolution}</span>
                      </div>
                    )}
                  </div>
                  {isEditing && (
                    <button onClick={() => removeEdge(i)} style={{ color: 'var(--gf-text-faint)' }}>
                      <Trash2 className="h-3 w-3" strokeWidth={1.5} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Agent prompt */}
        <Section
          title={<><Zap className="h-3.5 w-3.5 inline mr-1.5" style={{ color: 'var(--lime)' }} strokeWidth={1.5} />Agent prompt</>}
          action={!isEditing && view.agent_prompt && (
            <button onClick={copyPrompt} className="text-[11px] flex items-center gap-1" style={{ color: 'var(--lime)' }}>
              <Copy className="h-3 w-3" strokeWidth={1.5} /> Copy
            </button>
          )}
        >
          {isEditing ? (
            <textarea
              value={view.agent_prompt || ''}
              onChange={(e) => patchDraft('agent_prompt', e.target.value)}
              rows={8}
              className="w-full rounded px-3 py-2 text-[11.5px] gf-mono outline-none resize-y"
              style={{ background: 'var(--gf-surface-2)', color: 'var(--gf-text)', border: '1px solid var(--gf-line)' }}
              placeholder="System prompt for the guiding AI agent…"
            />
          ) : view.agent_prompt ? (
            <pre
              className="text-[11.5px] gf-mono rounded-lg p-3 whitespace-pre-wrap max-h-64 overflow-y-auto scroll-area"
              style={{ background: 'rgba(0,0,0,0.3)', color: 'var(--gf-text-dim)', border: '1px solid var(--gf-line)' }}
            >
              {view.agent_prompt}
            </pre>
          ) : (
            <p className="text-[11.5px] italic" style={{ color: 'var(--gf-text-faint)' }}>No agent prompt</p>
          )}
        </Section>

          </div>{/* right column */}
        </div>{/* two-column grid */}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------

function Section({ title, action, children }) {
  return (
    <section
      className="rounded-xl border hairline p-4"
      style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
    >
      {(title || action) && (
        <div className="flex items-center justify-between mb-3">
          {title && (
            <h3 className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--gf-text-dim)' }}>
              {title}
            </h3>
          )}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

function Field({ label, view, input, editing }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.14em] mb-1" style={{ color: 'var(--gf-text-faint)' }}>{label}</div>
      {editing && input ? input : (
        <div className="text-[13px] capitalize" style={{ color: 'var(--gf-text)' }}>{view}</div>
      )}
    </div>
  );
}

function ChipEditor({ icon: Icon, title, value, editing, onChange, accent }) {
  const [input, setInput] = useState('');
  const color = accent === 'amber' ? 'var(--amber)' : 'var(--gf-text-dim)';
  const commit = () => {
    const v = input.trim();
    if (!v) return;
    if (!value.includes(v)) onChange([...value, v]);
    setInput('');
  };
  return (
    <Section
      title={<><Icon className="h-3 w-3 inline mr-1.5" style={{ color }} strokeWidth={1.5} />{title}</>}
    >
      <div className="flex flex-wrap gap-1.5">
        {value.length === 0 && !editing && (
          <span className="text-[11px] italic" style={{ color: 'var(--gf-text-faint)' }}>None</span>
        )}
        {value.map((t, i) => (
          <span
            key={`${t}-${i}`}
            className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded"
            style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--gf-text-dim)' }}
          >
            {t}
            {editing && (
              <button
                onClick={() => onChange(value.filter((_, idx) => idx !== i))}
                style={{ color: 'var(--gf-text-faint)' }}
              >
                <X className="h-2.5 w-2.5" strokeWidth={2} />
              </button>
            )}
          </span>
        ))}
      </div>
      {editing && (
        <div className="flex gap-2 mt-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
            }}
            placeholder="Add…"
            className="flex-1 h-7 rounded px-2 text-[11px] outline-none"
            style={{ background: 'var(--gf-surface-2)', color: 'var(--gf-text)', border: '1px solid var(--gf-line)' }}
          />
          <button
            onClick={commit}
            className="h-7 px-2 rounded text-[11px] flex items-center gap-1"
            style={{ background: 'var(--lime-soft)', color: 'var(--lime)' }}
          >
            <Plus className="h-3 w-3" strokeWidth={1.5} />
          </button>
        </div>
      )}
    </Section>
  );
}
