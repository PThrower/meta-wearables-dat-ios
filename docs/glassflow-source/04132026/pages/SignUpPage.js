import React from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Waves } from 'lucide-react';
import { SignUp } from '@clerk/react';

export default function SignUpPage() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4" data-testid="sign-up-page">
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
          <p className="mt-1 text-xs text-muted-foreground">Create your account</p>
        </div>

        {/* Clerk SignUp */}
        <div className="flex justify-center">
          <SignUp
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
            to="/login"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            &larr; Already have an account? Sign in
          </Link>
        </div>
      </motion.div>
    </div>
  );
}
