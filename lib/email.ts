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
  /** This subscriber's Nth letter (1-based). Drives "Issue N" in the subject
   *  so it reads like a recognizable recurring newsletter (a reader nearly
   *  skimmed past it when the subject led with a news headline). Omit → the
   *  subject falls back to the week date instead of an issue number. */
  issueNumber?: number;
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

  // Subject reads like a newsletter the reader recognizes as theirs —
  // "{first}'s newsletter · Issue N" — NOT a news headline (a reader
  // nearly skimmed past the headline-led version). The content hook moves to
  // the preheader (inbox preview text), so we keep the click pull too.
  const subject = subjectLine(params.firstName, params.issueNumber, params.issue.weekOf);
  const preheader = previewFromIssue(params.issue);
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
    preheader,
    inboxUrl: params.inboxUrl,
    letterUrl: params.letterUrl ?? null,
    weekOf: params.issue.weekOf,
    unsubscribeUrl: unsubUrl,
  });

  const text = renderText({
    firstName: params.firstName,
    teaser,
    sectionList,
    preheader,
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
    // Unique per (subscriber, issue): issue.id alone is firstName+weekOf, which
    // collides across same-named subscribers. Prefix with the user id when we
    // have it so delivery tracing by this header is unambiguous.
    "X-Alpha-Issue-Id": params.userId ? `${params.userId}:${params.issue.id}` : params.issue.id,
  };
  if (unsubUrl) {
    resendHeaders["List-Unsubscribe"] = `<${unsubUrl}>`;
    resendHeaders["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  // Idempotency key: stable per (subscriber, send date). If a send for the same
  // (user, week_of) is retried — a Vercel cron retry racing the scheduled run,
  // the rollback path re-opening the delivered_at claim, an admin re-trigger —
  // Resend collapses it provider-side and the subscriber gets ONE letter, not
  // two. Only set when userId is known (the normal cron + generate paths both
  // pass it); legacy callers without a userId behave exactly as before.
  const idempotencyKey = params.userId
    ? `alpha-letter-${params.userId}-${params.issue.weekOf}`
    : undefined;
  const result = await resendClient().emails.send(
    {
      from: resendFrom,
      to: params.to,
      subject,
      html,
      text,
      headers: resendHeaders,
    },
    idempotencyKey ? { idempotencyKey } : undefined
  );
  if (result.error) {
    throw new Error(`Resend: ${result.error.message}`);
  }
  return { id: result.data?.id ?? "" };
}

// ─── Ops alert ────────────────────────────────────────────────────────────
// Best-effort INTERNAL notification (never sent to a subscriber). The cron
// calls this when a paid subscriber gets NOTHING this send (blanked profile /
// empty topic pool) or a send hard-fails — the exact silent drop that
// otherwise only surfaces when the owner happens to notice a missing letter
// days later. Never throws: a broken alert must never break the send path.
export async function sendOpsAlert(subject: string, body: string): Promise<void> {
  try {
    if (!resendConfiguredInternal()) return;
    const to = process.env.OPS_ALERT_EMAIL?.trim() || "youngalgy@gmail.com";
    const resendFrom = process.env.RESEND_FROM?.trim() || "Alpha <alpha@youngalgy.com>";
    await resendClient().emails.send({
      from: resendFrom,
      to,
      subject,
      text: body,
    });
  } catch (e) {
    console.warn("[ops-alert] failed:", e instanceof Error ? e.message : e);
  }
}

// The subject. Personal + unmistakably a newsletter + an issue number so it
// reads like a recurring publication the reader opted into. The brand is
// carried by the From name ("Alpha"); the subject earns the open. Exported
// for testing.
export function subjectLine(firstName: string, issueNumber?: number, weekOf?: string): string {
  const who = firstName?.trim() ? `${firstName.trim()}'s` : "Your";
  if (typeof issueNumber === "number" && issueNumber > 0) {
    return `${who} newsletter · Issue ${issueNumber}`;
  }
  // No issue number available — anchor on the date instead of a wrong number.
  const wk = weekOf ? shortWeek(weekOf) : "";
  return wk ? `${who} newsletter · ${wk}` : `${who} newsletter`;
}

// Inbox preview text (preheader): the actual content hook — lead headline +
// how many topics — so the open is still earned even though the subject is
// the recognizable identity. This is what used to be the subject.
function previewFromIssue(issue: Issue): string {
  const lead = issue.sections[0]?.items?.[0]?.headline;
  const others = Math.max(0, issue.sections.length - 1);
  if (lead) {
    const trimmed = lead.length > 90 ? lead.slice(0, 87).trimEnd() + "…" : lead;
    if (others === 0) return trimmed;
    return `${trimmed}, plus ${others} more topic${others === 1 ? "" : "s"}.`;
  }
  const labels = issue.sections.slice(0, 4).map((s) => s.topicLabel.toLowerCase());
  return `Latest on ${labels.join(", ")}.`;
}

// "June 8" from an ISO or long-form week_of string.
function shortWeek(weekOf: string): string {
  if (weekOf.includes(",")) {
    const m = weekOf.match(/([A-Za-z]+\s+\d+)/);
    if (m) return m[1];
  }
  const d = new Date(weekOf.length === 10 ? `${weekOf}T12:00:00Z` : weekOf);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

interface RenderArgs {
  firstName: string;
  teaser: string;
  sectionList: string;
  preheader?: string;
  inboxUrl: string;
  letterUrl?: string | null;
  weekOf: string;
  unsubscribeUrl: string | null;
}

// Exported (pure, no I/O) so the email can be previewed/snapshot-tested
// without ever triggering a live send.
export function renderHTML({ firstName, teaser, sectionList, preheader, inboxUrl, letterUrl, weekOf, unsubscribeUrl }: RenderArgs): string {
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
    <title>Your newsletter</title>
    <style>
      /* Tighter gutters on phones (supported in Apple Mail, Gmail app, etc.;
         degrades gracefully where <style> is stripped). */
      @media only screen and (max-width:600px) {
        .alpha-wrap { padding: 32px 20px !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#F4EFE0;font-family:Georgia,serif;color:#1F3D2E;">
    <!-- Preheader: the inbox preview text. Hidden in the body, but it's the
         first text mail clients pull for the snippet next to the subject. The
         trailing whitespace stops the client from spilling later body text
         into the preview. -->
    <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#F4EFE0;opacity:0;">
      ${escapeHtml(preheader || "")}${"&nbsp;&zwnj;".repeat(60)}
    </div>
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
        IN THIS ISSUE
      </p>
      <pre style="font-family:Georgia,serif;font-size:16px;line-height:1.7;margin:0 0 36px;color:#1F3D2E;white-space:pre-wrap;">${escapeHtml(sectionList)}</pre>
      <div style="margin:40px 0;">
        <a href="${escapeAttr(ctaUrl)}" style="display:inline-block;background:#1F3D2E;color:#F4EFE0;text-decoration:none;padding:14px 24px;border-radius:6px;font-family:Inter,Arial,sans-serif;font-weight:600;font-size:14px;">
          Read the full letter →
        </a>
      </div>
      <p style="font-size:12px;line-height:1.5;color:#4A5F50;margin:24px 0 0;">
        Want to change topics or read past letters? <a href="${escapeAttr(signinUrl)}" style="color:#A88947;">Sign in here</a>. We'll email you a 6-digit code.
      </p>
      <p style="font-size:14px;line-height:1.6;color:#4A5F50;margin:48px 0 0;">
        Alpha
      </p>
      <hr style="border:none;border-top:1px solid #C8D0BC;margin:32px 0 16px;">
      <p style="font-family:ui-monospace,Menlo,monospace;font-size:10px;letter-spacing:0.12em;color:#6B7B70;text-align:center;">
        ${unsubLine}ALPHA · A PERSONAL LETTER · ${new Date().getFullYear()}
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

IN THIS ISSUE
${sectionList}

Read the full letter:
${letterUrl || inboxUrl}

(To change topics or read past letters, sign in at ${inboxUrl.replace("/inbox", "/signin")}. We'll email you a 6-digit code.)

Alpha${unsubLine}`;
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
    subject: "Welcome to alpha. Your first letter is on its way",
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
        You're in, ${escapeHtml(firstName)}.
      </h1>
      <p style="font-size:18px;line-height:1.6;margin:0 0 24px;">
        Thanks for subscribing. Your first letter is being written for you right
        now, built around the topics you picked. It takes about a minute.
      </p>
      <div style="margin:36px 0;">
        <a href="${escapeAttr(inboxUrl)}" style="display:inline-block;background:#1F3D2E;color:#F4EFE0;text-decoration:none;padding:14px 24px;border-radius:6px;font-family:Inter,Arial,sans-serif;font-weight:600;font-size:14px;">
          Read your first letter &rarr;
        </a>
      </div>
      <p style="font-size:16px;line-height:1.7;margin:0 0 12px;">
        From here on, new letters land <strong>three times a week</strong>, on
        Sunday, Tuesday, and Thursday, in your inbox and on the web. No feeds,
        no firehose. Just the things you care about.
      </p>
      <p style="font-size:12px;line-height:1.5;color:#4A5F50;margin:24px 0 0;">
        Signed out when you click through? We'll email you a 6-digit code.
        <a href="${escapeAttr(signinUrl)}" style="color:#A88947;">Sign in here</a>.
        No password to remember.
      </p>
      <p style="font-size:14px;line-height:1.6;color:#4A5F50;margin:40px 0 0;">
        Algy
      </p>
      <hr style="border:none;border-top:1px solid #C8D0BC;margin:32px 0 16px;">
      <p style="font-family:ui-monospace,Menlo,monospace;font-size:10px;letter-spacing:0.12em;color:#6B7B70;text-align:center;">
        ALPHA · A PERSONAL LETTER · ${new Date().getFullYear()}
      </p>
    </div>
  </body>
</html>`;
}

function renderWelcomeText({ firstName, inboxUrl }: { firstName: string; inboxUrl: string }): string {
  return `Welcome to alpha.

You're in, ${firstName}.

Thanks for subscribing. Your first letter is being written for you right now, built around the topics you picked. It takes about a minute.

Read your first letter:
${inboxUrl}

From here on, new letters land three times a week, on Sunday, Tuesday, and Thursday, in your inbox and on the web. No feeds, no firehose. Just the things you care about.

(Signed out when you click through? We'll email you a 6-digit code at ${inboxUrl.replace("/inbox", "/signin")}. No password to remember.)

Algy`;
}
