// Stock in the ERP: check availability before anything is dispensed, then post the goods issue.
// Providers: MOCK (demo warehouse in this database), GENERIC (simple REST contract, see docs) and
// SAP S/4HANA (OData: API_MATERIAL_STOCK_SRV to read, API_MATERIAL_DOCUMENT_SRV to post).
import type { Db } from './db.js';
import { HttpError, notify } from './http.js';
import { cfg } from './settings.js';
import { emit } from './webhooks.js';

export interface StockItem { material: string; qty: number }
export interface StockLine extends StockItem { available: number | null; enough: boolean | null }
export interface StockCheck { checked: boolean; lines: StockLine[]; warnings: string[]; error?: string }

const sapEsc = (s: string) => s.replace(/'/g, "''");

function authHeaders(): Record<string, string> {
  const s = cfg();
  if (s.stockUser) return { Authorization: 'Basic ' + Buffer.from(`${s.stockUser}:${s.stockApiKey}`).toString('base64') };
  return s.stockApiKey ? { Authorization: `Bearer ${s.stockApiKey}` } : {};
}

/** Materials a delivered service consumes: the explicit list when given, else the service's mapped material. */
export function itemsFor(serviceCode: string, qty: number, explicit?: StockItem[]): StockItem[] {
  if (explicit?.length) return explicit.filter((i) => i.material && i.qty > 0);
  const mat = cfg().stockMaterials[serviceCode];
  return mat ? [{ material: mat, qty }] : [];
}

async function availableOne(db: Db, material: string, fetchImpl: typeof fetch): Promise<number> {
  const s = cfg();
  if (s.stockProvider === 'MOCK') return db.get<{ available: number }>('SELECT available FROM stock_mock WHERE material = ?', material)?.available ?? 0;
  const base = s.stockBaseUrl.replace(/\/$/, '');
  if (s.stockProvider === 'GENERIC') {
    const q = new URLSearchParams({ material, plant: s.stockPlant, location: s.stockLocation });
    const res = await fetchImpl(`${base}/stock?${q}`, { headers: { Accept: 'application/json', ...authHeaders() }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`ERP stock HTTP ${res.status}`);
    const j: any = await res.json();
    return Number(j.available ?? 0);
  }
  // SAP: unrestricted stock (InventoryStockType 01) of the material in the plant / storage location.
  const filter = [`Material eq '${sapEsc(material)}'`, s.stockPlant && `Plant eq '${sapEsc(s.stockPlant)}'`, s.stockLocation && `StorageLocation eq '${sapEsc(s.stockLocation)}'`, `InventoryStockType eq '01'`].filter(Boolean).join(' and ');
  const url = `${base}/sap/opu/odata/sap/API_MATERIAL_STOCK_SRV/A_MatlStkInAcctMod?$format=json&$filter=${encodeURIComponent(filter)}`;
  const res = await fetchImpl(url, { headers: { Accept: 'application/json', ...authHeaders() }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`SAP stock HTTP ${res.status}`);
  const j: any = await res.json();
  return (j?.d?.results ?? []).reduce((a: number, r: any) => a + Number(r.MatlWrhsStkQtyInMatlBaseUnit ?? 0), 0);
}

/** Ask the ERP whether every item is available. Never throws: an outage is reported in `error`. */
export async function checkStock(db: Db, items: StockItem[], fetchImpl: typeof fetch = fetch): Promise<StockCheck> {
  const s = cfg();
  if (s.stockProvider === 'OFF' || !items.length) return { checked: false, lines: items.map((i) => ({ ...i, available: null, enough: null })), warnings: [] };
  // The same material twice counts once with the summed quantity.
  const need = new Map<string, number>();
  for (const i of items) need.set(i.material, (need.get(i.material) ?? 0) + i.qty);
  try {
    const lines: StockLine[] = [];
    for (const [material, qty] of need) {
      const available = await availableOne(db, material, fetchImpl);
      lines.push({ material, qty, available, enough: available >= qty });
    }
    const short = lines.filter((l) => !l.enough);
    return { checked: true, lines, warnings: short.map((l) => `Not enough stock of ${l.material}: need ${l.qty}, available ${l.available}`) };
  } catch (e) {
    return { checked: false, lines: [...need].map(([material, qty]) => ({ material, qty, available: null, enough: null })), warnings: [], error: (e as Error).message };
  }
}

/** Apply the owner's policy: block when short (BLOCK) or when the ERP is unreachable (stockOnError BLOCK). */
export async function ensureStock(db: Db, items: StockItem[], fetchImpl: typeof fetch = fetch): Promise<StockCheck> {
  const s = cfg();
  const c = await checkStock(db, items, fetchImpl);
  if (c.error) {
    if (s.stockOnError === 'BLOCK') throw new HttpError(503, `Stock could not be checked in the ERP (${c.error}). Try again or ask the store.`);
    c.warnings.push(`Stock not checked: ERP unreachable (${c.error}). The goods issue will be posted when it is back.`);
  } else if (c.warnings.length && s.stockMode === 'BLOCK') {
    throw new HttpError(409, c.warnings.join('; '));
  }
  return c;
}

/** Record what was dispensed; the background job posts it to the ERP. Call inside the delivering transaction. */
export function queueGoodsIssue(db: Db, items: StockItem[], ctx: { reference: string; serviceCode?: string; patientId?: number; staffId?: number }) {
  if (cfg().stockProvider === 'OFF') return [];
  return items.map((i) => db.insert('stock_movements', {
    reference: ctx.reference, material: i.material, qty: i.qty, service_code: ctx.serviceCode, patient_id: ctx.patientId, created_by: ctx.staffId,
  }));
}

const BACKOFF_MIN = [1, 5, 15, 60, 240];

async function postOne(db: Db, m: any, fetchImpl: typeof fetch): Promise<string> {
  const s = cfg();
  if (s.stockProvider === 'MOCK') {
    db.run('UPDATE stock_mock SET available = available - ? WHERE material = ?', m.qty, m.material);
    return `MOCK-${m.id}`;
  }
  const base = s.stockBaseUrl.replace(/\/$/, '');
  if (s.stockProvider === 'GENERIC') {
    const res = await fetchImpl(`${base}/goods-issues`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...authHeaders() }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ reference: m.reference, plant: s.stockPlant, location: s.stockLocation, movementType: s.stockMovementType, costCenter: s.erpCostCenter, items: [{ material: m.material, qty: m.qty }] }),
    });
    if (!res.ok) throw new Error(`ERP goods issue HTTP ${res.status}`);
    const j: any = await res.json().catch(() => ({}));
    return String(j.documentNo ?? j.id ?? 'OK');
  }
  // SAP: fetch a CSRF token (and session cookie), then post a goods-issue material document (code 03).
  const svc = `${base}/sap/opu/odata/sap/API_MATERIAL_DOCUMENT_SRV`;
  const t = await fetchImpl(`${svc}/`, { headers: { 'x-csrf-token': 'fetch', Accept: 'application/json', ...authHeaders() }, signal: AbortSignal.timeout(15_000) });
  const token = t.headers.get('x-csrf-token') ?? '';
  const cookie = t.headers.get('set-cookie')?.split(',').map((c) => c.split(';')[0]).join('; ') ?? '';
  const day = `/Date(${Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())})/`;
  const res = await fetchImpl(`${svc}/A_MaterialDocumentHeader`, {
    method: 'POST', signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': token, ...(cookie ? { Cookie: cookie } : {}), ...authHeaders() },
    body: JSON.stringify({
      GoodsMovementCode: '03', PostingDate: day, DocumentDate: day, MaterialDocumentHeaderText: m.reference.slice(0, 25),
      to_MaterialDocumentItem: { results: [{
        Material: m.material, Plant: s.stockPlant, StorageLocation: s.stockLocation, GoodsMovementType: s.stockMovementType,
        QuantityInEntryUnit: String(m.qty), CostCenter: s.erpCostCenter || undefined,
      }] },
    }),
  });
  if (!res.ok) throw new Error(`SAP goods issue HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j: any = await res.json();
  return String(j?.d?.MaterialDocument ?? 'OK');
}

/** Post pending / due goods issues. The server runs this in its background jobs. */
export async function processStockQueue(db: Db, fetchImpl: typeof fetch = fetch): Promise<{ posted: number; failed: number }> {
  if (cfg().stockProvider === 'OFF') return { posted: 0, failed: 0 };
  const due = db.all(
    `SELECT * FROM stock_movements WHERE status = 'PENDING' OR (status = 'FAILED' AND attempts < ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?)) ORDER BY id LIMIT 50`,
    BACKOFF_MIN.length + 1, new Date().toISOString(),
  );
  let posted = 0, failed = 0;
  for (const m of due) {
    try {
      const doc = await postOne(db, m, fetchImpl);
      db.update('stock_movements', m.id, { status: 'POSTED', erp_document: doc, posted_at: new Date(), attempts: m.attempts + 1, last_error: null });
      emit(db, 'stock.issued', { movementId: m.id, reference: m.reference, material: m.material, qty: m.qty, erpDocument: doc });
      posted++;
    } catch (e) {
      const wait = BACKOFF_MIN[Math.min(m.attempts, BACKOFF_MIN.length - 1)];
      db.update('stock_movements', m.id, { status: 'FAILED', attempts: m.attempts + 1, last_error: (e as Error).message.slice(0, 300), next_attempt_at: new Date(Date.now() + wait * 60_000) });
      if (m.attempts + 1 === BACKOFF_MIN.length + 1) notify(db, 'role:ADMIN', 'PUSH', `Goods issue ${m.reference} (${m.material}) could not be posted to the ERP`);
      failed++;
    }
  }
  return { posted, failed };
}
