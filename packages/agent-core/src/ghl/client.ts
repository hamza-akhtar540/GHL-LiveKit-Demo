import { ghlEnv, type GhlEnv } from "../env.js";
import { GHL_BASE } from "./endpoints.js";

export class GhlError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: unknown,
  ) {
    super(`GHL ${status} on ${path}: ${JSON.stringify(body).slice(0, 400)}`);
    this.name = "GhlError";
  }

  /** 429 and 5xx are worth retrying; 4xx means we sent something wrong. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Total attempts including the first. */
  maxAttempts?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GhlClient {
  readonly env: GhlEnv;

  constructor(env: GhlEnv = ghlEnv()) {
    this.env = env;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.env.pit}`,
      Version: this.env.apiVersion,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    const { method = "GET", query, body, maxAttempts = 4 } = opts;

    const url = new URL(GHL_BASE + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: this.headers(),
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (networkErr) {
        // DNS blip / socket reset — retry with the same backoff as a 5xx.
        lastErr = networkErr;
        if (attempt === maxAttempts) throw networkErr;
        await sleep(backoffMs(attempt, undefined));
        continue;
      }

      const text = await res.text();
      const parsed = safeJson(text);

      if (res.ok) return parsed as T;

      const err = new GhlError(res.status, path, parsed);
      lastErr = err;

      if (!err.retryable || attempt === maxAttempts) throw err;

      // GHL burst limit is 100 req / 10s per location; honour Retry-After when sent.
      await sleep(backoffMs(attempt, res.headers.get("retry-after")));
    }

    throw lastErr;
  }

  get<T>(path: string, query?: RequestOptions["query"]) {
    return this.request<T>(path, { method: "GET", query });
  }

  post<T>(path: string, body: unknown, query?: RequestOptions["query"]) {
    return this.request<T>(path, { method: "POST", body, query });
  }
}

function backoffMs(attempt: number, retryAfter: string | null | undefined): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return secs * 1000;
  }
  // 500ms, 1s, 2s + jitter so parallel tool calls don't resonate.
  return 2 ** (attempt - 1) * 500 + Math.random() * 250;
}

function safeJson(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
