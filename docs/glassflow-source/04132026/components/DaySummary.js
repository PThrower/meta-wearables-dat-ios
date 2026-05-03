import React from 'react';
import { motion } from 'framer-motion';
import { Flame, Image as ImageIcon, Sparkles, Calendar } from 'lucide-react';
import { format } from 'date-fns';
import { Link } from 'react-router-dom';

export const DaySummary = ({ summary, compact = false }) => {
  const formatDay = (dayStr) => {
    try {
      const d = new Date(dayStr);
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      
      if (d.toDateString() === today.toDateString()) return 'Today';
      if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
      return format(d, 'EEE, MMM d');
    } catch {
      return dayStr;
    }
  };

  if (compact) {
    return (
      <motion.div
        initial={{ opacity: 0, x: 8 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.3 }}
      >
        <Link to={`/day/${summary.day}`}>
          <div
            className="group p-3 rounded-xl border border-white/10 bg-white/5 hover:border-emerald-500/30 hover:bg-white/[0.07] transition-all cursor-pointer"
            data-testid="day-summary"
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Calendar className="h-3.5 w-3.5 text-white/50" strokeWidth={1.5} />
                <span className="text-sm font-medium text-white/90">{formatDay(summary.day)}</span>
              </div>
            </div>
            <div className="flex items-center gap-3 text-xs text-white/60">
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-white/10 bg-white/5">
                <ImageIcon className="h-3 w-3" strokeWidth={1.5} />
                {summary.image_count}
              </span>
              {summary.total_calories > 0 && (
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 font-mono" data-testid="day-summary-calorie-total">
                  <Flame className="h-3 w-3" strokeWidth={1.5} />
                  {Math.round(summary.total_calories)}
                </span>
              )}
            </div>
          </div>
        </Link>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="p-4 rounded-xl border border-white/10 bg-white/5" data-testid="day-summary">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Calendar className="h-4 w-4 text-white/50" strokeWidth={1.5} />
            <span className="text-lg font-medium text-white/90">{formatDay(summary.day)}</span>
          </div>
        </div>
        
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="p-3 rounded-lg border border-white/10 bg-white/5 text-center">
            <p className="text-2xl font-semibold font-mono text-white/90">{summary.image_count}</p>
            <p className="text-xs text-white/50 mt-1">Moments</p>
          </div>
          <div className="p-3 rounded-lg border border-white/10 bg-white/5 text-center">
            <p className="text-2xl font-semibold font-mono text-emerald-400" data-testid="day-summary-calorie-total">
              {summary.total_calories > 0 ? Math.round(summary.total_calories) : '—'}
            </p>
            <p className="text-xs text-white/50 mt-1">Calories</p>
          </div>
        </div>

        {summary.summary && (
          <div className="pt-3 border-t border-white/10">
            <div className="flex items-center gap-1.5 mb-2">
              <Sparkles className="h-3.5 w-3.5 text-emerald-400" strokeWidth={1.5} />
              <span className="text-xs text-white/50">AI Summary</span>
            </div>
            <p className="text-sm leading-relaxed text-white/70">{summary.summary}</p>
          </div>
        )}

        {summary.top_tags?.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-3">
            {summary.top_tags.map((tag, i) => (
              <span key={i} className="text-xs px-2 py-0.5 rounded-full border border-white/10 bg-white/5 text-white/60">
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
};

export const DaySummarySkeleton = () => (
  <div className="p-3 rounded-xl border border-white/10 bg-white/5">
    <div className="h-4 w-24 bg-white/5 rounded animate-pulse mb-2" />
    <div className="flex gap-3">
      <div className="h-5 w-12 bg-white/5 rounded-full animate-pulse" />
      <div className="h-5 w-14 bg-white/5 rounded-full animate-pulse" />
    </div>
  </div>
);