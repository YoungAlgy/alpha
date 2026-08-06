import { NextResponse } from "next/server";
import { supabaseServiceClient } from "@/lib/supabase/server";
import { verifyUnsubscribeToken } from "@/lib/unsubscribe";
import { escapeHtml } from "@/lib/email";

export const runtime = "nodejs";

// One-click unsubscribe endpoint. Handles both:
//   - GET ?token=...  — user clicked the link in their email. Does NOT mutate
//     state (see 2026-08-06 fix below) — renders a confirmation page with a
//     real POST form.
//   - POST ?token=... — either the confirmation page's own form submit, OR
//     an inbox-provider auto-unsubscribe (Gmail, Apple Mail) following the
//     List-Unsubscribe-Post header per RFC 8058. Both set unsubscribed_at;
//     response format branches on which one it was (see below).
//
// FAIL-SAFE (2026-08-06): GET used to mutate state directly on request. Email
// security gateways and link-prescanners (Defender for Office 365 Safe Links,
// Proofpoint, Mimecast, etc.) routinely auto-fetch every URL in an inbound
// email's body to scan for malicious destinations, independent of whether the
// recipient ever opens or clicks anything -- which silently unsubscribed
// paying readers who never asked to stop. RFC 8058 added the separate POST
// one-click mechanism specifically because GET is unsafe for this; this route
// now only mutates on POST (either a human's confirmation click or a mail
// provider's own RFC-8058 POST), never on a bare GET.
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

// ABSOLUTE links only in this page's HTML. Old emails point at
// youngalgy.com/alpha/api/unsubscribe, which that hub PROXIES here forever —
// so this page renders on a foreign origin where a root-relative /settings
// would resolve into the portfolio site, not this app.
function appOrigin(): string {
  return process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://alpha.everyday.report";
}

// GET never mutates state (see FAIL-SAFE note above) — it only validates the
// token and renders a confirmation page with a real <form method="POST">.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const userId = verifyUnsubscribeToken(token);

  if (!userId) {
    return new NextResponse(htmlPage("Couldn't unsubscribe", "<p>Invalid or expired link.</p>"), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const actionUrl = escapeHtml(`${appOrigin()}/api/unsubscribe?token=${encodeURIComponent(token)}`);
  return new NextResponse(
    htmlPage(
      "Unsubscribe from alpha. letters?",
      `<p>Confirm below and we'll stop sending letters to this address. Your Stripe subscription is separate and unaffected — manage or cancel billing separately from settings if you also want to stop paying.</p>
      <form method="POST" action="${actionUrl}" style="margin: 24px 0 0;">
        <input type="hidden" name="source" value="confirm-page">
        <button type="submit" style="font: inherit; font-size: 16px; font-weight: 700; background: #1F3D2E; color: #F4EFE0; border: none; border-radius: 8px; padding: 12px 28px; cursor: pointer;">Yes, stop my letters</button>
      </form>`
    ),
    {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }
  );
}

// POST has two distinct callers with two distinct response contracts:
//   - The confirmation page's own form (carries source=confirm-page in the
//     body) — a real browser navigation from a human's click, expects the
//     same styled HTML page GET used to return.
//   - RFC 8058 one-click (inbox providers POST to List-Unsubscribe-Post with
//     no `source` field) — machine-to-machine, expects a bare JSON 200.
// Don't use User-Agent/Accept sniffing to tell them apart — gateways and mail
// clients vary those unpredictably. `source` is a field only our own form
// emits, so it's a signal we fully control.
export async function POST(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  let bodyToken = "";
  let fromConfirmPage = false;
  try {
    const body = await req.text();
    const params = new URLSearchParams(body);
    bodyToken = params.get("token") || params.get("List-Unsubscribe") || "";
    fromConfirmPage = params.get("source") === "confirm-page";
  } catch {
    // ignore
  }
  const result = await performUnsubscribe(token || bodyToken);

  if (fromConfirmPage) {
    if (!result.ok) {
      return new NextResponse(htmlPage("Couldn't unsubscribe", `<p>${result.error}</p>`), {
        status: result.status,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    const settingsUrl = escapeHtml(`${appOrigin()}/settings`);
    return new NextResponse(
      htmlPage(
        "You're unsubscribed.",
        `<p>We won't send any more letters to <strong>${escapeHtml(result.email)}</strong>. Your Stripe subscription is separate and unaffected, so manage or cancel billing from <a href="${settingsUrl}">settings</a> if you also want to stop paying. Changed your mind? Sign in and hit <a href="${settingsUrl}">Resume my letters in settings</a>, or email <a href="mailto:youngalgy@gmail.com?subject=Resume%20my%20alpha.%20letters">youngalgy@gmail.com</a>.</p>`
      ),
      {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }

  // RFC 8058 one-click path: no HTML, just a status a mail provider can check.
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
  .brand-gold {
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
    <p class="mark">α<span class="brand-gold">.</span></p>
    <h1>${escapeHtml(title)}</h1>
    ${bodyHtml}
    <p><a href="${escapeHtml(`${appOrigin()}/welcome`)}">Back to alpha<span class="brand-gold">.</span></a></p>
  </div>
</body>
</html>`;
}

