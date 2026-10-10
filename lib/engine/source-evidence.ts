// Operational counts only. No topic, reader, URL, source text or error fields.
export const SOURCE_EVIDENCE_PROVIDERS = [
  "brave", "gemini", "you", "google-rss", "publisher-rss",
  "globalvoices-rss", "crossref", "plos", "ccmixter", "federal-register", "govuk-news", "statcan-labour", "gdelt",
] as const;
export type EvidenceProvider = typeof SOURCE_EVIDENCE_PROVIDERS[number];
export type EvidenceOutcome = "signal" | "healthy-empty" | "unavailable" | "no-signal-unconfirmed";
export type EvidenceSelection = "first-enabled" | "after-empty" | "after-unavailable" | "after-unconfirmed";
export interface SourceObservation {
  provider: EvidenceProvider;
  outcome: EvidenceOutcome;
  admittedSources: number;
  mode: "no-key" | "keyed";
  selection: EvidenceSelection;
}
export type SourceObserver = (observation: Readonly<SourceObservation>) => void;

function safeObservation(value: SourceObservation): Readonly<SourceObservation> | null {
  if (!SOURCE_EVIDENCE_PROVIDERS.includes(value.provider) ||
      !["signal", "healthy-empty", "unavailable", "no-signal-unconfirmed"].includes(value.outcome) ||
      !["first-enabled", "after-empty", "after-unavailable", "after-unconfirmed"].includes(value.selection) ||
      !["no-key", "keyed"].includes(value.mode) ||
      !Number.isSafeInteger(value.admittedSources) || value.admittedSources < 0 ||
      value.admittedSources > 100 ||
      (value.outcome === "signal" ? value.admittedSources === 0 : value.admittedSources !== 0)) return null;
  // Reconstruct the allowlisted shape, never spread caller-supplied fields.
  return Object.freeze({ provider: value.provider, outcome: value.outcome,
    admittedSources: value.admittedSources, mode: value.mode, selection: value.selection });
}

/** One resolver call. "Unavailable" includes control/quota failures, not just outages. */
export function createSourceObserver(observer?: SourceObserver) {
  let priorEmpty = false;
  let priorUnavailable = false;
  let priorUnconfirmed = false;
  return (provider: EvidenceProvider, outcome: EvidenceOutcome, admittedSources: number,
    mode: SourceObservation["mode"]) => {
    const selection = priorUnavailable ? "after-unavailable" : priorUnconfirmed ? "after-unconfirmed" : priorEmpty ? "after-empty" : "first-enabled";
    const observation = safeObservation({ provider, outcome, admittedSources, mode, selection });
    if (observation && observer) {
      // Optional telemetry must never reject useful source work.
      try { void Promise.resolve(observer(observation)).catch(() => {}); }
      catch { /* keep resolution unchanged */ }
    }
    priorEmpty ||= outcome === "healthy-empty";
    priorUnavailable ||= outcome === "unavailable";
    priorUnconfirmed ||= outcome === "no-signal-unconfirmed";
  };
}

/** Per-assembly state. Shared cached/in-flight provenance is deliberately unknown. */
export function createSourceEvidence<T extends object>() {
  const attempts = Object.fromEntries(SOURCE_EVIDENCE_PROVIDERS.map(provider =>
    [provider, { signal: 0, healthyEmpty: 0, unavailable: 0, noSignalUnconfirmed: 0, admittedSources: 0 }]));
  const provenance = new WeakMap<T, Readonly<SourceObservation> | "cached" | "reused">();
  const observe: SourceObserver = value => {
    const observation = safeObservation(value);
    if (!observation) return;
    const count = attempts[observation.provider]!;
    if (observation.outcome === "healthy-empty") count.healthyEmpty++;
    else if (observation.outcome === "no-signal-unconfirmed") count.noSignalUnconfirmed++;
    else count[observation.outcome]++;
    count.admittedSources += observation.admittedSources;
  };
  return {
    observe,
    mark(value: T, origin: Readonly<SourceObservation> | "cached" | "reused") {
      if (typeof origin === "string") provenance.set(value, origin);
      else {
        const observation = safeObservation(origin);
        if (observation?.outcome === "signal") provenance.set(value, observation);
      }
    },
    snapshot(chosen: readonly T[]) {
      const selected = Object.fromEntries(SOURCE_EVIDENCE_PROVIDERS.map(provider =>
        [provider, { sections: 0, firstEnabled: 0, afterEmpty: 0, afterUnavailable: 0, afterUnconfirmed: 0 }]));
      let cachedProvenanceUnknown = 0;
      let reusedProvenanceUnknown = 0;
      let otherProvenanceUnknown = 0;
      for (const value of chosen) {
        const origin = provenance.get(value);
        if (origin === "cached") cachedProvenanceUnknown++;
        else if (origin === "reused") reusedProvenanceUnknown++;
        else if (!origin) otherProvenanceUnknown++;
        else {
          const count = selected[origin.provider]!;
          count.sections++;
          if (origin.selection === "first-enabled") count.firstEnabled++;
          else if (origin.selection === "after-empty") count.afterEmpty++;
          else if (origin.selection === "after-unavailable") count.afterUnavailable++;
          else count.afterUnconfirmed++;
        }
      }
      // Fresh copies prevent late underlying work from changing an emitted result.
      const resolved = Object.fromEntries(SOURCE_EVIDENCE_PROVIDERS.map(provider =>
        [provider, Object.freeze({ ...attempts[provider]! })]));
      for (const count of Object.values(selected)) Object.freeze(count);
      return Object.freeze({ stage: "assembled" as const,
        attempts: Object.freeze(resolved), selected: Object.freeze(selected),
        selectedSections: chosen.length, cachedProvenanceUnknown,
        reusedProvenanceUnknown, otherProvenanceUnknown });
    },
  };
}
