import { Resend } from "resend";
import type { Issue } from "@/lib/types";

let _client: Resend | null = null;

function client(): Resend {
  if (_client) return _client;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY missing");
  _client = new Resend(key);
  return _client;
}

export function resendConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

export interface SendLetterParams {
  to: string;
  firstName: string;
  issue: Issue;
  inboxUrl: string;
}

// V0 email: a short editorial notification with the editor's note as a teaser
// and a link to the full letter on web. V1 will render the entire letter as
// styled HTML (via React Email or similar).
export async function sendLetterNotification(params: SendLetterParams): Promise<{ id: string }> {
  const from = process.env.RESEND_FROM || "Alpha <onboarding@resend.dev>";
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
  });

  const text = renderText({
    firstName: params.firstName,
    teaser,
    sectionList,
    inboxUrl: params.inboxUrl,
    weekOf: params.issue.weekOf,
  });

  const result = await client().emails.send({
    from,
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
  const labels = issue.sections.slice(0, 3).map((s) => s.topicLabel.toLowerCase());
  return `Your Sunday alpha · ${labels.join(", ")}`;
}

interface RenderArgs {
  firstName: string;
  teaser: string;
  sectionList: string;
  inboxUrl: string;
  weekOf: string;
}

function renderHTML({ firstName, teaser, sectionList, inboxUrl, weekOf }: RenderArgs): string {
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

function renderText({ firstName, teaser, sectionList, inboxUrl, weekOf }: RenderArgs): string {
  return `${weekOf}

Hi ${firstName},

${teaser}…

THIS WEEK
${sectionList}

Read the full letter:
${inboxUrl}

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
