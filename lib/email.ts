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
  magicLink?: string | null;
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
    weekOf: params.issue.weekOf,
    magicLink: params.magicLink ?? null,
    unsubscribeUrl: unsubUrl,
  });

  const text = renderText({
    firstName: params.firstName,
    teaser,
    sectionList,
    inboxUrl: params.inboxUrl,
    weekOf: params.issue.weekOf,
    magicLink: params.magicLink ?? null,
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
    return `${trimmed} — and 4 more this week`;
  }
  const labels = issue.sections.slice(0, 3).map((s) => s.topicLabel.toLowerCase());
  return `Your Sunday alpha · ${labels.join(", ")}`;
}

interface RenderArgs {
  firstName: string;
  teaser: string;
  sectionList: string;
  inboxUrl: string;
  weekOf: string;
  magicLink: string | null;
  unsubscribeUrl: string | null;
}

function renderHTML({ firstName, teaser, sectionList, inboxUrl, weekOf, unsubscribeUrl }: RenderArgs): string {
  // CTA always points at /inbox. If the user is still signed in, they go
  // straight to their letter. If not, /inbox bounces them to /signin where
  // they request a 6-digit code — same as anywhere else in the app.
  const signinUrl = inboxUrl.replace("/inbox", "/signin");
  const unsubLine = unsubscribeUrl
    ? `<a href="${escapeAttr(unsubscribeUrl)}" style="color:#6B7B70;">Unsubscribe</a> · `
    : "";
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Your Sunday alpha</title></head>
  <body style="margin:0;padding:0;background:#F4EFE0;font-family:Georgia,serif;color:#1F3D2E;">
    <div style="max-width:560px;margin:0 auto;padding:48px 32px;">
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
        <a href="${escapeAttr(inboxUrl)}" style="display:inline-block;background:#1F3D2E;color:#F4EFE0;text-decoration:none;padding:14px 24px;border-radius:6px;font-family:Inter,Arial,sans-serif;font-weight:600;font-size:14px;">
          Read the full letter →
        </a>
      </div>
      <p style="font-size:12px;line-height:1.5;color:#4A5F50;margin:24px 0 0;">
        Need a new sign-in code? <a href="${escapeAttr(signinUrl)}" style="color:#A88947;">Request one here</a>.
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

function renderText({ firstName, teaser, sectionList, inboxUrl, weekOf, unsubscribeUrl }: RenderArgs): string {
  const unsubLine = unsubscribeUrl ? `\n\nUnsubscribe: ${unsubscribeUrl}` : "";
  return `${weekOf}

Hi ${firstName},

${teaser}…

THIS WEEK
${sectionList}

Read the full letter:
${inboxUrl}

(If you got signed out, request a fresh 6-digit code at ${inboxUrl.replace("/inbox", "/signin")})

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
