import { NextResponse } from "next/server";
import { generateIssue } from "@/lib/engine/assemble";
import { persistIssueIfPossible } from "@/lib/engine/persist";
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

    // Best-effort persistence. Doesn't block the response if it fails — letter
    // still renders for the user, just isn't saved to /archive.
    const persistence = await persistIssueIfPossible(body.profile, issue, weekOf);

    return NextResponse.json({
      issue,
      userId: persistence?.userId ?? null,
      magicLink: persistence?.magicLink ?? null,
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
