// Tax invoice as the customer receives it: seller and buyer, lines with tax, totals, and the tax authority QR.
// Prints on A4 on its own (see the print rules in styles.css).
import { fmtTime, jod } from './api';
import { Pill } from './ui';
import { Logo } from './icons';

const KIND_AR: Record<string, string> = { VISIT: 'فاتورة خدمة', PERIODIC: 'فاتورة دورية', FINAL: 'فاتورة نهائية' };
const CAT_AR: Record<string, string> = { S: 'خاضع', Z: 'صفر', O: 'معفى' };
const EINV_AR: Record<string, string> = { PENDING: 'بانتظار الإرسال', ACCEPTED: 'مقبولة من دائرة الضريبة', REJECTED: 'مرفوضة', FAILED: 'فشل الإرسال' };

export function InvoiceDoc({ doc }: { doc: any }) {
  const { invoice: inv, seller, buyer, lines, einvoice: e } = doc;
  const credit = inv.total < 0;
  return (
    <article className="invoice-doc" dir="rtl" aria-label={credit ? 'إشعار دائن' : 'فاتورة ضريبية'}>
      <header className="inv-top">
        <div className="inv-seller">
          <Logo size={44} />
          <div>
            <strong>{seller.name || '— (أدخل اسم الشركة بالإعدادات)'}</strong>
            <span className="small muted">الرقم الضريبي: <span className="mono">{seller.tin || '—'}</span></span>
          </div>
        </div>
        <div className="inv-title">
          <h2>{credit ? 'إشعار دائن' : 'فاتورة ضريبية'}</h2>
          <span>{credit ? 'Credit note' : 'Tax invoice'}</span>
        </div>
      </header>

      <section className="inv-head">
        <div><span className="k">رقم الفاتورة</span><strong className="mono">{inv.number}</strong></div>
        <div><span className="k">تاريخ الإصدار</span><span>{fmtTime(inv.issuedAt)}</span></div>
        <div>
          <span className="k">النوع</span>
          <span>{KIND_AR[inv.kind] ?? inv.kind}</span>
          {inv.periodFrom && <span className="small muted mono">{inv.periodFrom.slice(0, 10)} ← {inv.periodTo.slice(0, 10)}</span>}
        </div>
      </section>

      <section className="inv-parties">
        <div>
          <span className="k">البائع</span>
          <strong>{seller.name || '—'}</strong>
          <span className="small">الرقم الضريبي: <span className="mono">{seller.tin || '—'}</span></span>
        </div>
        <div>
          <span className="k">العميل</span>
          <strong>{buyer.full_name}</strong>
          <span className="small">الرقم الوطني: <span className="mono">{buyer.national_id}</span></span>
          {buyer.phone && <span className="small">الهاتف: <span className="mono">{buyer.phone}</span></span>}
        </div>
      </section>

      <div className="table-wrap">
        <table className="mini inv-lines">
          <thead><tr><th>#</th><th>البند</th><th className="tnum">الكمية</th><th className="tnum">قبل الضريبة</th><th className="tnum">الضريبة</th><th className="tnum">المجموع</th></tr></thead>
          <tbody>
            {lines.map((l: any, i: number) => (
              <tr key={l.id}>
                <td className="idx mono">{i + 1}</td>
                <td>{l.name_ar ?? l.description}</td>
                <td className="mono tnum">{Number(l.qty.toFixed(2))}</td>
                <td className="mono tnum">{jod(l.net_amount ?? l.amount)}</td>
                <td className="tnum"><span className="small muted">{CAT_AR[l.tax_category] ?? '—'}{l.tax_category === 'S' ? ` ${l.tax_rate}%` : ''}</span><div className="mono">{jod(l.tax_amount ?? 0)}</div></td>
                <td className="mono tnum">{jod(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="inv-foot">
        <div className="inv-qr">
          {e?.qrSvg ? (
            <>
              <div className="qr" aria-label="رمز QR من دائرة الضريبة" dangerouslySetInnerHTML={{ __html: e.qrSvg }} />
              <span className="small muted">رقم الفاتورة الإلكترونية: <span className="mono">{e.einv_number ?? '—'}</span></span>
              <span className="small muted mono uuid">{e.uuid}</span>
            </>
          ) : (
            <div className="qr-empty">
              <span className="small muted">{e ? EINV_AR[e.status] : 'ما انبعتت لدائرة الضريبة'}</span>
              {e?.message && <span className="small error">{e.message}</span>}
            </div>
          )}
          {e && <Pill status={e.status === 'ACCEPTED' ? 'RESOLVED' : e.status === 'PENDING' ? 'PLANNED' : 'HIGH'} label={EINV_AR[e.status]} />}
        </div>
        <dl className="inv-totals">
          <div><dt>المجموع قبل الضريبة</dt><dd className="mono">{jod(inv.subtotal)}</dd></div>
          <div><dt>الضريبة</dt><dd className="mono">{jod(inv.taxTotal)}</dd></div>
          <div className="grand"><dt>الإجمالي شامل الضريبة</dt><dd className="mono">{jod(inv.total)}</dd></div>
          {inv.payerTotal !== 0 && <div><dt>حصة التأمين</dt><dd className="mono">{jod(inv.payerTotal)}</dd></div>}
          <div className="due"><dt>المطلوب من المريض</dt><dd className="mono">{jod(inv.patientTotal)}</dd></div>
          <div><dt>المدفوع</dt><dd className="mono">{jod(inv.paid)}</dd></div>
        </dl>
      </section>
      <footer className="small muted inv-note">
        <span>{doc.pricesIncludeTax ? 'الأسعار شاملة الضريبة.' : 'الضريبة مضافة على الأسعار.'} المبالغ بالدينار الأردني.</span>
        <span>شكراً لثقتكم.</span>
      </footer>
    </article>
  );
}
