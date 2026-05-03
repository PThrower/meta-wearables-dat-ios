import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Waves, Eye, EyeOff, Lock, User, ArrowRight, AlertCircle } from 'lucide-react';
import { SignIn } from '@clerk/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/context/AuthContext';

const CLERK_ENABLED = !!process.env.REACT_APP_CLERK_PUBLISHABLE_KEY;

export default function LoginPage() {
  if (CLERK_ENABLED) {
    return <ClerkLoginPage />;
  }
  return <LegacyLoginPage />;
}

// ---------------------------------------------------------------------------
// Clerk Login — renders Clerk's <SignIn /> component
// ---------------------------------------------------------------------------

function ClerkLoginPage() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4" data-testid="login-page">
      {/* Background */}
      <div className="fixed inset-0 -z-10 pointer-events-none">
        <div
          className="absolute inset-0"
          style={{
            background: 'radial-gradient(60% 50% at 50% 30%, rgba(224,255,0,0.15) 0%, rgba(0,0,0,0) 60%)'
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            opacity: 0.4,
            backgroundImage: `
              linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)
            `,
            backgroundSize: '4rem 4rem'
          }}
        />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="w-full max-w-md"
      >
        {/* Logo */}
        <div className="text-center mb-8">
          <Link to="/" className="inline-flex items-center gap-2">
            <span className="inline-flex items-center justify-center h-12 w-12 clip-hex border border-border bg-card">
              <Waves className="h-6 w-6 text-[#E0FF00]" strokeWidth={1.5} />
            </span>
          </Link>
          <h1 className="mt-4 text-2xl font-bold text-foreground">
            <span>Glass</span><span className="text-[#E0FF00]">Flow</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">Dev Dashboard</p>
        </div>

        {/* Clerk SignIn */}
        <div className="flex justify-center">
          <SignIn
            routing="hash"
            forceRedirectUrl="/dashboard"
            fallbackRedirectUrl="/dashboard"
            appearance={{
              variables: {
                colorPrimary: '#E0FF00',
                colorBackground: '#111827',
                colorText: '#ffffff',
                colorTextOnPrimaryBackground: '#000000',
                colorTextSecondary: '#9ca3af',
                colorInputBackground: '#1f2937',
                colorInputText: '#ffffff',
                colorNeutral: '#ffffff',
                colorDanger: '#ef4444',
                borderRadius: '0.75rem',
              },
              elements: {
                rootBox: 'w-full',
                card: 'bg-[#111827]/95 backdrop-blur-sm border border-white/10 shadow-2xl rounded-xl',
                headerTitle: 'text-white text-lg font-semibold',
                headerSubtitle: 'text-gray-400 text-sm',
                socialButtonsBlockButton: 'bg-white/5 border border-white/15 text-white hover:bg-white/10 transition-colors',
                socialButtonsBlockButtonText: 'text-white font-medium',
                socialButtonsBlockButtonArrow: 'text-white',
                formFieldLabel: 'text-gray-300 text-sm',
                formFieldInput: 'bg-[#0d1117] border border-white/15 text-white placeholder:text-gray-400 focus:border-[#E0FF00]/50 focus:ring-1 focus:ring-[#E0FF00]/30',
                formFieldHintText: 'text-gray-400',
                formFieldInputShowPasswordButton: 'text-gray-400 hover:text-white',
                formButtonPrimary: 'bg-[#E0FF00] text-black font-semibold hover:bg-[#c8e600] transition-colors',
                formButtonReset: 'text-gray-300 hover:text-white',
                footerActionText: 'text-gray-300',
                footerActionLink: 'text-[#E0FF00] hover:text-[#c8e600] font-medium',
                dividerLine: 'bg-white/15',
                dividerText: 'text-gray-500 text-xs',
                identityPreviewText: 'text-white',
                identityPreviewEditButton: 'text-[#E0FF00]',
                formFieldAction: 'text-[#E0FF00] hover:text-[#c8e600]',
                footer: 'bg-[#0a0f14] border-t border-white/10 rounded-b-xl',
                footerPages: 'text-gray-400',
                footerPagesLink: 'text-[#E0FF00]',
                badge: 'text-[#E0FF00] bg-[#E0FF00]/10 border border-[#E0FF00]/20',
                alternativeMethodsBlockButton: 'text-gray-300 border-white/15 hover:bg-white/5',
              },
            }}
          />
        </div>

        <div className="mt-6 text-center">
          <Link
            to="/"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            &larr; Back to home
          </Link>
        </div>
      </motion.div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legacy Login — username/password form
// ---------------------------------------------------------------------------

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

    // Simulate a small delay for UX
    await new Promise(resolve => setTimeout(resolve, 500));

    try {
      const result = await login(username, password);
      if (result.success) {
        navigate('/dashboard');
      } else {
        setError(result.error);
      }
    } catch {
      setError('Sign in failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4" data-testid="login-page">
      {/* Background */}
      <div className="fixed inset-0 -z-10 pointer-events-none">
        <div
          className="absolute inset-0"
          style={{
            background: 'radial-gradient(60% 50% at 50% 30%, rgba(224,255,0,0.15) 0%, rgba(0,0,0,0) 60%)'
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            opacity: 0.4,
            backgroundImage: `
              linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)
            `,
            backgroundSize: '4rem 4rem'
          }}
        />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="w-full max-w-md"
      >
        {/* Logo */}
        <div className="text-center mb-8">
          <Link to="/" className="inline-flex items-center gap-2">
            <span className="inline-flex items-center justify-center h-12 w-12 clip-hex border border-border bg-card">
              <Waves className="h-6 w-6 text-[#E0FF00]" strokeWidth={1.5} />
            </span>
          </Link>
          <h1 className="mt-4 text-2xl font-bold text-foreground">
            <span>Glass</span><span className="text-[#E0FF00]">Flow</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">Dev Dashboard</p>
          <p className="mt-2 text-sm text-muted-foreground">Sign in to access your dashboard</p>
        </div>

        {/* Login Form */}
        <div className="clip-chamfer-lg border border-border bg-card p-6 shadow-lg">
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-center gap-2 clip-chamfer-sm bg-red-500/10 border border-red-500/30 p-3 text-sm text-red-600 dark:text-red-400 animate-shake-error"
                data-testid="login-error"
              >
                <AlertCircle className="h-4 w-4 flex-shrink-0" strokeWidth={1.5} />
                {error}
              </motion.div>
            )}

            <div className="space-y-2">
              <Label htmlFor="username" className="text-foreground">Username</Label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
                <Input
                  id="username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Enter your username"
                  className="pl-10 h-11 bg-background border-border"
                  required
                  data-testid="username-input"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="password" className="text-foreground">Password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  className="pl-10 pr-10 h-11 bg-background border-border"
                  required
                  data-testid="password-input"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  data-testid="toggle-password"
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" strokeWidth={1.5} />
                  ) : (
                    <Eye className="h-4 w-4" strokeWidth={1.5} />
                  )}
                </button>
              </div>
            </div>

            <Button
              type="submit"
              disabled={loading}
              variant="hex"
              className="w-full h-11 font-medium"
              data-testid="login-submit"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Signing in...
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  Sign In
                  <ArrowRight className="h-4 w-4" strokeWidth={1.5} />
                </span>
              )}
            </Button>
          </form>

          <div className="mt-6 pt-6 border-t border-border text-center">
            <Link
              to="/"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              &larr; Back to home
            </Link>
          </div>
        </div>

        {/* Credentials hint */}
        <div className="mt-6 text-center">
          <p className="text-xs text-muted-foreground">
            Credentials are configured on the backend via environment variables.
          </p>
        </div>
      </motion.div>
    </div>
  );
}
