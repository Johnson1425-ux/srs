import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { get, post, tokenStore } from './api';
import type { Permission, Profile, Role } from './types';

interface AuthState {
  user: Profile | null;
  loading: boolean;
  signIn: (email: string, password: string, schoolCode?: string) => Promise<Profile>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  can: (...permissions: Permission[]) => boolean;
  hasRole: (...roles: Role[]) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();

  const loadProfile = useCallback(async () => {
    if (!tokenStore.access()) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      setUser(await get<Profile>('/auth/me'));
    } catch {
      tokenStore.clear();
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  // The API client raises this when a refresh token is rejected.
  useEffect(() => {
    const onSignedOut = () => {
      setUser(null);
      queryClient.clear();
    };
    window.addEventListener('sms:signed-out', onSignedOut);
    return () => window.removeEventListener('sms:signed-out', onSignedOut);
  }, [queryClient]);

  const signIn = useCallback(
    async (email: string, password: string, schoolCode?: string) => {
      const res = await post<{ accessToken: string; refreshToken: string; user: Profile }>(
        '/auth/login',
        { email, password, ...(schoolCode ? { schoolCode } : {}) },
      );
      tokenStore.set(res.accessToken, res.refreshToken);
      setUser(res.user);
      return res.user;
    },
    [],
  );

  const signOut = useCallback(async () => {
    try {
      await post('/auth/logout', { refreshToken: tokenStore.refresh() ?? undefined });
    } catch {
      // Signing out locally matters more than the server acknowledging it.
    }
    tokenStore.clear();
    setUser(null);
    queryClient.clear();
  }, [queryClient]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      signIn,
      signOut,
      refreshProfile: loadProfile,
      can: (...permissions) =>
        user?.role === 'SUPER_ADMIN' ||
        permissions.some((p) => user?.permissions.includes(p) ?? false),
      hasRole: (...roles) => (user ? roles.includes(user.role) : false),
    }),
    [user, loading, signIn, signOut, loadProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside an AuthProvider');
  return ctx;
}
