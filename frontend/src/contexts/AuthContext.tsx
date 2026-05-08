import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { Platform } from "react-native";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { api, saveToken, clearToken, getStoredToken } from "../lib/api";

export interface AppUser {
  user_id: string;
  email: string;
  name: string;
  picture?: string;
  role: "user" | "admin" | "super_admin";
  verified: boolean;
  status: string;
  risk_score: number;
}

interface AuthState {
  user: AppUser | null;
  loading: boolean;
  authError: string | null;
  refresh: () => Promise<void>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  processSessionId: (sessionId: string) => Promise<void>;
}

const AuthCtx = createContext<AuthState | null>(null);

const EMERGENT_AUTH = "https://auth.emergentagent.com/";

function extractSessionId(input: string): string | null {
  if (!input) return null;
  try {
    const m = input.match(/[#?&]session_id=([^&]+)/i);
    if (m && m[1]) return decodeURIComponent(m[1]);
  } catch {}
  return null;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setAuthError(null);
    try {
      const token = await getStoredToken();
      if (!token) {
        setUser(null);
        setLoading(false);
        return;
      }
      const me = await api<AppUser>("/auth/me");
      setUser(me);
    } catch (e: any) {
      setUser(null);
      await clearToken();
    } finally {
      setLoading(false);
    }
  }, []);

  const processSessionId = useCallback(
    async (sessionId: string) => {
      if (!sessionId) return;
      setLoading(true);
      setAuthError(null);
      try {
        const r = await api<{ user: AppUser; session_token: string }>("/auth/session", {
          body: { session_id: sessionId },
        });
        await saveToken(r.session_token);
        setUser(r.user);
        // clean web URL fragment
        if (Platform.OS === "web" && typeof window !== "undefined") {
          try {
            window.history.replaceState({}, "", window.location.pathname);
          } catch {}
        }
      } catch (e: any) {
        setAuthError(e?.message || "Sign-in failed");
        setUser(null);
        await clearToken();
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const signIn = useCallback(async () => {
    setAuthError(null);
    if (Platform.OS === "web") {
      const redirect =
        typeof window !== "undefined"
          ? `${window.location.origin}/`
          : "/";
      const url = `${EMERGENT_AUTH}?redirect=${encodeURIComponent(redirect)}`;
      if (typeof window !== "undefined") {
        window.location.href = url;
      }
      return;
    }
    const redirect = Linking.createURL("/");
    const url = `${EMERGENT_AUTH}?redirect=${encodeURIComponent(redirect)}`;
    try {
      const result = await WebBrowser.openAuthSessionAsync(url, redirect);
      if (result.type === "success" && result.url) {
        const sid = extractSessionId(result.url);
        if (sid) {
          await processSessionId(sid);
        }
      }
    } catch (e: any) {
      setAuthError(e?.message || "Sign-in cancelled");
    }
  }, [processSessionId]);

  const signOut = useCallback(async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } catch {}
    await clearToken();
    setUser(null);
  }, []);

  // Cold-start handler — process session_id from URL on first mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Web: window.location.hash
      if (Platform.OS === "web" && typeof window !== "undefined") {
        const fromHash = extractSessionId(window.location.hash || "");
        const fromQuery = extractSessionId(window.location.search || "");
        const sid = fromHash || fromQuery;
        if (sid) {
          await processSessionId(sid);
          return;
        }
      } else {
        const initial = await Linking.getInitialURL();
        const sid = extractSessionId(initial || "");
        if (sid) {
          await processSessionId(sid);
          return;
        }
      }
      if (!cancelled) await refresh();
    })();
    return () => {
      cancelled = true;
    };
  }, [processSessionId, refresh]);

  // Hot-link handler for mobile.
  useEffect(() => {
    if (Platform.OS === "web") return;
    const sub = Linking.addEventListener("url", (event) => {
      const sid = extractSessionId(event.url || "");
      if (sid) {
        processSessionId(sid);
      }
    });
    return () => {
      sub?.remove?.();
    };
  }, [processSessionId]);

  return (
    <AuthCtx.Provider
      value={{ user, loading, authError, refresh, signIn, signOut, processSessionId }}
    >
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
