// Verify round 31 findings: no Strict-Transport-Security header despite the
// app being HTTPS-only on a paid product handling auth sessions; and 3
// routes (account/profile, account/topics, stripe/update-quantity) cast
// req.json()'s result straight to a typed shape with no runtime null-check,
// so a literal JSON `null` body (which parses successfully -- it's valid
// JSON, the try/catch never fires) crashed with an unhandled TypeError on
// the very next property read instead of this app's own established clean
// 400 pattern. alpha-drift-r31-01/r31-02, both 2026-08-14.
// Run: npx tsx scripts/verify-r31-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) next.config.ts: Strict-Transport-Security header added");
{
  const src = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
  check("(1a) HSTS header present with a real max-age + includeSubDomains", /\{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" \}/.test(src));
  check("(1b) deliberately no `preload` directive (needs Algy's sign-off on the shared everyday.report apex first, per the comment's own reasoning)", !/Strict-Transport-Security[\s\S]{0,10}preload/.test(src));
  // Sanity: the header sits inside the SAME `/:path*` source block as every
  // other defense-in-depth header, not a separate/narrower one.
  const pathStarBlock = src.slice(src.indexOf('source: "/:path*"'), src.indexOf("Content-Security-Policy"));
  check("(1c) HSTS lives in the same /:path* header block as X-Frame-Options/etc, not a narrower scope", /Strict-Transport-Security/.test(pathStarBlock));
}

console.log("(2) 3 routes now guard against a literal JSON null body before the first property read");
{
  // Ordering proof via indexOf (more robust than one giant regex across a
  // multi-line explanatory comment): the guard must exist, and must sit
  // AFTER the try/catch's closing brace but BEFORE the first real property
  // read on body.
  const profileSrc = readFileSync(new URL("../app/api/account/profile/route.ts", import.meta.url), "utf8");
  const profileCatchEnd = profileSrc.indexOf('} catch {\n    return NextResponse.json({ error: "Bad request." }, { status: 400 });\n  }');
  const profileGuardIdx = profileSrc.indexOf('if (typeof body !== "object" || body === null) {');
  const profileFirstReadIdx = profileSrc.indexOf("const firstName = cleanRequired");
  check(
    "(2a-profile) the null/non-object guard exists and sits between the try/catch and the first body.firstName read",
    profileCatchEnd >= 0 && profileGuardIdx > profileCatchEnd && profileFirstReadIdx > profileGuardIdx
  );

  const topicsSrc = readFileSync(new URL("../app/api/account/topics/route.ts", import.meta.url), "utf8");
  const topicsCatchEnd = topicsSrc.indexOf('} catch {\n    return NextResponse.json({ error: "Bad request." }, { status: 400 });\n  }');
  const topicsGuardIdx = topicsSrc.indexOf('if (typeof body !== "object" || body === null) {');
  const topicsFirstReadIdx = topicsSrc.indexOf("const shape = validateTopicsShape");
  check(
    "(2b-topics) the null/non-object guard exists and sits between the try/catch and the first body.topics read",
    topicsCatchEnd >= 0 && topicsGuardIdx > topicsCatchEnd && topicsFirstReadIdx > topicsGuardIdx
  );

  const qtySrc = readFileSync(new URL("../app/api/stripe/update-quantity/route.ts", import.meta.url), "utf8");
  check("(2c-update-quantity) the parsed body is null-checked before being assigned over the safe {} default", /if \(parsed && typeof parsed === "object"\) body = parsed;/.test(qtySrc));
  check("(2c-update-quantity) a genuinely null parse leaves `body` at its safe {} initializer, not overwritten with null", !/body = \(await req\.json\(\)\) as Body;/.test(qtySrc));

  // Behavioral proof: replicate each route's REAL guard logic (not exported
  // as standalone functions, so recomputed inline exactly as written) and
  // confirm a literal `null` -- the actual JSON.parse('null') result -- is
  // correctly rejected/normalized rather than reaching a property read.
  function profileTopicsGuard(body: unknown): boolean {
    // Mirrors: if (typeof body !== "object" || body === null) return 400
    return typeof body !== "object" || body === null;
  }
  check("(2d) behavioral: the profile/topics guard predicate is TRUE (would 400) for a literal null body", profileTopicsGuard(null) === true);
  check("(2e) behavioral: the profile/topics guard predicate is FALSE (proceeds normally) for a real object body", profileTopicsGuard({ firstName: "Alex" }) === false);
  // update-quantity's normalization: `parsed && typeof parsed === "object"`
  function updateQuantityNormalize(parsed: unknown, fallback: { direction?: "up" | "down" }): { direction?: "up" | "down" } {
    if (parsed && typeof parsed === "object") return parsed as { direction?: "up" | "down" };
    return fallback;
  }
  const nullResult = updateQuantityNormalize(null, {});
  check("(2f) behavioral: update-quantity's normalization leaves a null parse as the safe {} fallback (no crash on the next .direction read)", nullResult.direction === undefined);
  const realResult = updateQuantityNormalize({ direction: "up" }, {});
  check("(2g) behavioral: update-quantity's normalization still passes through a real parsed body unchanged", realResult.direction === "up");

  // Confirm the sibling Zod-validated routes (the ones this finding
  // contrasted against) are untouched -- this fix didn't need to touch them,
  // and shouldn't have.
  const checkoutSrc = readFileSync(new URL("../app/api/stripe/checkout/route.ts", import.meta.url), "utf8");
  check("(2h) sanity: stripe/checkout's Zod-validated body parsing (the pattern these 3 routes now partially match) is untouched", /body = CheckoutPayloadSchema\.parse\(raw\);/.test(checkoutSrc));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R31 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R31 FINDINGS ASSERTIONS PASS");
