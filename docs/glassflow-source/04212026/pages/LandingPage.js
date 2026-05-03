import React from 'react';

export default function LandingPage() {
  return (
    <div className="h-screen w-full overflow-hidden bg-[#05080A]" data-testid="landing-page-wrapper">
      <iframe
        src="/agentic-landing.html"
        title="Agentic Glass Landing"
        className="h-full w-full border-0"
      />
    </div>
  );
}
