// READ-ONLY: inspect whether real subscribers have the fields the weekly-send
// cron requires (first_name non-null AND topics non-empty). Prints structure
// only — no emails, names, or other PII. Decides whether the webhook needs to
// guarantee first_name, or whether a post-auth sync already does.
// Run: npx tsx scripts/inspect-user-completeness.mts
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("no service creds");
  process.exit(1);
}
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(url, key, { auth: { persistSession: false } });

const { data, error } = await sb
  .from("users")
  .select("first_name, city, topics, subscribed_at, cancelled_at, stripe_customer_id, created_at");
if (error) {
  console.error("query failed:", error.message);
  process.exit(1);
}

const rows = data ?? [];
console.log(`total public.users rows: ${rows.length}`);
let subscribed = 0,
  deliverable = 0,
  subNoName = 0,
  subNoTopics = 0;
for (const r of rows as any[]) {
  const hasName = !!(r.first_name && String(r.first_name).trim());
  const topicCount = Array.isArray(r.topics) ? r.topics.length : 0;
  const isSub = !!r.subscribed_at;
  // mirror the cron's active filter: subscribed AND (cancelled null or future)
  const active =
    isSub &&
    (!r.cancelled_at || new Date(r.cancelled_at).getTime() > Date.now());
  if (isSub) subscribed++;
  if (active && hasName && topicCount > 0) deliverable++;
  if (active && !hasName) subNoName++;
  if (active && topicCount === 0) subNoTopics++;
  // structural line only — NO pii
  console.log(
    `  row: name=${hasName ? "set" : "NULL"} topics=${topicCount} subscribed=${isSub} cancelled=${r.cancelled_at ? "set" : "null"} stripe=${r.stripe_customer_id ? "linked" : "none"}`
  );
}
console.log("");
console.log(`subscribed rows               : ${subscribed}`);
console.log(`active+deliverable (name+topics): ${deliverable}`);
console.log(`active but NO first_name        : ${subNoName}  <-- cron skips these`);
console.log(`active but NO topics            : ${subNoTopics} <-- cron skips these`);
