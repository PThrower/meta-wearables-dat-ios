import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  GraduationCap, ChevronRight, RefreshCw, Loader2, Clock, Wrench,
  AlertTriangle, CheckCircle2, Copy, Play, Trash2, Shield, ListChecks,
  ChevronDown, BookOpen, Zap
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { getSkills, deleteSkill, getFeed } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { toast } from 'sonner';

const difficultyColors = {
  beginner: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
  intermediate: 'bg-amber-500/15 text-amber-400 border-amber-500/20',
  advanced: 'bg-red-500/15 text-red-400 border-red-500/20',
};

const statusColors = {
  completed: 'bg-emerald-500/15 text-emerald-400',
  processing: 'bg-amber-500/15 text-amber-400',
  pending: 'bg-white/10 text-white/50',
  failed: 'bg-red-500/15 text-red-400',
};

export default function SkillsPage() {
  const { user } = useAuth();
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const [playbackUrl, setPlaybackUrl] = useState(null);

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

  const handleDelete = async (id, e) => {
    e.stopPropagation();
    if (!confirm('Delete this skill?')) return;
    try {
      await deleteSkill(id);
      setSkills((prev) => prev.filter((s) => s.id !== id));
      toast.success('Skill deleted');
    } catch {
      toast.error('Failed to delete skill');
    }
  };

  const handleCopyPrompt = (prompt, e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(prompt);
    toast.success('Agent prompt copied to clipboard');
  };

  const toggleExpand = async (skill) => {
    if (expandedId === skill.id) {
      setExpandedId(null);
      setPlaybackUrl(null);
      return;
    }
    setExpandedId(skill.id);
    setPlaybackUrl(null);
    // Try to get video playback for linked recording
    if (skill.media_asset_id) {
      try {
        const feed = await getFeed(skill.media_asset_id);
        if (feed?.playback_url) setPlaybackUrl(feed.playback_url);
      } catch { /* no video available */ }
    }
  };

  return (
    <div className="min-h-screen bg-background" data-testid="skills-page">
      <Header />

      <main className="px-5 lg:px-8 py-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
          <div>
            <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
              <GraduationCap className="h-5 w-5 text-[#E0FF00]" strokeWidth={1.5} />
              Skills Library
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {skills.filter(s => s.extraction_status === 'completed').length} skill{skills.filter(s => s.extraction_status === 'completed').length !== 1 ? 's' : ''} extracted from recordings
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={fetchSkills}
            className="border-white/10 text-white/60 hover:text-white h-8"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.5} />
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 text-[#E0FF00] animate-spin" />
          </div>
        ) : skills.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-white/40">
            <GraduationCap className="h-12 w-12 mb-4" strokeWidth={1} />
            <p className="text-sm">No skills extracted yet</p>
            <p className="text-xs mt-1">Go to Feeds, expand a recording, and click "Extract Skill"</p>
          </div>
        ) : (
          <div className="space-y-2">
            {skills.map((skill, idx) => {
              const isExpanded = expandedId === skill.id;
              const steps = Array.isArray(skill.steps) ? skill.steps : [];
              const edgeCases = Array.isArray(skill.edge_cases) ? skill.edge_cases : [];

              return (
                <div key={skill.id} data-testid={`skill-${skill.id}`}>
                  <motion.div
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: idx * 0.03 }}
                    className={`flex items-center gap-3 px-4 py-3 rounded-lg border cursor-pointer transition-colors ${
                      isExpanded
                        ? 'bg-[#E0FF00]/5 border-[#E0FF00]/20'
                        : 'bg-white/[0.03] border-white/10 hover:border-white/20'
                    }`}
                    onClick={() => toggleExpand(skill)}
                  >
                    <ChevronRight className={`h-4 w-4 text-white/30 transition-transform flex-shrink-0 ${isExpanded ? 'rotate-90 text-[#E0FF00]' : ''}`} strokeWidth={1.5} />

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white/90 truncate">{skill.name}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${statusColors[skill.extraction_status] || statusColors.pending}`}>
                          {skill.extraction_status}
                        </span>
                      </div>
                      {skill.description && (
                        <p className="text-xs text-white/40 truncate mt-0.5">{skill.description}</p>
                      )}
                    </div>

                    <div className="hidden sm:flex items-center gap-3 text-xs text-white/40 flex-shrink-0">
                      {skill.category && (
                        <Badge variant="outline" className="text-[10px] border-white/10 text-white/50 px-1.5 py-0">{skill.category}</Badge>
                      )}
                      {skill.difficulty && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${difficultyColors[skill.difficulty] || ''}`}>{skill.difficulty}</span>
                      )}
                      <span className="flex items-center gap-1">
                        <ListChecks className="h-3 w-3" strokeWidth={1.5} />
                        {steps.length} steps
                      </span>
                      {skill.estimated_duration_minutes && (
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" strokeWidth={1.5} />
                          {skill.estimated_duration_minutes}m
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-1 flex-shrink-0">
                      {skill.agent_prompt && (
                        <button
                          onClick={(e) => handleCopyPrompt(skill.agent_prompt, e)}
                          className="p-1.5 rounded hover:bg-white/10 text-white/30 hover:text-[#E0FF00] transition-colors"
                          title="Copy agent prompt"
                        >
                          <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
                        </button>
                      )}
                      <button
                        onClick={(e) => handleDelete(skill.id, e)}
                        className="p-1.5 rounded hover:bg-red-500/10 text-white/30 hover:text-red-400 transition-colors"
                        title="Delete skill"
                      >
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                      </button>
                    </div>
                  </motion.div>

                  {/* Expanded detail */}
                  <AnimatePresence>
                    {isExpanded && skill.extraction_status === 'completed' && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <div className="p-4 mx-4 mb-2 bg-white/[0.02] border border-white/5 rounded-b-lg space-y-5">
                          {/* Steps */}
                          <div>
                            <h3 className="text-xs font-semibold text-white/60 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                              <ListChecks className="h-3.5 w-3.5 text-[#E0FF00]" strokeWidth={1.5} />
                              Procedure — {steps.length} Steps
                            </h3>
                            <div className="space-y-2">
                              {steps.map((step, i) => (
                                <div key={i} className="flex gap-3 group">
                                  <div className="flex flex-col items-center">
                                    <span className="flex items-center justify-center h-6 w-6 rounded-full bg-[#E0FF00]/10 text-[#E0FF00] text-[10px] font-bold flex-shrink-0">
                                      {step.step_num || i + 1}
                                    </span>
                                    {i < steps.length - 1 && <div className="w-px flex-1 bg-white/10 my-1" />}
                                  </div>
                                  <div className="pb-3 min-w-0">
                                    <p className="text-xs font-medium text-white/90">{step.title}</p>
                                    <p className="text-[11px] text-white/50 mt-0.5">{step.instruction}</p>
                                    {step.verification && (
                                      <div className="flex items-start gap-1.5 mt-1.5 text-[10px] text-emerald-400/80 bg-emerald-500/5 rounded px-2 py-1">
                                        <CheckCircle2 className="h-3 w-3 flex-shrink-0 mt-0.5" strokeWidth={1.5} />
                                        <span>Verify: {step.verification}</span>
                                      </div>
                                    )}
                                    {step.estimated_seconds && (
                                      <span className="text-[10px] text-white/30 mt-1 inline-block">~{Math.ceil(step.estimated_seconds / 60)}min</span>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* Info grid */}
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                            {/* Tools */}
                            {skill.tools_required?.length > 0 && (
                              <div className="bg-white/5 rounded-lg p-3">
                                <h4 className="text-[10px] font-semibold text-white/40 uppercase tracking-wider mb-2 flex items-center gap-1">
                                  <Wrench className="h-3 w-3" strokeWidth={1.5} /> Tools Required
                                </h4>
                                <div className="flex flex-wrap gap-1">
                                  {skill.tools_required.map((t, i) => (
                                    <Badge key={i} variant="outline" className="text-[10px] border-white/10 text-white/60 px-1.5 py-0">{t}</Badge>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Safety */}
                            {skill.safety_notes?.length > 0 && (
                              <div className="bg-white/5 rounded-lg p-3">
                                <h4 className="text-[10px] font-semibold text-white/40 uppercase tracking-wider mb-2 flex items-center gap-1">
                                  <Shield className="h-3 w-3" strokeWidth={1.5} /> Safety Notes
                                </h4>
                                <ul className="space-y-1">
                                  {skill.safety_notes.map((n, i) => (
                                    <li key={i} className="text-[11px] text-white/50 flex items-start gap-1">
                                      <span className="text-amber-400 mt-0.5">!</span> {n}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {/* Edge cases */}
                            {edgeCases.length > 0 && (
                              <div className="bg-white/5 rounded-lg p-3">
                                <h4 className="text-[10px] font-semibold text-white/40 uppercase tracking-wider mb-2 flex items-center gap-1">
                                  <AlertTriangle className="h-3 w-3" strokeWidth={1.5} /> Edge Cases
                                </h4>
                                <ul className="space-y-1.5">
                                  {edgeCases.map((ec, i) => (
                                    <li key={i} className="text-[11px]">
                                      <span className="text-white/60">{ec.scenario}</span>
                                      <span className="text-white/30"> → </span>
                                      <span className="text-emerald-400/70">{ec.resolution}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>

                          {/* Agent prompt */}
                          {skill.agent_prompt && (
                            <div>
                              <div className="flex items-center justify-between mb-2">
                                <h3 className="text-xs font-semibold text-white/60 uppercase tracking-wider flex items-center gap-1.5">
                                  <Zap className="h-3.5 w-3.5 text-[#E0FF00]" strokeWidth={1.5} />
                                  Agent Prompt
                                </h3>
                                <button
                                  onClick={(e) => handleCopyPrompt(skill.agent_prompt, e)}
                                  className="flex items-center gap-1 text-[10px] text-[#E0FF00]/70 hover:text-[#E0FF00] transition-colors"
                                >
                                  <Copy className="h-3 w-3" strokeWidth={1.5} /> Copy
                                </button>
                              </div>
                              <pre className="text-[11px] text-white/50 bg-black/30 border border-white/5 rounded-lg p-3 max-h-48 overflow-y-auto whitespace-pre-wrap font-mono">
                                {skill.agent_prompt}
                              </pre>
                            </div>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
