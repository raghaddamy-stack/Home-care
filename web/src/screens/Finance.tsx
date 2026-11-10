// Finance: run the weekly / monthly billing cycle, review against attendance, issue and collect.
import { useState } from 'react';
import { api, fmtTime, jod } from '../api';
import { Drawer, Empty, Field, Pill, useAction, useLoad } from '../ui';
import { InvoiceDoc } from '../InvoiceDoc';

const KIND_AR: Record<string, string> = { VISIT: 'زيارة', PERIODIC: 'دورية', FINAL: 'نهائية' };
const EINV_PILL: Record<string, [string, string]> = {
  ACCEPTED: ['RESOLVED', 'مقبولة'], PENDING: ['PLANNED', 'بالانتظار'], REJECTED: ['HIGH', 'مرفوضة'], FAILED: ['LATE', 'فشل'],
};

/** Tax authority monitor: setup gaps, failures with reasons, invoices never sent. */
function EInvoiceMonitor() {
  const data = useLoad(() => api.get<any>('/einvoices'));
  const { busy, run } = useAction();
  const d = data.data;
  if (!d) return <p className="muted">تحميل…</p>;
  const send = (id: number) => run(async () => {
    const r = await api.post<any>(`/invoices/${id}/einvoice`);
    data.reload();
    if (r.status !== 'ACCEPTED') throw new Error(`ما انقبلت: ${r.message ?? r.status}`);
  }, 'انقبلت من دائرة الضريبة');
  return (
    <div className="stack">
      {d.provider === 'NONE' && <div className="notice warn">الربط مع دائرة الضريبة متوقف. المالك بيشغّله من إعدادات المالك ← الفوترة الإلكترونية.</div>}
      {d.provider !== 'NONE' && d.setupProblems.length > 0 && <div className="notice bad">ناقص بالإعدادات: {d.setupProblems.join('، ')}</div>}
      <div className="card">
        <div className="card-head">
          <h2>الفوترة الإلكترونية {d.provider === 'MOCK' && <Pill status="PLANNED" label="وضع تجريبي" />}</h2>
          <button className="secondary" disabled={busy || d.provider === 'NONE'} onClick={() => run(async () => { await api.post('/einvoices/process'); data.reload(); }, 'تمت معالجة قائمة الإرسال')}>أرسل المعلّق الآن</button>
        </div>
        <div className="row-tight">{d.counts.map((c: any) => <Pill key={c.status} status={EINV_PILL[c.status]?.[0] ?? 'PLANNED'} label={`${EINV_PILL[c.status]?.[1] ?? c.status}: ${c.n}`} />)}</div>
        {!d.items.length && <Empty>ما انبعتت ولا فاتورة بعد.</Empty>}
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>الفاتورة</th><th>المريض</th><th>الإجمالي</th><th>النوع</th><th>الحالة</th><th>رقم/سبب</th><th></th></tr></thead>
            <tbody>
              {d.items.map((x: any) => (
                <tr key={x.id}>
                  <td className="mono">{x.invoice_no}</td><td>{x.full_name}</td><td className="mono">{jod(x.total)}</td>
                  <td className="small">{x.type_code === '381' ? 'إشعار دائن' : 'فاتورة'} · ICV {x.icv}</td>
                  <td><Pill status={EINV_PILL[x.status][0]} label={EINV_PILL[x.status][1]} /></td>
                  <td className="small">{x.status === 'ACCEPTED' ? <span className="mono">{x.einv_number}</span> : <span className="error">{x.message}</span>}</td>
                  <td>{x.status !== 'ACCEPTED' && <button className="secondary" disabled={busy || d.provider === 'NONE'} onClick={() => send(x.invoice_id)}>إعادة إرسال</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {d.notSent.length > 0 && (
        <div className="card">
          <h2>فواتير صادرة وما انبعتت</h2>
          <ul className="list">
            {d.notSent.map((x: any) => (
              <li key={x.id} className="list-row"><span className="mono">{x.invoice_no} · {jod(x.total)}</span>
                <button className="secondary" disabled={busy || d.provider === 'NONE'} onClick={() => send(x.id)}>إرسال</button></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function Finance() {
  const [tab, setTab] = useState<'invoices' | 'einvoice'>('invoices');
  return (
    <>
      <div className="subtabs" role="tablist">
        <button role="tab" aria-selected={tab === 'invoices'} className={tab === 'invoices' ? 'on' : ''} onClick={() => setTab('invoices')}>الفواتير</button>
        <button role="tab" aria-selected={tab === 'einvoice'} className={tab === 'einvoice' ? 'on' : ''} onClick={() => setTab('einvoice')}>الفوترة الإلكترونية (الضريبة)</button>
      </div>
      {tab === 'invoices' ? <Invoices /> : <EInvoiceMonitor />}
    </>
  );
}

function Invoices() {
  const list = useLoad(() => api.get<any[]>('/invoices'));
  const { busy, run } = useAction();
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const [open, setOpen] = useState<number | null>(null);
  const inv = useLoad(() => (open ? api.get<any>(`/invoices/${open}`) : Promise.resolve(null)), [open]);
  const [method, setMethod] = useState('CASH');
  const [amount, setAmount] = useState('');
  const d = inv.data;
  const [showDoc, setShowDoc] = useState(false);
  const doc = useLoad(() => (open && showDoc ? api.get<any>(`/invoices/${open}/document`) : Promise.resolve(null)), [open, showDoc]);
  const paid = d?.payments.reduce((a: number, p: any) => a + p.amount, 0) ?? 0;
  const refresh = () => { inv.reload(); list.reload(); };

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>الفواتير</h2>
          <div className="row">
            <Field label="تاريخ التشغيل" hint="بتطلع فواتير الفترة المنتهية قبل هالتاريخ"><input id="asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
            <button className="primary" disabled={busy} onClick={() => run(async () => {
              const r = await api.post<{ created: number[] }>('/billing/run', { asOf: new Date(asOf + 'T12:00:00').toISOString() });
              list.reload();
              if (!r.created.length) throw new Error('ما في شي جديد للفوترة بهالفترة');
            }, 'طلعت الفواتير الدورية كمسودات')}>تشغيل الفوترة الدورية</button>
          </div>
        </div>
        {!list.data?.length && <Empty>ما في فواتير بعد.</Empty>}
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>الرقم</th><th>العميل</th><th>النوع</th><th>الفترة</th><th>الإجمالي</th><th>الضريبة</th><th>المريض</th><th>الحالة</th><th>الضريبة الإلكترونية</th><th></th></tr></thead>
            <tbody>
              {list.data?.map((i) => (
                <tr key={i.id}>
                  <td className="mono">{i.invoice_no}</td><td>{i.full_name}</td><td>{KIND_AR[i.kind]}</td>
                  <td className="small">{i.period_from ? `${i.period_from.slice(0, 10)} ← ${i.period_to.slice(0, 10)}` : fmtTime(i.created_at)}</td>
                  <td className="mono">{jod(i.total)}</td><td className="mono">{jod(i.tax_total ?? 0)}</td><td className="mono">{jod(i.patient_total)}</td>
                  <td><Pill status={i.status} /></td>
                  <td>{i.einvoice_status ? <Pill status={EINV_PILL[i.einvoice_status][0]} label={EINV_PILL[i.einvoice_status][1]} /> : <span className="small muted">—</span>}</td>
                  <td><button className="secondary" onClick={() => { setOpen(i.id); setAmount(''); setShowDoc(false); }}>فتح</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <Drawer open={open !== null} onClose={() => setOpen(null)} title={d ? `${d.invoice_no} · ${KIND_AR[d.kind]}` : 'تحميل…'}>
        {d && (
          <div className="stack">
            <div className="row-tight no-print">
              <button className="secondary" onClick={() => setShowDoc(!showDoc)}>{showDoc ? 'عرض البنود' : 'الفاتورة الضريبية'}</button>
              {showDoc && <button className="ghost" onClick={() => window.print()}>طباعة</button>}
              {d.status !== 'DRAFT' && (
                <button className="ghost" disabled={busy} onClick={() => run(async () => {
                  const r = await api.post<any>(`/invoices/${d.id}/einvoice`);
                  doc.reload(); refresh();
                  if (r.status !== 'ACCEPTED') throw new Error(`ما انقبلت: ${r.message ?? r.status}`);
                }, 'انقبلت من دائرة الضريبة')}>إرسال لدائرة الضريبة</button>
              )}
            </div>
            {showDoc && doc.data && <InvoiceDoc doc={doc.data} />}
            {!showDoc && <table className="mini">
              <thead><tr><th>البند</th><th>الكمية</th><th>السعر</th><th>المبلغ</th><th>المريض</th></tr></thead>
              <tbody>{d.lines.map((l: any) => <tr key={l.id}><td>{l.description}</td><td className="mono">{l.qty}</td><td className="mono">{jod(l.unit_price)}</td><td className="mono">{jod(l.amount)}</td><td className="mono">{jod(l.patient_amount)}</td></tr>)}</tbody>
              <tfoot><tr><td colSpan={3}>المجموع</td><td className="mono">{jod(d.total)}</td><td className="mono"><strong>{jod(d.patient_total)}</strong></td></tr></tfoot>
            </table>}
            {d.status === 'DRAFT' && (
              <button className="primary" disabled={busy} onClick={() => run(async () => { await api.post(`/invoices/${d.id}/issue`); refresh(); }, 'صدرت الفاتورة وانبعتت للمريض')}>مطابقة مع الحضور وإصدار</button>
            )}
            {['ISSUED', 'PARTIALLY_PAID'].includes(d.status) && (
              <section className="action">
                <h3>تسجيل دفعة · المتبقي <span className="mono">{jod(Math.max(0, d.patient_total - paid))}</span></h3>
                <div className="grid-2">
                  <Field label="الطريقة"><select value={method} onChange={(e) => setMethod(e.target.value)}><option value="CASH">كاش</option><option value="CARD">بطاقة</option><option value="LINK">رابط دفع</option><option value="TRANSFER">تحويل</option><option value="CLIQ">CliQ</option></select></Field>
                  <Field label="المبلغ (د.أ)"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
                </div>
                <button className="primary" disabled={busy || !amount} onClick={() => run(async () => { await api.post(`/invoices/${d.id}/payments`, { method, amount: Math.round(Number(amount) * 1000) }); setAmount(''); refresh(); }, 'تم تسجيل الدفعة')}>تسجيل</button>
              </section>
            )}
            {d.payments.length > 0 && (
              <ul className="list">{d.payments.map((p: any) => <li key={p.id} className="list-row"><span>{p.method} · {fmtTime(p.at)}</span><span className="mono">{jod(p.amount)}</span></li>)}</ul>
            )}
          </div>
        )}
      </Drawer>
    </>
  );
}
