"use client";

import { createBrowserClient } from "@supabase/ssr";

let _client: ReturnType<typeof createBrowserClient> | null = null;

export function supabaseClient() {
  if (_client) return _client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase env vars missing (NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)"
    );
  }
  // Bound every request this client makes (no override = an unbounded fetch —
  // e.g. a merely-slow, not-erroring auth call — could stall a caller
  // indefinitely with nothing to catch it). Matches the AbortSignal.timeout
  // pattern used by every other fetch-based client in the app (lib/email.ts,
  // lib/engine/*-client.ts, lib/brave.ts, lib/you-search.ts).
  _client = createBrowserClient(url, key, {
    global: {
      fetch: (input, init) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }),
    },
    // See the matching comment in lib/supabase/server.ts — @supabase/ssr's
    // own default has no `secure` key at all for this app's session cookie.
    cookieOptions: { secure: true },
  });
  return _client;
}

export function supabaseConfigured(): boolean {
  return (
    !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    (!!process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  );
}
