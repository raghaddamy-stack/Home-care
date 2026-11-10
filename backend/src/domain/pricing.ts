// Quote calculation (BRD §5.2). Money is integer fils (1 JOD = 1000 fils).

export interface PriceItem {
  serviceCode: string;
  unitPrice: number; // fils
}

export interface QuoteInputLine {
  serviceCode: string;
  qty: number;
}

export interface Coverage {
  /** Patient co-pay share, 0..100. */
  copayPct: number;
  /** Maximum co-pay per quote in fils; undefined = no cap. */
  copayCap?: number;
  coveredCodes: string[];
}

export interface QuoteLine {
  serviceCode: string;
  qty: number;
  unitPrice: number;
  gross: number;
  discount: number;
  net: number;
  payerShare: number;
  patientShare: number;
}

export interface Quote {
  lines: QuoteLine[];
  total: number;
  payerTotal: number;
  patientTotal: number;
}

export const AFTER_HOURS_MULTIPLIER = 1.25;
/** Max discount a coordinator may give without manager approval (BR-11). */
export const COORDINATOR_DISCOUNT_LIMIT = 10;

/** 20:00–07:00 or Friday counts as after-hours (BR-16). */
export function isAfterHours(at: Date): boolean {
  const h = at.getHours();
  return at.getDay() === 5 || h >= 20 || h < 7;
}

export function buildQuote(
  lines: QuoteInputLine[],
  prices: PriceItem[],
  opts: { discountPct?: number; scheduledAt?: Date; coverage?: Coverage } = {},
): Quote {
  const discountPct = opts.discountPct ?? 0;
  if (discountPct < 0 || discountPct > 100) throw new Error('discountPct must be 0..100');
  const multiplier = opts.scheduledAt && isAfterHours(opts.scheduledAt) ? AFTER_HOURS_MULTIPLIER : 1;

  const out: QuoteLine[] = lines.map((l) => {
    const p = prices.find((x) => x.serviceCode === l.serviceCode);
    if (!p) throw new Error(`No price for service ${l.serviceCode}`);
    const unitPrice = Math.round(p.unitPrice * multiplier);
    const gross = unitPrice * l.qty;
    const discount = Math.round((gross * discountPct) / 100);
    const net = gross - discount;
    const covered = opts.coverage?.coveredCodes.includes(l.serviceCode) ?? false;
    const patientShare = covered ? Math.round((net * opts.coverage!.copayPct) / 100) : net;
    return { serviceCode: l.serviceCode, qty: l.qty, unitPrice, gross, discount, net, payerShare: net - patientShare, patientShare };
  });

  // Apply the co-pay cap across covered lines, moving the excess back to the payer.
  const cap = opts.coverage?.copayCap;
  if (cap !== undefined) {
    let copay = out
      .filter((l) => opts.coverage!.coveredCodes.includes(l.serviceCode))
      .reduce((a, l) => a + l.patientShare, 0);
    for (const l of out) {
      if (copay <= cap) break;
      if (!opts.coverage!.coveredCodes.includes(l.serviceCode)) continue;
      const reduce = Math.min(l.patientShare, copay - cap);
      l.patientShare -= reduce;
      l.payerShare += reduce;
      copay -= reduce;
    }
  }

  const sum = (k: keyof QuoteLine) => out.reduce((a, l) => a + (l[k] as number), 0);
  return { lines: out, total: sum('net'), payerTotal: sum('payerShare'), patientTotal: sum('patientShare') };
}
