import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function supabaseServerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("Supabase env vars missing");
  }
  const cookieStore = await cookies();
  return createServerClient(url, key, {
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
          // Called from a Server Component — Next.js doesn't allow cookie sets there.
          // Middleware refreshes the session instead.
        }
      },
    },
  });
}

export async function supabaseServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("Supabase service env vars missing");
  }
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(url, serviceKey, {
    auth: { persistSession: false },
  });
}
