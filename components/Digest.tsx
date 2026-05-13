import type { Issue } from "@/lib/types";

interface DigestProps {
  issue: Issue;
}

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

      {issue.sections.map((section, sectionIdx) => (
        <section key={section.topicId} className="mb-16">
          <div
            className="border-t mb-10"
            style={{ borderColor: "var(--rule)" }}
          />
          <h2 className="alpha-display text-3xl md:text-4xl font-bold mb-10 tracking-tight">
            {section.topicLabel}
          </h2>
          <div className="space-y-12">
            {section.items.map((item, itemIdx) => (
              <div key={itemIdx}>
                <h3 className="alpha-display text-xl md:text-2xl font-semibold mb-3 leading-snug">
                  {item.headline}
                </h3>
                <p className="text-base md:text-lg leading-relaxed">
                  {item.body}
                </p>
                {item.source && (
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
