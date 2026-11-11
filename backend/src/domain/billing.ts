// Billing periods and invoice line building (BRD §5.7).

export type BillingCycle = 'PER_VISIT' | 'WEEKLY' | 'MONTHLY';

export interface Period {
  from: Date; // inclusive
  to: Date; // exclusive
}

/** The most recent closed period before `asOf`. Weeks start Saturday (Jordan work week). */
export function previousPeriod(cycle: Exclude<BillingCycle, 'PER_VISIT'>, asOf: Date): Period {
  const d = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate());
  if (cycle === 'MONTHLY') {
    const to = new Date(d.getFullYear(), d.getMonth(), 1);
    const from = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    return { from, to };
  }
  const sinceSaturday = (d.getDay() + 1) % 7; // Sat=0
  const to = new Date(d.getFullYear(), d.getMonth(), d.getDate() - sinceSaturday);
  const from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - 7);
  return { from, to };
}

export interface BillableSource {
  sourceType: 'SHIFT' | 'SHIFT_PLANNED' | 'SHIFT_ADJUST' | 'VISIT' | 'RENTAL' | 'SUPPLY' | 'ORDER';
  /** Service billed, for tax and insurer coverage of this line. */
  serviceCode?: string;
  sourceId: number;
  description: string;
  qty: number;
  unitPrice: number; // fils
}

export interface InvoiceLineDraft extends BillableSource {
  amount: number;
  payerAmount: number;
  patientAmount: number;
}

export function buildInvoiceLines(sources: BillableSource[], copayPct: number | null): InvoiceLineDraft[] {
  return sources.map((s) => {
    const amount = Math.round(s.qty * s.unitPrice);
    const patientAmount = copayPct === null ? amount : Math.round((amount * copayPct) / 100);
    return { ...s, amount, patientAmount, payerAmount: amount - patientAmount };
  });
}

/** Rental days that fall inside the period. */
export function rentalDaysInPeriod(start: Date, end: Date | null, p: Period): number {
  const from = Math.max(start.getTime(), p.from.getTime());
  const to = Math.min((end ?? p.to).getTime(), p.to.getTime());
  return Math.max(0, Math.ceil((to - from) / 86_400_000));
}

/** The period right after `p` (same cycle), used when nursing is billed in advance. */
export function nextPeriod(cycle: Exclude<BillingCycle, 'PER_VISIT'>, p: Period): Period {
  const from = p.to;
  const to = cycle === 'MONTHLY'
    ? new Date(from.getFullYear(), from.getMonth() + 1, 1)
    : new Date(from.getFullYear(), from.getMonth(), from.getDate() + 7);
  return { from, to };
}
