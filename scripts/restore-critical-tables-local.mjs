#!/usr/bin/env node
// Local-only recovery drill. It validates every backup byte before opening a
// database connection and rejects any target that is not explicit loopback.
// Raw rows and psql output are never printed.
import { runLocalRestore } from "./critical-table-restore.mjs";

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index === process.argv.length - 1) return "";
  return process.argv[index + 1];
}

try {
  const result = runLocalRestore({
    backupDir: argumentValue("--backup-dir"),
    databaseUrl: argumentValue("--database-url"),
    psqlBin: process.env.PSQL_BIN,
  });
  console.log(
    `RESTORE PASS: ${result.tableCount} tables, ${result.totalRows} rows, ${result.anchorCount} auth anchors, counts/hashes/FKs/sequences verified.`
  );
} catch (error) {
  const message =
    error instanceof Error ? error.message : "local restore validation failed";
  console.error(`RESTORE FAIL: ${message}`);
  process.exitCode = 1;
}
