import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

export const config = {
  matcher: [
    /*
     * Match all paths except _next internals and static assets (anything with a
     * file extension). /api routes ARE matched on purpose — the CSRF guard below
     * depends on it, so do not narrow this to exclude /api.
     */
    "/((?!_next/static|_next/image|favicon|manifest|.*\\..*).*)",
  ],
};

// CSRF defense for the state-changing, session-authed POST endpoints. A forged
// browser request — a malicious page calling fetch() to one of these on a
// logged-in reader's behalf, riding their cookie — carries Sec-Fetch-Site of
// "cross-site" or "same-site"; we reject both. This is safe because every
// legitimate in-app call is same-ORIGIN (relative "/alpha/api/..." fetches →
// Sec-Fetch-Site: same-origin), and server-to-server callers send no Sec-Fetch
// header at all (the Stripe webhook + cron aren't in this list anyway). GETs are
// untouched. Sec-Fetch-Site is browser-computed from the user-visible origin, so
// it's robust behind the youngalgy.com→internal-host rewrite, unlike an
// Origin/Host check the rewrite breaks. (/api/support is deliberately NOT here —
// it's an unauthenticated public form with no session to forge.) These routes
// each require a session on their own; this is uniform defense-in-depth.
const CSRF_GUARDED_SUFFIXES = [
  "/api/resume",
  "/api/account/delete",
  "/api/account/profile",
  "/api/account/email/reconcile",
  "/api/admin/users",
  "/api/stripe/portal",
  "/api/stripe/update-quantity",
];

export async function proxy(req: NextRequest) {
  const secFetchSite = req.headers.get("sec-fetch-site");
  if (
    req.method === "POST" &&
    (secFetchSite === "cross-site" || secFetchSite === "same-site") &&
    CSRF_GUARDED_SUFFIXES.some((s) => req.nextUrl.pathname.endsWith(s))
  ) {
    return NextResponse.json({ error: "Cross-site request blocked." }, { status: 403 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  // Without configured Supabase, just pass through.
  if (!url || !key) return NextResponse.next();

  const res = NextResponse.next({ request: req });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll(values) {
        for (const { name, value, options } of values) {
          res.cookies.set(name, value, options);
        }
      },
    },
  });

  // Refresh session if it exists; ignore the result.
  await supabase.auth.getUser();
  return res;
}
