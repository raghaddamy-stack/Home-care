// Finance: run the weekly / monthly billing cycle, review against attendance, issue and collect.
import { useState } from 'react';
import { api, fmtTime, jod } from '../api';
import { Drawer, Empty, Field, Loading, Pill, useAction, useLoad } from '../ui';
import { Icon } from '../icons';
import { InvoiceDoc } from '../InvoiceDoc';

const KIND_AR: Record<string, string> = { VISIT: 'زيارة', PERIODIC: 'دورية', FINAL: 'نهائية' };
const METHOD_AR: Record<string, string> = { CASH: 'كاش', CARD: 'بطاقة', LINK: 'رابط دفع', TRANSFER: 'تحويل', CLIQ: 'CliQ' };
const EINV_PILL: Record<string, [string, string]> = {
  ACCEPTED: ['RESOLVED', 'مقبولة'], PENDING: ['PLANNED', 'بالانتظار'], REJECTED: ['HIGH', 'مرفوضة'], FAILED: ['LATE', 'فشل'],
};

/** Tax authority monitor: setup gaps, failures with reasons, invoices never sent. */
function EInvoiceMonitor() {
  const data = useLoad(() => api.get<any>('/einvoices'));
  const { busy, run } = useAction();
  const d = data.data;
  if (!d) return data.error ? <div className="notice bad">{data.error}</div> : <Loading card />;
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
          <div>
            <h2>الفوترة الإلكترونية (JoFotara) {d.provider === 'MOCK' && <Pill status="PLANNED" label="وضع تجريبي" />}</h2>
            <p>كل فاتورة صادرة بتنبعت لدائرة ضريبة الدخل والمبيعات وبترجع برقم و QR.</p>
          </div>
          <button className="secondary" disabled={busy || d.provider === 'NONE'} onClick={() => run(async () => { await api.post('/einvoices/process'); data.reload(); }, 'تمت معالجة قائمة الإرسال')}><Icon name="send" />أرسل المعلّق الآن</button>
        </div>
        <div className="row-tight">{d.counts.map((c: any) => <Pill key={c.status} status={EINV_PILL[c.status]?.[0] ?? 'PLANNED'} label={`${EINV_PILL[c.status]?.[1] ?? c.status}: ${c.n}`} />)}</div>
        {!d.items.length && <Empty icon="receipt" title="ما انبعتت ولا فاتورة بعد">أول ما تصدر فاتورة بتنبعت تلقائياً وبتظهر هون.</Empty>}
        {!!d.items.length && <div className="table-wrap">
          <table className="table stack-sm">
            <thead><tr><th>الفاتورة</th><th>المريض</th><th className="tnum">الإجمالي</th><th>النوع</th><th>الحالة</th><th>رقم / سبب</th><th><span className="sr-only">إجراء</span></th></tr></thead>
            <tbody>
              {d.items.map((x: any) => (
                <tr key={x.id}>
                  <td data-label="الفاتورة" className="lead"><span className="mono">{x.invoice_no}</span></td>
                  <td data-label="المريض">{x.full_name}</td>
                  <td data-label="الإجمالي" className="mono tnum">{jod(x.total)}</td>
                  <td data-label="النوع" className="small">{x.type_code === '381' ? 'إشعار دائن' : 'فاتورة'} · <span className="mono">ICV {x.icv}</span></td>
                  <td data-label="الحالة"><Pill status={EINV_PILL[x.status][0]} label={EINV_PILL[x.status][1]} /></td>
                  <td data-label="رقم/سبب" className="small">{x.status === 'ACCEPTED' ? <span className="mono">{x.einv_number}</span> : <span className="error">{x.message}</span>}</td>
                  <td data-label="" className="act">{x.status !== 'ACCEPTED' && <button className="secondary" disabled={busy || d.provider === 'NONE'} onClick={() => send(x.invoice_id)}>إعادة إرسال</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>}
      </div>
      {d.notSent.length > 0 && (
        <div className="card">
          <div className="card-head"><div><h2>فواتير صادرة وما انبعتت</h2><p>صدرت قبل تشغيل الربط أو فشل إرسالها. ابعتها من هون.</p></div></div>
          <ul className="list">
            {d.notSent.map((x: any) => (
              <li key={x.id} className="list-row"><span><span className="mono">{x.invoice_no}</span> · <span className="mono">{jod(x.total)}</span></span>
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
        <button role="tab" aria-selected={tab === 'invoices'} className={tab === 'invoices' ? 'on' : ''} onClick={() => setTab('invoices')}>الفواتير والتحصيل</button>
        <button role="tab" aria-selected={tab === 'einvoice'} className={tab === 'einvoice' ? 'on' : ''} onClick={() => setTab('einvoice')}>الفوترة الإلكترونية</button>
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
        <div className="card-head" style={{ alignItems: 'flex-end' }}>
          <div>
            <h2>الفواتير</h2>
            <p>فواتير الزيارات بتطلع تلقائياً. الرعاية المنزلية بتنفوتر أسبوعي أو شهري من هون.</p>
          </div>
          <div className="row">
            <Field label="تاريخ التشغيل" hint="بتطلع فواتير الفترة المنتهية قبل هالتاريخ"><input id="asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
            <button className="primary" disabled={busy} onClick={() => run(async () => {
              const r = await api.post<{ created: number[] }>('/billing/run', { asOf: new Date(asOf + 'T12:00:00').toISOString() });
              list.reload();
              if (!r.created.length) throw new Error('ما في شي جديد للفوترة بهالفترة');
            }, 'طلعت الفواتير الدورية كمسودات')}><Icon name="refresh" />تشغيل الفوترة الدورية</button>
          </div>
        </div>
        {!list.data && !list.error && <Loading />}
        {list.data && !list.data.length && <Empty icon="receipt" title="ما في فواتير بعد">فواتير الزيارات بتظهر هون أول ما تخلص الزيارة.</Empty>}
        {!!list.data?.length && <div className="table-wrap">
          <table className="table stack-sm">
            <thead><tr><th>الرقم</th><th>العميل</th><th>النوع</th><th>الفترة / التاريخ</th><th className="tnum">الإجمالي</th><th className="tnum">الضريبة</th><th className="tnum">على المريض</th><th>الحالة</th><th>الفوترة الإلكترونية</th><th><span className="sr-only">إجراء</span></th></tr></thead>
            <tbody>
              {list.data?.map((i) => (
                <tr key={i.id}>
                  <td data-label="الرقم" className="lead"><span className="mono">{i.invoice_no}</span></td>
                  <td data-label="العميل">{i.full_name}</td>
                  <td data-label="النوع">{KIND_AR[i.kind]}</td>
                  <td data-label="الفترة" className="small" style={{ whiteSpace: 'nowrap' }}>{i.period_from ? <span className="mono">{i.period_from.slice(0, 10)} ← {i.period_to.slice(0, 10)}</span> : fmtTime(i.created_at)}</td>
                  <td data-label="الإجمالي" className="mono tnum">{jod(i.total)}</td>
                  <td data-label="الضريبة" className="mono tnum">{jod(i.tax_total ?? 0)}</td>
                  <td data-label="على المريض" className="mono tnum">{jod(i.patient_total)}</td>
                  <td data-label="الحالة"><Pill status={i.status} /></td>
                  <td data-label="الفوترة الإلكترونية">{i.einvoice_status ? <Pill status={EINV_PILL[i.einvoice_status][0]} label={EINV_PILL[i.einvoice_status][1]} /> : <span className="small muted">—</span>}</td>
                  <td data-label="" className="act"><button className="secondary" onClick={() => { setOpen(i.id); setAmount(''); setShowDoc(false); }}>فتح</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>}
      </div>
      <Drawer open={open !== null} onClose={() => setOpen(null)} title={d ? `${d.invoice_no} · ${KIND_AR[d.kind]}` : 'جاري التحميل…'}>
        {!d && <Loading card />}
        {d && (
          <div className="stack">
            <div className="row-tight no-print">
              <Pill status={d.status} />
              <div className="seg" role="tablist" aria-label="العرض">
                <button role="tab" aria-selected={!showDoc} className={!showDoc ? 'on' : ''} onClick={() => setShowDoc(false)}>البنود</button>
                <button role="tab" aria-selected={showDoc} className={showDoc ? 'on' : ''} onClick={() => setShowDoc(true)}>الفاتورة الضريبية</button>
              </div>
              {showDoc && <button className="ghost" onClick={() => window.print()}><Icon name="printer" />طباعة</button>}
              {d.status !== 'DRAFT' && (
                <button className="ghost" disabled={busy} onClick={() => run(async () => {
                  const r = await api.post<any>(`/invoices/${d.id}/einvoice`);
                  doc.reload(); refresh();
                  if (r.status !== 'ACCEPTED') throw new Error(`ما انقبلت: ${r.message ?? r.status}`);
                }, 'انقبلت من دائرة الضريبة')}><Icon name="send" />إرسال لدائرة الضريبة</button>
              )}
            </div>
            {showDoc && (doc.data ? <InvoiceDoc doc={doc.data} /> : <Loading card />)}
            {!showDoc && <section className="action"><div className="table-wrap"><table className="mini">
              <thead><tr><th>البند</th><th className="tnum">الكمية</th><th className="tnum">السعر</th><th className="tnum">المبلغ</th><th className="tnum">على المريض</th></tr></thead>
              <tbody>{d.lines.map((l: any) => <tr key={l.id}><td>{l.description}</td><td className="mono tnum">{l.qty}</td><td className="mono tnum">{jod(l.unit_price)}</td><td className="mono tnum">{jod(l.amount)}</td><td className="mono tnum">{jod(l.patient_amount)}</td></tr>)}</tbody>
              <tfoot><tr><td colSpan={3}>المجموع</td><td className="mono tnum">{jod(d.total)}</td><td className="mono tnum"><strong>{jod(d.patient_total)}</strong></td></tr></tfoot>
            </table></div></section>}
            {d.status === 'DRAFT' && (
              <button className="primary" disabled={busy} onClick={() => run(async () => { await api.post(`/invoices/${d.id}/issue`); refresh(); }, 'صدرت الفاتورة وانبعتت للمريض')}><Icon name="check" />مطابقة مع الحضور وإصدار</button>
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
              <section className="action"><h3>الدفعات</h3><ul className="list">{d.payments.map((p: any) => <li key={p.id} className="list-row"><span>{METHOD_AR[p.method] ?? p.method}<span className="cell-sub">{fmtTime(p.at)}</span></span><span className="mono">{jod(p.amount)}</span></li>)}</ul></section>
            )}
          </div>
        )}
      </Drawer>
    </>
  );
}
