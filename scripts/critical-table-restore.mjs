import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  BACKUP_FORMAT_VERSION,
  CRITICAL_TABLES,
  sha256Hex,
} from "./critical-table-backup-format.mjs";

const MAX_BACKUP_FILE_BYTES = 512 * 1024 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COLUMN_PATTERN = /^[a-z_][a-z0-9_]*$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export class RestoreValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "RestoreValidationError";
  }
}

function fail(message) {
  throw new RestoreValidationError(message);
}

function sameStrings(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function plainRow(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function safeFile(root, fileName) {
  const candidate = path.resolve(root, fileName);
  if (path.dirname(candidate).toLowerCase() !== root.toLowerCase()) {
    fail("backup manifest contains an invalid file path");
  }
  const status = lstatSync(candidate);
  if (!status.isFile() || status.isSymbolicLink()) {
    fail(`backup file is not a regular file: ${fileName}`);
  }
  const real = realpathSync(candidate);
  if (path.dirname(real).toLowerCase() !== root.toLowerCase()) {
    fail(`backup file resolves outside the backup directory: ${fileName}`);
  }
  if (status.size > MAX_BACKUP_FILE_BYTES) {
    fail(`backup file exceeds the local restore size cap: ${fileName}`);
  }
  return candidate;
}

function validatedColumns(tableName, rows) {
  if (rows.length === 0) return [];
  if (!plainRow(rows[0])) {
    fail(`${tableName}: every backup row must be a JSON object`);
  }
  const columns = Object.keys(rows[0]).sort();
  if (columns.length === 0 || columns.some((column) => !COLUMN_PATTERN.test(column))) {
    fail(`${tableName}: backup row has an invalid column set`);
  }
  for (const row of rows) {
    if (!plainRow(row)) {
      fail(`${tableName}: every backup row must be a JSON object`);
    }
    const rowColumns = Object.keys(row).sort();
    if (!sameStrings(rowColumns, columns)) {
      fail(`${tableName}: backup rows do not share one exact column set`);
    }
  }
  return columns;
}

function userAnchors(rows) {
  const anchors = [];
  const ids = new Set();
  const emails = new Set();
  for (const row of rows) {
    if (!UUID_PATTERN.test(row.id || "")) {
      fail("users: every row needs an exact UUID auth anchor");
    }
    if (
      typeof row.email !== "string" ||
      row.email.length < 3 ||
      row.email.length > 254
    ) {
      fail("users: every row needs an exact email auth anchor");
    }
    const normalizedEmail = row.email.toLowerCase();
    if (ids.has(row.id) || emails.has(normalizedEmail)) {
      fail("users: auth anchors must have unique IDs and emails");
    }
    ids.add(row.id);
    emails.add(normalizedEmail);
    anchors.push({ id: row.id, email: row.email });
  }
  return anchors;
}

export function validateBackupDirectory(backupDir) {
  if (typeof backupDir !== "string" || backupDir.trim() === "") {
    fail("an explicit backup directory is required");
  }
  const root = realpathSync(path.resolve(backupDir));
  const manifestPath = safeFile(root, "MANIFEST.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    fail("backup manifest is not valid JSON");
  }

  const tableNames = CRITICAL_TABLES.map(({ name }) => name);
  if (!plainRow(manifest)) fail("backup manifest must be a JSON object");
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
    fail(`backup manifest format must be ${BACKUP_FORMAT_VERSION}`);
  }
  if (manifest.failed !== false) fail("backup manifest is marked failed");
  if (!sameStrings(manifest.tables, tableNames)) {
    fail("backup manifest table order is not the recovery order");
  }
  if (!plainRow(manifest.orderBy) || !plainRow(manifest.files)) {
    fail("backup manifest is missing ordering or file evidence");
  }
  if (!sameStrings(Object.keys(manifest.files).sort(), [...tableNames].sort())) {
    fail("backup manifest file inventory is incomplete or has extras");
  }
  if (!sameStrings(Object.keys(manifest.orderBy).sort(), [...tableNames].sort())) {
    fail("backup manifest ordering inventory is incomplete or has extras");
  }

  const tables = new Map();
  let totalRows = 0;
  for (const table of CRITICAL_TABLES) {
    if (manifest.orderBy[table.name] !== table.order) {
      fail(`${table.name}: backup ordering marker does not match`);
    }
    const metadata = manifest.files[table.name];
    if (!plainRow(metadata) || metadata.file !== `${table.name}.json`) {
      fail(`${table.name}: backup file metadata is invalid`);
    }
    if (!Number.isSafeInteger(metadata.rowCount) || metadata.rowCount < 0) {
      fail(`${table.name}: backup row count is invalid`);
    }
    if (!Number.isSafeInteger(metadata.bytes) || metadata.bytes < 0) {
      fail(`${table.name}: backup byte count is invalid`);
    }
    if (!/^[0-9a-f]{64}$/.test(metadata.sha256 || "")) {
      fail(`${table.name}: backup SHA-256 is invalid`);
    }

    const filePath = safeFile(root, metadata.file);
    const bytes = readFileSync(filePath);
    if (bytes.byteLength !== metadata.bytes) {
      fail(`${table.name}: backup byte count does not match the manifest`);
    }
    if (sha256Hex(bytes) !== metadata.sha256) {
      fail(`${table.name}: backup SHA-256 does not match the manifest`);
    }

    let rows;
    try {
      rows = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail(`${table.name}: backup file is not valid JSON`);
    }
    if (!Array.isArray(rows) || rows.length !== metadata.rowCount) {
      fail(`${table.name}: backup row count does not match the manifest`);
    }
    const columns = validatedColumns(table.name, rows);
    tables.set(table.name, {
      columns,
      json: JSON.stringify(rows),
      rowCount: rows.length,
    });
    totalRows += rows.length;
  }

  if (!Number.isSafeInteger(manifest.totalRows) || manifest.totalRows !== totalRows) {
    fail("backup aggregate row count does not match the table evidence");
  }

  return {
    anchors: userAnchors(JSON.parse(tables.get("users").json)),
    manifest,
    root,
    tables,
    totalRows,
  };
}

export function parseLocalPostgresUrl(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    fail("an explicit local PostgreSQL URL is required");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail("the PostgreSQL URL is invalid");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
    fail("the restore target must use PostgreSQL");
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOCAL_HOSTS.has(host)) {
    fail("the restore target must be an explicit loopback host");
  }
  if (parsed.search || parsed.hash) {
    fail("the local restore URL cannot contain query or fragment options");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const user = decodeURIComponent(parsed.username);
  if (!database || database.includes("/") || !user) {
    fail("the local restore URL must include one database and one user");
  }
  const port = parsed.port || "5432";
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    fail("the local restore PostgreSQL port is invalid");
  }
  return {
    database,
    host,
    password: decodeURIComponent(parsed.password),
    port: String(portNumber),
    user,
  };
}

function quoteIdentifier(value) {
  if (!COLUMN_PATTERN.test(value)) fail("restore SQL received an invalid identifier");
  return `"${value}"`;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function dollarLiteral(value, label) {
  let attempt = 0;
  for (;;) {
    const tag = `$alpha_${label}_${attempt}$`;
    if (!value.includes(tag)) return `${tag}${value}${tag}`;
    attempt += 1;
  }
}

function tableArraySql() {
  return `ARRAY[${CRITICAL_TABLES.map(({ name }) => sqlString(name)).join(", ")}]::text[]`;
}

export function buildRestoreSql(snapshot) {
  const tableNames = CRITICAL_TABLES.map(({ name }) => name);
  const qualifiedTables = tableNames.map(
    (name) => `public.${quoteIdentifier(name)}`
  );
  const lockTargets = ["auth.users", ...qualifiedTables].join(", ");
  const tableArray = tableArraySql();
  const anchorsJson = JSON.stringify(snapshot.anchors);
  const anchorsLiteral = dollarLiteral(anchorsJson, "anchors");

  const emptinessChecks = [
    "if exists (select 1 from auth.users limit 1) then raise exception 'restore destination auth table is not empty'; end if;",
    ...tableNames.map(
      (name) =>
        `if exists (select 1 from public.${quoteIdentifier(name)} limit 1) then raise exception 'restore destination table is not empty: ${name}'; end if;`
    ),
  ].join("\n  ");

  const disableTriggers = ["auth.users", ...qualifiedTables]
    .map((name) => `alter table ${name} disable trigger user;`)
    .join("\n");
  const enableTriggers = ["auth.users", ...qualifiedTables]
    .map((name) => `alter table ${name} enable trigger user;`)
    .join("\n");

  const inserts = [];
  for (const { name } of CRITICAL_TABLES) {
    const table = snapshot.tables.get(name);
    if (table.rowCount === 0) continue;
    const columns = table.columns.map(quoteIdentifier).join(", ");
    const jsonLiteral = dollarLiteral(table.json, `rows_${name}`);
    inserts.push(
      `insert into public.${quoteIdentifier(name)} (${columns})\n` +
        `select ${columns}\n` +
        `from jsonb_populate_recordset(null::public.${quoteIdentifier(name)}, ${jsonLiteral}::jsonb);`
    );
  }

  const countChecks = CRITICAL_TABLES.map(({ name }) => {
    const expected = snapshot.tables.get(name).rowCount;
    return `if (select count(*) from public.${quoteIdentifier(name)}) <> ${expected} then raise exception 'restored row count mismatch: ${name}'; end if;`;
  }).join("\n  ");

  return `\\set ON_ERROR_STOP on
\\set VERBOSITY sqlstate
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
set local row_security = off;
set local client_min_messages = warning;
set local request.jwt.claims = '{"role":"service_role"}';

do $alpha_local_target$
begin
  if inet_server_addr() is null or not (
    inet_server_addr() <<= inet '127.0.0.0/8'
    or inet_server_addr() = inet '::1'
  ) then
    raise exception 'restore connection is not loopback';
  end if;
end
$alpha_local_target$;

select pg_advisory_xact_lock(hashtextextended('alpha-local-critical-restore', 80425089));
lock table ${lockTargets} in access exclusive mode;

do $alpha_empty_target$
begin
  ${emptinessChecks}
end
$alpha_empty_target$;

${disableTriggers}

insert into auth.users (id, email)
select anchor.id, anchor.email
from jsonb_to_recordset(${anchorsLiteral}::jsonb) as anchor(id uuid, email text);

${inserts.join("\n\n")}

${enableTriggers}

do $alpha_counts$
begin
  ${countChecks}
  if (select count(*) from auth.users) <> ${snapshot.anchors.length} then
    raise exception 'restored auth anchor count mismatch';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(${anchorsLiteral}::jsonb) as anchor(id uuid, email text)
    left join auth.users restored
      on restored.id = anchor.id
     and restored.email = anchor.email
    where restored.id is null
  ) then
    raise exception 'restored auth anchor mismatch';
  end if;
end
$alpha_counts$;

do $alpha_foreign_keys$
declare
  foreign_key record;
  child_nonnull text;
  join_predicate text;
  orphan_exists boolean;
begin
  for foreign_key in
    select
      constraint_row.conname,
      constraint_row.conkey,
      constraint_row.confkey,
      constraint_row.convalidated,
      format('%I.%I', child_namespace.nspname, child_table.relname) as child_table,
      format('%I.%I', parent_namespace.nspname, parent_table.relname) as parent_table,
      constraint_row.conrelid,
      constraint_row.confrelid
    from pg_constraint constraint_row
    join pg_class child_table on child_table.oid = constraint_row.conrelid
    join pg_namespace child_namespace on child_namespace.oid = child_table.relnamespace
    join pg_class parent_table on parent_table.oid = constraint_row.confrelid
    join pg_namespace parent_namespace on parent_namespace.oid = parent_table.relnamespace
    where constraint_row.contype = 'f'
      and child_namespace.nspname = 'public'
      and child_table.relname = any(${tableArray})
  loop
    if not foreign_key.convalidated then
      raise exception 'restore target has an unvalidated foreign key';
    end if;
    select
      string_agg(format('child.%I is not null', child_attribute.attname), ' and ' order by key_column.ordinality),
      string_agg(format('child.%I = parent.%I', child_attribute.attname, parent_attribute.attname), ' and ' order by key_column.ordinality)
    into child_nonnull, join_predicate
    from unnest(foreign_key.conkey, foreign_key.confkey) with ordinality
      as key_column(child_number, parent_number, ordinality)
    join pg_attribute child_attribute
      on child_attribute.attrelid = foreign_key.conrelid
     and child_attribute.attnum = key_column.child_number
    join pg_attribute parent_attribute
      on parent_attribute.attrelid = foreign_key.confrelid
     and parent_attribute.attnum = key_column.parent_number;

    execute format(
      'select exists (select 1 from %s child where %s and not exists (select 1 from %s parent where %s))',
      foreign_key.child_table,
      child_nonnull,
      foreign_key.parent_table,
      join_predicate
    ) into orphan_exists;
    if orphan_exists then
      raise exception 'restored foreign key has an orphan';
    end if;
  end loop;
end
$alpha_foreign_keys$;

do $alpha_sequences$
declare
  table_name text;
  column_row record;
  sequence_name text;
  maximum_value numeric;
  next_value numeric;
  sequence_start numeric;
  sequence_increment numeric;
begin
  foreach table_name in array ${tableArray}
  loop
    for column_row in
      select attribute_row.attname
      from pg_attribute attribute_row
      where attribute_row.attrelid = format('public.%I', table_name)::regclass
        and attribute_row.attnum > 0
        and not attribute_row.attisdropped
    loop
      sequence_name := pg_get_serial_sequence(
        format('public.%I', table_name),
        column_row.attname
      );
      if sequence_name is null then
        continue;
      end if;
      execute format(
        'select max(%I)::numeric from public.%I',
        column_row.attname,
        table_name
      ) into maximum_value;
      select sequence_row.seqstart, sequence_row.seqincrement
      into sequence_start, sequence_increment
      from pg_sequence sequence_row
      where sequence_row.seqrelid = sequence_name::regclass;
      next_value := coalesce(maximum_value + sequence_increment, sequence_start);
      execute format(
        'alter sequence %s restart with %s',
        sequence_name::regclass,
        next_value
      );
    end loop;
  end loop;
end
$alpha_sequences$;

set constraints all immediate;
commit;
`;
}

function psqlEnvironment(connection) {
  const environment = {
    ...process.env,
    PGAPPNAME: "alpha-local-critical-restore",
    PGCONNECT_TIMEOUT: "5",
    PGDATABASE: connection.database,
    PGHOST: connection.host,
    PGPASSWORD: connection.password,
    PGPORT: connection.port,
    PGSSLMODE: "disable",
    PGUSER: connection.user,
  };
  // Ambient libpq service and host-address settings must not redirect an
  // explicitly loopback URL. The SQL transaction independently checks the
  // server-side address before taking its first lock.
  delete environment.PGHOSTADDR;
  delete environment.PGSERVICE;
  delete environment.PGSERVICEFILE;
  return environment;
}

export function runLocalRestore({ backupDir, databaseUrl, psqlBin }) {
  const connection = parseLocalPostgresUrl(databaseUrl);
  const snapshot = validateBackupDirectory(backupDir);
  const sql = buildRestoreSql(snapshot);
  const executable = psqlBin?.trim() || process.env.PSQL_BIN?.trim() || "psql";
  const result = spawnSync(
    executable,
    ["-X", "-w", "-q", "-v", "ON_ERROR_STOP=1", "-f", "-"],
    {
      encoding: "utf8",
      env: psqlEnvironment(connection),
      input: sql,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 150_000,
      windowsHide: true,
    }
  );
  if (result.error || result.signal || result.status !== 0) {
    const sqlState = result.stderr?.match(/ERROR:\s+([0-9A-Z]{5})\b/)?.[1];
    const processReason = result.error?.code
      ? `process ${result.error.code}`
      : result.signal
        ? `signal ${result.signal}`
        : /psql:\s*error:|\bFATAL:/i.test(result.stderr || "")
          ? "connection failure"
          : `exit ${result.status}`;
    const inputLine = result.stderr?.match(/<stdin>:(\d+):/i)?.[1];
    const location = inputLine ? ` at generated line ${inputLine}` : "";
    const clientDiagnostic = [
      [/invalid command/i, "invalid psql command"],
      [/unrecognized value/i, "unsupported psql setting"],
      [/could not read from input/i, "psql input failure"],
      [/could not send data/i, "psql transport failure"],
      [/connection to server was lost/i, "lost local connection"],
      [/unterminated/i, "unterminated generated SQL"],
      [/permission denied/i, "local permission failure"],
    ].find(([pattern]) => pattern.test(result.stderr || ""))?.[1];
    fail(
      sqlState
        ? `local PostgreSQL rejected the restore transaction (SQLSTATE ${sqlState}${location})`
        : `local PostgreSQL rejected the restore transaction (${clientDiagnostic || processReason}${location})`
    );
  }
  return {
    anchorCount: snapshot.anchors.length,
    tableCount: CRITICAL_TABLES.length,
    totalRows: snapshot.totalRows,
  };
}
