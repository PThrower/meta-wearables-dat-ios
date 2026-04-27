import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Loader2, Sparkles } from 'lucide-react';
import { Header } from '@/components/Header';
import { TimelineItem, TimelineItemSkeleton } from '@/components/TimelineItem';
import { DaySummary, DaySummarySkeleton } from '@/components/DaySummary';
import { Button } from '@/components/ui/button';
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
          getDaySummary(date).catch(() => null)
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
    } catch (error) {
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
    <div className="min-h-screen bg-background">
      <Header />
      
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
        <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6">
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>

        <div className="mb-6">
          <h1 className="text-2xl font-semibold mb-1">{formattedDate()}</h1>
          <p className="text-sm text-muted-foreground">
            {loading ? 'Loading...' : `${images.length} moment${images.length !== 1 ? 's' : ''}`}
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-8">
          {/* Timeline */}
          <div className="relative">
            <div className="absolute left-[3px] top-4 bottom-0 w-px bg-gradient-to-b from-primary/40 via-border/40 to-transparent" />
            
            {loading ? (
              <div className="space-y-1">
                {[...Array(4)].map((_, i) => <TimelineItemSkeleton key={i} />)}
              </div>
            ) : images.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">No moments this day</p>
            ) : (
              images.map((image, idx) => (
                <TimelineItem key={image.id} image={image} index={idx} />
              ))
            )}
          </div>

          {/* Sidebar */}
          <div className="hidden lg:block">
            <div className="sticky top-20 space-y-4">
              <h3 className="text-xs font-medium text-muted-foreground tracking-wide uppercase">Day Summary</h3>
              {loading ? (
                <DaySummarySkeleton />
              ) : summary ? (
                <>
                  <DaySummary summary={summary} />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleGenerateSummary}
                    disabled={generating}
                    className="w-full text-xs"
                  >
                    {generating ? (
                      <><Loader2 className="h-3 w-3 mr-1.5 animate-spin" />Generating...</>
                    ) : (
                      <><Sparkles className="h-3 w-3 mr-1.5" />Regenerate</>
                    )}
                  </Button>
                </>
              ) : (
                <div className="p-4 rounded-xl bg-card/30 border border-border/30 text-center">
                  <p className="text-xs text-muted-foreground mb-3">No summary yet</p>
                  <Button
                    size="sm"
                    onClick={handleGenerateSummary}
                    disabled={generating || images.length === 0}
                    className="text-xs"
                  >
                    {generating ? (
                      <><Loader2 className="h-3 w-3 mr-1.5 animate-spin" />Generating...</>
                    ) : (
                      <><Sparkles className="h-3 w-3 mr-1.5" />Generate Summary</>
                    )}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
