// Offline route-level regression test for the invite access request endpoint.
// It transpiles the real route into a VM with value-free, in-memory Supabase
// doubles. No environment files, network clients, or database connections run.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";
import { BLURB_CAPS } from "../lib/types.ts";
import { parseBirthday } from "../lib/demographics.ts";
import { coerceThemeId } from "../lib/themes.ts";
import { hasReaderAccess } from "../lib/access.ts";
import {
  authOwnsAccessRequestEmail,
  normalizeAccessRequestEmail,
} from "../lib/access-request-ownership.ts";
import { clientKeyFromRequest, rateLimit } from "../lib/rate-limit.ts";
import { isValidTopicId, MAX_CUSTOM_TOPIC_LEN, CUSTOM_PREFIX } from "../lib/topics.ts";
import { hasUsableReaderProfile } from "../lib/reader-profile-state.ts";

type JsonResponse = { body: Record<string, unknown>; status: number; headers: Headers };
type UserRow = Record<string, unknown>;
type LimitResult = { ok: boolean; available: boolean; retryAfterSec: number };
type Scenario = {
  user?: { id: string; email?: string | null; email_confirmed_at?: string | null } | null;
  authError?: { code?: string; message: string } | null;
  authThrows?: boolean;
  serviceThrows?: boolean;
  existing?: UserRow | null;
  readError?: string;
  writeError?: string;
  noWriteData?: boolean;
  distributed?: LimitResult;
  afterThrows?: boolean;
};

const argumentsAfterScript = process.argv.slice(2);
assert.ok(
  argumentsAfterScript.length === 0 ||
    (argumentsAfterScript.length === 1 && argumentsAfterScript[0] === "--baseline"),
  "usage: npx tsx scripts/verify-invite-request-route.mts [--baseline]"
);
const baseline = argumentsAfterScript[0] === "--baseline";
const routePath = baseline
  ? fileURLToPath(new URL("../../alpha-free-invite-release-20260905/app/api/access/request/route.ts", import.meta.url))
  : fileURLToPath(new URL("../app/api/access/request/route.ts", import.meta.url));
assert.ok(existsSync(routePath), `route source must exist: ${routePath}`);
const routeSource = readFileSync(routePath, "utf8");

function compileRoute(): string {
  const imports = [
    'import { NextResponse, after } from "next/server";',
    'import { isAuthSessionMissingError, type User } from "@supabase/supabase-js";',
    'import { z } from "zod";',
    'import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";',
    'import { clientKeyFromRequest, rateLimit } from "@/lib/rate-limit";',
    'import { consumeDistributedRateLimit } from "@/lib/distributed-rate-limit";',
    'import { isValidTopicId, MAX_CUSTOM_TOPIC_LEN, CUSTOM_PREFIX } from "@/lib/topics";',
    'import { BLURB_CAPS } from "@/lib/types";',
    'import { parseBirthday } from "@/lib/demographics";',
    'import { coerceThemeId } from "@/lib/themes";',
    'import { isInviteOnly } from "@/lib/access-mode";',
    'import { hasReaderAccess } from "@/lib/access";',
    'import { sendOpsWebhookAlert } from "@/lib/email";',
    'import { hasUsableReaderProfile } from "@/lib/reader-profile-state";',
  ];
  let source = routeSource;
  for (const statement of imports) source = source.replace(statement, "");
  source = source.replace(
    /import \{\s*authOwnsAccessRequestEmail,\s*normalizeAccessRequestEmail,\s*\} from "@\/lib\/access-request-ownership";/m,
    ""
  );
  source = source.replace('export const runtime = "nodejs";', 'const runtime = "nodejs";');
  source = source.replace("export async function POST", "async function POST");
  source += "\nmodule.exports = { POST };\n";
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

const compiledRoute = compileRoute();

function response(body: Record<string, unknown>, init?: ResponseInit): JsonResponse {
  return { body, status: init?.status ?? 200, headers: new Headers(init?.headers) };
}

function validBody(email = "reader@example.test") {
  return {
    firstName: "Reader",
    city: "Tampa",
    topics: ["healthcare-recruiting", "sales-persuasion", "founder-operator", "marketing-growth", "ai-news"],
    theme: "forest",
    email,
  };
}

function post(body: unknown, clientKey: string, contentType = "application/json") {
  return new Request("https://alpha.test/api/access/request", {
    method: "POST",
    headers: { "content-type": contentType, "cf-connecting-ip": clientKey },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function makeRoute(scenario: Scenario = {}) {
  const writes: Array<{ kind: "insert" | "update"; id: string; value: UserRow }> = [];
  const reads: string[] = [];
  let serviceCreates = 0;
  const profileColumns = [
    "email", "first_name", "city", "job_blurb", "project_blurb", "fun_blurb",
    "birthday", "gender", "topics", "theme", "access_requested_at",
  ].sort();
  const user = scenario.user === undefined
    ? { id: "reader-id", email: "reader@example.test", email_confirmed_at: "2026-09-05T00:00:00.000Z" }
    : scenario.user;

  function query(kind: "read" | "insert" | "update", value?: UserRow) {
    let targetId = "";
    const fencedColumns = new Set<string>();
    return {
      select() { return this; },
      eq(column: string, filterValue: string) {
        if (column === "id") targetId = filterValue;
        else {
          assert.equal(kind, "update", "only updates use snapshot fences");
          assert.ok(["subscribed_at", "access_granted_at", "updated_at"].includes(column), `known write fence: ${column}`);
          assert.equal(filterValue, scenario.existing?.[column], `snapshot fence matches ${column}`);
          fencedColumns.add(column);
        }
        return this;
      },
      is(column: string, value: null) {
        assert.equal(kind, "update", "only updates use snapshot fences");
        assert.equal(value, null);
        assert.ok(["subscribed_at", "access_granted_at", "updated_at"].includes(column), `known null fence: ${column}`);
        assert.equal(scenario.existing?.[column] ?? null, null, `null fence matches ${column}`);
        fencedColumns.add(column);
        return this;
      },
      maybeSingle: async () => {
        if (kind === "read") {
          reads.push(targetId);
          return scenario.readError
            ? { data: null, error: { message: scenario.readError } }
            : { data: scenario.existing ?? null, error: null };
        }
        assert.ok(value, "write query has a value");
        if (kind === "update") {
          assert.deepEqual([...fencedColumns].sort(), ["access_granted_at", "subscribed_at", "updated_at"],
            "existing-row requests fence grant, subscription, and account clock");
        }
        const allowedColumns = kind === "insert" ? ["id", ...profileColumns].sort() : profileColumns;
        assert.deepEqual(Object.keys(value).sort(), allowedColumns, `${kind} has exactly the allowed profile columns`);
        writes.push({ kind, id: targetId || String(value.id), value });
        return scenario.writeError
          ? { data: null, error: { message: scenario.writeError } }
          : { data: scenario.noWriteData ? null : { id: targetId || value.id }, error: null };
      },
    };
  }
  const service = {
    from(table: string) {
      assert.equal(table, "users");
      return {
        select: () => query("read"),
        update: (value: UserRow) => query("update", value),
        insert: (value: UserRow) => ({ select: () => query("insert", value) }),
      };
    },
  };

  const context = {
    module: { exports: {} as { POST?: (request: Request) => Promise<JsonResponse> } },
    NextResponse: { json: response },
    after: (callback: () => void) => {
      if (scenario.afterThrows) throw new Error("scheduler unavailable");
      void callback;
    },
    isAuthSessionMissingError: (error: { code?: string }) => error?.code === "session_missing",
    z,
    supabaseServerClient: async () => {
      if (scenario.authThrows) throw new Error("auth unavailable");
      return { auth: { getUser: async () => ({ data: { user }, error: scenario.authError ?? null }) } };
    },
    supabaseServiceClient: async () => {
      serviceCreates += 1;
      if (scenario.serviceThrows) throw new Error("service unavailable");
      return service;
    },
    clientKeyFromRequest,
    rateLimit,
    consumeDistributedRateLimit: async () => scenario.distributed ?? { ok: true, available: true, retryAfterSec: 0 },
    isValidTopicId,
    MAX_CUSTOM_TOPIC_LEN,
    CUSTOM_PREFIX,
    BLURB_CAPS,
    parseBirthday,
    coerceThemeId,
    isInviteOnly: () => true,
    hasReaderAccess,
    hasUsableReaderProfile,
    authOwnsAccessRequestEmail,
    normalizeAccessRequestEmail,
    sendOpsWebhookAlert: async () => undefined,
    console: { error() {}, warn() {} },
    Headers,
    Date,
  };
  runInNewContext(compiledRoute, context, { filename: routePath });
  const POST = context.module.exports.POST;
  assert.ok(POST, "route exports POST");
  return { POST, writes, reads, get serviceCreates() { return serviceCreates; } };
}

async function expectStatus(
  handler: (request: Request) => Promise<JsonResponse>,
  request: Request,
  status: number
) {
  const result = await handler(request);
  assert.equal(result.status, status);
  return result;
}

async function main() {
  if (!baseline) {
    // This source placement check prevents a future refactor from moving the daily
    // bucket back above the confirmed-owner decision.
    const burstIndex = routeSource.indexOf("access-request-burst:${clientKey}");
    const ownershipIndex = routeSource.indexOf("authOwnsAccessRequestEmail(signedInUser.email, email)");
    const dailyIndex = routeSource.indexOf("access-request:${clientKey}");
    assert.ok(burstIndex >= 0 && burstIndex < ownershipIndex, "burst guard precedes authentication and parsing");
    assert.ok(dailyIndex > ownershipIndex, "daily guard follows confirmed email ownership");
    assert.match(routeSource, /limit:\s*10,[\s\S]*?windowMs:\s*60 \* 1000/);
    assert.match(routeSource, /Too many attempts\. Try again in a minute\./);
  } else {
    console.log("BASELINE: old release route is expected to fail the same behavioral assertions below");
  }

  // These two cases fail against the old ordering: three malformed or signed-out
  // attempts would have exhausted access-request:<clientKey> before a real owner
  // could submit the request.
  {
    const key = "198.51.100.101";
    const route = makeRoute();
    for (let i = 0; i < 3; i++) await expectStatus(route.POST!, post({ bad: true }, key), 400);
    const accepted = await expectStatus(route.POST!, post(validBody(), key), 200);
    assert.equal(accepted.body.ok, true);
  }
  {
    const key = "198.51.100.102";
    const unauthenticated = makeRoute({ user: null });
    for (let i = 0; i < 3; i++) await expectStatus(unauthenticated.POST!, post(validBody(), key), 401);
    const confirmed = makeRoute();
    for (let i = 0; i < 3; i++) await expectStatus(confirmed.POST!, post(validBody(), key), 200);
    await expectStatus(confirmed.POST!, post(validBody(), key), 429);
  }
  {
    const key = "198.51.100.103";
    const mismatch = makeRoute({ user: { id: "reader-id", email: "other@example.test", email_confirmed_at: "2026-09-05T00:00:00.000Z" } });
    await expectStatus(mismatch.POST!, post(validBody(), key), 403);
    const confirmed = makeRoute();
    for (let i = 0; i < 3; i++) await expectStatus(confirmed.POST!, post(validBody(), key), 200);
    await expectStatus(confirmed.POST!, post(validBody(), key), 429);
  }
  {
    const key = "198.51.100.104";
    const route = makeRoute();
    for (let i = 0; i < 10; i++) await expectStatus(route.POST!, post("{", key), 400);
    const capped = await expectStatus(route.POST!, post("{", key), 429);
    assert.match(String(capped.body.error), /Try again in a minute/);
    assert.ok(Number(capped.headers.get("Retry-After")) > 0);
  }

  {
    const unauthenticated = makeRoute({ user: null });
    await expectStatus(unauthenticated.POST!, post(validBody(), "198.51.100.105"), 401);
    assert.equal(unauthenticated.serviceCreates, 0);
    assert.equal(unauthenticated.reads.length, 0);
    assert.equal(unauthenticated.writes.length, 0);
  }
  {
    const unconfirmed = makeRoute({ user: { id: "id", email: "reader@example.test", email_confirmed_at: null } });
    await expectStatus(unconfirmed.POST!, post(validBody(), "198.51.100.106"), 401);
    assert.equal(unconfirmed.serviceCreates, 0);
    assert.equal(unconfirmed.reads.length, 0);
    assert.equal(unconfirmed.writes.length, 0);
  }
  {
    const authThrows = makeRoute({ authThrows: true });
    await expectStatus(authThrows.POST!, post(validBody(), "198.51.100.107"), 503);
    assert.equal(authThrows.serviceCreates, 0);
    assert.equal(authThrows.reads.length, 0);
    assert.equal(authThrows.writes.length, 0);
  }
  {
    const returnedAuthError = makeRoute({ authError: { code: "provider_down", message: "provider down" } });
    await expectStatus(returnedAuthError.POST!, post(validBody(), "198.51.100.118"), 503);
    assert.equal(returnedAuthError.serviceCreates, 0);
    assert.equal(returnedAuthError.reads.length, 0);
    assert.equal(returnedAuthError.writes.length, 0);
  }
  {
    const sessionMissing = makeRoute({ user: null, authError: { code: "session_missing", message: "no session" } });
    await expectStatus(sessionMissing.POST!, post(validBody(), "198.51.100.119"), 401);
    assert.equal(sessionMissing.serviceCreates, 0);
    assert.equal(sessionMissing.reads.length, 0);
    assert.equal(sessionMissing.writes.length, 0);
  }
  {
    const wrongMedia = makeRoute();
    await expectStatus(wrongMedia.POST!, post(validBody(), "198.51.100.120", "text/plain"), 415);
    assert.equal(wrongMedia.serviceCreates, 0);
    assert.equal(wrongMedia.reads.length, 0);
    assert.equal(wrongMedia.writes.length, 0);
  }
  await expectStatus(makeRoute({ serviceThrows: true }).POST!, post(validBody(), "198.51.100.108"), 503);
  {
    const blocked = await expectStatus(
      makeRoute({ distributed: { ok: false, available: true, retryAfterSec: 33 } }).POST!,
      post(validBody(), "198.51.100.109"), 429
    );
    assert.equal(blocked.headers.get("Retry-After"), "33");
    await expectStatus(
      makeRoute({ distributed: { ok: false, available: false, retryAfterSec: 0 } }).POST!,
      post(validBody(), "198.51.100.110"), 503
    );
  }

  {
    const route = makeRoute({ user: { id: "insert-owner", email: "reader@example.test", email_confirmed_at: "2026-09-05T00:00:00.000Z" } });
    await expectStatus(route.POST!, post(validBody(), "198.51.100.111"), 200);
    assert.equal(route.reads[0], "insert-owner");
    assert.deepEqual(route.writes.map(({ kind, id }) => ({ kind, id })), [{ kind: "insert", id: "insert-owner" }]);
    assert.equal(route.writes[0].value.id, "insert-owner");
    assert.equal(route.writes[0].value.email, "reader@example.test");
  }
  {
    const route = makeRoute({
      user: { id: "update-owner", email: "reader@example.test", email_confirmed_at: "2026-09-05T00:00:00.000Z" },
      existing: { id: "update-owner", subscribed_at: "2026-01-01T00:00:00.000Z", cancelled_at: "2026-02-01T00:00:00.000Z", access_granted_at: null, stripe_customer_id: "kept-by-db" },
    });
    await expectStatus(route.POST!, post(validBody(), "198.51.100.112"), 200);
    assert.deepEqual(route.writes.map(({ kind, id }) => ({ kind, id })), [{ kind: "update", id: "update-owner" }]);
    assert.equal(route.writes[0].value.id, undefined, "update profile does not replace the primary key");
  }
  {
    const route = makeRoute({ existing: { id: "reader-id", subscribed_at: "2026-01-01T00:00:00.000Z", cancelled_at: null, access_granted_at: null } });
    await expectStatus(route.POST!, post(validBody(), "198.51.100.113"), 409);
    assert.equal(route.writes.length, 0);
  }
  await expectStatus(makeRoute({ readError: "read failed" }).POST!, post(validBody(), "198.51.100.114"), 503);
  await expectStatus(makeRoute({ writeError: "write failed" }).POST!, post(validBody(), "198.51.100.115"), 503);
  await expectStatus(makeRoute({ noWriteData: true }).POST!, post(validBody(), "198.51.100.116"), 409);
  await expectStatus(makeRoute({ afterThrows: true }).POST!, post(validBody(), "198.51.100.117"), 200);

  console.log("PASS verify-invite-request-route (offline)");
}

await main();
