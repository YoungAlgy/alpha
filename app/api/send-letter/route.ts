import { NextResponse } from "next/server";
import { sendLetterNotification, resendConfigured } from "@/lib/email";
import type { Issue } from "@/lib/types";

export const runtime = "nodejs";

interface SendPayload {
  to: string;
  firstName: string;
  issue: Issue;
  inboxUrl?: string;
}

export async function POST(req: Request) {
  if (!resendConfigured()) {
    return NextResponse.json(
      { error: "Email not configured. Set RESEND_API_KEY in .env.local." },
      { status: 503 }
    );
  }

  let body: SendPayload;
  try {
    body = (await req.json()) as SendPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body?.to || !body?.firstName || !body?.issue) {
    return NextResponse.json(
      { error: "to + firstName + issue required" },
      { status: 400 }
    );
  }

  const origin = new URL(req.url).origin;
  const inboxUrl = body.inboxUrl || `${origin}/alpha/inbox`;

  try {
    const result = await sendLetterNotification({
      to: body.to,
      firstName: body.firstName,
      issue: body.issue,
      inboxUrl,
    });
    return NextResponse.json({ ok: true, id: result.id });
  } catch (e) {
    const message = e instanceof Error ? e.message : "send failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
