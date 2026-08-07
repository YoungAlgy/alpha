import type { Issue, DigestItem, ItemKind } from "@/lib/types";
import { ScrollFadeIn } from "./ScrollFadeIn";
import { topicEmoji, topicAnchor } from "@/lib/topics";
import { Wordmark } from "./Wordmark";

interface DigestProps {
  issue: Issue;
  // Render the dateline in the READER's own browser timezone instead of a
  // fixed UTC anchor -- alpha-drift-r14-05 (review 2026-08-06): without
  // this, a subscriber roughly UTC+11 through UTC+14 (NZ, Fiji, Tonga) sees
  // YESTERDAY's date on the dateline even once it's unambiguously today for
  // them (they read the letter at ~8am local, but it landed at 14:00 UTC =
  // 2-3am local the following calendar day). Only meaningful where Digest
  // actually renders in the reader's own browser (the /inbox and
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
// Always parse as a precise UTC instant (noon UTC on weekOf, unambiguous);
// only the FORMAT step's timezone varies by caller -- see DigestProps'
// localTimezone comment for why.
function formatDateline(weekOf: string, localTimezone: boolean): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekOf)) return weekOf; // already formatted
  return new Date(`${weekOf}T12:00:00Z`).toLocaleDateString("en-US", {
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
        return (
        <ScrollFadeIn key={section.topicId} className="mb-16">
        <section id={topicAnchor(section.topicId, i)}>
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
        <div
          className="alpha-mono mb-2"
          style={{ color: "var(--accent-ink)" }}
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
