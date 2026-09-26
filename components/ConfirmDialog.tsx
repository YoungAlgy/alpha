"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import styles from "./ConfirmDialog.module.css";

interface ConfirmOptions {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
}

interface PendingConfirmation extends ConfirmOptions {
  resolve: (accepted: boolean) => void;
}

// One outstanding question per page. A second click cannot replace the
// first question, and leaving the page always cancels the pending action.
export function useConfirmDialog() {
  const [request, setRequest] = useState<PendingConfirmation | null>(null);
  const pending = useRef<PendingConfirmation | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const current = pending.current;
      pending.current = null;
      current?.resolve(false);
    };
  }, []);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    if (!mounted.current || pending.current) return Promise.resolve(false);
    return new Promise((resolve) => {
      const next = { ...options, resolve };
      pending.current = next;
      setRequest(next);
    });
  }, []);

  const finish = useCallback((current: PendingConfirmation, accepted: boolean) => {
    // Ignore a late close event from a previous dialog.
    if (pending.current !== current) return;
    pending.current = null;
    if (mounted.current) setRequest(null);
    current.resolve(accepted);
  }, []);

  return {
    confirm,
    dialog: request ? (
      <ConfirmDialog options={request} onAnswer={(accepted) => finish(request, accepted)} />
    ) : null,
  };
}

function ConfirmDialog({ options, onAnswer }: {
  options: ConfirmOptions;
  onAnswer: (accepted: boolean) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    // showModal supplies native focus containment and makes the page behind
    // the themed dialog inert. It does not create a browser pop-up.
    dialog.showModal();
    cancelRef.current?.focus();
    document.body.style.overflow = "hidden";
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onCancel={(event) => { event.preventDefault(); onAnswer(false); }}
      onClose={() => {
        // Strict Mode reopens the same element after its effect cleanup.
        if (!dialogRef.current?.open) onAnswer(false);
      }}
    >
      <h2 id={`${id}-title`} className={`alpha-display ${styles.title}`}>{options.title}</h2>
      <p id={`${id}-description`} className={`alpha-ui ${styles.description}`}>{options.description}</p>
      <div className={styles.actions}>
        <button ref={cancelRef} type="button" className={`alpha-ui ${styles.cancel}`} onClick={() => onAnswer(false)}>
          {options.cancelLabel ?? "Cancel"}
        </button>
        <button type="button" className={`alpha-ui ${styles.confirm}`} onClick={() => onAnswer(true)}>
          {options.destructive && <span aria-hidden="true">! </span>}{options.confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
