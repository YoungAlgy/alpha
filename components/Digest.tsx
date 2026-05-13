import type { Issue, DigestItem, ItemKind } from "@/lib/types";

interface DigestProps {
  issue: Issue;
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

export function Digest({ issue }: DigestProps) {
  return (
    <article className="alpha-body max-w-2xl mx-auto px-6 py-20 md:py-28">
      <div
        className="alpha-mono mb-14 text-center"
        style={{ color: "var(--ink-soft)" }}
      >
        {issue.weekOf}
      </div>

      <h1 className="alpha-display text-4xl md:text-5xl font-bold mb-6 tracking-tight">
        Hi {issue.recipientFirstName},
      </h1>

      <p
        className="alpha-display text-lg md:text-xl leading-relaxed mb-20"
        style={{ color: "var(--ink)" }}
      >
        {issue.editorIntro}
      </p>

      {issue.sections.map((section) => (
        <section key={section.topicId} className="mb-16">
          <div
            className="border-t mb-10"
            style={{ borderColor: "var(--rule)" }}
          />
          <h2 className="alpha-display text-3xl md:text-4xl font-bold mb-3 tracking-tight">
            {section.topicLabel}
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
      ))}

      <div
        className="border-t pt-12 mt-16"
        style={{ borderColor: "var(--rule)" }}
      >
        <p
          className="alpha-display text-xl italic mb-1"
          style={{ color: "var(--ink-soft)" }}
        >
          That's the drop. See you next Sunday.
        </p>
        <p className="alpha-display text-xl font-semibold">— Alpha</p>
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

      {item.primaryRef && (
        <a
          href={item.primaryRef.url}
          target="_blank"
          rel="noopener noreferrer"
          className="alpha-ui mt-4 inline-flex items-baseline gap-2 font-semibold underline underline-offset-4 decoration-1"
          style={{ color: "var(--accent-ink)" }}
        >
          {kindLabel || "Open"}: {item.primaryRef.label}
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
            {item.supplementaryRefs.map((ref, i) => (
              <li key={i} className="alpha-ui text-sm leading-relaxed">
                <a
                  href={ref.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-4 decoration-1"
                  style={{ color: "var(--ink-soft)" }}
                >
                  {ref.label} ↗
                </a>
                {ref.note && (
                  <span style={{ color: "var(--ink-soft)" }}> — {ref.note}</span>
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
            {item.sourceUrl ? (
              <a
                href={item.sourceUrl}
                className="hover:underline"
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
