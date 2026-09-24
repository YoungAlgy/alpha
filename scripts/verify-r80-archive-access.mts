// Deterministic, local-only verification of Round 80 reader-access closure.
// Reads source and migration text, plus exercises the pure shared predicate.
// It never loads environment files or contacts Supabase or any provider.
import { readFileSync } from "node:fs";
import { hasReaderAccess, hasSubscriberAccess } from "../lib/access.ts";
import { getSignupAccountState } from "../lib/signup-progress.ts";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  console.log(`  ${condition ? "OK " : "XX "} ${label}`);
  if (condition) passed++;
  else failed++;
}
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

console.log("(1) shared reader-access predicate");
{
  const now = new Date("2026-08-27T12:00:00.000Z");
  const grant = "2026-08-01T00:00:00.000Z";
  check("missing subscribed_at fails closed", !hasSubscriberAccess(null, null, now));
  check("empty subscribed_at fails closed", !hasSubscriberAccess("", null, now));
  check("grant with no cancellation is active", hasSubscriberAccess(grant, null, now));
  check("future cancellation remains active through paid period", hasSubscriberAccess(grant, "2026-09-01T00:00:00.000Z", now));
  check("past cancellation has ended", !hasSubscriberAccess(grant, "2026-08-01T00:00:00.000Z", now));
  check("invalid cancellation fails closed", !hasSubscriberAccess(grant, "invalid", now));
  check(
    "protected invite grant survives the paid cancellation date",
    hasReaderAccess(
      grant,
      "2026-08-01T00:00:00.000Z",
      "2026-08-26T00:00:00.000Z",
      now
    )
  );
  check(
    "invite marker without subscribed_at fails closed",
    !hasReaderAccess(null, null, "2026-08-26T00:00:00.000Z", now)
  );
}

console.log("(2) every reader-facing database path uses the shared predicate");
{
  const readers = [
    { path: "../app/letter/page.tsx", label: "/letter", calls: 1, selects: 1 },
    { path: "../app/inbox/page.tsx", label: "/inbox", calls: 1, selects: 1 },
    { path: "../app/inbox/[issueId]/page.tsx", label: "/inbox/[issueId]", calls: 1, selects: 1 },
    { path: "../app/archive/page.tsx", label: "/archive load + loadMore", calls: 2, selects: 2 },
  ];
  for (const reader of readers) {
    const src = read(reader.path);
    const throughSignupState = reader.label === "/inbox";
    const helper = throughSignupState ? read("../lib/signup-progress.ts") : src;
    const calls = throughSignupState
      ? (src.match(/getSignupAccountState\(userRow\)/g) ?? []).length
      : (src.match(/hasReaderAccess\(\s*userRow/g) ?? []).length;
    const selected = (src.match(/select\([^\n]*subscribed_at[^\n]*cancelled_at[^\n]*access_granted_at[^\n]*\)/g) ?? []).length;
    check(`${reader.label}: imports shared reader-access helper`, /import \{ hasReaderAccess \} from "@\/lib\/access";/.test(helper) &&
      (!throughSignupState || /import \{ getSignupAccountState \} from "@\/lib\/signup-progress";/.test(src)));
    check(`${reader.label}: every access gate uses hasReaderAccess (${reader.calls})`, calls === reader.calls);
    if (throughSignupState) {
      check("/inbox: signup classification uses the shared grant and cancellation predicate",
        /hasReaderAccess\(row\.subscribed_at, row\.cancelled_at, row\.access_granted_at\)/.test(helper));
      check("/inbox: incomplete, pending and ended accounts return before rendering an issue",
        /accountState === "pending" \|\| accountState === "incomplete"[\s\S]*?return;[\s\S]*?accountState === "ended" \|\| !userRow[\s\S]*?return;[\s\S]*?setIssue\(/.test(src));
      for (const row of [
        null,
        { subscribed_at: null, access_granted_at: "2020-01-01" },
        { subscribed_at: "2020-01-01", cancelled_at: "2020-01-02" },
        { subscribed_at: "2020-01-01", cancelled_at: "2020-01-02", access_granted_at: "2020-01-03" },
        { subscribed_at: "2020-01-01", cancelled_at: null },
        { access_requested_at: "2020-01-01" },
      ]) {
        check(`/inbox: reader classification matches access for ${JSON.stringify(row)}`,
          (getSignupAccountState(row) === "reader") === hasReaderAccess(row?.subscribed_at, row?.cancelled_at, row?.access_granted_at));
      }
    }
    check(`${reader.label}: every users query selects paid and invite access fields (${reader.selects})`, selected === reader.selects);
    check(`${reader.label}: cancellation-only helper is absent`, !/hasActiveAccess\(/.test(src));
  }
}

console.log("(3) database enforcement matches application enforcement");
{
  const migration = read("../supabase/migrations/20260830000000_invite_access.sql");
  check("migration replaces the issues self-read policy", /drop policy if exists "issues self read"[\s\S]*create policy "issues self read"/.test(migration));
  check("policy remains scoped to the authenticated issue owner", /auth\.uid\(\) = user_id/.test(migration));
  check("policy requires subscribed_at IS NOT NULL", /u\.subscribed_at is not null/.test(migration));
  check(
    "policy preserves future cancel-at-period-end access",
    /u\.cancelled_at is null\s+or\s+u\.cancelled_at > now\(\)/.test(
      migration
    )
  );
  check("policy grants protected invite access independently", /u\.access_granted_at is not null/.test(migration));

  const admin = read("../app/api/admin/users/route.ts");
  check(
    "free revoke clears subscribed_at, the pending request, invite marker, and cancelled_at atomically",
    /if \(body\.action === "revoke_free"\)[\s\S]*?\.update\(\{[\s\S]*?subscribed_at:\s*null,[\s\S]*?access_requested_at:\s*null,[\s\S]*?access_granted_at:\s*null,[\s\S]*?cancelled_at:\s*revokedAt,[\s\S]*?delivery_enrolled:\s*false,[\s\S]*?\}\)/.test(
      admin
    )
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("ROUND 80 ARCHIVE ACCESS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL ROUND 80 ARCHIVE ACCESS ASSERTIONS PASS");
