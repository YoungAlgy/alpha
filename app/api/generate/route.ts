import { NextResponse } from "next/server";
import { generateIssue } from "@/lib/engine/assemble";
import { persistIssueIfPossible } from "@/lib/engine/persist";
import { sendLetterNotification, resendConfigured } from "@/lib/email";
import type { UserProfile } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { profile: UserProfile; weekOf?: string };
    if (!body?.profile?.firstName || !body.profile.topics?.length) {
      return NextResponse.json(
        { error: "Profile incomplete: firstName + topics required" },
        { status: 400 }
      );
    }
    const weekOf = body.weekOf || defaultWeekOf();
    const issue = await generateIssue(body.profile, weekOf);

    // Best-effort persistence (doesn't block on failure)
    const persistence = await persistIssueIfPossible(body.profile, issue, weekOf);

    // Best-effort email send (doesn't block on failure either — letter still
    // renders on /inbox even if email delivery hiccups)
    const origin = new URL(req.url).origin;
    const inboxUrl = `${origin}/alpha/inbox`;
    let emailSent = false;
    if (body.profile.email && resendConfigured()) {
      try {
        await sendLetterNotification({
          to: body.profile.email,
          firstName: body.profile.firstName,
          issue,
          inboxUrl,
          magicLink: persistence?.magicLink ?? null,
        });
        emailSent = true;
      } catch (e) {
        console.warn("[generate] letter email failed:", e instanceof Error ? e.message : e);
      }
    }

    return NextResponse.json({
      issue,
      userId: persistence?.userId ?? null,
      magicLink: persistence?.magicLink ?? null,
      emailSent,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function defaultWeekOf(): string {
  // Round to most recent Sunday in ISO yyyy-mm-dd
  const now = new Date();
  const day = now.getDay(); // 0 = Sunday
  const offset = day === 0 ? 0 : day;
  now.setDate(now.getDate() - offset);
  return now.toISOString().slice(0, 10);
}
