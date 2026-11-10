// UBL 2.1 invoice XML for Jordan's national e-invoicing system (JoFotara, Income and Sales Tax Department).
// Structure follows the ISTD technical guide as published by integrators (ProfileID reporting:1.0, ICV counter,
// seller income-source sequence, UN/ECE 5305 tax categories). Verify against the current official guide
// before going live: the system rejects documents that differ from it.

export interface UblParty {
  /** National ID (NIN), passport (PN) or tax number (TN). */
  idScheme?: 'NIN' | 'PN' | 'TN';
  id?: string;
  name: string;
  phone?: string;
  postalZone?: string;
}

export interface UblLine {
  id: number;
  name: string;
  qty: number;
  /** All amounts in fils (1 JOD = 1000 fils). Unit price before tax. */
  unitNet: number;
  net: number;
  tax: number;
  category: 'S' | 'Z' | 'O';
  rate: number;
}

export interface UblInvoice {
  number: string;
  uuid: string;
  issueDate: string; // YYYY-MM-DD
  /** 388 invoice, 381 credit note. */
  typeCode: '388' | '381';
  /** 011 cash / 021 receivable (general sales invoices). */
  paymentKind: '011' | '021';
  icv: number;
  note?: string;
  sellerTin: string;
  sellerName: string;
  incomeSourceSequence: string;
  buyer: UblParty;
  lines: UblLine[];
  /** For a credit note: the invoice it corrects. */
  original?: { number: string; uuid: string; total: number; reason: string };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Fils → JOD with 3 decimals. JoFotara expects positive amounts on both invoices and credit notes. */
const jd = (fils: number) => (Math.abs(fils) / 1000).toFixed(3);
const amt = (tag: string, fils: number) => `<cbc:${tag} currencyID="JO">${jd(fils)}</cbc:${tag}>`;

export function buildUbl(inv: UblInvoice): string {
  const sum = (f: (l: UblLine) => number) => inv.lines.reduce((a, l) => a + f(l), 0);
  const net = sum((l) => l.net);
  const tax = sum((l) => l.tax);
  const b = inv.buyer;

  const lines = inv.lines.map((l) => `
  <cac:InvoiceLine>
    <cbc:ID>${l.id}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="PCE">${Math.abs(l.qty)}</cbc:InvoicedQuantity>
    ${amt('LineExtensionAmount', l.net)}
    <cac:TaxTotal>
      ${amt('TaxAmount', l.tax)}
      ${amt('RoundingAmount', l.net + l.tax)}
      <cac:TaxSubtotal>
        ${amt('TaxableAmount', l.net)}
        ${amt('TaxAmount', l.tax)}
        <cac:TaxCategory>
          <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">${l.category}</cbc:ID>
          <cbc:Percent>${l.rate}</cbc:Percent>
          <cac:TaxScheme><cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID></cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item><cbc:Name>${esc(l.name)}</cbc:Name></cac:Item>
    <cac:Price>
      ${amt('PriceAmount', l.unitNet)}
      <cac:AllowanceCharge>
        <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
        <cbc:AllowanceChargeReason>DISCOUNT</cbc:AllowanceChargeReason>
        ${amt('Amount', 0)}
      </cac:AllowanceCharge>
    </cac:Price>
  </cac:InvoiceLine>`).join('');

  const billingRef = inv.typeCode === '381' && inv.original ? `
  <cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>${esc(inv.original.number)}</cbc:ID>
      <cbc:UUID>${esc(inv.original.uuid)}</cbc:UUID>
      <cbc:DocumentDescription>${jd(inv.original.total)}</cbc:DocumentDescription>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>` : '';
  const paymentMeans = inv.typeCode === '381' && inv.original ? `
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode listID="UN/ECE 4461">10</cbc:PaymentMeansCode>
    <cbc:InstructionNote>${esc(inv.original.reason)}</cbc:InstructionNote>
  </cac:PaymentMeans>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
  xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${esc(inv.number)}</cbc:ID>
  <cbc:UUID>${esc(inv.uuid)}</cbc:UUID>
  <cbc:IssueDate>${inv.issueDate}</cbc:IssueDate>
  <cbc:InvoiceTypeCode name="${inv.paymentKind}">${inv.typeCode}</cbc:InvoiceTypeCode>
  ${inv.note ? `<cbc:Note>${esc(inv.note)}</cbc:Note>` : ''}
  <cbc:DocumentCurrencyCode>JOD</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>JOD</cbc:TaxCurrencyCode>${billingRef}
  <cac:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>${inv.icv}</cbc:UUID>
  </cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PostalAddress><cac:Country><cbc:IdentificationCode>JO</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${esc(inv.sellerTin)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity><cbc:RegistrationName>${esc(inv.sellerName)}</cbc:RegistrationName></cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      ${b.id ? `<cac:PartyIdentification><cbc:ID schemeID="${b.idScheme ?? 'NIN'}">${esc(b.id)}</cbc:ID></cac:PartyIdentification>` : ''}
      <cac:PostalAddress>
        ${b.postalZone ? `<cbc:PostalZone>${esc(b.postalZone)}</cbc:PostalZone>` : ''}
        <cac:Country><cbc:IdentificationCode>JO</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
      <cac:PartyLegalEntity><cbc:RegistrationName>${esc(b.name)}</cbc:RegistrationName></cac:PartyLegalEntity>
    </cac:Party>
    ${b.phone ? `<cac:AccountingContact><cbc:Telephone>${esc(b.phone)}</cbc:Telephone></cac:AccountingContact>` : ''}
  </cac:AccountingCustomerParty>
  <cac:SellerSupplierParty>
    <cac:Party><cac:PartyIdentification><cbc:ID>${esc(inv.incomeSourceSequence)}</cbc:ID></cac:PartyIdentification></cac:Party>
  </cac:SellerSupplierParty>${paymentMeans}
  <cac:AllowanceCharge>
    <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
    <cbc:AllowanceChargeReason>discount</cbc:AllowanceChargeReason>
    ${amt('Amount', 0)}
  </cac:AllowanceCharge>
  <cac:TaxTotal>
    ${amt('TaxAmount', tax)}
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    ${amt('TaxExclusiveAmount', net)}
    ${amt('TaxInclusiveAmount', net + tax)}
    ${amt('AllowanceTotalAmount', 0)}
    ${amt('PayableAmount', net + tax)}
  </cac:LegalMonetaryTotal>${lines}
</Invoice>
`;
}
