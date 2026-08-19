import type { Issue, DigestItem, ItemKind } from "@/lib/types";
import { ScrollFadeIn } from "./ScrollFadeIn";
import { topicEmoji, topicAnchor, TOPIC_BY_ID } from "@/lib/topics";
import { Wordmark } from "./Wordmark";
import { SEND_HOUR_UTC } from "@/lib/cadence";

// alpha-drift-r14-12 (review 2026-08-06): the only disclaimer anywhere in
// the app was generic legal boilerplate on /terms -- a subscriber reading
// their actual letter never saw any caveat next to a specific financial or
// health claim, even though the "calm friend" editorial voice states
// things as flat, confident fact with no hedge by design (topic-blurb.ts's
// SYSTEM_PROMPT). Short and understated on purpose, matching the app's own
// plain, un-preachy voice -- not a wall of legal text, just enough to mark
// the section as "this is information, not advice" where it actually
// matters. Returns null for a custom: topic (no known catalog bucket) or
// any bucket that isn't Money/Body -- most topics get nothing added.
function sectionDisclaimer(topicId: string): string | null {
  const meta = TOPIC_BY_ID[topicId as keyof typeof TOPIC_BY_ID];
  if (!meta) return null;
  if (meta.bucket === "Money") return "Not financial advice. Do your own research before acting on anything here.";
  if (meta.bucket === "Body") return "Not medical advice. Talk to a doctor before acting on anything here.";
  return null;
}

interface DigestProps {
  issue: Issue;
  // Render the dateline in the READER's own browser timezone instead of a
  // fixed UTC anchor -- alpha-drift-r14-05 (review 2026-08-06): without
  // this, a subscriber roughly UTC+10 and above (Australia east coast, NZ,
  // Fiji, Tonga) sees YESTERDAY's date on the dateline even once it's
  // unambiguously today for them -- the letter landed at SEND_HOUR_UTC
  // (14:00 UTC) and their local calendar has already crossed into the next
  // day by the time they read it, once their offset is >= 24 - SEND_HOUR_UTC.
  // alpha-drift-r33-02: that affected-range figure was originally computed
  // against the wrong anchor (a plain noon UTC formatDateline used to parse
  // against, not the real 14:00Z send hour) -- corrected here to UTC+10 and
  // above, now that formatDateline actually anchors to SEND_HOUR_UTC.
  // alpha-drift-r34-04 (2026-08-14, self-audit): dropped the single "2-3am"
  // example clock time that survived the r33-02 edit -- it only held for the
  // narrow NZ/Tonga end (UTC+12/+13) of this now-widened range; at UTC+10
  // the send instant actually lands at local midnight, and at UTC+11 it's
  // 1am. The range spans local midnight (UTC+10) through ~4am (UTC+14), not
  // one fixed hour. Only meaningful where
  // Digest actually renders in the reader's own browser (the /inbox and
  // /inbox/[id] pages, both client components) -- the /letter page renders
  // server-side with no reliable reader-timezone signal at all, so it
  // deliberately omits this and keeps the safe, deterministic UTC anchor
  // (matches nextSendLabel()'s own already-established convention in
  // app/inbox/page.tsx: parse the precise UTC instant, then format it in
  // whichever timezone is actually meaningful for where this is rendered).
  localTimezone?: boolean;
}

const KIND_LABEL: Record<ItemKind, string> = {
  read: "Read",
  watch: "Watch",
  listen: "Listen",
  try: "Try",
  post: "Read the post",
  book: "Get the book",
  event: "Details",
  note: "",
};

function faviconUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=64`;
  } catch {
    return null;
  }
}

// Only ever render http(s) links. Letter URLs originate from Brave results
// (untrusted) routed through Claude, so a poisoned/hallucinated `javascript:`
// or `data:` URL could otherwise reach an <a href> and execute on click.
// Returns the URL if safe, else null (caller hides the link).
function safeUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

// The dateline. Cron-generated issues arrive pre-formatted ("Tuesday, June
// 30, 2026"); the tokenized /letter page passes the raw DB date ("2026-06-30")
// — format that case too, so every view carries an unmistakable human date
// (a subscriber couldn't tell her letters apart; the day must be loud).
// alpha-drift-r33-02 (2026-08-14): always parse as a precise UTC instant at
// the REAL send hour (lib/cadence.ts's SEND_HOUR_UTC, 14:00Z) -- this used
// to anchor to a plain noon (T12:00:00Z), a 2-hour-early value that was
// never actually the send time. That gap silently broke the whole point of
// localTimezone=true for UTC+10/UTC+11 readers (still showed yesterday's
// date), and drifted from app/inbox/page.tsx's nextSendLabel(), which always
// used the real 14:00Z anchor. Only the FORMAT step's timezone varies by
// caller -- see DigestProps' localTimezone comment for why.
function formatDateline(weekOf: string, localTimezone: boolean): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekOf)) return weekOf; // already formatted
  return new Date(`${weekOf}T${String(SEND_HOUR_UTC).padStart(2, "0")}:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    ...(localTimezone ? {} : { timeZone: "UTC" }),
  });
}

export function Digest({ issue, localTimezone = false }: DigestProps) {
  return (
    <article className="alpha-body max-w-2xl mx-auto px-6 py-20 md:py-28">
      <div
        className="alpha-mono mb-14 text-center"
        style={{ color: "var(--ink-soft)" }}
      >
        {formatDateline(issue.weekOf, localTimezone)}
      </div>

      <h1 className="alpha-display text-4xl md:text-5xl font-bold mb-6 tracking-tight">
        Hi {issue.recipientFirstName},
      </h1>

      <p
        className="alpha-display alpha-editor-intro text-lg md:text-xl leading-relaxed mb-20"
        style={{ color: "var(--ink)" }}
      >
        {issue.editorIntro}
      </p>

      {issue.sections.map((section, i) => {
        const emoji = topicEmoji(section.topicId);
        const disclaimer = sectionDisclaimer(section.topicId);
        return (
        <ScrollFadeIn key={section.topicId} className="mb-16">
        {/* alpha-drift-r35-16 (2026-08-14): tabIndex={-1} makes this a valid
            PROGRAMMATIC focus target -- components/LetterTOC.tsx's jump()
            scrolls here via a JS onClick (not a native <a href="#anchor">,
            so the browser's built-in "activating an anchor moves focus"
            never fires) and now also calls .focus() on this same element
            right after scrollIntoView, so a keyboard user's next Tab
            continues from the section that's now on screen, and a screen
            reader's cursor actually repositions to match the visual jump. */}
        <section id={topicAnchor(section.topicId, i)} tabIndex={-1} style={{ outline: "none" }}>
          <div
            className="border-t mb-10"
            style={{ borderColor: "var(--rule)" }}
          />
          <h2 className="alpha-display text-3xl md:text-4xl font-bold mb-3 tracking-tight flex items-baseline gap-3">
            {emoji && (
              <span aria-hidden className="text-2xl md:text-3xl" style={{ opacity: 0.85 }}>
                {emoji}
              </span>
            )}
            <span>{section.topicLabel}</span>
          </h2>
          {section.intro && (
            <p
              className="text-base md:text-lg mb-10 leading-relaxed"
              style={{ color: "var(--ink-soft)" }}
            >
              {section.intro}
            </p>
          )}
          <div className="space-y-14">
            {section.items.map((item, itemIdx) => (
              <Item key={itemIdx} item={item} />
            ))}
          </div>
          {disclaimer && (
            <p className="alpha-ui text-xs mt-8" style={{ color: "var(--ink-soft)", opacity: 0.75 }}>
              {disclaimer}
            </p>
          )}
        </section>
        </ScrollFadeIn>
        );
      })}

      <div
        className="border-t pt-12 mt-16"
        style={{ borderColor: "var(--rule)" }}
      >
        <p
          className="alpha-display text-xl italic mb-1"
          style={{ color: "var(--ink-soft)" }}
        >
          That&apos;s the drop. See you next time.
        </p>
        <p className="alpha-display text-xl font-semibold"><Wordmark /></p>
      </div>
    </article>
  );
}

function Item({ item }: { item: DigestItem }) {
  const kindLabel = KIND_LABEL[item.kind];
  return (
    <div>
      {kindLabel && (
        // alpha-drift-r25-04 (2026-08-14): --accent-ink fails WCAG AA 4.5:1
        // against --paper in most themes (2.88:1 default); this label is
        // plain informational text, not decoration, so it needs a token
        // that clears 4.5:1 -- --ink-soft does, in all 26 themes, and is
        // already this app's established color for muted meta text.
        <div
          className="alpha-mono mb-2"
          style={{ color: "var(--ink-soft)" }}
        >
          {item.kind.toUpperCase()}
        </div>
      )}
      <h3 className="alpha-display text-xl md:text-2xl font-semibold mb-3 leading-snug">
        {item.headline}
      </h3>
      <p className="text-base md:text-lg leading-relaxed">{item.body}</p>

      {item.primaryRef && safeUrl(item.primaryRef.url) && (
        <a
          href={safeUrl(item.primaryRef.url)!}
          target="_blank"
          rel="noopener noreferrer"
          className="alpha-ui mt-4 inline-flex items-center gap-1 font-semibold underline underline-offset-4 decoration-1"
          style={{ color: "var(--accent-ink)" }}
        >
          {faviconUrl(item.primaryRef.url) && (
            <img
              src={faviconUrl(item.primaryRef.url)!}
              alt=""
              loading="lazy"
              width={14}
              height={14}
              className="alpha-src-favicon"
            />
          )}
          <span>{kindLabel || "Open"}: {item.primaryRef.label}</span>
          <span aria-hidden>↗</span>
        </a>
      )}

      {item.supplementaryRefs && item.supplementaryRefs.length > 0 && (
        <div className="mt-4 space-y-1">
          <div
            className="alpha-mono mb-1"
            style={{ color: "var(--ink-soft)" }}
          >
            ALSO
          </div>
          <ul className="space-y-1.5">
            {item.supplementaryRefs.filter((ref) => safeUrl(ref.url)).map((ref, i) => (
              <li key={i} className="alpha-ui text-sm leading-relaxed">
                <a
                  href={safeUrl(ref.url)!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 underline underline-offset-4 decoration-1"
                  style={{ color: "var(--ink-soft)" }}
                >
                  {faviconUrl(ref.url) && (
                    <img
                      src={faviconUrl(ref.url)!}
                      alt=""
                      loading="lazy"
                      width={14}
                      height={14}
                      className="alpha-src-favicon"
                    />
                  )}
                  <span>{ref.label} ↗</span>
                </a>
                {ref.note && (
                  <span style={{ color: "var(--ink-soft)" }}> ({ref.note})</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Legacy text source (no URL) — only shown when neither primaryRef nor supplementaryRefs exists */}
      {!item.primaryRef &&
        (!item.supplementaryRefs || item.supplementaryRefs.length === 0) &&
        item.source && (
          <div
            className="alpha-mono mt-4"
            style={{ color: "var(--ink-soft)" }}
          >
            {safeUrl(item.sourceUrl) ? (
              <a
                href={safeUrl(item.sourceUrl)!}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
                style={{ color: "var(--accent-ink)" }}
              >
                {item.source}
              </a>
            ) : (
              item.source
            )}
          </div>
        )}
    </div>
  );
}
