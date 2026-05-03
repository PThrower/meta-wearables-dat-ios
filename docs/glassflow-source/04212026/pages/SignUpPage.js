import React from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { SignUp } from '@clerk/react';

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

export default function SignUpPage() {
  return (
    <div
      className="gf-page min-h-screen w-full flex flex-col items-center justify-center py-10 px-4"
      data-testid="sign-up-page"
      style={{ background: 'var(--gf-bg)' }}
    >
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

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="flex flex-col items-center w-full"
      >
        <div className="flex flex-col items-center text-center mb-7">
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
          <h1 className="mt-4 text-[22px] font-semibold tracking-tight" style={{ color: 'var(--gf-text)' }}>
            GlassFlow
          </h1>
          <p className="mt-1 text-[11px] font-mono tracking-[0.2em] uppercase" style={{ color: 'var(--gf-text-faint)' }}>
            Create your account
          </p>
        </div>

        <SignUp
          routing="hash"
          forceRedirectUrl="/dashboard"
          fallbackRedirectUrl="/dashboard"
          appearance={clerkAppearance}
        />

        <Link
          to="/login"
          className="mt-7 text-[12px] transition-colors hover:text-white"
          style={{ color: 'var(--gf-text-faint)' }}
        >
          ← Already have an account? Sign in
        </Link>
      </motion.div>
    </div>
  );
}
