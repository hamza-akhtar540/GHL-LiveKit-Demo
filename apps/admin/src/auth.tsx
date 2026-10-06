import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { UNAUTHENTICATED, get } from "./api";

export type Role = "admin" | "viewer";

export interface Me {
  user: { email: string; role: Role };
  capabilities: { db: boolean; ghl: boolean; live: boolean };
  business: { name: string; industry: string; timezone: string };
  autosend: "off" | "dry_run" | "on";
  automation: boolean;
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  isAdmin: boolean;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setMe(await get<Me>("me"));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onExpired = () => setMe(null);
    window.addEventListener(UNAUTHENTICATED, onExpired);
    return () => window.removeEventListener(UNAUTHENTICATED, onExpired);
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await fetch("/admin/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Sign-in failed");
      await refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    await fetch("/admin/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => {});
    setMe(null);
  }, []);

  return (
    <Ctx.Provider value={{ me, loading, isAdmin: me?.user.role === "admin", login, logout }}>{children}</Ctx.Provider>
  );
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
