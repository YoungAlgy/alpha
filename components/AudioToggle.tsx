"use client";

import { useEffect, useState } from "react";
import { isAudioEnabled, setAudioEnabled, tap } from "@/lib/audio";

export function AudioToggle({ compact = false }: { compact?: boolean }) {
  const [on, setOn] = useState(true);

  useEffect(() => {
    setOn(isAudioEnabled());
    // Cross-tab sync: without this, muting in Tab A leaves Tab B's toggle
    // showing unmuted (and still playing UI chimes) until Tab B reloads.
    // lib/audio.ts writes the "alpha-audio" key directly with no CustomEvent
    // dispatch, so "storage" (which only fires in OTHER tabs, not the one
    // that made the change) is the only signal available here.
    function onStorage(e: StorageEvent) {
      if (e.key === "alpha-audio") setOn(isAudioEnabled());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  function toggle() {
    const next = !on;
    setOn(next);
    setAudioEnabled(next);
    if (next) tap();
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={on ? "Mute audio" : "Unmute audio"}
      className="alpha-ui text-sm font-medium rounded-full border p-2"
      style={{
        borderColor: "var(--rule)",
        color: "var(--ink-soft)",
        width: compact ? 36 : undefined,
        height: compact ? 36 : undefined,
        lineHeight: 1,
      }}
    >
      <span aria-hidden style={{ display: "inline-block", width: 16 }}>
        {on ? "♪" : "·"}
      </span>
    </button>
  );
}
