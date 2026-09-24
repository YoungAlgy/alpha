import { issueIsReaderVisible } from "@/lib/issue-visibility";

type StoredIssue = { editor_intro?: unknown; sections?: unknown };

// Row windows, newest first. The newest issue is almost always visible, so
// read one full issue before widening. 100 rows in total.
const WINDOWS: ReadonlyArray<readonly [number, number]> = [[0, 0], [1, 24], [25, 49], [50, 74], [75, 99]];

// Walk past hidden historical issues without deleting delivery records or
// pretending an exhausted search window means the reader has no letters.
export async function latestVisibleIssue<T extends StoredIssue>(
  readPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
) {
  for (const [from, to] of WINDOWS) {
    const { data, error } = await readPage(from, to);
    if (error) return { data: null, error };
    const rows = data || [];
    const visible = rows.find(issueIsReaderVisible);
    if (visible) return { data: visible, error: null };
    if (rows.length < to - from + 1) return { data: null, error: null };
  }
  return { data: null, error: new Error("Earlier available letters require an archive search.") };
}
