// Rented devices: who has what, what is overdue, extend the rental, and record the return (with damage).
// Used by the coordinator (all devices) and by the delivery driver's app (devices to collect).
import { useState } from 'react';
import { api, fmtTime, isoToLocal, jod } from '../api';
import { Empty, Field, Loading, Pill, useAction, useLoad } from '../ui';
import { Icon } from '../icons';

export function Devices({ pickupOnly = false, canExtend = true }: { pickupOnly?: boolean; canExtend?: boolean }) {
  const list = useLoad(() => api.get<any[]>('/rentals?status=ACTIVE'));
  const { busy, run } = useAction();
  const [open, setOpen] = useState<number | null>(null);
  const [mode, setMode] = useState<'return' | 'extend'>('return');
  const [condition, setCondition] = useState<'OK' | 'DAMAGED'>('OK');
  const [charge, setCharge] = useState('');
  const [note, setNote] = useState('');
  const [until, setUntil] = useState('');

  if (!list.data) return <Loading card />;
  const rows = pickupOnly ? list.data.filter((r) => r.pickupDue) : list.data;
  const reset = () => { setOpen(null); setCondition('OK'); setCharge(''); setNote(''); setUntil(''); };

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>{pickupOnly ? 'أجهزة لازم ترجع' : 'الأجهزة عند المرضى'}</h2>
          <p className="small muted">{pickupOnly ? 'أجهزة انتهى إيجارها أو صاحبها خلّص الرعاية. سجّل الاستلام لما ترجّعها.' : 'كل جهاز مؤجر حالياً، والمتأخر عن موعد الإرجاع بيبيّن بالأحمر.'}</p>
        </div>
        <button className="ghost" onClick={list.reload}><Icon name="refresh" />تحديث</button>
      </div>
      {!rows.length && <Empty icon="check" title={pickupOnly ? 'ما في أجهزة للاسترجاع' : 'ما في أجهزة مؤجرة'}>{pickupOnly ? 'كل الأجهزة بمواعيدها.' : 'لما يتسلّم مريض جهاز بيظهر هون.'}</Empty>}
      <ul className="list">
        {rows.map((r) => (
          <li key={r.id}>
            <div className="list-row">
              <div>
                <strong>{r.name_ar}</strong> <bdi dir="ltr" className="mono small muted">{r.serial_no ?? '—'}</bdi>
                <div className="small">{r.full_name}{r.episode_no ? <span className="muted"> · {r.episode_no}</span> : null}</div>
                <div className="small muted">{r.address} · <span dir="ltr">{r.phone}</span></div>
                <div className="small muted">من {fmtTime(r.start_date)} · الإرجاع {r.expected_return.slice(0, 10)}{r.deposit ? ` · تأمين ${jod(r.deposit)}` : ''}</div>
              </div>
              <div className="row-tight">
                {r.overdue ? <Pill status="HIGH" label="متأخر" /> : r.pickupDue ? <Pill status="LATE" label="للاسترجاع" /> : <Pill status="ACTIVE" label="عند المريض" />}
                <button className="secondary" onClick={() => { reset(); setOpen(r.id); setMode('return'); }}>استلام</button>
                {canExtend && !r.episode_id && <button className="ghost" onClick={() => { reset(); setOpen(r.id); setMode('extend'); setUntil(r.expected_return.slice(0, 10)); }}>تمديد</button>}
              </div>
            </div>
            {open === r.id && mode === 'return' && (
              <form className="inline-form" onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  const out = await api.post<any>(`/rentals/${r.id}/return`, { condition, damageCharge: Math.round(Number(charge || 0) * 1000), note: note || undefined });
                  reset(); list.reload();
                  return out;
                }, 'تم تسجيل استلام الجهاز');
              }}>
                <div className="seg" role="radiogroup" aria-label="حالة الجهاز">
                  <button type="button" className={condition === 'OK' ? 'on' : ''} onClick={() => setCondition('OK')}>سليم</button>
                  <button type="button" className={condition === 'DAMAGED' ? 'on' : ''} onClick={() => setCondition('DAMAGED')}>فيه ضرر</button>
                </div>
                {condition === 'DAMAGED' && (
                  <div className="grid-2">
                    <Field label="كلفة الضرر (د.أ)"><input id={`dmg-${r.id}`} inputMode="decimal" value={charge} onChange={(e) => setCharge(e.target.value)} /></Field>
                    <Field label="وصف الضرر"><input id={`dmgn-${r.id}`} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
                  </div>
                )}
                <p className="small muted">{r.episode_id ? 'أيام الإيجار بتنحسب بفاتورة الرعاية لحد اليوم.' : 'إذا رجع بعد الأيام المدفوعة، الأيام الزيادة بتطلع بفاتورة لحالها.'}</p>
                <button className="primary" disabled={busy}><Icon name="check" />تأكيد الاستلام</button>
              </form>
            )}
            {open === r.id && mode === 'extend' && (
              <form className="inline-form" onSubmit={(e) => {
                e.preventDefault();
                run(async () => { await api.post(`/rentals/${r.id}/extend`, { expectedReturn: until }); reset(); list.reload(); }, 'تم تمديد الإيجار وإبلاغ المريض');
              }}>
                <Field label="موعد الإرجاع الجديد"><input id={`ext-${r.id}`} type="date" min={isoToLocal(new Date()).slice(0, 10)} value={until} onChange={(e) => setUntil(e.target.value)} required /></Field>
                <button className="primary" disabled={busy}>تمديد</button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
