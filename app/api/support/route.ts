import { NextResponse } from "next/server";

export const runtime = "nodejs";

interface SupportPayload {
  name?: string;
  email: string;
  message: string;
}

// V0 stub: logs the ticket to the server console. In V1 this writes to Supabase
// + emails youngalgy@gmail.com via Resend.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as SupportPayload;
    if (!body?.email || !body?.message) {
      return NextResponse.json(
        { error: "email and message required" },
        { status: 400 }
      );
    }
    console.log(
      `[support] ${new Date().toISOString()} from ${body.email}${
        body.name ? ` (${body.name})` : ""
      }:\n  ${body.message.replace(/\n/g, "\n  ")}`
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
