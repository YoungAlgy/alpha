import { NextResponse } from "next/server";
import { z } from "zod";
import { generateIssue } from "@/lib/engine/assemble";
import { persistIssueIfPossible } from "@/lib/engine/persist";
import { sendLetterNotification, resendConfigured } from "@/lib/email";
import { rateLimit, clientKeyFromRequest } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 120;

const ProfileSchema = z.object({
  firstName: z.string().min(1).max(60),
  city: z.string().max(120).default(""),
  jobBlurb: z.string().max(280).optional(),
  projectBlurb: z.string().max(600).optional(),
  funBlurb: z.string().max(280).optional(),
  topics: z.array(z.string().min(1).max(60)).min(1).max(10),
  theme: z.string().max(30).default("forest"),
  email: z.string().email().optional(),
});

const BodySchema = z.object({
  profile: ProfileSchema,
  weekOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function POST(req: Request) {
  // Rate limit: 3 generations per IP per hour. Resets on cold start.
  // Authenticated users could get a higher cap once we wire it; V0 is anon.
  const ip = clientKeyFromRequest(req);
  const limited = rateLimit(`generate:${ip}`, { limit: 3, windowMs: 60 * 60 * 1000 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${Math.ceil(limited.retryAfterSec / 60)} minutes.` },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
    );
  }

  let body: z.infer<typeof BodySchema>;
  try {
    const raw = await req.json();
    body = BodySchema.parse(raw);
  } catch (e) {
    const message =
      e instanceof z.ZodError
        ? `Invalid input: ${e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
        : "Invalid JSON";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const weekOf = body.weekOf || defaultWeekOf();
    // Cast: zod validated structure, the type narrowing for TopicId / ThemeId
    // happens implicitly via the engine's TOPIC_BY_ID lookup (unknown topics
    // throw clearly inside resolveTopicSignal).
    const profile = body.profile as Parameters<typeof generateIssue>[0];
    const issue = await generateIssue(profile, weekOf);

    // Best-effort persistence (doesn't block on failure)
    const persistence = await persistIssueIfPossible(profile, issue, weekOf);

    // Best-effort email send (doesn't block on failure either — letter still
    // renders on /inbox even if email delivery hiccups)
    const origin = new URL(req.url).origin;
    const inboxUrl = `${origin}/alpha/inbox`;
    let emailSent = false;
    if (profile.email && resendConfigured()) {
      try {
        await sendLetterNotification({
          to: profile.email,
          firstName: profile.firstName,
          issue,
          inboxUrl,
          magicLink: persistence?.magicLink ?? null,
          userId: persistence?.userId ?? null,
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
