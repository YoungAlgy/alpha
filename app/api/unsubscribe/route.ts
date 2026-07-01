import { NextResponse } from "next/server";
import { supabaseServiceClient } from "@/lib/supabase/server";
import { verifyUnsubscribeToken } from "@/lib/unsubscribe";

export const runtime = "nodejs";

// One-click unsubscribe endpoint. Handles both:
//   - GET ?token=...  — user clicked the link in their email. Sets
//     unsubscribed_at, renders a small confirmation HTML page.
//   - POST ?token=... — inbox-provider auto-unsubscribe (Gmail, Apple Mail)
//     following the List-Unsubscribe-Post header per RFC 8058. Sets
//     unsubscribed_at, returns 200 with no body.
//
// Turning letters back on is self-serve: the reader signs in and hits "Resume
// my letters" in /settings (POST /api/resume clears unsubscribed_at for their
// own row). Signing in ALONE never touches unsubscribed_at, so the copy points
// at the Resume control specifically, with email support as a fallback. We
// respect the explicit opt-out by default — they paid us to send them email,
// and they told us to stop, until they choose to resume.

async function performUnsubscribe(token: string): Promise<
  | { ok: true; email: string }
  | { ok: false; status: number; error: string }
> {
  const userId = verifyUnsubscribeToken(token);
  if (!userId) {
    return { ok: false, status: 400, error: "Invalid or expired link." };
  }

  const sb = await supabaseServiceClient();
  const { data, error } = await sb
    .from("users")
    .update({ unsubscribed_at: new Date().toISOString() })
    .eq("id", userId)
    .select("email")
    .maybeSingle();

  if (error) {
    console.error("[unsubscribe] update failed:", error.message);
    return { ok: false, status: 500, error: "Couldn't update. Try again." };
  }
  if (!data) {
    return { ok: false, status: 404, error: "Account not found." };
  }
  return { ok: true, email: data.email };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const result = await performUnsubscribe(token);

  if (!result.ok) {
    return new NextResponse(htmlPage("Couldn't unsubscribe", result.error), {
      status: result.status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return new NextResponse(
    htmlPage(
      "You're unsubscribed.",
      `We won't send any more letters to <strong>${escapeHtml(result.email)}</strong>. Your Stripe subscription is separate and unaffected, so manage or cancel billing from <a href="/alpha/settings">settings</a> if you also want to stop paying. Changed your mind? Sign in and hit <a href="/alpha/settings">Resume my letters in settings</a>, or email <a href="mailto:youngalgy@gmail.com?subject=Resume%20my%20alpha.%20letters">youngalgy@gmail.com</a>.`
    ),
    {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }
  );
}

// RFC 8058 one-click: inbox providers POST to the URL in List-Unsubscribe-Post
// when the user hits the inbox-provider's unsubscribe button. No HTML response.
export async function POST(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  // Some providers send the token in the body instead of the query. Try both.
  let bodyToken = "";
  try {
    const body = await req.text();
    const params = new URLSearchParams(body);
    bodyToken = params.get("token") || params.get("List-Unsubscribe") || "";
  } catch {
    // ignore
  }
  const result = await performUnsubscribe(token || bodyToken);
  return NextResponse.json(
    { ok: result.ok, ...(result.ok ? {} : { error: result.error }) },
    { status: result.ok ? 200 : result.status }
  );
}

function htmlPage(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} | alpha.</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<style>
  body {
    margin: 0;
    background: #F4EFE0;
    color: #1F3D2E;
    font-family: Georgia, "Times New Roman", serif;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .card {
    max-width: 480px;
    text-align: center;
  }
  .mark {
    font-size: 56px;
    font-weight: 700;
    margin: 0 0 24px;
    color: #1F3D2E;
  }
  .accent {
    color: #C9A961;
  }
  h1 {
    font-size: 28px;
    font-weight: 700;
    letter-spacing: -0.01em;
    margin: 0 0 16px;
  }
  p {
    font-size: 16px;
    line-height: 1.6;
    margin: 0 0 16px;
    color: #4A5F50;
  }
  a {
    color: #A88947;
  }
</style>
</head>
<body>
  <div class="card">
    <p class="mark">α<span class="accent">.</span></p>
    <h1>${escapeHtml(title)}</h1>
    <p>${bodyHtml}</p>
    <p><a href="/alpha/welcome">Back to alpha<span class="accent">.</span></a></p>
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
