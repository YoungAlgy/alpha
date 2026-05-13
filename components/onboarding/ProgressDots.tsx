interface ProgressDotsProps {
  current: number; // 1-based step index
  total: number;
}

export function ProgressDots({ current, total }: ProgressDotsProps) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: total }).map((_, i) => {
        const idx = i + 1;
        const filled = idx <= current;
        return (
          <span
            key={i}
            className="block rounded-full transition-all"
            style={{
              width: idx === current ? "20px" : "6px",
              height: "6px",
              background: filled ? "var(--accent)" : "var(--rule)",
            }}
          />
        );
      })}
    </div>
  );
}
