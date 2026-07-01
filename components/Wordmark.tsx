// The alpha. wordmark: lowercase, with a gold trailing period. The dot uses
// --brand-gold (fixed across every theme), never --accent (which each theme
// recolors) -- the wordmark is brand identity, not theme chrome.
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={className}>
      alpha<span style={{ color: "var(--brand-gold)" }}>.</span>
    </span>
  );
}
