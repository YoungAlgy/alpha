// Signal-strength audit across all topics. Brave-only (cheap/fast, no Claude):
// resolves each topic's weekly signal and reports the count of distinct real
// URLs. Thin signal (few URLs) → thin letters + more links dropped by the
// guard. Surfaces which topic query sets need work.
//
// Run: npx tsx scripts/audit-topic-signal.mts
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const { resolveTopicSignal } = await import("../lib/engine/source-resolver.ts");
const { extractSignalUrls } = await import("../lib/engine/url-guard.ts");
const { TOPICS } = await import("../lib/topics.ts");

function weekOfNow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}
const weekOf = weekOfNow();

const rows: { id: string; label: string; urls: number }[] = [];
for (const t of TOPICS) {
  try {
    const sig = await resolveTopicSignal(t.id as never, weekOf);
    const n = sig ? extractSignalUrls(sig.context).size : 0;
    rows.push({ id: t.id, label: t.label, urls: n });
    console.log(`${String(n).padStart(3)}  ${t.id}`);
  } catch (e) {
    rows.push({ id: t.id, label: t.label, urls: -1 });
    console.log(`ERR  ${t.id} — ${e instanceof Error ? e.message : e}`);
  }
}

rows.sort((a, b) => a.urls - b.urls);
console.log(`\n=== WEAKEST (fewest real URLs — fix these query sets) ===`);
for (const r of rows.slice(0, 6)) console.log(`  ${String(r.urls).padStart(3)}  ${r.id} (${r.label})`);
const thin = rows.filter((r) => r.urls >= 0 && r.urls < 8);
console.log(`\n${thin.length} topic(s) under 8 URLs (a 3-item letter wants ~9+ for good link choice).`);
