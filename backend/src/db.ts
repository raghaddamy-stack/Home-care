import type { DatabaseSync as DatabaseSyncT, SQLInputValue } from 'node:sqlite';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// Loaded via require so bundlers (vitest/vite) do not strip the `node:` prefix.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export type Row = Record<string, any>;

export class Db {
  readonly raw: DatabaseSyncT;

  constructor(path = ':memory:') {
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
    this.migrate();
  }

  /** Columns added to existing tables after the first release. Idempotent: only adds what is missing. */
  private migrate() {
    const add = (table: string, column: string, ddl: string) => {
      const cols = this.raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === column)) this.raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    };
    // BR-12 quote validity.
    add('quotes', 'valid_until', 'TEXT');
    // §5.5 escalation timers.
    add('escalations', 'due_at', 'TEXT');
    add('escalations', 'escalated_at', 'TEXT');
    add('escalations', 'escalated_to', 'TEXT');
    add('escalations', 'recheck_requested_at', 'TEXT');
    add('results', 'escalated_at', 'TEXT');
    // BR-23 cancellation fee and BR-24 no-show tracking on the visit.
    add('visits', 'cancelled_at', 'TEXT');
    add('visits', 'cancel_fee', 'INTEGER');
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.raw.prepare(sql).run(...params).lastInsertRowid);
  }

  /** Insert a row from an object, skipping undefined values. Returns the new id. */
  insert(table: string, data: Record<string, unknown>): number {
    const entries = Object.entries(data).filter(([, v]) => v !== undefined);
    const cols = entries.map(([k]) => k).join(', ');
    const qs = entries.map(() => '?').join(', ');
    return this.run(`INSERT INTO ${table} (${cols}) VALUES (${qs})`, ...entries.map(([, v]) => toSql(v)));
  }

  update(table: string, id: number, data: Record<string, unknown>): void {
    const entries = Object.entries(data).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const set = entries.map(([k]) => `${k} = ?`).join(', ');
    this.run(`UPDATE ${table} SET ${set} WHERE id = ?`, ...entries.map(([, v]) => toSql(v)), id);
  }

  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }
}

function toSql(v: unknown): SQLInputValue {
  if (v === null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Array.isArray(v) || typeof v === 'object') return JSON.stringify(v);
  return v as SQLInputValue;
}
