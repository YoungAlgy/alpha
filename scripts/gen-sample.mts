// Flexible letter-sample generator for voice/model A/B work. Bypasses the shared
// blurb cache (calls generateTopicBlurb directly) so two models on the same topic
// are a clean comparison, not a cache hit. Model is controlled by the env vars
// ALPHA_BLURB_MODEL / ALPHA_EDITOR_MODEL (see lib/engine/client.ts).
//
// Run: ALPHA_BLURB_MODEL=claude-sonnet-4-6 npx tsx scripts/gen-sample.mts <profile> <topicsCsv>
//   <profile>   = gigi | founder        (a reader profile)
//   <topicsCsv> = personal-finance,real-estate   (defaults to the profile's set)
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const { resolveTopicSignal } = await import("../lib/engine/source-resolver.ts");
const { generateTopicBlurb } = await import("../lib/engine/topic-blurb.ts");
const { generateEditorNote } = await import("../lib/engine/editor-note.ts");
const { BLURB_MODEL, EDITOR_NOTE_MODEL } = await import("../lib/engine/client.ts");

function weekOfNow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

const PROFILES: Record<string, { profile: any; topics: string[] }> = {
  // Algy's mom — the real live reader.
  gigi: {
    profile: {
      id: "sample-gigi",
      email: "sample@example.com",
      firstName: "Gigi",
      city: "Tampa, FL",
      jobBlurb: undefined,
      projectBlurb: undefined,
      funBlurb: "real estate, women's health, nutrition, faith",
      gender: "female",
      birthday: undefined,
      topics: [],
    },
    topics: ["personal-finance", "womens-health"],
  },
  // A contrasting reader so the voice isn't overfit to one person.
  founder: {
    profile: {
      id: "sample-founder",
      email: "sample2@example.com",
      firstName: "Marcus",
      city: "Austin, TX",
      jobBlurb: "founder of a small B2B software company",
      projectBlurb: "shipping our first AI feature",
      funBlurb: "trail running, jazz, sci-fi novels",
      gender: "male",
      birthday: undefined,
      topics: [],
    },
    topics: ["founder-operator", "ai-news"],
  },
};

const which = process.argv[2] || "gigi";
const sel = PROFILES[which];
if (!sel) {
  console.error(`unknown profile "${which}". use: ${Object.keys(PROFILES).join(" | ")}`);
  process.exit(1);
}
const topicIds = (process.argv[3] ? process.argv[3].split(",") : sel.topics).map((s) => s.trim());
const profile = { ...sel.profile, topics: topicIds };
const weekOf = weekOfNow();

console.log(`# SAMPLE — profile=${which} week=${weekOf}`);
console.log(`# BLURB_MODEL=${BLURB_MODEL}  EDITOR_NOTE_MODEL=${EDITOR_NOTE_MODEL}`);
console.log(`# topics=${topicIds.join(", ")}\n`);

const blurbs: any[] = [];
for (const id of topicIds) {
  process.stderr.write(`resolving + generating ${id}...\n`);
  const signal = await resolveTopicSignal(id as never, weekOf);
  const blurb = await generateTopicBlurb(id as never, weekOf, signal);
  blurbs.push(blurb);
  console.log(`===== SECTION: ${blurb.topicLabel} =====`);
  console.log(`[intro] ${blurb.intro}\n`);
  for (const it of blurb.items) {
    console.log(`(${it.kind}) ${it.headline}`);
    console.log(it.body);
    if (it.primaryRef) console.log(`-> ${it.primaryRef.label}`);
    console.log("");
  }
}

process.stderr.write(`generating editor note...\n`);
const note = await generateEditorNote(profile as never, blurbs);
console.log(`===== EDITOR NOTE =====\n${note}\n`);
