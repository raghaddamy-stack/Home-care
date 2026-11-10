// Sales tax on invoice lines (Jordan general sales tax by default). Category and rate per revenue line
// come from owner settings; prices may already include tax (default) or have it added on top.
import { cfg, type TaxCategory, type TaxLine } from '../settings.js';

export interface LineTax {
  taxLine: TaxLine;
  category: TaxCategory;
  rate: number;
  /** Amount before tax, fils. */
  net: number;
  tax: number;
  /** Amount including tax, fils. */
  gross: number;
}

/** Tax for one line amount (fils, may be negative for credits). */
export function taxFor(taxLine: TaxLine, amount: number): LineTax {
  const s = cfg();
  const { category, rate } = s.taxRules[taxLine];
  if (s.pricesIncludeTax) {
    const net = Math.round((amount * 100) / (100 + rate));
    return { taxLine, category, rate, net, tax: amount - net, gross: amount };
  }
  const tax = Math.round((amount * rate) / 100);
  return { taxLine, category, rate, net: amount, tax, gross: amount + tax };
}

/** Revenue line of an invoice line: the service's line when known, otherwise from the source. */
export function taxLineFor(sourceType: string, serviceLine?: string | null): TaxLine {
  if (serviceLine && ['LAB', 'IMG', 'DEV', 'DOC', 'NRS'].includes(serviceLine)) return serviceLine as TaxLine;
  if (sourceType.startsWith('SHIFT')) return 'NRS';
  if (sourceType === 'RENTAL') return 'DEV';
  return 'FEE';
}

/** Split a line's tax between payer and patient in proportion to their shares (amounts are pre-tax when tax is added on top). */
export function splitShares(t: LineTax, payer: number, patient: number): { payerGross: number; patientGross: number } {
  if (cfg().pricesIncludeTax) return { payerGross: payer, patientGross: patient };
  const base = payer + patient;
  const payerTax = base === 0 ? 0 : Math.round((t.tax * payer) / base);
  return { payerGross: payer + payerTax, patientGross: patient + (t.tax - payerTax) };
}
