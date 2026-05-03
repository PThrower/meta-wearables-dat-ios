import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, Glasses, Waves, Workflow, LayoutDashboard, Radio, Film, BarChart3, LogOut, User, GraduationCap } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';

export const Header = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout, isAuthenticated } = useAuth();

  const isActive = (path) => {
    if (path === '/dashboard') {
      return location.pathname === '/dashboard';
    }
    return location.pathname.startsWith(path);
  };

  const handleSignOut = async () => {
    await logout();
    navigate('/login');
  };

  const navLinkClass = (path) =>
    `px-2.5 py-1 text-xs font-medium transition-all flex items-center gap-1.5 relative ${
      isActive(path)
        ? 'text-[#E0FF00] after:absolute after:bottom-0 after:left-1 after:right-1 after:h-0.5 after:bg-[#E0FF00] after:clip-chamfer-sm'
        : 'text-white/60 hover:text-white relative after:absolute after:bottom-0 after:left-1 after:right-1 after:h-0.5 after:bg-white/30 after:scale-x-0 hover:after:scale-x-100 after:transition-transform after:origin-left'
    }`;

  return (
    <header className="sticky top-0 z-40 border-b backdrop-blur-xl border-white/10 bg-[#05080A]/85">
      <div className="px-4 sm:px-6">
        <div className="flex h-12 items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              to="/"
              className="flex items-center gap-1 transition-colors text-white/60 hover:text-white"
              data-testid="back-to-landing"
            >
              <ArrowLeft className="h-4 w-4" strokeWidth={1.5} />
            </Link>

            <Link to="/dashboard" className="flex items-center gap-2" data-testid="dashboard-logo">
              <span className="inline-flex h-7 w-7 items-center justify-center clip-hex border border-white/15 bg-white/5">
                <Waves className="h-3.5 w-3.5 text-[#E0FF00]" strokeWidth={1.5} />
              </span>
              <div className="leading-none">
                <span className="text-sm font-semibold tracking-tight text-white">Glass</span>
                <span className="text-sm font-semibold tracking-tight text-[#E0FF00]">Flow</span>
              </div>
            </Link>

            <nav className="ml-2 hidden items-center gap-1 md:flex">
              <Link to="/dashboard" data-testid="nav-dashboard" className={navLinkClass('/dashboard')}>
                <LayoutDashboard className="h-3.5 w-3.5" strokeWidth={1.5} />
                Command Center
              </Link>
              <span className="w-1 h-1 bg-white/20 rotate-45 mx-1" />
              <Link to="/devices" data-testid="nav-devices" className={navLinkClass('/devices')}>
                <Glasses className="h-3.5 w-3.5" strokeWidth={1.5} />
                Devices
              </Link>
              <span className="w-1 h-1 bg-white/20 rotate-45 mx-1" />
              <Link to="/live" data-testid="nav-live" className={navLinkClass('/live')}>
                <Radio className="h-3.5 w-3.5" strokeWidth={1.5} />
                Live Streams
              </Link>
              <span className="w-1 h-1 bg-white/20 rotate-45 mx-1" />
              <Link to="/feeds" data-testid="nav-feeds" className={navLinkClass('/feeds')}>
                <Film className="h-3.5 w-3.5" strokeWidth={1.5} />
                Feeds
              </Link>
              <span className="w-1 h-1 bg-white/20 rotate-45 mx-1" />
              <Link to="/skills" data-testid="nav-skills" className={navLinkClass('/skills')}>
                <GraduationCap className="h-3.5 w-3.5" strokeWidth={1.5} />
                Skills
              </Link>
              <span className="w-1 h-1 bg-white/20 rotate-45 mx-1" />
              <Link to="/analytics" data-testid="nav-analytics" className={navLinkClass('/analytics')}>
                <BarChart3 className="h-3.5 w-3.5" strokeWidth={1.5} />
                Analytics
              </Link>
              <span className="w-1 h-1 bg-white/20 rotate-45 mx-1" />
              <Link to="/workflows" data-testid="nav-workflows" className={navLinkClass('/workflows')}>
                <Workflow className="h-3.5 w-3.5" strokeWidth={1.5} />
                Workflows
              </Link>
            </nav>
          </div>

          {/* User info + sign out */}
          {isAuthenticated && user && (
            <div className="flex items-center gap-3">
              <div className="hidden sm:flex items-center gap-2 text-xs text-white/60">
                {user.imageUrl ? (
                  <img src={user.imageUrl} alt="" className="h-6 w-6 rounded-full border border-white/10" />
                ) : (
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-white/10 border border-white/10">
                    <User className="h-3 w-3" strokeWidth={1.5} />
                  </span>
                )}
                <span className="max-w-[120px] truncate">
                  {user.firstName || user.username || user.email || 'User'}
                </span>
              </div>
              <button
                onClick={handleSignOut}
                className="flex items-center gap-1 px-2 py-1 text-xs text-white/50 hover:text-white transition-colors"
                data-testid="sign-out-button"
              >
                <LogOut className="h-3.5 w-3.5" strokeWidth={1.5} />
                <span className="hidden sm:inline">Sign Out</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
