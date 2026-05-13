import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - _next (Next.js internals)
     * - favicon, manifest, og-image (static assets)
     * - api (we handle auth there as needed)
     */
    "/((?!_next/static|_next/image|favicon|manifest|.*\\..*).*)",
  ],
};

export async function middleware(req: NextRequest) {
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
