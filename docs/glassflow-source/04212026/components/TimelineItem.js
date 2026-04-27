import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Flame, Tag, X, Clock } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { format } from 'date-fns';

export const TimelineItem = ({ image, index = 0 }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const formatTime = (dateStr) => {
    try {
      return format(new Date(dateStr), 'h:mm a');
    } catch {
      return '';
    }
  };

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: index * 0.05 }}
        className="relative pl-6 pb-6 group"
        data-testid="timeline-card"
      >
        {/* Timeline dot */}
        <div className="absolute left-0 top-2 w-2 h-2 rounded-full bg-emerald-500/60 group-hover:bg-emerald-400 transition-colors shadow-[0_0_8px_rgba(16,185,129,0.4)]" />
        
        {/* Content */}
        <div
          className="cursor-pointer"
          onClick={() => setIsOpen(true)}
        >
          {/* Time + Calories */}
          <div className="flex items-center gap-3 mb-2" data-testid="timeline-card-time">
            <span className="inline-flex items-center gap-1.5 text-xs font-mono text-white/60">
              <Clock className="h-3 w-3" strokeWidth={1.5} />
              {formatTime(image.created_at)}
            </span>
            {image.calories && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-xs font-mono text-emerald-400" data-testid="food-calories">
                <Flame className="h-3 w-3" strokeWidth={1.5} />
                {Math.round(image.calories)}
              </span>
            )}
          </div>

          {/* Image Card */}
          <div className="relative max-w-md rounded-xl overflow-hidden border border-white/10 bg-white/5 hover:border-white/20 hover:shadow-[0_0_30px_rgba(16,185,129,0.1)] transition-all duration-200">
            <div className="aspect-[16/9] relative overflow-hidden">
              {!loaded && (
                <div className="absolute inset-0 animate-pulse bg-white/5" />
              )}
              <img
                src={image.image_url}
                alt={image.caption || ''}
                className={`w-full h-full object-cover transition-all duration-300 group-hover:scale-[1.02] ${
                  loaded ? 'opacity-100' : 'opacity-0'
                }`}
                onLoad={() => setLoaded(true)}
                onError={(e) => {
                  e.target.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="%23111" width="100" height="100"/></svg>';
                  setLoaded(true);
                }}
                data-testid="timeline-card-image"
              />
              {/* Gradient overlay */}
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
            </div>
            
            {/* Caption + Tags overlay */}
            <div className="p-3">
              <p className="text-sm text-white/90 leading-relaxed line-clamp-2" data-testid="timeline-card-caption">
                {image.caption || 'No description'}
              </p>

              {/* Tags */}
              {image.tags?.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {image.tags.slice(0, 4).map((tag, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border border-white/10 bg-white/5 text-white/60"
                      data-testid="tag-badge"
                    >
                      <Tag className="h-2.5 w-2.5" strokeWidth={1.5} />
                      {tag}
                    </span>
                  ))}
                  {image.tags.length > 4 && (
                    <span className="text-xs px-2 py-0.5 rounded-full border border-white/10 bg-white/5 text-white/50">
                      +{image.tags.length - 4}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </motion.div>

      {/* Detail Modal */}
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-2xl p-0 overflow-hidden bg-black/90 border-white/10 backdrop-blur-xl">
          <button
            onClick={() => setIsOpen(false)}
            className="absolute top-3 right-3 z-10 p-2 rounded-lg border border-white/10 bg-black/50 text-white/70 hover:text-white hover:bg-black/70 transition-colors"
          >
            <X className="h-4 w-4" strokeWidth={1.5} />
          </button>
          <img
            src={image.image_url}
            alt={image.caption || ''}
            className="w-full max-h-[60vh] object-contain bg-black/50"
          />
          <div className="p-4 space-y-3 border-t border-white/10">
            <p className="text-sm leading-relaxed text-white/90">{image.caption}</p>
            {image.calories && (
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10">
                <Flame className="h-4 w-4 text-emerald-400" strokeWidth={1.5} />
                <span className="text-sm font-mono text-emerald-400">{Math.round(image.calories)} cal</span>
              </div>
            )}
            {image.tags?.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {image.tags.map((tag, i) => (
                  <span key={i} className="text-xs px-2.5 py-1 rounded-lg border border-white/10 bg-white/5 text-white/70">
                    {tag}
                  </span>
                ))}
              </div>
            )}
            <p className="text-xs text-white/50 font-mono">
              {format(new Date(image.created_at), 'MMM d, yyyy • h:mm a')}
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};

export const TimelineItemSkeleton = () => (
  <div className="relative pl-6 pb-6">
    <div className="absolute left-0 top-2 w-2 h-2 rounded-full bg-white/10" />
    <div className="space-y-2 max-w-md">
      <div className="h-4 w-20 bg-white/5 rounded animate-pulse" />
      <div className="rounded-xl overflow-hidden border border-white/10 bg-white/5">
        <div className="aspect-[16/9] bg-white/5 animate-pulse" />
        <div className="p-3 space-y-2">
          <div className="h-4 w-3/4 bg-white/5 rounded animate-pulse" />
          <div className="flex gap-1.5">
            <div className="h-5 w-14 bg-white/5 rounded-full animate-pulse" />
            <div className="h-5 w-18 bg-white/5 rounded-full animate-pulse" />
          </div>
        </div>
      </div>
    </div>
  </div>
);