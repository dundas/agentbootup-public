/**
 * brain-db-guards.ts — Pure guard/validation functions shared between brain-db.ts and tests.
 *
 * Exported so tests can import the real logic rather than re-implementing it.
 */

/** Table names must be brain_<alphanumeric/underscore> to be safe for SQL interpolation. */
export function assertBrainTable(table: string): void {
  if (!/^brain_[a-zA-Z0-9_]+$/.test(table)) {
    throw new Error(`Invalid table name: "${table}". Must match brain_[a-zA-Z0-9_]+`);
  }
}

/** Returns true if the SQL is safe for the read-only `sql` command (SELECT/PRAGMA/WITH). */
export function isReadOnlySql(query: string): boolean {
  const normalized = query.trim().toUpperCase();
  return normalized.startsWith('SELECT') || normalized.startsWith('PRAGMA') || normalized.startsWith('WITH');
}

/**
 * Returns true if the migration SQL does NOT reference any foundation table.
 * Foundation tables (chunks, transcript_index, schema_meta) are managed by agentbootup.
 * Any reference — including read-only ops like CREATE INDEX — is blocked.
 */
export function isMigrationSafe(sql: string): boolean {
  const foundationTargets = /\b(chunks|transcript_index|schema_meta)\b/i;
  return !foundationTargets.test(sql);
}

/**
 * Extract the table name from a CREATE TABLE statement.
 * Handles all SQLite quoting styles: unquoted, double-quoted, backtick, and bracket.
 * Returns undefined if the SQL is not a CREATE TABLE statement.
 */
export function extractTableName(sql: string): string | undefined {
  const m = sql.trim().match(
    /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([a-zA-Z0-9_]+)"|`([a-zA-Z0-9_]+)`|\[([a-zA-Z0-9_]+)\]|([a-zA-Z0-9_]+))/i
  );
  return m ? (m[1] ?? m[2] ?? m[3] ?? m[4]) : undefined;
}
