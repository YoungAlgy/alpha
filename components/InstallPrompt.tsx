"use client";

import { useEffect, useState } from "react";
import { tap } from "@/lib/audio";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISSED_KEY = "alpha-install-dismissed";

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(DISMISSED_KEY)) return;

    function handler(e: Event) {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      // Wait a beat so it doesn't pop in instantly on arrival
      setTimeout(() => setVisible(true), 2400);
    }

    window.addEventListener("beforeinstallprompt", handler as EventListener);
    return () => window.removeEventListener("beforeinstallprompt", handler as EventListener);
  }, []);

  async function install() {
    if (!deferred) return;
    tap();
    setVisible(false);
    await deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
    localStorage.setItem(DISMISSED_KEY, "installed");
  }

  function dismiss() {
    tap();
    setVisible(false);
    localStorage.setItem(DISMISSED_KEY, "1");
  }

  if (!visible || !deferred) return null;

  return (
    <div
      className="fixed bottom-4 inset-x-4 md:bottom-6 md:right-6 md:left-auto md:max-w-sm z-40 alpha-card p-4 flex items-center gap-3"
      style={{
        boxShadow: "0 12px 30px rgba(0,0,0,0.10)",
        background: "var(--paper)",
        borderColor: "var(--rule)",
        animation: "alpha-step-in 320ms ease-out",
      }}
    >
      <div className="flex-1">
        <p className="alpha-display font-semibold text-base mb-0.5">
          Add Alpha to your home screen
        </p>
        <p
          className="alpha-ui text-xs leading-snug"
          style={{ color: "var(--ink-soft)" }}
        >
          Open your letters in one tap.
        </p>
      </div>
      <button
        type="button"
        onClick={install}
        className="alpha-button text-sm py-2 px-4"
      >
        Add
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="alpha-ui text-sm"
        style={{ color: "var(--ink-soft)" }}
      >
        ✕
      </button>
    </div>
  );
}
