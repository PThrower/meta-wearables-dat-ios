import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Analytics } from '@vercel/analytics/react';
import { ClerkProvider } from '@clerk/react';
import { ThemeProvider } from '@/context/ThemeContext';
import { AuthProvider } from '@/context/AuthContext';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { AppLayout } from '@/components/AppLayout';
import { Toaster } from '@/components/ui/sonner';
import LandingPage from '@/pages/LandingPage';
import LoginPage from '@/pages/LoginPage';
import SignUpPage from '@/pages/SignUpPage';
import HomePage from '@/pages/HomePage';
import DayPage from '@/pages/DayPage';
import DevicesPage from '@/pages/DevicesPage';
import DeviceDetailPage from '@/pages/DeviceDetailPage';
import WorkflowBuilderPage from '@/pages/WorkflowBuilderPage';
import LiveStreamPage from '@/pages/LiveStreamPage';
import FeedsPage from '@/pages/FeedsPage';
import AnalyticsPage from '@/pages/AnalyticsPage';
import SkillsPage from '@/pages/SkillsPage';
import SkillDetailPage from '@/pages/SkillDetailPage';
import AgentsPage from '@/pages/AgentsPage';
import '@/App.css';

const CLERK_PUBLISHABLE_KEY = process.env.REACT_APP_CLERK_PUBLISHABLE_KEY;

function Protected({ children }) {
  return (
    <ProtectedRoute>
      <AppLayout>{children}</AppLayout>
    </ProtectedRoute>
  );
}

function AppRoutes() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/sign-up" element={<SignUpPage />} />
        <Route path="/glasses" element={<Navigate to="/devices" replace />} />
        <Route path="/dashboard"           element={<Protected><HomePage /></Protected>} />
        <Route path="/devices"             element={<Protected><DevicesPage /></Protected>} />
        <Route path="/devices/:deviceId"   element={<Protected><DeviceDetailPage /></Protected>} />
        <Route path="/agents"              element={<Protected><AgentsPage /></Protected>} />
        <Route path="/workflows"           element={<Protected><WorkflowBuilderPage /></Protected>} />
        <Route path="/workflows/:workflowId" element={<Protected><WorkflowBuilderPage /></Protected>} />
        <Route path="/live"                element={<Protected><LiveStreamPage /></Protected>} />
        <Route path="/feeds"               element={<Protected><FeedsPage /></Protected>} />
        <Route path="/skills"              element={<Protected><SkillsPage /></Protected>} />
        <Route path="/skills/:skillId"     element={<Protected><SkillDetailPage /></Protected>} />
        <Route path="/analytics"           element={<Protected><AnalyticsPage /></Protected>} />
        <Route path="/day/:date"           element={<Protected><DayPage /></Protected>} />
      </Routes>
      <Toaster position="bottom-right" theme="dark" />
      <Analytics />
    </BrowserRouter>
  );
}

function App() {
  const inner = (
    <ThemeProvider>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </ThemeProvider>
  );

  // Wrap with ClerkProvider only when a publishable key is configured
  if (CLERK_PUBLISHABLE_KEY) {
    return (
      <ClerkProvider
        publishableKey={CLERK_PUBLISHABLE_KEY}
        afterSignOutUrl="/login"
        forceRedirectUrl="/dashboard"
        signInForceRedirectUrl="/dashboard"
        signUpForceRedirectUrl="/dashboard"
      >
        {inner}
      </ClerkProvider>
    );
  }

  return inner;
}

export default App;
