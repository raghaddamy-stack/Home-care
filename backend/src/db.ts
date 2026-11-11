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
    // Owner settings: gender preference and nursing billed in advance.
    add('patients', 'preferred_staff_gender', "TEXT CHECK (preferred_staff_gender IN ('M','F'))");
    add('shifts', 'advance_minutes', 'INTEGER');
    add('shifts', 'adjusted_at', 'TEXT');
    // Tax on invoices and ERP integration.
    add('invoice_lines', 'service_code', 'TEXT');
    add('invoice_lines', 'tax_line', 'TEXT');
    add('invoice_lines', 'tax_category', 'TEXT');
    add('invoice_lines', 'tax_rate', 'REAL');
    add('invoice_lines', 'net_amount', 'INTEGER');
    add('invoice_lines', 'tax_amount', 'INTEGER');
    add('invoices', 'subtotal', 'INTEGER');
    add('invoices', 'tax_total', 'INTEGER');
    add('invoices', 'issued_at', 'TEXT');
    add('invoices', 'erp_ref', 'TEXT');
    add('invoices', 'erp_synced_at', 'TEXT');
    add('invoices', 'updated_at', 'TEXT');
    add('payers', 'erp_code', 'TEXT');
    add('patients', 'erp_code', 'TEXT');
    add('patients', 'updated_at', 'TEXT');
    // Closing every lifecycle loop: billed orders, credit notes, insurer receivable, episode closure, rental return.
    add('orders', 'invoice_id', 'INTEGER');
    add('invoices', 'credit_for', 'INTEGER');
    add('invoices', 'void_reason', 'TEXT');
    add('invoices', 'payer_paid', 'INTEGER NOT NULL DEFAULT 0');
    add('episodes', 'closed_at', 'TEXT');
    add('episodes', 'hold_reason', 'TEXT');
    add('episodes', 'final_billed_at', 'TEXT');
    add('rentals', 'return_condition', 'TEXT');
    add('rentals', 'damage_charge', 'INTEGER');
    add('rentals', 'paid_days', 'INTEGER');
    add('rentals', 'return_invoice_id', 'INTEGER');
    this.raw.exec(`UPDATE invoices SET updated_at = created_at WHERE updated_at IS NULL; UPDATE patients SET updated_at = created_at WHERE updated_at IS NULL;`);
    // Keep updated_at current so the ERP can pull changes since its last sync.
    this.raw.exec(`
      CREATE TRIGGER IF NOT EXISTS invoices_touch AFTER UPDATE ON invoices
        WHEN NEW.updated_at IS OLD.updated_at
        BEGIN UPDATE invoices SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
      CREATE TRIGGER IF NOT EXISTS invoices_touch_insert AFTER INSERT ON invoices
        BEGIN UPDATE invoices SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
      CREATE TRIGGER IF NOT EXISTS payments_touch_invoice AFTER INSERT ON payments
        BEGIN UPDATE invoices SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.invoice_id; END;
      CREATE TRIGGER IF NOT EXISTS patients_touch AFTER UPDATE ON patients
        WHEN NEW.updated_at IS OLD.updated_at
        BEGIN UPDATE patients SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
    `);
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
