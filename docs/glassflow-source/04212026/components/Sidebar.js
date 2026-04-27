import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Glasses, Radio, Film, GraduationCap,
  BarChart3, Workflow, LogOut, Sun, Moon, Bot,
  ChevronLeft, ChevronRight,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';

const NAV_ITEMS = [
  { path: '/dashboard', icon: LayoutDashboard, label: 'Command Center' },
  { path: '/devices',   icon: Glasses,         label: 'Fleet' },
  { path: '/agents',    icon: Bot,             label: 'Agents' },
  { path: '/live',      icon: Radio,           label: 'Live Streams' },
  { path: '/feeds',     icon: Film,            label: 'Feeds' },
  { path: '/skills',    icon: GraduationCap,   label: 'Skills' },
  { path: '/analytics', icon: BarChart3,       label: 'Analytics' },
  { path: '/workflows', icon: Workflow,        label: 'Workflows' },
];

export const Sidebar = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout, isAuthenticated } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('gf_nav_collapsed') === '1');

  const setCollapsedPersist = (v) => {
    setCollapsed(v);
    try { localStorage.setItem('gf_nav_collapsed', v ? '1' : '0'); } catch {}
  };

  const isActive = (path) =>
    path === '/dashboard'
      ? location.pathname === '/dashboard'
      : location.pathname.startsWith(path);

  const handleSignOut = async () => {
    await logout();
    navigate('/login');
  };

  const userInitial = (user?.firstName?.[0] || user?.username?.[0] || user?.email?.[0] || 'N').toUpperCase();
  const userLabel = user?.firstName || user?.username || user?.email || 'Operator';

  const width = collapsed ? 64 : 232;

  return (
    <aside
      className="shrink-0 border-r hairline flex flex-col h-full relative transition-all duration-200 overflow-visible"
      style={{ background: 'var(--gf-bg)', width, borderRightColor: 'var(--gf-line)' }}
    >
      {/* Logo */}
      <div
        className={`h-14 flex items-center border-b relative ${collapsed ? 'justify-center px-0' : 'gap-2.5 px-4'}`}
        style={{ borderBottomColor: 'var(--gf-line)' }}
      >
        <Link to="/dashboard" className="flex items-center gap-2.5 min-w-0">
          <span
            className="w-7 h-7 rounded-md flex items-center justify-center shrink-0"
            style={{ background: 'var(--lime)' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="2" strokeLinecap="round">
              <circle cx="6" cy="14" r="3.5"/>
              <circle cx="18" cy="14" r="3.5"/>
              <path d="M9.5 14h5M2 10l2-4h3M22 10l-2-4h-3"/>
            </svg>
          </span>
          {!collapsed && (
            <div className="leading-tight overflow-hidden">
              <div className="text-[13px] font-semibold whitespace-nowrap" style={{ color: 'var(--gf-text)' }}>GlassFlow</div>
              <div className="text-[10px] gf-mono whitespace-nowrap" style={{ color: 'var(--gf-text-faint)' }}>fleet · v2.4</div>
            </div>
          )}
        </Link>
        {!collapsed && (
          <button
            onClick={() => setCollapsedPersist(true)}
            className="ml-auto h-7 w-7 rounded-md flex items-center justify-center transition-colors"
            style={{ color: 'var(--gf-text-faint)' }}
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            <ChevronLeft className="h-3.5 w-3.5" strokeWidth={1.5} />
          </button>
        )}
      </div>

      {collapsed && (
        <button
          onClick={() => setCollapsedPersist(false)}
          className="absolute top-1/2 -right-3 -translate-y-1/2 w-6 h-6 rounded-full border z-10 flex items-center justify-center"
          style={{
            background: 'var(--gf-surface-3)',
            borderColor: 'var(--gf-line-2)',
            color: 'var(--gf-text-faint)',
          }}
          title="Expand sidebar"
          aria-label="Expand sidebar"
        >
          <ChevronRight className="h-3 w-3" strokeWidth={1.5} />
        </button>
      )}

      {/* Nav */}
      <nav className={`flex flex-col gap-0.5 ${collapsed ? 'p-2' : 'p-3'}`}>
        {NAV_ITEMS.map(({ path, icon: Icon, label }) => {
          const active = isActive(path);
          if (collapsed) {
            return (
              <Link
                key={path}
                to={path}
                title={label}
                className="relative h-9 w-full rounded-lg flex items-center justify-center transition"
                style={{
                  background: active ? 'var(--lime-soft)' : 'transparent',
                  color: active ? 'var(--lime)' : 'var(--gf-text-dim)',
                }}
              >
                <Icon className="h-[17px] w-[17px]" strokeWidth={1.5} />
              </Link>
            );
          }
          return (
            <Link
              key={path}
              to={path}
              className="group w-full flex items-center gap-3 px-3 h-9 rounded-lg text-sm transition"
              style={{
                background: active ? 'var(--lime-soft)' : 'transparent',
                color: active ? 'var(--lime)' : 'var(--gf-text-dim)',
              }}
            >
              <Icon className="h-[17px] w-[17px]" strokeWidth={1.5} />
              <span className="flex-1 text-left">{label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Workspace fleet health */}
      {!collapsed && (
        <div className="px-3 mt-2">
          <div
            className="text-[10px] uppercase tracking-[0.18em] px-2 mb-1.5"
            style={{ color: 'var(--gf-text-faint)' }}
          >
            Workspace
          </div>
          <div
            className="rounded-lg p-3 border hairline"
            style={{ background: 'var(--gf-surface-2)', borderColor: 'var(--gf-line)' }}
          >
            <div className="flex items-center justify-between">
              <div className="text-[11px]" style={{ color: 'var(--gf-text-dim)' }}>Fleet health</div>
              <div className="text-[11px] gf-mono" style={{ color: 'var(--mint)' }}>94%</div>
            </div>
            <div
              className="h-1 mt-2 rounded-full overflow-hidden"
              style={{ background: 'rgba(255,255,255,0.06)' }}
            >
              <div
                className="h-full rounded-full"
                style={{ width: '94%', background: 'linear-gradient(90deg, var(--lime), var(--mint))' }}
              />
            </div>
            <div
              className="mt-2.5 flex items-center gap-1.5 text-[10px] gf-mono"
              style={{ color: 'var(--gf-text-faint)' }}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--lime)' }} />
              live
              <span className="w-1.5 h-1.5 rounded-full ml-1.5" style={{ background: 'var(--amber)' }} />
              attn
              <span className="w-1.5 h-1.5 rounded-full ml-1.5" style={{ background: 'var(--gf-text-faint)' }} />
              off
            </div>
          </div>
        </div>
      )}

      {/* Bottom controls */}
      <div
        className={`mt-auto border-t ${collapsed ? 'p-2' : 'p-3'}`}
        style={{ borderTopColor: 'var(--gf-line)' }}
      >
        <button
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
          className={`w-full flex items-center gap-3 px-3 h-8 rounded-lg text-[12px] transition mb-1 ${collapsed ? 'justify-center px-0' : ''}`}
          style={{ color: 'var(--gf-text-dim)' }}
        >
          {theme === 'dark' ? <Sun className="h-4 w-4" strokeWidth={1.5} /> : <Moon className="h-4 w-4" strokeWidth={1.5} />}
          {!collapsed && <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>}
        </button>

        {isAuthenticated && user && (
          <div className={`flex items-center ${collapsed ? 'justify-center' : 'gap-2 px-1'} py-1.5`}>
            {user.imageUrl ? (
              <img src={user.imageUrl} alt="" className="h-7 w-7 rounded-full shrink-0" />
            ) : (
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold text-black shrink-0"
                style={{ background: 'linear-gradient(135deg, #FFB547, #FF6B5E)' }}
              >
                {userInitial}
              </div>
            )}
            {!collapsed && (
              <>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-medium truncate" style={{ color: 'var(--gf-text)' }}>{userLabel}</div>
                  <div className="text-[10px] truncate" style={{ color: 'var(--gf-text-faint)' }}>Fleet Operator · Admin</div>
                </div>
                <button
                  onClick={handleSignOut}
                  title="Sign out"
                  data-testid="sign-out-button"
                  className="transition-colors shrink-0"
                  style={{ color: 'var(--gf-text-faint)' }}
                >
                  <LogOut className="h-3.5 w-3.5" strokeWidth={1.5} />
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </aside>
  );
};
