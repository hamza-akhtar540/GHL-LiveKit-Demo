import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Fired on any 401 so the auth context can drop back to the login screen. */
export const UNAUTHENTICATED = "admin:unauthenticated";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/admin/api/${path}`, {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 401) window.dispatchEvent(new Event(UNAUTHENTICATED));
  if (!res.ok) {
    const detail = typeof body.detail === "string" ? ` — ${body.detail}` : "";
    throw new ApiError(`${typeof body.error === "string" ? body.error : res.statusText}${detail}`, res.status);
  }
  return body as T;
}

export const get = <T,>(path: string) => request<T>(path);
export const post = <T,>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });

export function useApi<T>(path: string | null, opts: { refreshMs?: number } = {}) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(path !== null);
  const alive = useRef(true);

  const load = useCallback(
    async (quiet = false) => {
      if (path === null) return;
      if (!quiet) setLoading(true);
      try {
        const next = await get<T>(path);
        if (!alive.current) return;
        setData(next);
        setError(undefined);
      } catch (e) {
        if (alive.current) setError(e as ApiError);
      } finally {
        if (alive.current) setLoading(false);
      }
    },
    [path],
  );

  useEffect(() => {
    alive.current = true;
    setData(undefined);
    void load();
    const timer = opts.refreshMs ? setInterval(() => void load(true), opts.refreshMs) : undefined;
    return () => {
      alive.current = false;
      if (timer) clearInterval(timer);
    };
  }, [load, opts.refreshMs]);

  return { data, error, loading, reload: () => load(true) };
}
