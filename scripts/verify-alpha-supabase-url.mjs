#!/usr/bin/env node
// Pure offline verifier for the service-key destination guard.
// This intentionally reads no environment files and makes no network calls.

import assert from "node:assert/strict";
import {
  ALPHA_SUPABASE_HOST,
  isExactAlphaSupabaseUrl,
  requireExactAlphaSupabaseUrl,
} from "./alpha-supabase-url.mjs";

const valid = [
  `https://${ALPHA_SUPABASE_HOST}`,
  `https://${ALPHA_SUPABASE_HOST}/`,
];
for (const value of valid) {
  assert.equal(isExactAlphaSupabaseUrl(value), true, value);
  assert.equal(requireExactAlphaSupabaseUrl(value).hostname, ALPHA_SUPABASE_HOST);
}

const invalid = [
  "",
  null,
  `http://${ALPHA_SUPABASE_HOST}`,
  "https://example.supabase.co",
  `https://${ALPHA_SUPABASE_HOST}/rest/v1`,
  `https://${ALPHA_SUPABASE_HOST}/?select=*`,
  `https://user:pass@${ALPHA_SUPABASE_HOST}`,
];
for (const value of invalid) {
  assert.equal(isExactAlphaSupabaseUrl(value), false, String(value));
  assert.throws(() => requireExactAlphaSupabaseUrl(value), /value withheld/);
}

console.log("PASS verify-alpha-supabase-url (offline, no env or network access)");
