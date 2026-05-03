import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Loader2, Sparkles } from 'lucide-react';
import { TimelineItem, TimelineItemSkeleton } from '@/components/TimelineItem';
import { DaySummary, DaySummarySkeleton } from '@/components/DaySummary';
import { getTimeline, getDaySummary, generateDaySummary } from '@/lib/api';
import { format } from 'date-fns';
import { toast } from 'sonner';

export default function DayPage() {
  const { date } = useParams();
  const [images, setImages] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const [timelineData, summaryData] = await Promise.all([
          getTimeline({ day: date, limit: 100 }),
          getDaySummary(date).catch(() => null),
        ]);
        setImages(timelineData);
        setSummary(summaryData);
      } catch (error) {
        console.error('Error:', error);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [date]);

  const handleGenerateSummary = async () => {
    setGenerating(true);
    try {
      const newSummary = await generateDaySummary(date);
      setSummary(newSummary);
      toast.success('Summary generated');
    } catch {
      toast.error('Failed to generate summary');
    } finally {
      setGenerating(false);
    }
  };

  const formattedDate = () => {
    try {
      return format(new Date(date), 'EEEE, MMMM d, yyyy');
    } catch {
      return date;
    }
  };

  return (
    <div className="gf-page min-h-screen" style={{ background: 'var(--gf-bg)' }}>
      <main className="max-w-5xl mx-auto p-6 sm:p-8 space-y-6">
        <Link
          to="/dashboard"
          className="inline-flex items-center gap-1.5 text-[12px] hover:underline"
          style={{ color: 'var(--gf-text-dim)' }}
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.5} />
          Back
        </Link>

        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] mb-1.5" style={{ color: 'var(--gf-text-faint)' }}>
            Day
          </div>
          <h1 className="text-[26px] font-semibold tracking-tight" style={{ color: 'var(--gf-text)' }}>
            {formattedDate()}
          </h1>
          <p className="text-[13px] mt-1" style={{ color: 'var(--gf-text-dim)' }}>
            {loading ? 'Loading…' : `${images.length} moment${images.length === 1 ? '' : 's'}`}
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-8">
          {/* Timeline */}
          <div
            className="rounded-2xl border hairline p-5 relative"
            style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
          >
            <div
              className="absolute left-[23px] top-10 bottom-6 w-px"
              style={{ background: 'linear-gradient(to bottom, var(--lime) 0%, var(--gf-line) 40%, transparent 100%)' }}
            />

            {loading ? (
              <div className="space-y-1">
                {[...Array(4)].map((_, i) => <TimelineItemSkeleton key={i} />)}
              </div>
            ) : images.length === 0 ? (
              <p className="text-sm text-center py-8" style={{ color: 'var(--gf-text-faint)' }}>
                No moments this day
              </p>
            ) : (
              images.map((image, idx) => (
                <TimelineItem key={image.id} image={image} index={idx} />
              ))
            )}
          </div>

          {/* Sidebar */}
          <div className="hidden lg:block">
            <div className="sticky top-20 space-y-3">
              <h3 className="text-[10px] font-medium uppercase tracking-[0.18em]" style={{ color: 'var(--gf-text-faint)' }}>
                Day summary
              </h3>
              {loading ? (
                <DaySummarySkeleton />
              ) : summary ? (
                <>
                  <div
                    className="rounded-2xl border hairline p-4"
                    style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
                  >
                    <DaySummary summary={summary} />
                  </div>
                  <button
                    onClick={handleGenerateSummary}
                    disabled={generating}
                    className="btn-ghost w-full h-8 px-3 rounded-md text-[12px] flex items-center justify-center gap-1.5 disabled:opacity-50"
                  >
                    {generating ? (
                      <><Loader2 className="h-3 w-3 animate-spin" />Generating…</>
                    ) : (
                      <><Sparkles className="h-3 w-3" strokeWidth={1.5} />Regenerate</>
                    )}
                  </button>
                </>
              ) : (
                <div
                  className="rounded-2xl border hairline p-4 text-center"
                  style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
                >
                  <p className="text-[12px] mb-3" style={{ color: 'var(--gf-text-dim)' }}>
                    No summary yet
                  </p>
                  <button
                    onClick={handleGenerateSummary}
                    disabled={generating || images.length === 0}
                    className="btn-lime w-full h-8 px-3 rounded-md text-[12px] font-medium flex items-center justify-center gap-1.5 disabled:opacity-50"
                  >
                    {generating ? (
                      <><Loader2 className="h-3 w-3 animate-spin" />Generating…</>
                    ) : (
                      <><Sparkles className="h-3 w-3" strokeWidth={1.5} />Generate summary</>
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
