#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { maskSqlNonCode } from "./sql-read-only-mask.mjs";

const mutationPattern =
  /\b(insert|update|delete|truncate|alter|create|drop|grant|revoke|copy|call|do|merge|vacuum|analyze|refresh|reindex|cluster|set|reset)\b/i;

const safe = `
-- UPDATE is explanatory text.
select has_table_privilege('anon', 'public.users', 'INSERT');
select 'it''s safe to say DELETE here';
select $$ CREATE TABLE hidden_in_a_dollar_string $$;
select "UPDATE" from public.users;
/* outer DROP /* nested ALTER */ still comment text */
with evidence as (select 'TRUNCATE' as label) select * from evidence;
`;
const safeSurface = maskSqlNonCode(safe);
assert.doesNotMatch(safeSurface, mutationPattern);
assert.equal(
  safeSurface
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean)
    .every((statement) => /^(select|with)\b/i.test(statement)),
  true
);

for (const unsafe of [
  "insert into public.users(id) values ('x');",
  "with removed as (delete from public.users returning id) select * from removed;",
  "select nextval('sequence_name');",
  "select * from public.users for update;",
]) {
  const surface = maskSqlNonCode(unsafe);
  assert.equal(
    mutationPattern.test(surface) ||
      /\bnextval\s*\(/i.test(surface) ||
      /\bfor\s+update\b/i.test(surface),
    true
  );
}

for (const malformed of ["select 'open", "select $$open", "select /* open"]) {
  assert.throws(() => maskSqlNonCode(malformed), /unterminated/);
}

const verification = readFileSync(
  new URL("./r80-live-verification.sql", import.meta.url),
  "utf8"
);
assert.doesNotThrow(() => maskSqlNonCode(verification));
assert.doesNotMatch(maskSqlNonCode(verification), mutationPattern);

console.log("PASS verify-sql-read-only-mask (offline)");
