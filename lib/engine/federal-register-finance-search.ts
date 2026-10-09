import type { BraveResult, BraveSearchOptions } from "@/lib/brave";
import { cleanField } from "./text-clean";
import { createPublicSourceCache } from "./public-source-cache";
import { publicSourceWindow } from "./public-source-freshness";
import { readPublicSourceText } from "./public-source-response";
import { durablePublicSourceBudgetEnabled, reservePublicSourceRequest } from "./public-source-budget";
import { durablePublicSourceCircuitEnabled, runPublicSourceAttempt, type PublicSourceAttempt } from "./public-source-circuit";
import { noModelModeEnabled } from "./provider-policy";

const PROVIDER = "federal-register-finance";
const MAX_RECORDS = 100;
// The publisher's search export documents this endpoint. Only fixed public
// filters and six metadata fields leave the app. No reader query or contact.
const params = new URLSearchParams();
for (const [key, value] of [
  ["conditions[sections][]", "money"], ["conditions[type][]", "RULE"],
  ["conditions[type][]", "PRORULE"], ["order", "newest"], ["per_page", String(MAX_RECORDS)],
  ...["title", "type", "document_number", "html_url", "publication_date", "agencies"].map(value => ["fields[]", value]),
]) params.append(key!, value!);
export const FEDERAL_REGISTER_FINANCE_ENDPOINT = `https://www.federalregister.gov/api/v1/documents.json?${params}`;

type Document = { title: string; url: string; date: string; number: string; proposal: boolean; agency: string };
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const AGENCIES: Readonly<Record<string, string>> = {
  "internal-revenue-service": "Internal Revenue Service",
  "securities-and-exchange-commission": "Securities and Exchange Commission",
};

export function federalRegisterFinanceFallbackEnabled(): boolean {
  return noModelModeEnabled() &&
    /^(1|true|yes)$/i.test(process.env.ALPHA_FEDERAL_REGISTER_FINANCE_FALLBACK?.trim() ?? "") &&
    durablePublicSourceBudgetEnabled() && durablePublicSourceCircuitEnabled();
}

function calendarAnchor(value: unknown): number {
  // This is the journal's official publication DAY, not a timezone-less clock
  // or an effective date. Midnight is only a conservative comparison anchor,
  // following Crossref's existing calendar-publication-date convention.
  if (typeof value !== "string" || !/^(?:19|20)\d{2}-\d{2}-\d{2}$/.test(value)) return NaN;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : NaN;
}

function relevantTitle(title: string): boolean {
  if (/\b(?:information collection|paperwork|comment request|agency collection|sanctions?|self-regulatory|privacy act|sunshine act|hearing|withdrawal|withdrawn|correction|retraction|bank holding|stress test|capital requirements?|filer manual)\b/i.test(title)) return false;
  return /\b(?:retirement|pensions?|individual retirement|IRA|401\(?k\)?|individual income tax|child tax credits?|earned income tax credits?|premium tax credits?|education tax credits?|saver.?s credits?|savings|mortgages?|consumer credit|credit cards?|credit reporting|student loans?|investment advisers?|investment advisors?|mutual funds?|exchange.traded funds?|fund custody|adviser.*custody)\b/i.test(title);
}

function agencyCredit(value: unknown): string | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return null;
  const names = new Set<string>();
  for (const row of value) {
    if (!object(row) || typeof row.slug !== "string" || !Object.hasOwn(AGENCIES, row.slug) ||
        row.name !== AGENCIES[row.slug]) return null;
    names.add(AGENCIES[row.slug]!);
  }
  return [...names].join(", ");
}

function canonicalUrl(value: unknown, date: string, number: string): string | null {
  if (typeof value !== "string" || value.length > 500) return null;
  const prefix = `https://www.federalregister.gov/documents/${date.replaceAll("-", "/")}/${number}/`;
  if (!value.startsWith(prefix) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.slice(prefix.length))) return null;
  try {
    const url = new URL(value);
    return url.href === value && !url.username && !url.password && !url.port && !url.search && !url.hash ? value : null;
  } catch { return null; }
}

/** Metadata only. Unknown fields, abstracts, excerpts and body URLs are dropped. */
export function parseFederalRegisterFinanceMetadata(value: unknown): Document[] {
  if (!object(value) || !Number.isSafeInteger(value.count) || (value.count as number) < 0 ||
      !Array.isArray(value.results) || value.results.length > MAX_RECORDS ||
      value.results.length > (value.count as number)) throw new Error("Federal Register metadata invalid response");
  const documents: Document[] = [];
  const seen = new Set<string>();
  for (const row of value.results) {
    if (!object(row) || typeof row.title !== "string" || !row.title || row.title.length > 1000 ||
        /[\x00-\x1f\x7f]/.test(row.title) || (row.type !== "Rule" && row.type !== "Proposed Rule") ||
        typeof row.document_number !== "string" || !/^(?:19|20)\d{2}-\d{5}$/.test(row.document_number) ||
        Number(row.document_number.slice(5)) === 0 ||
        !Number.isFinite(calendarAnchor(row.publication_date))) continue;
    const title = cleanField(row.title).replace(/\s+/g, " ").trim();
    if (!title || title.length > 300 || !relevantTitle(title)) continue;
    const date = row.publication_date as string;
    // The publisher can assign a December document number to a January issue.
    // Validate that identity against the canonical URL, not the publication year.
    const url = canonicalUrl(row.html_url, date, row.document_number);
    const agency = agencyCredit(row.agencies);
    if (!url || !agency || seen.has(url)) continue;
    seen.add(url);
    documents.push({ title, url, date, number: row.document_number, proposal: row.type === "Proposed Rule", agency });
  }
  return documents;
}

export function createFederalRegisterFinanceSearch(deps: {
  fetcher?: typeof fetch;
  now?: () => number;
  reserve?: typeof reservePublicSourceRequest;
  attempt?: PublicSourceAttempt;
} = {}) {
  const fetcher = deps.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? Date.now;
  const reserve = deps.reserve ?? reservePublicSourceRequest;
  const attempt = deps.attempt ?? runPublicSourceAttempt;
  const cached = createPublicSourceCache<Document>(now);
  return async (topicId: string, opts: BraveSearchOptions = {}): Promise<BraveResult[]> => {
    if (topicId !== "personal-finance" || !federalRegisterFinanceFallbackEnabled() ||
        !publicSourceWindow(opts.freshness, now())) return [];
    const documents = await cached(PROVIDER, "fixed-money-rules-v1", () => attempt(PROVIDER,
      () => reserve(PROVIDER), async () => {
        const signal = AbortSignal.timeout(5000);
        const response = await fetcher(FEDERAL_REGISTER_FINANCE_ENDPOINT, {
          signal, redirect: "error", credentials: "omit", cache: "no-store", headers: { Accept: "application/json" },
        });
        if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
          void response.body?.cancel().catch(() => {});
          throw new Error("Federal Register metadata unavailable or invalid content type");
        }
        return parseFederalRegisterFinanceMetadata(JSON.parse(await readPublicSourceText(response, signal)));
      }));
    const window = publicSourceWindow(opts.freshness, now());
    if (!window) return [];
    return documents.filter(document => {
      const date = calendarAnchor(document.date);
      return date >= window.start && date <= window.end;
    }).map(document => ({
      title: `Federal Register ${document.proposal ? "proposed rule" : "rule publication"}: ${document.title}`,
      url: document.url,
      description: `${document.proposal ? "Proposed-rule document. This is a proposal." : "Rule publication. Publication does not establish its effective date."} Published ${document.date}. Issuing agency: ${document.agency}. Federal Register document ${document.number}.`,
      // Preserve calendar precision. No publication clock or legal effect inferred.
      age: document.date,
    }));
  };
}

export const federalRegisterFinanceSearch = createFederalRegisterFinanceSearch();
