import React from 'react';
import { Sidebar } from '@/components/Sidebar';

export const AppLayout = ({ children }) => (
  <div
    className="flex h-screen overflow-hidden gf-page"
    style={{ background: 'var(--gf-bg)', color: 'var(--gf-text)' }}
  >
    <Sidebar />
    <div className="flex-1 overflow-auto min-w-0 scroll-area">
      {children}
    </div>
  </div>
);
