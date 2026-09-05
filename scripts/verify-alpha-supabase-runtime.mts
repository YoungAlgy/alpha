// Offline guard proving browser and server clients can only target Alpha's
// dedicated Supabase project. No env file, key, or network is used.
import assert from "node:assert/strict";
import fs from "node:fs";

const {
  ALPHA_SUPABASE_HOST,
  exactAlphaSupabaseOrigin,
  isExactAlphaSupabaseUrl,
} = await import("../lib/alpha-supabase-url.ts");

assert.equal(ALPHA_SUPABASE_HOST, "xpqxhdciaoicsnyyfshy.supabase.co");
assert.equal(
  exactAlphaSupabaseOrigin(
    "https://xpqxhdciaoicsnyyfshy.supabase.co/"
  ),
  "https://xpqxhdciaoicsnyyfshy.supabase.co"
);
for (const value of [
  "http://xpqxhdciaoicsnyyfshy.supabase.co",
  "https://evil.example",
  "https://xpqxhdciaoicsnyyfshy.supabase.co.evil.example",
  "https://xpqxhdciaoicsnyyfshy.supabase.co@evil.example",
  "https://xpqxhdciaoicsnyyfshy.supabase.co/rest/v1",
  "https://xpqxhdciaoicsnyyfshy.supabase.co?redirect=evil",
]) {
  assert.equal(isExactAlphaSupabaseUrl(value), false, value);
}

const server = fs.readFileSync(
  new URL("../lib/supabase/server.ts", import.meta.url),
  "utf8"
);
const client = fs.readFileSync(
  new URL("../lib/supabase/client.ts", import.meta.url),
  "utf8"
);
assert.match(server, /exactAlphaSupabaseOrigin\(url\)/);
assert.match(client, /exactAlphaSupabaseOrigin\(url\)/);
assert.match(client, /isExactAlphaSupabaseUrl/);

console.log("PASS verify-alpha-supabase-runtime (offline)");
