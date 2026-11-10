// Finance: run the weekly / monthly billing cycle, review against attendance, issue and collect.
import { useState } from 'react';
import { api, fmtTime, jod } from '../api';
import { Drawer, Empty, Field, Pill, useAction, useLoad } from '../ui';

const KIND_AR: Record<string, string> = { VISIT: 'زيارة', PERIODIC: 'دورية', FINAL: 'نهائية' };

export function Finance() {
  const list = useLoad(() => api.get<any[]>('/invoices'));
  const { busy, run } = useAction();
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const [open, setOpen] = useState<number | null>(null);
  const inv = useLoad(() => (open ? api.get<any>(`/invoices/${open}`) : Promise.resolve(null)), [open]);
  const [method, setMethod] = useState('CASH');
  const [amount, setAmount] = useState('');
  const d = inv.data;
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
            <thead><tr><th>الرقم</th><th>النوع</th><th>الفترة</th><th>الإجمالي</th><th>التأمين</th><th>المريض</th><th>الحالة</th><th></th></tr></thead>
            <tbody>
              {list.data?.map((i) => (
                <tr key={i.id}>
                  <td className="mono">{i.invoice_no}</td><td>{KIND_AR[i.kind]}</td>
                  <td className="small">{i.period_from ? `${i.period_from.slice(0, 10)} ← ${i.period_to.slice(0, 10)}` : fmtTime(i.created_at)}</td>
                  <td className="mono">{jod(i.total)}</td><td className="mono">{jod(i.payer_total)}</td><td className="mono">{jod(i.patient_total)}</td>
                  <td><Pill status={i.status} /></td>
                  <td><button className="secondary" onClick={() => { setOpen(i.id); setAmount(''); }}>فتح</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <Drawer open={open !== null} onClose={() => setOpen(null)} title={d ? `${d.invoice_no} · ${KIND_AR[d.kind]}` : 'تحميل…'}>
        {d && (
          <div className="stack">
            <table className="mini">
              <thead><tr><th>البند</th><th>الكمية</th><th>السعر</th><th>المبلغ</th><th>المريض</th></tr></thead>
              <tbody>{d.lines.map((l: any) => <tr key={l.id}><td>{l.description}</td><td className="mono">{l.qty}</td><td className="mono">{jod(l.unit_price)}</td><td className="mono">{jod(l.amount)}</td><td className="mono">{jod(l.patient_amount)}</td></tr>)}</tbody>
              <tfoot><tr><td colSpan={3}>المجموع</td><td className="mono">{jod(d.total)}</td><td className="mono"><strong>{jod(d.patient_total)}</strong></td></tr></tfoot>
            </table>
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
