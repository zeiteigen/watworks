import type { Database } from 'bun:sqlite';

/** Atomic migration retains history while allowing a fresh approval after a proven no-write failure. */
export function migrateAttemptLedger(database: Database): void {
  database.transaction(() => {
    database.exec(`CREATE TABLE IF NOT EXISTS application_attempts (
      attemptId TEXT PRIMARY KEY, accountKey TEXT NOT NULL, operationKey TEXT NOT NULL,
      manifestHash TEXT NOT NULL, kind TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('reserved','staging','submitting','succeeded','failed','outcome_unknown')),
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, receiptId TEXT,
      accountReleasedAt INTEGER, accountReleaseEvidence TEXT,
      noRemoteMutation INTEGER NOT NULL DEFAULT 0 CHECK (noRemoteMutation IN (0,1) AND (noRemoteMutation = 0 OR state = 'failed'))
    )`);
    const columns = new Set(database.query<{ name: string }, []>('PRAGMA table_info(application_attempts)').all().map(c => c.name));
    if (!columns.has('accountReleasedAt')) database.exec('ALTER TABLE application_attempts ADD COLUMN accountReleasedAt INTEGER');
    if (!columns.has('accountReleaseEvidence')) database.exec('ALTER TABLE application_attempts ADD COLUMN accountReleaseEvidence TEXT');
    if (!columns.has('noRemoteMutation')) database.exec("ALTER TABLE application_attempts ADD COLUMN noRemoteMutation INTEGER NOT NULL DEFAULT 0 CHECK (noRemoteMutation IN (0,1) AND (noRemoteMutation = 0 OR state = 'failed'))");
    if (!columns.has('retryAuthorizedAt')) database.exec('ALTER TABLE application_attempts ADD COLUMN retryAuthorizedAt INTEGER');
    if (!columns.has('retryEvidence')) database.exec('ALTER TABLE application_attempts ADD COLUMN retryEvidence TEXT');
    // SQLite cannot drop the legacy inline UNIQUE(operationKey) constraint in place.
    const legacy = database.query<{ origin: string }, []>('PRAGMA index_list(application_attempts)').all().some(i => i.origin === 'u');
    if (legacy) {
      const schema = database.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type='table' AND name='application_attempts'").get()!.sql;
      database.exec(schema.replace(/CREATE TABLE\s+application_attempts/i, 'CREATE TABLE application_attempts_migrated').replace(/operationKey TEXT NOT NULL UNIQUE/i, 'operationKey TEXT NOT NULL'));
      database.exec('INSERT INTO application_attempts_migrated SELECT * FROM application_attempts');
      database.exec('DROP TABLE application_attempts; ALTER TABLE application_attempts_migrated RENAME TO application_attempts');
    }
    database.exec('DROP INDEX IF EXISTS application_attempts_operation');
    database.exec(`CREATE UNIQUE INDEX application_attempts_operation
      ON application_attempts (operationKey) WHERE noRemoteMutation = 0 AND retryAuthorizedAt IS NULL`);
    database.exec(`CREATE TABLE IF NOT EXISTS application_events (
      id INTEGER PRIMARY KEY, attemptId TEXT NOT NULL, at INTEGER NOT NULL,
      event TEXT NOT NULL, failure TEXT
    ); CREATE INDEX IF NOT EXISTS application_events_attempt ON application_events(attemptId, id)`);
    database.exec('DROP INDEX IF EXISTS application_attempts_active_account');
    database.exec(`CREATE UNIQUE INDEX application_attempts_active_account ON application_attempts (accountKey)
      WHERE state IN ('reserved','staging','submitting','outcome_unknown')
      AND (state != 'outcome_unknown' OR accountReleasedAt IS NULL)`);
  }).immediate();
}
