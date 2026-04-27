import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useUser, useAuth as useClerkAuth } from '@clerk/react';
import { getCurrentUser, loginDashboard, setAuthToken, getAuthToken } from '@/lib/api';

const AuthContext = createContext();

const USER_STORAGE_KEY = 'glassflow_user';
const CLERK_ENABLED = !!process.env.REACT_APP_CLERK_PUBLISHABLE_KEY;

/**
 * Auth provider that supports two modes:
 * 1. Clerk mode (REACT_APP_CLERK_PUBLISHABLE_KEY set) — delegates auth to Clerk
 * 2. Legacy mode — username/password login against FastAPI backend
 */
export const AuthProvider = ({ children }) => {
  if (CLERK_ENABLED) {
    return <ClerkAuthProvider>{children}</ClerkAuthProvider>;
  }
  return <LegacyAuthProvider>{children}</LegacyAuthProvider>;
};

// ---------------------------------------------------------------------------
// Clerk-powered Auth
// ---------------------------------------------------------------------------

const ClerkAuthProvider = ({ children }) => {
  const { isLoaded, isSignedIn, user: clerkUser } = useUser();
  const { getToken, signOut: clerkSignOut } = useClerkAuth();
  const [user, setUser] = useState(null);
  const [tokenReady, setTokenReady] = useState(false);

  useEffect(() => {
    if (!isLoaded) return;

    if (isSignedIn && clerkUser) {
      const userData = {
        id: clerkUser.id,
        username: clerkUser.username || clerkUser.primaryEmailAddress?.emailAddress || 'user',
        email: clerkUser.primaryEmailAddress?.emailAddress,
        firstName: clerkUser.firstName,
        lastName: clerkUser.lastName,
        imageUrl: clerkUser.imageUrl,
        role: 'admin',
        org_id: clerkUser.organizationMemberships?.[0]?.organization?.id || null,
        loggedInAt: new Date().toISOString(),
      };
      setUser(userData);

      // Set the Clerk JWT as the API bearer token
      getToken().then((token) => {
        if (token) setAuthToken(token);
        setTokenReady(true);
      });
    } else if (isLoaded && !isSignedIn) {
      setUser(null);
      setAuthToken(null);
      setTokenReady(true);
    }
  }, [isLoaded, isSignedIn, clerkUser, getToken]);

  // Refresh Clerk token periodically (tokens expire)
  useEffect(() => {
    if (!isSignedIn) return;
    const interval = setInterval(() => {
      getToken().then((token) => {
        if (token) setAuthToken(token);
      });
    }, 50_000); // refresh every 50s (Clerk tokens last ~60s)
    return () => clearInterval(interval);
  }, [isSignedIn, getToken]);

  const login = useCallback(async () => {
    // In Clerk mode, login is handled by Clerk UI — this is a no-op
    return { success: true };
  }, []);

  const logout = useCallback(async () => {
    setUser(null);
    setAuthToken(null);
    localStorage.removeItem(USER_STORAGE_KEY);
    await clerkSignOut();
  }, [clerkSignOut]);

  const isAuthenticated = !!user;
  // Stay in loading state until Clerk is fully loaded AND we've processed the auth state
  const loading = !isLoaded || !tokenReady;

  return (
    <AuthContext.Provider value={{ user, login, logout, isAuthenticated, loading, clerkEnabled: true }}>
      {children}
    </AuthContext.Provider>
  );
};

// ---------------------------------------------------------------------------
// Legacy username/password Auth (original implementation)
// ---------------------------------------------------------------------------

const LegacyAuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const bootstrap = async () => {
      const token = getAuthToken();
      const cachedUser = localStorage.getItem(USER_STORAGE_KEY);

      if (!token) {
        setUser(null);
        setLoading(false);
        return;
      }

      if (cachedUser) {
        try {
          setUser(JSON.parse(cachedUser));
        } catch {
          // ignore corrupt cache
        }
      }

      try {
        const profile = await getCurrentUser();
        const userData = {
          username: profile.username,
          role: profile.role,
          org_id: profile.org_id,
          loggedInAt: new Date().toISOString(),
        };
        setUser(userData);
        localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(userData));
      } catch {
        setAuthToken(null);
        localStorage.removeItem(USER_STORAGE_KEY);
        setUser(null);
      } finally {
        setLoading(false);
      }
    };

    bootstrap();
  }, []);

  const login = async (username, password) => {
    try {
      const data = await loginDashboard(username, password);
      const token = data.access_token;
      setAuthToken(token);

      const userData = {
        username: data.user?.username || username,
        role: data.user?.role || 'admin',
        org_id: data.user?.org_id,
        loggedInAt: new Date().toISOString(),
      };

      setUser(userData);
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(userData));
      return { success: true };
    } catch (error) {
      const message = error?.response?.data?.detail || 'Invalid username or password';
      return { success: false, error: message };
    }
  };

  const logout = () => {
    setUser(null);
    setAuthToken(null);
    localStorage.removeItem(USER_STORAGE_KEY);
  };

  const isAuthenticated = !!user;

  return (
    <AuthContext.Provider value={{ user, login, logout, isAuthenticated, loading, clerkEnabled: false }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
