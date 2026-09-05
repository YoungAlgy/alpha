export const ACCOUNT_EXPORT_PAGE_SIZE = 500;
export const ACCOUNT_EXPORT_MAX_ROWS = 25_000;

export type AccountEmail = string | null | undefined;

export interface ExportPage<T> {
  data: T[] | null;
  count: number | null;
  error: { message: string } | null;
}

export class AccountExportTooLargeError extends Error {
  constructor(label: string, count: number, maxRows: number) {
    super(
      `${label} contains ${count.toLocaleString()} rows, above the ${maxRows.toLocaleString()}-row export limit`
    );
    this.name = "AccountExportTooLargeError";
  }
}

export function normalizeAccountEmails(...emails: AccountEmail[]): string[] {
  const unique = new Set<string>();
  for (const email of emails) {
    if (typeof email !== "string") continue;
    const normalized = email.trim().toLowerCase();
    if (normalized) unique.add(normalized);
  }
  return [...unique];
}

/**
 * Read a stable, count-verified snapshot in bounded pages. PostgREST can
 * apply a server-side row cap below the requested range. Exact counts plus a
 * final cardinality check make that condition an explicit failure instead of
 * a partial privacy export that looks complete to the caller.
 */
export async function fetchCompleteExportRows<T>(
  label: string,
  loadPage: (from: number, to: number) => PromiseLike<ExportPage<T>>,
  options: { pageSize?: number; maxRows?: number } = {}
): Promise<T[]> {
  const requestedPageSize = Number.isSafeInteger(options.pageSize)
    ? (options.pageSize as number)
    : ACCOUNT_EXPORT_PAGE_SIZE;
  const requestedMaxRows = Number.isSafeInteger(options.maxRows)
    ? (options.maxRows as number)
    : ACCOUNT_EXPORT_MAX_ROWS;
  const pageSize = Math.max(
    1,
    Math.min(1000, requestedPageSize)
  );
  const maxRows = Math.max(pageSize, requestedMaxRows);
  const rows: T[] = [];
  let expectedCount: number | null = null;

  for (let from = 0; ; from += pageSize) {
    const to = Math.min(from + pageSize - 1, maxRows - 1);
    const page = await loadPage(from, to);
    if (page.error) {
      throw new Error(`${label} fetch failed: ${page.error.message}`);
    }
    if (
      !Number.isSafeInteger(page.count) ||
      (page.count as number) < 0
    ) {
      throw new Error(`${label} did not return a safe exact row count`);
    }
    if (expectedCount === null) {
      expectedCount = page.count as number;
      if (expectedCount > maxRows) {
        throw new AccountExportTooLargeError(label, expectedCount, maxRows);
      }
    } else if (page.count !== expectedCount) {
      throw new Error(`${label} changed while it was being exported`);
    }
    if (!Array.isArray(page.data)) {
      throw new Error(`${label} returned no page data`);
    }
    if (page.data.length > pageSize) {
      throw new Error(`${label} returned a page larger than requested`);
    }

    rows.push(...page.data);
    if (rows.length > expectedCount) {
      throw new Error(`${label} returned more rows than its exact count`);
    }
    if (rows.length === expectedCount) return rows;
    if (page.data.length === 0 || from + pageSize >= maxRows) {
      throw new Error(`${label} could not be read completely`);
    }
  }
}
