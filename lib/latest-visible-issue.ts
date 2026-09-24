import { issueIsReaderVisible } from "@/lib/issue-visibility";

type StoredIssue = { editor_intro?: unknown; sections?: unknown };

// Walk past hidden historical issues without deleting delivery records or
// pretending an exhausted search window means the reader has no letters.
export async function latestVisibleIssue<T extends StoredIssue>(
  readPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
) {
  const pageSize = 25;
  for (let page = 0; page < 4; page++) {
    const { data, error } = await readPage(page * pageSize, (page + 1) * pageSize - 1);
    if (error) return { data: null, error };
    const rows = data || [];
    const visible = rows.find(issueIsReaderVisible);
    if (visible) return { data: visible, error: null };
    if (rows.length < pageSize) return { data: null, error: null };
  }
  return { data: null, error: new Error("Earlier available letters require an archive search.") };
}
