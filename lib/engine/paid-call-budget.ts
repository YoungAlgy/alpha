export interface PaidCallSnapshot {
  topicBlurbAnthropic: number;
  editorNoteAnthropic: number;
  deepseek: number;
}

export function paidCallTotal(snapshot: PaidCallSnapshot): number {
  return snapshot.topicBlurbAnthropic + snapshot.editorNoteAnthropic + snapshot.deepseek;
}

export function paidCallsSinceBaseline(
  baseline: PaidCallSnapshot,
  current: PaidCallSnapshot
): number {
  return paidCallTotal(current) - paidCallTotal(baseline);
}

/**
 * A paid call may start while the run is below its ceiling. The call-specific
 * counter is incremented synchronously immediately after this check, so a run
 * at ceiling - 1 may start its final paid call and a run at ceiling may not.
 */
export function canStartPaidCall(
  ceiling: number,
  baseline: PaidCallSnapshot,
  current: PaidCallSnapshot
): boolean {
  return paidCallsSinceBaseline(baseline, current) < ceiling;
}
