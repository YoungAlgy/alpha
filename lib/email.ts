import { Resend } from "resend";
import type { Issue } from "@/lib/types";
import { unsubscribeUrl as buildUnsubscribeUrl } from "@/lib/unsubscribe";

// Single provider: Resend, sending from the verified alpha@youngalgy.com
// domain. (We previously carried an AWS SES branch as a dual-provider cutover
// path, but AWS denied production access and we standardized on Resend —
// the SES code was dead and has been removed.)

function resendConfiguredInternal(): boolean {
  return !!process.env.RESEND_API_KEY?.trim();
}

let _resend: Resend | null = null;
function resendClient(): Resend {
  if (_resend) return _resend;
  _resend = new Resend(process.env.RESEND_API_KEY!.trim());
  return _resend;
}

// Callers check `resendConfigured()` to decide whether to attempt a send.
export function resendConfigured(): boolean {
  return resendConfiguredInternal();
}

export interface SendLetterParams {
  to: string;
  firstName: string;
  issue: Issue;
  inboxUrl: string;
  /** Tokenized /letter URL (view-in-browser). When present the CTA points
   *  here so the letter opens with NO session — fixes the "No letter yet"
   *  dead end subscribers hit clicking the email on a signed-out device. */
  letterUrl?: string | null;
  /** User id used to mint the signed one-click unsubscribe token. If omitted
   *  the email still sends but won't include unsubscribe links/headers — only
   *  use this for legacy callers that don't have a user id available. */
  userId?: string | null;
}

// V0 email: a short editorial notification with the editor's note as a teaser
// and a link to the full letter on web. V1 will render the entire letter as
// styled HTML (via React Email or similar).
export async function sendLetterNotification(params: SendLetterParams): Promise<{ id: string }> {
  if (!resendConfiguredInternal()) throw new Error("No email provider configured");

  const subject = subjectFromIssue(params.issue);
  const teaser = params.issue.editorIntro.slice(0, 320).trim();
  const sectionList = params.issue.sections
    .map((s) => `• ${s.topicLabel}`)
    .join("\n");

  // Build the unsubscribe URL once and reuse it everywhere (HTML link, plain
  // text link, and the RFC 8058 List-Unsubscribe header that Gmail / Apple
  // Mail use to render their inbox-side unsubscribe button).
  const origin = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://youngalgy.com";
  const unsubUrl = params.userId ? buildUnsubscribeUrl(params.userId, origin) : null;

  const html = renderHTML({
    firstName: params.firstName,
    teaser,
    sectionList,
    inboxUrl: params.inboxUrl,
    letterUrl: params.letterUrl ?? null,
    weekOf: params.issue.weekOf,
    unsubscribeUrl: unsubUrl,
  });

  const text = renderText({
    firstName: params.firstName,
    teaser,
    sectionList,
    inboxUrl: params.inboxUrl,
    letterUrl: params.letterUrl ?? null,
    weekOf: params.issue.weekOf,
    unsubscribeUrl: unsubUrl,
  });

  // List-Unsubscribe + List-Unsubscribe-Post (RFC 2369 + 8058) tell Gmail /
  // Apple Mail / Outlook to surface a one-click unsubscribe button. The Post
  // variant tells them they can use POST without navigating away from the inbox.
  const resendFrom = process.env.RESEND_FROM?.trim() || "Alpha <alpha@youngalgy.com>";
  const resendHeaders: Record<string, string> = {
    "X-Alpha-Issue-Id": params.issue.id,
  };
  if (unsubUrl) {
    resendHeaders["List-Unsubscribe"] = `<${unsubUrl}>`;
    resendHeaders["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  const result = await resendClient().emails.send({
    from: resendFrom,
    to: params.to,
    subject,
    html,
    text,
    headers: resendHeaders,
  });
  if (result.error) {
    throw new Error(`Resend: ${result.error.message}`);
  }
  return { id: result.data?.id ?? "" };
}

function subjectFromIssue(issue: Issue): string {
  // Lead with the first item's headline — most-likely-to-be-clicked thing —
  // then bucket the topics as the second clause. Better preview text in Gmail
  // / Apple Mail than a generic 'Your Sunday alpha · topics…'.
  const lead = issue.sections[0]?.items?.[0]?.headline;
  if (lead) {
    const trimmed = lead.length > 70 ? lead.slice(0, 67).trimEnd() + "…" : lead;
    // Count the OTHER topics accurately — quota can be 5–25 and a topic can
    // drop in a thin week, so never hardcode "4 more".
    const others = Math.max(0, issue.sections.length - 1);
    if (others === 0) return trimmed;
    return `${trimmed} — and ${others} more topic${others === 1 ? "" : "s"} this week`;
  }
  const labels = issue.sections.slice(0, 3).map((s) => s.topicLabel.toLowerCase());
  return `Your Sunday alpha · ${labels.join(", ")}`;
}

interface RenderArgs {
  firstName: string;
  teaser: string;
  sectionList: string;
  inboxUrl: string;
  letterUrl?: string | null;
  weekOf: string;
  unsubscribeUrl: string | null;
}

// Exported (pure, no I/O) so the email can be previewed/snapshot-tested
// without ever triggering a live send.
export function renderHTML({ firstName, teaser, sectionList, inboxUrl, letterUrl, weekOf, unsubscribeUrl }: RenderArgs): string {
  // CTA prefers the tokenized /letter URL — it opens the letter directly with
  // no session, on any device (the view-in-browser pattern). Falls back to
  // /inbox for legacy callers without a letter token.
  const ctaUrl = letterUrl || inboxUrl;
  const signinUrl = inboxUrl.replace("/inbox", "/signin");
  const unsubLine = unsubscribeUrl
    ? `<a href="${escapeAttr(unsubscribeUrl)}" style="color:#6B7B70;">Unsubscribe</a> · `
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <!-- The letter is a light cream/forest design. Tell mail clients NOT to
         auto-invert it in dark mode, which otherwise mangles the palette. -->
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>Your Sunday alpha</title>
    <style>
      /* Tighter gutters on phones (supported in Apple Mail, Gmail app, etc.;
         degrades gracefully where <style> is stripped). */
      @media only screen and (max-width:600px) {
        .alpha-wrap { padding: 32px 20px !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#F4EFE0;font-family:Georgia,serif;color:#1F3D2E;">
    <div class="alpha-wrap" style="max-width:560px;margin:0 auto;padding:48px 32px;">
      <div style="font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:0.15em;color:#4A5F50;text-align:center;margin-bottom:32px;">
        ${escapeHtml(weekOf.toUpperCase())}
      </div>
      <h1 style="font-size:32px;font-weight:700;letter-spacing:-0.01em;margin:0 0 24px;">
        Hi ${escapeHtml(firstName)},
      </h1>
      <p style="font-size:18px;line-height:1.6;margin:0 0 32px;">
        ${escapeHtml(teaser)}…
      </p>
      <p style="font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:0.15em;color:#4A5F50;margin:0 0 8px;">
        THIS WEEK
      </p>
      <pre style="font-family:Georgia,serif;font-size:16px;line-height:1.7;margin:0 0 36px;color:#1F3D2E;white-space:pre-wrap;">${escapeHtml(sectionList)}</pre>
      <div style="margin:40px 0;">
        <a href="${escapeAttr(ctaUrl)}" style="display:inline-block;background:#1F3D2E;color:#F4EFE0;text-decoration:none;padding:14px 24px;border-radius:6px;font-family:Inter,Arial,sans-serif;font-weight:600;font-size:14px;">
          Read the full letter →
        </a>
      </div>
      <p style="font-size:12px;line-height:1.5;color:#4A5F50;margin:24px 0 0;">
        Want to change topics or read past letters? <a href="${escapeAttr(signinUrl)}" style="color:#A88947;">Sign in here</a> — we&rsquo;ll email you a 6-digit code.
      </p>
      <p style="font-size:14px;line-height:1.6;color:#4A5F50;margin:48px 0 0;">
        — Alpha
      </p>
      <hr style="border:none;border-top:1px solid #C8D0BC;margin:32px 0 16px;">
      <p style="font-family:ui-monospace,Menlo,monospace;font-size:10px;letter-spacing:0.12em;color:#6B7B70;text-align:center;">
        ${unsubLine}ALPHA · A WEEKLY LETTER · ${new Date().getFullYear()}
      </p>
    </div>
  </body>
</html>`;
}

function renderText({ firstName, teaser, sectionList, inboxUrl, letterUrl, weekOf, unsubscribeUrl }: RenderArgs): string {
  const unsubLine = unsubscribeUrl ? `\n\nUnsubscribe: ${unsubscribeUrl}` : "";
  return `${weekOf}

Hi ${firstName},

${teaser}…

THIS WEEK
${sectionList}

Read the full letter:
${letterUrl || inboxUrl}

(To change topics or read past letters, sign in at ${inboxUrl.replace("/inbox", "/signin")} — we'll email you a 6-digit code.)

— Alpha${unsubLine}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

// ─── Welcome email ────────────────────────────────────────────────────────
// Sent once, on first subscription, from the Stripe webhook. Confirms the
// payment worked, points to the first letter (already generated + waiting on
// web), and sets the Sunday cadence + passwordless sign-in expectation.

export interface SendWelcomeParams {
  to: string;
  firstName: string;
  inboxUrl: string;
  /** When present, adds RFC 8058 List-Unsubscribe headers (deliverability +
   *  inbox-side unsubscribe button) — same scheme as the letter email. */
  userId?: string | null;
}

export async function sendWelcomeEmail(params: SendWelcomeParams): Promise<{ id: string }> {
  if (!resendConfiguredInternal()) throw new Error("No email provider configured");
  const html = renderWelcomeHTML(params);
  const text = renderWelcomeText(params);
  const resendFrom = process.env.RESEND_FROM?.trim() || "Alpha <alpha@youngalgy.com>";
  const headers: Record<string, string> = {};
  if (params.userId) {
    const origin = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://youngalgy.com";
    const unsubUrl = buildUnsubscribeUrl(params.userId, origin);
    headers["List-Unsubscribe"] = `<${unsubUrl}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  const result = await resendClient().emails.send({
    from: resendFrom,
    to: params.to,
    subject: "Welcome to alpha. — your first letter's ready",
    html,
    text,
    headers,
  });
  if (result.error) {
    throw new Error(`Resend: ${result.error.message}`);
  }
  return { id: result.data?.id ?? "" };
}

// Exported (pure, no I/O) so the welcome email can be previewed/snapshot-tested
// without a live send — same pattern as renderHTML.
export function renderWelcomeHTML({ firstName, inboxUrl }: { firstName: string; inboxUrl: string }): string {
  const signinUrl = inboxUrl.replace("/inbox", "/signin");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>Welcome to alpha.</title>
    <style>
      @media only screen and (max-width:600px) {
        .alpha-wrap { padding: 32px 20px !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#F4EFE0;font-family:Georgia,serif;color:#1F3D2E;">
    <div class="alpha-wrap" style="max-width:560px;margin:0 auto;padding:48px 32px;">
      <div style="font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:0.15em;color:#4A5F50;text-align:center;margin-bottom:32px;">
        WELCOME TO ALPHA
      </div>
      <h1 style="font-size:32px;font-weight:700;letter-spacing:-0.01em;margin:0 0 24px;">
        You&rsquo;re in, ${escapeHtml(firstName)}.
      </h1>
      <p style="font-size:18px;line-height:1.6;margin:0 0 24px;">
        Thanks for subscribing. Your first letter is already written and waiting
        &mdash; built around the topics you picked.
      </p>
      <div style="margin:36px 0;">
        <a href="${escapeAttr(inboxUrl)}" style="display:inline-block;background:#1F3D2E;color:#F4EFE0;text-decoration:none;padding:14px 24px;border-radius:6px;font-family:Inter,Arial,sans-serif;font-weight:600;font-size:14px;">
          Read your first letter &rarr;
        </a>
      </div>
      <p style="font-size:16px;line-height:1.7;margin:0 0 12px;">
        From here on, a new letter lands <strong>every Sunday</strong> &mdash; in
        your inbox and on the web. No feeds, no firehose. Just the things you
        care about.
      </p>
      <p style="font-size:12px;line-height:1.5;color:#4A5F50;margin:24px 0 0;">
        Signed out when you click through? We&rsquo;ll email you a 6-digit code
        &mdash; <a href="${escapeAttr(signinUrl)}" style="color:#A88947;">sign in here</a>.
        No password to remember.
      </p>
      <p style="font-size:14px;line-height:1.6;color:#4A5F50;margin:40px 0 0;">
        &mdash; Algy
      </p>
      <hr style="border:none;border-top:1px solid #C8D0BC;margin:32px 0 16px;">
      <p style="font-family:ui-monospace,Menlo,monospace;font-size:10px;letter-spacing:0.12em;color:#6B7B70;text-align:center;">
        ALPHA · A WEEKLY LETTER · ${new Date().getFullYear()}
      </p>
    </div>
  </body>
</html>`;
}

function renderWelcomeText({ firstName, inboxUrl }: { firstName: string; inboxUrl: string }): string {
  return `Welcome to alpha.

You're in, ${firstName}.

Thanks for subscribing. Your first letter is already written and waiting — built around the topics you picked.

Read your first letter:
${inboxUrl}

From here on, a new letter lands every Sunday — in your inbox and on the web. No feeds, no firehose. Just the things you care about.

(Signed out when you click through? We'll email you a 6-digit code at ${inboxUrl.replace("/inbox", "/signin")} — no password to remember.)

— Algy`;
}
