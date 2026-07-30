import { NextResponse, type NextRequest } from "next/server";

// Host-based apex/www -> alpha.everyday.report redirect, done here instead of
// next.config.ts's redirects() array. The equivalent declarative rule
// (source: "/:path*", has: [{type: "host", ...}], destination: "https://
// alpha.everyday.report/:path*") compiles correctly into .next/routes-
// manifest.json, but OpenNext's Cloudflare runtime doesn't interpolate the
// :path* capture into the destination -- confirmed live, every host hitting
// that rule got a literal, unsubstituted "https://alpha.everyday.report/
// :path*" Location header (a real URL that 404s). Building the destination
// from the actual request here sidesteps that gap entirely.
const REDIRECT_HOSTS = new Set(["everyday.report", "www.everyday.report"]);

export function middleware(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  if (REDIRECT_HOSTS.has(host)) {
    const url = new URL(request.nextUrl.pathname + request.nextUrl.search, "https://alpha.everyday.report");
    return NextResponse.redirect(url, 308);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next).*)"],
};
