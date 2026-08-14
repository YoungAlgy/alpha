import { Resend } from "resend";
import type { CreateEmailResponse } from "resend";
import type { Issue } from "@/lib/types";
import { unsubscribeUrl as buildUnsubscribeUrl } from "@/lib/unsubscribe";
import { codePointSafeTruncate } from "@/lib/text-truncate";

// Single provider: Resend, sending from the verified everyday.report domain.
// (We previously carried an AWS SES branch as a dual-provider cutover path,
// but AWS denied production access and we standardized on Resend — the SES
// code was dead and has been removed.)

function resendConfiguredInternal(): boolean {
  return !!process.env.RESEND_API_KEY?.trim();
}

// alpha-drift-r19-01 (found+fixed 2026-08-07): app/api/support/route.ts's
// replyTo build (round 18) interpolates a free-text, user-controlled display
// name straight into a compound RFC 5322 mailbox (`${name} <${email}>`) with
// zero sanitization -- name has no character restriction, unlike email,
// which is already regex-constrained. A name containing '<'/'>' (e.g. "X
// <attacker@evil.com>") produces a malformed compound address with two
// bracketed address groups: either the send fails outright, or however
// Resend/the receiving client resolves the ambiguity, hitting Reply could
// land on an address embedded in the crafted name instead of the real
// sender's. Strips the characters that let a display-name string escape its
// position in the mailbox: '<'/'>' (a second address), '"' (breaking a
// quoted-string), and any control character (CR/LF header injection being
// the classic case). Lives here (not in the route file) because a route.ts
// can only export the reserved HTTP-method names -- an extra named export
// either fails Next's route typing or is silently untestable the way every
// other route helper in this codebase already handles it (lib/webhook-user-
// mutation.ts, lib/gotrue-errors.ts, etc.).
//
// alpha-drift-r20-01 (found+fixed 2026-08-13, self-audit of the fix above):
// the original regex missed ',' -- the RFC 5322 ADDRESS-LIST delimiter. A
// bare email needs no angle brackets to be a valid standalone mailbox entry,
// so a name like "attacker@evil.com, Foo" produces the Reply-To value
// "attacker@evil.com, Foo <real@submitter.com>", which most mail-header
// parsers split into TWO real addresses: the attacker's bare one, plus the
// real submitter's Name+angle-addr. This reopened the exact "reply could
// land on an embedded address" risk the original fix's own commit message
// describes closing -- the '<email>' vector was closed, the comma-delimited
// multi-address vector was not.
export function sanitizeDisplayName(name: string): string {
  return name.replace(/[\r\n<>",]/g, "").trim();
}

let _resend: Resend | null = null;
function resendClient(): Resend {
  if (_resend) return _resend;
  // Every current caller checks resendConfigured() first and bails before
  // reaching this line -- that's an unenforced convention, not something
  // this function itself guaranteed. A future caller that skips the
  // external guard used to get a raw, confusing TypeError from the `!`
  // assertion; this throws the same clean error resendConfigured() implies.
  if (!resendConfiguredInternal()) {
    throw new Error("Resend is not configured (RESEND_API_KEY missing).");
  }
  _resend = new Resend(process.env.RESEND_API_KEY!.trim());
  return _resend;
}

// Callers check `resendConfigured()` to decide whether to attempt a send.
export function resendConfigured(): boolean {
  return resendConfiguredInternal();
}

// alpha-drift-r17-06 (found+fixed 2026-08-07): Resend maintains its OWN
// account-level suppression list, separate from this app's bounced_at/
// complained_at columns -- populated automatically on a hard bounce or
// complaint, per Resend's docs (resend.com/docs/dashboard/emails/email-
// suppressions): entries are removed "manually only," never auto-expire,
// and re-adding happens automatically if the underlying cause isn't
// addressed. Clearing this app's own DB columns (see
// lib/webhook-user-mutation.ts's checkoutUserMutation) is necessary but NOT
// sufficient to restore delivery -- Resend would keep silently skipping the
// send regardless of what this app's own tables say. The `resend` SDK
// version installed here doesn't wrap this endpoint (confirmed against its
// own .d.ts -- no `suppressions` client property), so this calls Resend's
// REST API directly: DELETE https://api.resend.com/suppressions/{email}
// (resend.com/docs/api-reference/suppressions/remove-suppression).
// Best-effort by design, matching every other Resend call in this file: a
// removal failure must never block or fail the caller's own DB write (a
// real subscriber's re-consent is recorded either way; this is cleanup on
// top of that, not the source of truth). A 404 (the address was never
// actually suppressed -- e.g. bounced_at was set by something other than a
// REAL Resend-side suppression, or it's already been manually removed) is
// treated as success, not failure, same "already in the end state we
// wanted" reasoning as lib/gotrue-errors.ts's isUserNotFoundError.
export async function removeResendSuppression(email: string): Promise<boolean> {
  if (!resendConfiguredInternal()) return false;
  try {
    const res = await fetch(`https://api.resend.com/suppressions/${encodeURIComponent(email)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY!.trim()}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok && res.status !== 404) {
      console.warn(`[email] removeResendSuppression failed for an address: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[email] removeResendSuppression threw:", e instanceof Error ? e.message : e);
    return false;
  }
}

// Retry-with-backoff around a single emails.send() call. Added 2026-08-05
// (resilience audit finding): a single transient Resend error used to
// propagate straight up to the cron's caller, which for the letter path
// means throwing away 45 seconds of work and escalating to the full
// three-layer backup chain (real Anthropic/Gemini/Groq/DeepSeek/Brave spend)
// for what might have been one rate-limited request that would have
// succeeded a second later. Cheap to fix at the source instead.
//
// Only retries error classes Resend's own docs describe as transient
// (RESEND_ERROR_CODE_KEY in the SDK's types) or a network-level throw
// (fetch/timeout failure before any Resend response came back at all) —
// never a validation/auth/quota error, where retrying identically can only
// waste the remaining time budget for a guaranteed-identical failure.
// Idempotency keys make retrying the SAME payload safe by design: Resend
// collapses a retried send against the same key server-side rather than
// double-sending (see idempotencyKey's own comment on SendLetterParams).
const RETRYABLE_RESEND_ERRORS = new Set<string>([
  "rate_limit_exceeded",
  "internal_server_error",
  "application_error",
  "concurrent_idempotent_requests",
]);
const RESEND_RETRY_BACKOFF_MS = [500, 1500]; // 2 retries -> 3 attempts total

// alpha-drift-r15-06 (found+fixed 2026-08-06): Resend was the ONE provider
// integration in this codebase with no bounded timeout at any call site --
// Anthropic (60s), Stripe (20s), Brave/You.com (5s), Jina (7s), Gemini/Groq/
// DeepSeek (20s each), and even this same file's own ops-alert webhook
// fallback (8s, below) all set one; a bare `new Resend(key)` + `fetch()`
// with no `signal` does not (confirmed against the SDK's own source:
// fetchRequest() only ever bounds the request if the caller supplies one).
// A hung TCP/TLS handshake to api.resend.com would otherwise stall
// retryResendCall's caller indefinitely -- the onboarding response
// (app/api/generate/route.ts awaits sendLetterNotification with no deadline
// of its own), the Stripe webhook's own ACK (awaits sendWelcomeEmail
// synchronously), an anonymous support-form submission, and -- worst of
// all -- sendOpsAlertViaResend itself, whose two-channel design exists
// specifically so a downed Resend can't also take out the alert ABOUT it;
// a hang rather than a fast error never gives the webhook fallback a
// timely chance to run. 15s: generous for what should be a fast REST call
// (not LLM inference), while still bounded well inside every outer route
// deadline (GENERATE_DEADLINE_MS, PER_USER_DEADLINE_MS) even after
// retryResendCall's own 2 retries.
const RESEND_TIMEOUT_MS = 15_000;

// Every emails.send() call site in this file goes through this so the
// timeout can't be forgotten at a new call site the way it was here before.
function resendSendOptions(idempotencyKey?: string): { signal: AbortSignal; idempotencyKey?: string } {
  return {
    signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

// Takes the actual API call as an injected function (not payload/options
// directly) so tests can exercise the real retry/backoff decision logic
// against a fake that returns engineered responses, without needing the
// real Resend SDK to be pointed at anything -- same dependency-injection
// shape as lib/letter-delivery.ts's deliverLetterOnce(store, send, ...).
export async function retryResendCall(
  sendFn: () => Promise<CreateEmailResponse>
): Promise<CreateEmailResponse> {
  const maxAttempts = RESEND_RETRY_BACKOFF_MS.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const isLastAttempt = attempt === maxAttempts;
    try {
      const result = await sendFn();
      const errorName = result.error?.name;
      if (!result.error || isLastAttempt || !RETRYABLE_RESEND_ERRORS.has(errorName ?? "")) {
        return result;
      }
      console.warn(
        `[email] Resend send failed with retryable error "${errorName}" (attempt ${attempt}/${maxAttempts}), retrying: ${result.error!.message}`
      );
    } catch (e) {
      // A throw here means the request never got a Resend response at all
      // (network failure, timeout) -- also transient, also worth retrying.
      if (isLastAttempt) throw e;
      console.warn(
        `[email] Resend send threw (attempt ${attempt}/${maxAttempts}), retrying: ${e instanceof Error ? e.message : e}`
      );
    }
    const delayMs = RESEND_RETRY_BACKOFF_MS[attempt - 1] + Math.random() * 200;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  // Unreachable: the loop always returns or throws on isLastAttempt above.
  throw new Error("retryResendCall: exhausted retries without resolving");
}

// The alpha. wordmark (lowercase serif + gold dot) and the footer line are shared
// by the letter + welcome emails, so define them once instead of copy-pasting.
// BRAND_GOLD #C9A961 matches the web --brand-gold (globals.css :root, fixed
// across every theme — never --accent, which each theme recolors).
const BRAND_GOLD = "#C9A961";
// alpha-drift-r15-12 (found+fixed 2026-08-06): round 14's Gmail dark-mode
// fix added .alpha-ink/.alpha-gold classes + a @media(prefers-color-scheme:
// dark) block that reasserts them with !important -- but only the elements
// that carry one of those classes are reachable by it. Gmail's auto-invert
// targets an element's OWN inline `style="color:..."`, regardless of what
// class a PARENT has (confirmed by every other colored element in this file
// already carrying its own class despite also nesting under <body
// class="alpha-ink">, e.g. the mid-body signature wordmark at line ~535's
// `class="alpha-gold"` span). These two were the only exceptions: the
// wordmark shown at the very top of both emails and the one embedded in the
// footer of both had bare inline styles with no class, so Gmail's dark mode
// could still invert them even after the round-14 fix.
const WORDMARK_MASTHEAD = `<div class="alpha-ink" style="font-family:Georgia,serif;font-size:30px;font-weight:700;letter-spacing:-0.01em;color:#1F3D2E;text-align:center;margin:0 0 10px;">alpha<span class="alpha-gold" style="color:${BRAND_GOLD};">.</span></div>`;
// CAN-SPAM (15 U.S.C. 7704, 16 CFR 316.4) requires a valid physical postal
// address on every commercial email -- alpha is a paid recurring
// subscription, not a purely transactional receipt.
const MAILING_ADDRESS = "3608 S Belcher Dr, Tampa, FL 33629";
const wordmarkFooter = (prefix = "") =>
  `${prefix}alpha<span class="alpha-gold" style="color:${BRAND_GOLD};">.</span> · A PERSONAL LETTER · ${new Date().getFullYear()}<br>${MAILING_ADDRESS}`;
// replyTo for every subscriber-facing send -- everyday.report has no MX
// record (verified live, 2026-08-06), so a reply straight to the From
// address bounces. Both the letter and welcome email are first-person and
// signed "Algy", actively inviting a reply. Same address already used as
// this file's own ops-alert fallback below.
const REPLY_TO_EMAIL = "youngalgy@gmail.com";

export interface SendLetterParams {
  to: string;
  firstName: string;
  issue: Issue;
  inboxUrl: string;
  /** Tokenized /letter URL (view-in-browser). When present the CTA points
   *  here so the letter opens with NO session — fixes the "No letter yet"
   *  dead end subscribers hit clicking the email on a signed-out device. */
  letterUrl?: string | null;
  /** This subscriber's Nth letter (1-based). Drives "Issue N" in the subject
   *  so it reads like a recognizable recurring newsletter (a reader nearly
   *  skimmed past it when the subject led with a news headline). Omit → the
   *  subject falls back to the week date instead of an issue number. */
  issueNumber?: number;
  /** User id used to mint the signed one-click unsubscribe token. If omitted
   *  the email still sends but won't include unsubscribe links/headers — only
   *  use this for legacy callers that don't have a user id available. */
  userId?: string | null;
  /** Folded into the idempotency key below so a same-(userId,weekOf) retry
   *  with genuinely DIFFERENT content (e.g. the cron's live send failing on
   *  our side after Resend already accepted it, then a backup layer sending
   *  different content for the same day) can never get silently deduped by
   *  Resend against the earlier attempt. Omit for same-content retries where
   *  dedup IS the desired behavior (the default, "live", covers that case). */
  idempotencyKind?: string;
}

// V0 email: a short editorial notification with the editor's note as a teaser
// and a link to the full letter on web. V1 will render the entire letter as
// styled HTML (via React Email or similar).
export async function sendLetterNotification(params: SendLetterParams): Promise<{ id: string }> {
  if (!resendConfiguredInternal()) throw new Error("No email provider configured");

  // Subject reads like a newsletter the reader recognizes as theirs —
  // "{first}'s newsletter · Issue N" — NOT a news headline (a reader
  // nearly skimmed past the headline-led version). The content hook moves to
  // the preheader (inbox preview text), so we keep the click pull too.
  const subject = subjectLine(params.firstName, params.issueNumber, params.issue.weekOf);
  const preheader = previewFromIssue(params.issue);
  // alpha-drift-r19-01 (found+fixed 2026-08-07): both renderers used to
  // append an ellipsis to this unconditionally, even when slice() never
  // actually cut anything off -- most visibly on assemble.ts's own generic
  // fallback sentence (fires when every generation tier fails), which is
  // well under 320 chars and already ends in a period, so the reader got a
  // stray "...let the rest wait.…" in both the HTML card and the plain-text
  // body. Same truncation-flag guard MAX_HEADLINE_LEN uses just below.
  //
  // alpha-drift-r20-08 (found+fixed 2026-08-13): the r19-01 fix above swapped
  // in codePointSafeSlice everywhere ELSE in this codebase, but this specific
  // truncated-flag check was missed -- str.length > 320 still counts UTF-16
  // code UNITS, so editorIntro text containing astral-plane characters
  // (surrogate pairs, most modern emoji) could read as "truncated" here even
  // when its actual code-point count is <= 320, reintroducing the exact
  // spurious-ellipsis bug this comment describes, just one layer deeper.
  // codePointSafeTruncate derives both the flag and the cut text from the
  // same Array.from() pass, so they can't disagree.
  const { text: editorIntroCut, truncated: editorIntroTruncated } = codePointSafeTruncate(params.issue.editorIntro, 320);
  const teaser = editorIntroCut.trim() + (editorIntroTruncated ? "…" : "");
  // Topic label + the lead item's actual headline. The old label-only list
  // made every email look IDENTICAL day to day (a reader's topics never
  // change, so "IN THIS ISSUE • Personal finance • Real estate ..." read the
  // same in every letter — a subscriber thought she was getting the same
  // letter repeatedly). The headline is what proves each day is new.
  // Length-capped, mirroring teaser's own 320-char truncation above --
  // alpha-drift-r14-06 (review 2026-08-06): the HTML template renders this
  // whole list into a <pre> block (see renderHTML's own overflow-wrap
  // comment for the CSS-side defense); an unusually long or few-whitespace
  // headline (a long hyphen/em-dash-joined phrase, a URL-like string, CJK
  // text) could otherwise overflow the card's fixed-width column on mobile
  // with no CSS-only fallback fully bulletproof across every mail client.
  // 100 chars is generous for a single headline (well over what any real
  // catalog headline has run) while still bounding the worst case.
  const MAX_HEADLINE_LEN = 100;
  const sectionList = params.issue.sections
    .map((s) => {
      const rawLead = s.items?.[0]?.headline?.trim();
      // alpha-drift-r20-08: same UTF-16-vs-code-point truncation-flag bug as
      // the teaser above, in the sibling guard this comment's own
      // r19-01 note (nearby) referenced but never actually fixed.
      const leadCut = rawLead ? codePointSafeTruncate(rawLead, MAX_HEADLINE_LEN - 1) : null;
      const lead = leadCut?.truncated ? `${leadCut.text.trim()}…` : rawLead;
      return lead ? `• ${s.topicLabel} — ${lead}` : `• ${s.topicLabel}`;
    })
    .join("\n");

  // Build the unsubscribe URL once and reuse it everywhere (HTML link, plain
  // text link, and the RFC 8058 List-Unsubscribe header that Gmail / Apple
  // Mail use to render their inbox-side unsubscribe button).
  const origin = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://alpha.everyday.report";
  const unsubUrl = params.userId ? buildUnsubscribeUrl(params.userId, origin) : null;

  const html = renderHTML({
    firstName: params.firstName,
    teaser,
    sectionList,
    preheader,
    inboxUrl: params.inboxUrl,
    letterUrl: params.letterUrl ?? null,
    weekOf: params.issue.weekOf,
    unsubscribeUrl: unsubUrl,
  });

  const text = renderText({
    firstName: params.firstName,
    teaser,
    sectionList,
    preheader,
    inboxUrl: params.inboxUrl,
    letterUrl: params.letterUrl ?? null,
    weekOf: params.issue.weekOf,
    unsubscribeUrl: unsubUrl,
  });

  // List-Unsubscribe + List-Unsubscribe-Post (RFC 2369 + 8058) tell Gmail /
  // Apple Mail / Outlook to surface a one-click unsubscribe button. The Post
  // variant tells them they can use POST without navigating away from the inbox.
  const resendFrom = process.env.RESEND_FROM?.trim() || "\"alpha.\" <alpha@everyday.report>";
  // alpha-drift-r21-01: issue.id is built elsewhere (lib/engine/assemble.ts,
  // app/api/cron/weekly-send/route.ts) from raw firstName.toLowerCase() --
  // sanitizeDisplayName applied here at the actual header sink, rather than
  // chasing every place issue.id gets constructed. Safe even though it also
  // strips characters an id wouldn't legitimately contain anyway.
  const safeIssueId = sanitizeDisplayName(params.issue.id);
  const resendHeaders: Record<string, string> = {
    // Unique per (subscriber, issue): issue.id alone is firstName+weekOf, which
    // collides across same-named subscribers. Prefix with the user id when we
    // have it so delivery tracing by this header is unambiguous.
    "X-Alpha-Issue-Id": params.userId ? `${params.userId}:${safeIssueId}` : safeIssueId,
  };
  if (unsubUrl) {
    resendHeaders["List-Unsubscribe"] = `<${unsubUrl}>`;
    resendHeaders["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  // Idempotency key: stable per (subscriber, send date, kind). If a send for
  // the same (user, week_of, kind) is retried — a Vercel cron retry racing the
  // scheduled run, the rollback path re-opening the delivered_at claim, an
  // admin re-trigger — Resend collapses it provider-side and the subscriber
  // gets ONE letter, not two. `kind` is included (not just user+date) so a
  // DIFFERENT-content retry — the cron's live send failing on our side after
  // Resend already accepted it, then a backup layer sending different content
  // for the same day — gets its own key instead of being silently deduped
  // against the earlier, different attempt (2026-07-29 review finding: the
  // three-layer backup system's core guarantee only holds if this can't
  // happen). Only set when userId is known (the normal cron + generate paths
  // both pass it); legacy callers without a userId behave exactly as before.
  const idempotencyKey = params.userId
    ? `alpha-letter-${params.userId}-${params.issue.weekOf}-${params.idempotencyKind ?? "live"}`
    : undefined;
  const result = await retryResendCall(() =>
    resendClient().emails.send(
      {
        from: resendFrom,
        to: params.to,
        replyTo: REPLY_TO_EMAIL,
        subject,
        html,
        text,
        headers: resendHeaders,
      },
      resendSendOptions(idempotencyKey)
    )
  );
  if (result.error) {
    throw new Error(`Resend: ${result.error.message}`);
  }
  return { id: result.data?.id ?? "" };
}

// ─── Ops alert ────────────────────────────────────────────────────────────
// Best-effort INTERNAL notification (never sent to a subscriber). The cron
// calls this when a paid subscriber gets NOTHING this send (blanked profile /
// empty topic pool) or a send hard-fails — the exact silent drop that
// otherwise only surfaces when the owner happens to notice a missing letter
// days later. Never throws: a broken alert must never break the send path.
//
// Two independent channels, tried in order: Resend (email), then a webhook
// if Resend fails or isn't configured. Without the second channel, a full
// Resend outage would silently take out the ONE mechanism meant to surface
// that exact kind of outage — subscriber sends and the alert about them
// failing together, with nothing left to notice either. OPS_ALERT_WEBHOOK_URL
// is optional; leave it unset and this is identical to the old Resend-only
// behavior.
//
// idempotencyKey is optional and caller-supplied (unlike sendLetterNotification,
// there's no single natural key shared by every call site here) -- pass one
// whenever the alert is tied to an event Stripe/etc. can redeliver, e.g.
// `alpha-ops-alert-${invoiceId}` for invoice.payment_failed, so a genuine
// redelivery collapses provider-side instead of paging Algy twice.
export async function sendOpsAlert(
  subject: string,
  body: string,
  idempotencyKey?: string
): Promise<void> {
  const viaResend = await sendOpsAlertViaResend(subject, body, idempotencyKey);
  if (!viaResend) await sendOpsAlertViaWebhook(subject, body);
}

async function sendOpsAlertViaResend(
  subject: string,
  body: string,
  idempotencyKey?: string
): Promise<boolean> {
  try {
    if (!resendConfiguredInternal()) return false;
    const to = process.env.OPS_ALERT_EMAIL?.trim() || "youngalgy@gmail.com";
    const resendFrom = process.env.RESEND_FROM?.trim() || "\"alpha.\" <alpha@everyday.report>";
    // The SDK returns { data, error } on an API-level failure (bad/expired key,
    // etc.) — it does NOT throw, same as sendLetterNotification/sendWelcomeEmail
    // below. Missing this check was the actual bug the verify script caught:
    // an invalid key "succeeded" silently and the webhook fallback never fired.
    const result = await resendClient().emails.send(
      {
        from: resendFrom,
        to,
        subject,
        text: body,
      },
      resendSendOptions(idempotencyKey)
    );
    if (result.error) {
      console.warn("[ops-alert] Resend failed:", result.error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[ops-alert] Resend failed:", e instanceof Error ? e.message : e);
    return false;
  }
}

// Discord and Slack incoming webhooks both accept a plain JSON POST; sending
// both `content` (Discord's field) and `text` (Slack's field) is harmless
// either way — each platform ignores the field it doesn't recognize, so this
// works with whichever free webhook Algy sets up without the code needing to
// know which. No SDK, no signup beyond creating the webhook URL (Discord:
// Server Settings > Integrations > Webhooks; Slack: api.slack.com/apps >
// Incoming Webhooks). Same never-throws contract as the Resend path.
async function sendOpsAlertViaWebhook(subject: string, body: string): Promise<boolean> {
  try {
    const url = process.env.OPS_ALERT_WEBHOOK_URL?.trim();
    if (!url) return false;
    const message = `**[alpha ops alert]** ${subject}\n\n${body}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message, text: message }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn(`[ops-alert] webhook failed: ${res.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[ops-alert] webhook failed:", e instanceof Error ? e.message : e);
    return false;
  }
}

// The subject. Personal + unmistakably a newsletter + an issue number so it
// reads like a recurring publication the reader opted into. The brand is
// carried by the From name ("alpha."); the subject earns the open. Exported
// for testing.
//
// alpha-drift-r21-01 (found+fixed 2026-08-14): firstName is user-controlled
// (onboarding writes it via lib/user-sync.ts with only .trim(), and the daily
// cron reads the DB column back completely raw) and reaches Resend's `subject`
// field here with no character restriction -- unlike sanitizeDisplayName just
// above, built for exactly this class of risk (CR/LF header injection) but
// never applied to firstName. Sanitized here, at the actual sink, rather than
// chasing every write path.
export function subjectLine(firstName: string, issueNumber?: number, weekOf?: string): string {
  const safeFirstName = sanitizeDisplayName(firstName ?? "");
  const who = safeFirstName ? `${safeFirstName}'s` : "Your";
  if (typeof issueNumber === "number" && issueNumber > 0) {
    return `${who} newsletter · Issue ${issueNumber}`;
  }
  // No issue number available — anchor on the date instead of a wrong number.
  const wk = weekOf ? shortWeek(weekOf) : "";
  return wk ? `${who} newsletter · ${wk}` : `${who} newsletter`;
}

// Inbox preview text (preheader): the actual content hook — lead headline +
// how many topics — so the open is still earned even though the subject is
// the recognizable identity. This is what used to be the subject.
function previewFromIssue(issue: Issue): string {
  const lead = issue.sections[0]?.items?.[0]?.headline;
  const others = Math.max(0, issue.sections.length - 1);
  if (lead) {
    const trimmed = lead.length > 90 ? lead.slice(0, 87).trimEnd() + "…" : lead;
    if (others === 0) return trimmed;
    return `${trimmed}, plus ${others} more topic${others === 1 ? "" : "s"}.`;
  }
  const labels = issue.sections.slice(0, 4).map((s) => s.topicLabel.toLowerCase());
  return `Latest on ${labels.join(", ")}.`;
}

// "June 8" from an ISO or long-form week_of string.
function shortWeek(weekOf: string): string {
  if (weekOf.includes(",")) {
    const m = weekOf.match(/([A-Za-z]+\s+\d+)/);
    if (m) return m[1];
  }
  const d = new Date(weekOf.length === 10 ? `${weekOf}T12:00:00Z` : weekOf);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

interface RenderArgs {
  firstName: string;
  teaser: string;
  sectionList: string;
  preheader?: string;
  inboxUrl: string;
  letterUrl?: string | null;
  weekOf: string;
  unsubscribeUrl: string | null;
}

// Exported (pure, no I/O) so the email can be previewed/snapshot-tested
// without ever triggering a live send.
export function renderHTML({ firstName, teaser, sectionList, preheader, inboxUrl, letterUrl, weekOf, unsubscribeUrl }: RenderArgs): string {
  // CTA prefers the tokenized /letter URL — it opens the letter directly with
  // no session, on any device (the view-in-browser pattern). Falls back to
  // /inbox for legacy callers without a letter token.
  const ctaUrl = letterUrl || inboxUrl;
  const signinUrl = inboxUrl.replace("/inbox", "/signin");
  const unsubLine = unsubscribeUrl
    ? `<a href="${escapeAttr(unsubscribeUrl)}" class="alpha-ink-faint" style="color:#6B7B70;">Unsubscribe</a> · `
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <!-- The letter is a light cream/forest design. Tell mail clients NOT to
         auto-invert it in dark mode, which otherwise mangles the palette. -->
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>Your newsletter</title>
    <!--[if mso]>
    <noscript>
      <xml>
        <o:OfficeDocumentSettings>
          <o:PixelsPerInch>96</o:PixelsPerInch>
        </o:OfficeDocumentSettings>
      </xml>
    </noscript>
    <![endif]-->
    <style>
      /* Tighter gutters on phones (supported in Apple Mail, Gmail app, etc.;
         degrades gracefully where <style> is stripped). */
      @media only screen and (max-width:600px) {
        .alpha-wrap-td { padding: 32px 20px !important; }
        .alpha-wrap-table { width: 100% !important; }
      }
      /* Gmail (web + app) is a documented holdout that ignores the
         color-scheme meta tags above and applies its own auto-invert
         heuristic regardless -- Apple Mail/new Outlook/Samsung Mail already
         get the correct behavior from those meta tags alone. Re-asserting
         the SAME light palette here, explicitly, under
         prefers-color-scheme:dark is the standard technique to make
         Gmail's dark-mode engine defer to author-declared CSS instead of
         guessing (and mangling the palette in the process). !important is
         required to win against Gmail's own injected override, not just
         the inline styles below (which already match -- this isn't fixing
         a normal CSS cascade conflict, it's fighting a client's own
         dark-mode rewrite). */
      @media (prefers-color-scheme: dark) {
        body, .alpha-bg { background: #F4EFE0 !important; }
        .alpha-ink { color: #1F3D2E !important; }
        .alpha-ink-soft { color: #4A5F50 !important; }
        .alpha-ink-faint { color: #6B7B70 !important; }
        .alpha-gold { color: #C9A961 !important; }
        .alpha-gold-link { color: #A88947 !important; }
      }
    </style>
  </head>
  <body class="alpha-bg alpha-ink" style="margin:0;padding:0;background:#F4EFE0;font-family:Georgia,serif;color:#1F3D2E;">
    <!-- Preheader: the inbox preview text. Hidden in the body, but it's the
         first text mail clients pull for the snippet next to the subject. The
         trailing whitespace stops the client from spilling later body text
         into the preview. -->
    <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#F4EFE0;opacity:0;">
      ${escapeHtml(preheader || "")}${"&nbsp;&zwnj;".repeat(60)}
    </div>
    <!-- Table-based outer wrap, not a bare div: Outlook desktop (2016/2019/
         365 "classic", which still renders via the Word HTML engine, not
         WebView2) does not support max-width or margin:0 auto centering on
         a div at all -- without a table with an explicit HTML width
         attribute (which Outlook's Word engine DOES honor), the letter
         stretched to the full reading-pane width there instead of staying
         a centered 560px column. -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="alpha-bg" style="width:100%;background:#F4EFE0;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" class="alpha-wrap-table" style="width:560px;max-width:560px;">
            <tr>
              <td class="alpha-wrap-td" style="padding:48px 32px;">
                ${WORDMARK_MASTHEAD}
                <div class="alpha-ink-soft" style="font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:0.15em;color:#4A5F50;text-align:center;margin-bottom:32px;">
                  ${escapeHtml(weekOf.toUpperCase())}
                </div>
                <!-- alpha-drift-r19-01 (found+fixed 2026-08-07): same
                     overflow-wrap/word-break gap as the sectionList <pre>
                     block below, for the same reason -- firstName is raw,
                     unmoderated user input (up to 60 chars, LIMITS.first_name
                     in app/api/account/profile/route.ts) and cleanRequired()
                     only collapses whitespace runs, never requires any at
                     all, so a single unbroken 60-char token (no spaces, RTL,
                     CJK, anything pasted without spaces) is valid saved
                     input that runs on EVERY daily send. -->
                <h1 class="alpha-ink" style="font-size:32px;font-weight:700;letter-spacing:-0.01em;margin:0 0 24px;overflow-wrap:anywhere;word-break:break-word;">
                  Hi ${escapeHtml(firstName)},
                </h1>
                <p class="alpha-ink" style="font-size:18px;line-height:1.6;margin:0 0 32px;">
                  ${escapeHtml(teaser)}
                </p>
                <p class="alpha-ink-soft" style="font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:0.15em;color:#4A5F50;margin:0 0 8px;">
                  IN THIS ISSUE
                </p>
                <!-- overflow-wrap/word-break: defense in depth alongside the
                     sender-side MAX_HEADLINE_LEN cap (sendLetterNotification)
                     -- an unusually long or few-whitespace headline (a long
                     hyphen/em-dash-joined phrase, a URL-like string, CJK
                     text) could otherwise overflow this fixed-width column
                     with plain pre-wrap alone, which only breaks at
                     whitespace. -->
                <pre class="alpha-ink" style="font-family:Georgia,serif;font-size:16px;line-height:1.7;margin:0 0 36px;color:#1F3D2E;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;">${escapeHtml(sectionList)}</pre>
                <div style="margin:40px 0;">
                  <a href="${escapeAttr(ctaUrl)}" style="display:inline-block;background:#1F3D2E;color:#F4EFE0;text-decoration:none;padding:14px 24px;border-radius:6px;font-family:Inter,Arial,sans-serif;font-weight:600;font-size:14px;">
                    Read the full letter &rarr;
                  </a>
                </div>
                <p class="alpha-ink-soft" style="font-size:12px;line-height:1.5;color:#4A5F50;margin:24px 0 0;">
                  Want to change topics or read past letters? <a href="${escapeAttr(signinUrl)}" class="alpha-gold-link" style="color:#A88947;">Sign in here</a>. We'll email you a 6-digit code.
                </p>
                <p class="alpha-ink-soft" style="font-size:14px;line-height:1.6;color:#4A5F50;margin:48px 0 0;">
                  alpha<span class="alpha-gold" style="color:${BRAND_GOLD};">.</span>
                </p>
                <hr style="border:none;border-top:1px solid #C8D0BC;margin:32px 0 16px;">
                <p class="alpha-ink-faint" style="font-family:ui-monospace,Menlo,monospace;font-size:10px;letter-spacing:0.12em;color:#6B7B70;text-align:center;">
                  ${wordmarkFooter(unsubLine)}
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function renderText({ firstName, teaser, sectionList, inboxUrl, letterUrl, weekOf, unsubscribeUrl }: RenderArgs): string {
  const unsubLine = unsubscribeUrl ? `\n\nUnsubscribe: ${unsubscribeUrl}` : "";
  return `${weekOf}

Hi ${firstName},

${teaser}

IN THIS ISSUE
${sectionList}

Read the full letter:
${letterUrl || inboxUrl}

(To change topics or read past letters, sign in at ${inboxUrl.replace("/inbox", "/signin")}. We'll email you a 6-digit code.)

alpha.
${MAILING_ADDRESS}${unsubLine}`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

// ─── Welcome email ────────────────────────────────────────────────────────
// Sent once, on first subscription, from the Stripe webhook. Confirms the
// payment worked, points to the first letter (already generated + waiting on
// web), and sets the daily cadence + passwordless sign-in expectation.

export interface SendWelcomeParams {
  to: string;
  firstName: string;
  inboxUrl: string;
  /** When present, adds RFC 8058 List-Unsubscribe headers (deliverability +
   *  inbox-side unsubscribe button) — same scheme as the letter email. */
  userId?: string | null;
}

export async function sendWelcomeEmail(params: SendWelcomeParams): Promise<{ id: string }> {
  if (!resendConfiguredInternal()) throw new Error("No email provider configured");
  const headers: Record<string, string> = {};
  let unsubUrl: string | null = null;
  if (params.userId) {
    const origin = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://alpha.everyday.report";
    unsubUrl = buildUnsubscribeUrl(params.userId, origin);
    headers["List-Unsubscribe"] = `<${unsubUrl}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  // Same reasoning applied to renderHTML/renderText for the recurring
  // letter: the invisible List-Unsubscribe header alone renders as an
  // inbox-side button in Gmail/Apple Mail/Outlook but not in plain-text-only
  // clients, some webmail, or a forwarded copy -- give the body a real link too.
  const html = renderWelcomeHTML({ ...params, unsubscribeUrl: unsubUrl });
  const text = renderWelcomeText({ ...params, unsubscribeUrl: unsubUrl });
  const resendFrom = process.env.RESEND_FROM?.trim() || "\"alpha.\" <alpha@everyday.report>";
  // Stable per user, not per call -- this is a one-time email, so unlike
  // sendLetterNotification's per-(user, week_of, kind) key there's no second
  // dimension to it. Only set when userId is known, same as the
  // List-Unsubscribe headers above; without it retryResendCall's
  // network-throw retry (the request reached Resend but the response never
  // came back) could otherwise send this twice.
  const idempotencyKey = params.userId ? `alpha-welcome-${params.userId}` : undefined;
  const result = await retryResendCall(() =>
    resendClient().emails.send(
      {
        from: resendFrom,
        to: params.to,
        replyTo: REPLY_TO_EMAIL,
        subject: "Welcome to alpha. Your first letter is on its way",
        html,
        text,
        headers,
      },
      resendSendOptions(idempotencyKey)
    )
  );
  if (result.error) {
    throw new Error(`Resend: ${result.error.message}`);
  }
  return { id: result.data?.id ?? "" };
}

// Exported (pure, no I/O) so the welcome email can be previewed/snapshot-tested
// without a live send — same pattern as renderHTML.
export function renderWelcomeHTML({
  firstName,
  inboxUrl,
  unsubscribeUrl,
}: {
  firstName: string;
  inboxUrl: string;
  unsubscribeUrl?: string | null;
}): string {
  const signinUrl = inboxUrl.replace("/inbox", "/signin");
  const unsubLine = unsubscribeUrl
    ? `<a href="${escapeAttr(unsubscribeUrl)}" class="alpha-ink-faint" style="color:#6B7B70;">Unsubscribe</a> · `
    : "";
  // Same table-based layout + dark-mode re-assertion as renderHTML above --
  // alpha-drift-r14-06 (review 2026-08-06): this was a straight sibling
  // copy of that template's structure, so it had the identical Outlook/
  // Gmail-dark-mode gaps. See renderHTML's own comments for why each piece
  // exists; not re-explained here to avoid duplicated commentary drifting
  // out of sync between the two.
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>Welcome to alpha.</title>
    <!--[if mso]>
    <noscript>
      <xml>
        <o:OfficeDocumentSettings>
          <o:PixelsPerInch>96</o:PixelsPerInch>
        </o:OfficeDocumentSettings>
      </xml>
    </noscript>
    <![endif]-->
    <style>
      @media only screen and (max-width:600px) {
        .alpha-wrap-td { padding: 32px 20px !important; }
        .alpha-wrap-table { width: 100% !important; }
      }
      @media (prefers-color-scheme: dark) {
        body, .alpha-bg { background: #F4EFE0 !important; }
        .alpha-ink { color: #1F3D2E !important; }
        .alpha-ink-soft { color: #4A5F50 !important; }
        .alpha-ink-faint { color: #6B7B70 !important; }
        .alpha-gold { color: #C9A961 !important; }
        .alpha-gold-link { color: #A88947 !important; }
      }
    </style>
  </head>
  <body class="alpha-bg alpha-ink" style="margin:0;padding:0;background:#F4EFE0;font-family:Georgia,serif;color:#1F3D2E;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="alpha-bg" style="width:100%;background:#F4EFE0;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" class="alpha-wrap-table" style="width:560px;max-width:560px;">
            <tr>
              <td class="alpha-wrap-td" style="padding:48px 32px;">
                ${WORDMARK_MASTHEAD}
                <div class="alpha-ink-soft" style="font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:0.15em;color:#4A5F50;text-align:center;margin-bottom:32px;">
                  WELCOME
                </div>
                <!-- alpha-drift-r19-01: same overflow-wrap/word-break gap
                     and fix as renderHTML's greeting h1 above -- see that
                     comment. -->
                <h1 class="alpha-ink" style="font-size:32px;font-weight:700;letter-spacing:-0.01em;margin:0 0 24px;overflow-wrap:anywhere;word-break:break-word;">
                  You're in, ${escapeHtml(firstName)}.
                </h1>
                <p class="alpha-ink" style="font-size:18px;line-height:1.6;margin:0 0 24px;">
                  Thanks for subscribing. Your first letter is being written for you right
                  now, built around the topics you picked. It takes about a minute.
                </p>
                <div style="margin:36px 0;">
                  <a href="${escapeAttr(inboxUrl)}" style="display:inline-block;background:#1F3D2E;color:#F4EFE0;text-decoration:none;padding:14px 24px;border-radius:6px;font-family:Inter,Arial,sans-serif;font-weight:600;font-size:14px;">
                    Read your first letter &rarr;
                  </a>
                </div>
                <p class="alpha-ink" style="font-size:16px;line-height:1.7;margin:0 0 12px;">
                  From here on, a new letter lands <strong>every day</strong>, in your
                  inbox and on the web. No feeds, no firehose. Just the things you care
                  about.
                </p>
                <p class="alpha-ink-soft" style="font-size:12px;line-height:1.5;color:#4A5F50;margin:24px 0 0;">
                  Signed out when you click through? We'll email you a 6-digit code.
                  <a href="${escapeAttr(signinUrl)}" class="alpha-gold-link" style="color:#A88947;">Sign in here</a>.
                  No password to remember.
                </p>
                <p class="alpha-ink-soft" style="font-size:14px;line-height:1.6;color:#4A5F50;margin:40px 0 0;">
                  Algy
                </p>
                <hr style="border:none;border-top:1px solid #C8D0BC;margin:32px 0 16px;">
                <p class="alpha-ink-faint" style="font-family:ui-monospace,Menlo,monospace;font-size:10px;letter-spacing:0.12em;color:#6B7B70;text-align:center;">
                  ${wordmarkFooter(unsubLine)}
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function renderWelcomeText({
  firstName,
  inboxUrl,
  unsubscribeUrl,
}: {
  firstName: string;
  inboxUrl: string;
  unsubscribeUrl?: string | null;
}): string {
  const unsubLine = unsubscribeUrl ? `\n\nUnsubscribe: ${unsubscribeUrl}` : "";
  return `Welcome to alpha.

You're in, ${firstName}.

Thanks for subscribing. Your first letter is being written for you right now, built around the topics you picked. It takes about a minute.

Read your first letter:
${inboxUrl}

From here on, a new letter lands every day, in your inbox and on the web. No feeds, no firehose. Just the things you care about.

(Signed out when you click through? We'll email you a 6-digit code at ${inboxUrl.replace("/inbox", "/signin")}. No password to remember.)

Algy

alpha.
${MAILING_ADDRESS}${unsubLine}`;
}
