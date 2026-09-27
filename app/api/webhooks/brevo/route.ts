import { BREVO_DELIVERY_SCHEMA_ENABLED } from "@/lib/brevo-delivery-policy";
import { handleBrevoSuppressionWebhook } from "@/lib/brevo-webhook";
import { supabaseServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  // A provider can be configured before the matching SQL release. The route
  // cannot acknowledge events until their protected audit table is installed.
  if (!BREVO_DELIVERY_SCHEMA_ENABLED) {
    return Response.json({ error: "webhook_not_configured" }, {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }
  return handleBrevoSuppressionWebhook(req, {
    secret: process.env.BREVO_WEBHOOK_TOKEN,
    // The isolated handler authenticates before reading a body or calling this.
    // No database client exists for an unauthenticated request.
    record: async (event) => {
      const sb = await supabaseServiceClient();
      const { data, error } = await sb.rpc("record_brevo_suppression_event", {
        p_message_id: event.messageId,
        p_event_type: event.type,
        p_event_at: event.eventAt,
        p_recipient: event.recipient,
      });
      if (error) throw new Error("suppression_write_failed");
      return data;
    },
  });
}
