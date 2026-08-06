import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function supabaseServerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("Supabase env vars missing");
  }
  const cookieStore = await cookies();
  return createServerClient(url, key, {
    // Bound every request this client makes (no override = an unbounded
    // fetch — e.g. a merely-slow, not-erroring auth call — could stall a
    // route handler indefinitely with nothing to catch it). Matches the
    // AbortSignal.timeout pattern used by every other fetch-based client in
    // the app (lib/email.ts, lib/engine/*-client.ts, lib/brave.ts, lib/you-search.ts).
    global: {
      fetch: (input, init) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }),
    },
    // @supabase/ssr's own DEFAULT_COOKIE_OPTIONS has no `secure` key at all
    // (verified against its source) — this is the session cookie for a paid
    // product, so an explicit true is worth stating outright rather than
    // relying on the default. Modern browsers treat http://localhost as a
    // secure context, so this doesn't break local dev.
    cookieOptions: { secure: true },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(values) {
        try {
          for (const { name, value, options } of values) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component — Next.js doesn't allow cookie sets
          // there. Harmless here: the app is client-rendered and the browser
          // Supabase client refreshes tokens + persists cookies itself; the
          // server route handlers where we actually gate auth can set cookies.
        }
      },
    },
  });
}

export async function supabaseServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("Supabase service env vars missing");
  }
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(url, serviceKey, {
    auth: { persistSession: false },
    // Bound every request this client makes — see the matching comment in
    // supabaseServerClient() above for why.
    global: {
      fetch: (input, init) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }),
    },
  });
}
