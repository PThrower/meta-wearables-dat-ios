import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Eye, EyeOff, Lock, User, ArrowRight, AlertCircle } from 'lucide-react';
import { SignIn } from '@clerk/react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/context/AuthContext';

const CLERK_ENABLED = !!process.env.REACT_APP_CLERK_PUBLISHABLE_KEY;

export default function LoginPage() {
  if (CLERK_ENABLED) return <ClerkLoginPage />;
  return <LegacyLoginPage />;
}

const GlassLogo = () => (
  <Link to="/" className="inline-flex items-center gap-2">
    <span
      className="inline-flex items-center justify-center h-11 w-11 rounded-xl"
      style={{ background: 'var(--lime)' }}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="2" strokeLinecap="round">
        <circle cx="6" cy="14" r="3.5"/>
        <circle cx="18" cy="14" r="3.5"/>
        <path d="M9.5 14h5M2 10l2-4h3M22 10l-2-4h-3"/>
      </svg>
    </span>
  </Link>
);

const AuthBackdrop = () => (
  <div className="fixed inset-0 -z-10 pointer-events-none">
    <div
      className="absolute inset-0"
      style={{ background: 'radial-gradient(60% 50% at 50% 30%, rgba(212,255,58,0.12) 0%, rgba(0,0,0,0) 60%)' }}
    />
    <div
      className="absolute inset-0 opacity-40"
      style={{
        backgroundImage: `
          linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)
        `,
        backgroundSize: '4rem 4rem',
      }}
    />
  </div>
);

function ClerkLoginPage() {
  return (
    <div
      className="gf-page min-h-screen w-full flex flex-col items-center justify-center py-10 px-4"
      data-testid="login-page"
      style={{ background: 'var(--gf-bg)' }}
    >
      <AuthBackdrop />
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="flex flex-col items-center w-full"
      >
        <div className="flex flex-col items-center text-center mb-7">
          <GlassLogo />
          <h1 className="mt-4 text-[22px] font-semibold tracking-tight" style={{ color: 'var(--gf-text)' }}>
            GlassFlow
          </h1>
          <p className="mt-1 text-[11px] font-mono tracking-[0.2em] uppercase" style={{ color: 'var(--gf-text-faint)' }}>
            fleet · v2.4
          </p>
        </div>

        <SignIn
          routing="hash"
          forceRedirectUrl="/dashboard"
          fallbackRedirectUrl="/dashboard"
          appearance={clerkAppearance}
        />

        <Link
          to="/"
          className="mt-7 text-[12px] transition-colors hover:text-white"
          style={{ color: 'var(--gf-text-faint)' }}
        >
          ← Back to home
        </Link>
      </motion.div>
    </div>
  );
}

const clerkAppearance = {
  variables: {
    colorPrimary: '#D4FF3A',
    colorBackground: '#111317',
    colorText: '#E8EAED',
    colorTextOnPrimaryBackground: '#0A0B0D',
    colorTextSecondary: '#9AA0A7',
    colorInputBackground: '#171A1F',
    colorInputText: '#E8EAED',
    colorNeutral: '#E8EAED',
    colorDanger: '#FF6B5E',
    borderRadius: '0.75rem',
    fontFamily: 'Inter, system-ui, sans-serif',
  },
  elements: {
    rootBox: 'mx-auto',
    cardBox: 'mx-auto',
    card: 'bg-[#111317]/95 backdrop-blur-sm border border-white/[0.07] shadow-2xl rounded-2xl',
    headerTitle: 'text-[#E8EAED] text-lg font-semibold',
    headerSubtitle: 'text-[#9AA0A7] text-sm',
    socialButtonsBlockButton: 'bg-white/[0.04] border border-white/[0.08] text-[#E8EAED] hover:bg-white/[0.08] transition-colors',
    socialButtonsBlockButtonText: 'text-[#E8EAED] font-medium',
    formFieldLabel: 'text-[#9AA0A7] text-sm',
    formFieldInput: 'bg-[#171A1F] border border-white/[0.08] text-[#E8EAED] placeholder:text-[#5B6068] focus:border-[#D4FF3A]/50',
    formButtonPrimary: 'bg-[#D4FF3A] text-black font-semibold hover:brightness-105 transition',
    formButtonReset: 'text-[#9AA0A7] hover:text-[#E8EAED]',
    footerActionText: 'text-[#9AA0A7]',
    footerActionLink: 'text-[#D4FF3A] hover:brightness-110 font-medium',
    dividerLine: 'bg-white/[0.07]',
    dividerText: 'text-[#5B6068] text-xs',
    identityPreviewText: 'text-[#E8EAED]',
    identityPreviewEditButton: 'text-[#D4FF3A]',
    formFieldAction: 'text-[#D4FF3A] hover:brightness-110',
    footer: 'bg-[#0B0D10] border-t border-white/[0.07] rounded-b-2xl',
    footerPages: 'text-[#9AA0A7]',
    footerPagesLink: 'text-[#D4FF3A]',
    badge: 'text-[#D4FF3A] bg-[#D4FF3A]/10 border border-[#D4FF3A]/20',
  },
};

function LegacyLoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    await new Promise((r) => setTimeout(r, 400));
    try {
      const result = await login(username, password);
      if (result.success) navigate('/dashboard');
      else setError(result.error);
    } catch {
      setError('Sign in failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="gf-page min-h-screen w-full flex flex-col items-center justify-center py-10 px-4"
      data-testid="login-page"
      style={{ background: 'var(--gf-bg)' }}
    >
      <AuthBackdrop />
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="w-full max-w-md mx-auto"
      >
        <div className="text-center mb-8">
          <GlassLogo />
          <h1 className="mt-4 text-[22px] font-semibold tracking-tight" style={{ color: 'var(--gf-text)' }}>
            GlassFlow
          </h1>
          <p className="mt-1 text-[11px] font-mono tracking-[0.2em] uppercase" style={{ color: 'var(--gf-text-faint)' }}>fleet · v2.4</p>
          <p className="mt-3 text-[13px]" style={{ color: 'var(--gf-text-dim)' }}>Sign in to access your dashboard</p>
        </div>

        <div
          className="rounded-2xl border hairline p-6 shadow-lg"
          style={{ background: 'var(--gf-surface)', borderColor: 'var(--gf-line)' }}
        >
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-center gap-2 rounded-md p-3 text-sm animate-shake-error"
                style={{ background: 'rgba(255,107,94,0.08)', color: 'var(--red)', border: '1px solid rgba(255,107,94,0.25)' }}
                data-testid="login-error"
              >
                <AlertCircle className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                {error}
              </motion.div>
            )}

            <div className="space-y-2">
              <Label htmlFor="username" style={{ color: 'var(--gf-text-dim)' }}>Username</Label>
              <div className="relative">
                <User
                  className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4"
                  style={{ color: 'var(--gf-text-faint)' }}
                  strokeWidth={1.5}
                />
                <Input
                  id="username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Enter your username"
                  className="pl-10 h-11"
                  style={{ background: 'var(--gf-surface-2)', borderColor: 'var(--gf-line)' }}
                  required
                  data-testid="username-input"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="password" style={{ color: 'var(--gf-text-dim)' }}>Password</Label>
              <div className="relative">
                <Lock
                  className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4"
                  style={{ color: 'var(--gf-text-faint)' }}
                  strokeWidth={1.5}
                />
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  className="pl-10 pr-10 h-11"
                  style={{ background: 'var(--gf-surface-2)', borderColor: 'var(--gf-line)' }}
                  required
                  data-testid="password-input"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                  style={{ color: 'var(--gf-text-faint)' }}
                  data-testid="toggle-password"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" strokeWidth={1.5} /> : <Eye className="h-4 w-4" strokeWidth={1.5} />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="btn-lime w-full h-11 rounded-md text-[13px] font-medium flex items-center justify-center gap-2 disabled:opacity-50"
              data-testid="login-submit"
            >
              {loading ? (
                <>
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Signing in…
                </>
              ) : (
                <>
                  Sign in
                  <ArrowRight className="h-4 w-4" strokeWidth={1.5} />
                </>
              )}
            </button>
          </form>

          <div
            className="mt-6 pt-6 border-t hairline text-center"
            style={{ borderTopColor: 'var(--gf-line)' }}
          >
            <Link
              to="/"
              className="text-[12px] transition-colors"
              style={{ color: 'var(--gf-text-faint)' }}
            >
              ← Back to home
            </Link>
          </div>
        </div>

        <div className="mt-6 text-center">
          <p className="text-[11px]" style={{ color: 'var(--gf-text-faint)' }}>
            Credentials are configured on the backend via environment variables.
          </p>
        </div>
      </motion.div>
    </div>
  );
}
