"use client";

import { useState } from "react";
import { track } from "@/lib/analytics";

// Turns a reader into a distributor. Uses the Web Share API (native share
// sheet on mobile — Algy's primary surface) and falls back to copy-link on
// desktop. Always shares a PUBLIC url (the landing or the sample), never a
// subscriber's private letter. Fires analytics so we can see whether sharing
// actually drives anything.
interface ShareButtonProps {
  url: string;
  title: string;
  text: string;
  label?: string;
  context: string; // where the share fired from, e.g. "sample" | "inbox"
  className?: string;
  style?: React.CSSProperties;
}

export function ShareButton({
  url,
  title,
  text,
  label = "Share",
  context,
  className,
  style,
}: ShareButtonProps) {
  const [copied, setCopied] = useState(false);

  async function onShare() {
    track("share_clicked", { context });
    const data = { title, text, url };
    // Native share sheet (mobile + some desktops)
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share(data);
        track("shared", { context, method: "native" });
        return;
      } catch {
        // user cancelled or it failed — fall through to clipboard
      }
    }
    // Fallback: copy the link
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
      track("shared", { context, method: "clipboard" });
    } catch {
      // last resort: open a mail/X intent? keep it simple — no-op
    }
  }

  return (
    <button type="button" onClick={onShare} className={className} style={style}>
      {copied ? "Link copied ✓" : label}
    </button>
  );
}
