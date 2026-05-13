import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { Resend } from "resend";
import type { Issue } from "@/lib/types";

// Dual provider: prefer AWS SES (alpha@youngalgy.com), fall back to Resend
// (alpha@avahealth.co) if SES isn't configured yet. Lets us cut over without
// a flag-day deploy.

type Provider = "ses" | "resend";

function sesConfigured(): boolean {
  return (
    !!process.env.AWS_ACCESS_KEY_ID?.trim() &&
    !!process.env.AWS_SECRET_ACCESS_KEY?.trim()
  );
}

function resendConfiguredInternal(): boolean {
  return !!process.env.RESEND_API_KEY?.trim();
}

function activeProvider(): Provider | null {
  if (sesConfigured()) return "ses";
  if (resendConfiguredInternal()) return "resend";
  return null;
}

let _ses: SESv2Client | null = null;
function sesClient(): SESv2Client {
  if (_ses) return _ses;
  _ses = new SESv2Client({
    region: process.env.AWS_REGION?.trim() || "us-east-1",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!.trim(),
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!.trim(),
    },
  });
  return _ses;
}

let _resend: Resend | null = null;
function resendClient(): Resend {
  if (_resend) return _resend;
  _resend = new Resend(process.env.RESEND_API_KEY!.trim());
  return _resend;
}

// Back-compat: callers check `resendConfigured()` to decide whether to send.
// Keep the name even though we now also accept SES — the boolean is "is some
// email provider configured."
export function resendConfigured(): boolean {
  return activeProvider() !== null;
}

export interface SendLetterParams {
  to: string;
  firstName: string;
  issue: Issue;
  inboxUrl: string;
  magicLink?: string | null;
}

// V0 email: a short editorial notification with the editor's note as a teaser
// and a link to the full letter on web. V1 will render the entire letter as
// styled HTML (via React Email or similar).
export async function sendLetterNotification(params: SendLetterParams): Promise<{ id: string }> {
  const provider = activeProvider();
  if (!provider) throw new Error("No email provider configured");

  // SES path uses ALPHA_EMAIL_FROM; Resend keeps its legacy RESEND_FROM so
  // we don't accidentally email avahealth.co from SES (it isn't verified there).
  const from =
    provider === "ses"
      ? process.env.ALPHA_EMAIL_FROM?.trim() || "Alpha <alpha@youngalgy.com>"
      : process.env.RESEND_FROM?.trim() || "Alpha <onboarding@resend.dev>";

  const subject = subjectFromIssue(params.issue);
  const teaser = params.issue.editorIntro.slice(0, 320).trim();
  const sectionList = params.issue.sections
    .map((s) => `• ${s.topicLabel}`)
    .join("\n");

  const html = renderHTML({
    firstName: params.firstName,
    teaser,
    sectionList,
    inboxUrl: params.inboxUrl,
    weekOf: params.issue.weekOf,
    magicLink: params.magicLink ?? null,
  });

  const text = renderText({
    firstName: params.firstName,
    teaser,
    sectionList,
    inboxUrl: params.inboxUrl,
    weekOf: params.issue.weekOf,
    magicLink: params.magicLink ?? null,
  });

  if (provider === "ses") {
    try {
      const out = await sesClient().send(
        new SendEmailCommand({
          FromEmailAddress: from,
          Destination: { ToAddresses: [params.to] },
          Content: {
            Simple: {
              Subject: { Data: subject, Charset: "UTF-8" },
              Body: {
                Html: { Data: html, Charset: "UTF-8" },
                Text: { Data: text, Charset: "UTF-8" },
              },
              Headers: [{ Name: "X-Alpha-Issue-Id", Value: params.issue.id }],
            },
          },
        })
      );
      return { id: out.MessageId ?? "" };
    } catch (e) {
      // SES still in sandbox / DKIM not yet propagated / recipient not verified —
      // automatically fall back to Resend so the user still gets their letter.
      if (!resendConfiguredInternal()) throw e;
      console.warn(
        "[email] SES failed, falling back to Resend:",
        e instanceof Error ? e.message : e
      );
    }
  }

  const resendFrom = process.env.RESEND_FROM?.trim() || "Alpha <onboarding@resend.dev>";
  const result = await resendClient().emails.send({
    from: resendFrom,
    to: params.to,
    subject,
    html,
    text,
    headers: {
      "X-Alpha-Issue-Id": params.issue.id,
    },
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
}

function renderHTML({ firstName, teaser, sectionList, inboxUrl, weekOf, magicLink }: RenderArgs): string {
  // Prefer the magic link as the CTA if we have one — it signs them in AND
  // lands them at the inbox. Falls back to inboxUrl if not.
  const cta = magicLink || inboxUrl;
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
        <a href="${escapeAttr(cta)}" style="display:inline-block;background:#1F3D2E;color:#F4EFE0;text-decoration:none;padding:14px 24px;border-radius:6px;font-family:Inter,Arial,sans-serif;font-weight:600;font-size:14px;">
          Read the full letter →
        </a>
      </div>
      ${magicLink ? `<p style="font-size:12px;line-height:1.5;color:#4A5F50;margin:24px 0 0;">This button signs you in automatically. The link expires in an hour — but you can always request a new one at <a href="${escapeAttr(inboxUrl.replace("/inbox", "/signin"))}" style="color:#A88947;">signin</a>.</p>` : ""}
      <p style="font-size:14px;line-height:1.6;color:#4A5F50;margin:48px 0 0;">
        — Alpha
      </p>
      <hr style="border:none;border-top:1px solid #C8D0BC;margin:32px 0 16px;">
      <p style="font-family:ui-monospace,Menlo,monospace;font-size:10px;letter-spacing:0.12em;color:#4A5F50;text-align:center;">
        ALPHA · A WEEKLY LETTER · ${new Date().getFullYear()}
      </p>
    </div>
  </body>
</html>`;
}

function renderText({ firstName, teaser, sectionList, inboxUrl, weekOf, magicLink }: RenderArgs): string {
  const cta = magicLink || inboxUrl;
  return `${weekOf}

Hi ${firstName},

${teaser}…

THIS WEEK
${sectionList}

Read the full letter:
${cta}
${magicLink ? `\n(This link signs you in automatically — expires in an hour.)\n` : ""}
— Alpha`;
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
