// Coordinator console: request board (review → quote → schedule), home-care episodes (roster), and alerts.
import { useMemo, useState } from 'react';
import { api, escalationAr, fmtTime, isoToLocal, jod, localToIso, ROLE_AR, ROUTE_AR, type RequestRow, type Service, type Staff } from '../api';
import { Drawer, Empty, Field, Pill, useAction, useLoad } from '../ui';
import { agoAr, LiveStamp, minutesSince, usePolling, useUpdatedAt } from '../live';
import { KpiStrip, SlaBadge, type Dashboard } from './CoordinatorKpis';

const COLUMNS: { key: string; title: string; statuses: string[]; hint: string }[] = [
  { key: 'review', title: 'للمراجعة والتسعير', statuses: ['SUBMITTED', 'UNDER_REVIEW', 'PENDING_PREAPPROVAL'], hint: 'سعّر ووجّه' },
  { key: 'quoted', title: 'بانتظار موافقة المريض', statuses: ['QUOTED', 'EXPIRED'], hint: 'تابع مع المريض' },
  { key: 'accepted', title: 'جاهز للجدولة', statuses: ['ACCEPTED', 'NO_SHOW'], hint: 'عيّن الكادر' },
  { key: 'field', title: 'بالميدان', statuses: ['SCHEDULED', 'DISPATCHED', 'IN_PROGRESS'], hint: 'متابعة' },
];

function RequestCard({ r, onOpen, services, late }: { r: RequestRow; onOpen: () => void; services: Service[]; late?: Dashboard['sla']['overdue'][number] }) {
  const names = r.services?.split(', ').map((c) => services.find((s) => s.code === c)?.name_ar ?? c).join('، ');
  return (
    <button className={`req-card u-${r.urgency}${late ? ' is-late' : ''}`} onClick={onOpen}>
      <div className="req-top">
        <span className="mono muted">{r.request_no}</span>
        <Pill status={r.status} />
      </div>
      <strong>{r.full_name}</strong>
      <span className="small">{names}</span>
      <div className="req-meta">
        <span title={fmtTime(r.created_at)}>{agoAr(minutesSince(r.created_at))}</span>
        {late && <SlaBadge waited={late.waitedMinutes} sla={late.slaMinutes} kind={late.kind} />}
        <span>{r.channel === 'APP' ? 'تطبيق' : 'كول سنتر'}</span>
        {r.urgency !== 'ROUTINE' && <span className="urgent">{r.urgency === 'URGENT' ? 'عاجل' : 'نفس اليوم'}</span>}
        {r.route && <span>{ROUTE_AR[r.route]}</span>}
        {r.patient_total !== null && <span className="mono">{jod(r.patient_total)}</span>}
      </div>
    </button>
  );
}

const ELIGIBLE: Record<string, string[]> = { ASSESSMENT: ['DOCTOR', 'NURSE'], NURSE: ['NURSE'] };
const LINE_ROLES: Record<string, string[]> = { LAB: ['LAB_TECH', 'NURSE'], IMG: ['RADIOGRAPHER'], DEV: ['DRIVER'], DOC: ['DOCTOR'], NRS: ['NURSE'] };

function RequestDrawer({ id, onClose, onChanged, staff, services }: { id: number; onClose: () => void; onChanged: () => void; staff: Staff[]; services: Service[] }) {
  const detail = useLoad(() => api.get<any>(`/requests/${id}`), [id]);
  const { busy, run } = useAction();
  const d = detail.data;

  const [discount, setDiscount] = useState(0);
  const [approver, setApprover] = useState('');
  const [preNo, setPreNo] = useState('');
  const [route, setRoute] = useState('DIRECT');
  const [assignee, setAssignee] = useState('');
  const [when, setWhen] = useState('');
  const [reason, setReason] = useState('');
  const [byCompany, setByCompany] = useState(false);
  const [preAmount, setPreAmount] = useState('');
  const [preMethod, setPreMethod] = useState('LINK');

  const line = d ? services.find((s) => s.code === d.items[0]?.service_code)?.line : undefined;
  const roles = route === 'DIRECT' ? LINE_ROLES[line ?? ''] ?? [] : ELIGIBLE[route];
  const candidates = useMemo(() => staff
    .filter((s) => roles.includes(s.role))
    .sort((a, b) => Number(b.zone_id === d?.patient.zone_id) - Number(a.zone_id === d?.patient.zone_id)), [staff, roles, d]);
  const supervisors = staff.filter((s) => s.role === 'SUPERVISOR' || s.role === 'ADMIN');
  const latestQuote = d?.quotes.at(-1);
  const after = () => { detail.reload(); onChanged(); };
  const at = when || (d?.preferred_at ? isoToLocal(new Date(d.preferred_at)) : isoToLocal(new Date(Date.now() + 3600_000)));

  return (
    <Drawer open onClose={onClose} title={d ? `${d.request_no} · ${d.patient.full_name}` : 'تحميل…'}>
      {d && (
        <div className="stack">
          <div className="facts">
            <div><span className="k">الحالة</span><Pill status={d.status} /></div>
            <div><span className="k">الهاتف</span><span className="mono">{d.patient.phone ?? '—'}</span></div>
            <div><span className="k">العنوان</span><span>{d.patient.address ?? '—'}</span></div>
            <div><span className="k">الوقت المفضّل</span><span>{fmtTime(d.preferred_at)}</span></div>
            <div><span className="k">الخدمات</span><span>{d.items.map((i: any) => `${services.find((s) => s.code === i.service_code)?.name_ar ?? i.service_code} ×${i.qty}`).join('، ')}</span></div>
            <div><span className="k">التأمين</span><span>{d.policy_id ? 'مؤمَّن' : 'نقدي'}</span></div>
            {d.clinical_notes && <div className="wide"><span className="k">ملاحظات</span><span>{d.clinical_notes}</span></div>}
          </div>

          {['SUBMITTED', 'UNDER_REVIEW', 'PENDING_PREAPPROVAL', 'QUOTED', 'EXPIRED'].includes(d.status) && (
            <section className="action">
              <h3>{d.status === 'QUOTED' ? 'تعديل عرض السعر' : d.status === 'EXPIRED' ? 'العرض انتهى: سعّر من جديد' : 'التسعير'}</h3>
              <div className="grid-3">
                <Field label="خصم %" hint="فوق 10% بدها موافقة مشرف"><input id="disc" type="number" min={0} max={100} value={discount} onChange={(e) => setDiscount(Number(e.target.value))} /></Field>
                {discount > 10 && (
                  <Field label="موافقة">
                    <select id="appr" value={approver} onChange={(e) => setApprover(e.target.value)}>
                      <option value="">اختر مشرف</option>
                      {supervisors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </Field>
                )}
                {d.policy_id && <Field label="رقم موافقة التأمين" hint="إذا الخدمة بدها موافقة مسبقة"><input id="preno" value={preNo} onChange={(e) => setPreNo(e.target.value)} /></Field>}
                <Field label="موعد مبدئي" hint="بعد 8 مساءً والجمعة ×1.25"><input id="qwhen" type="datetime-local" value={at} onChange={(e) => setWhen(e.target.value)} /></Field>
              </div>
              <button className="primary" disabled={busy} onClick={() => run(async () => {
                const res = await api.post<any>(`/requests/${id}/quote`, {
                  discountPct: discount, approvedBy: approver ? Number(approver) : undefined, preApprovalNo: preNo || undefined, scheduledAt: localToIso(at),
                });
                if (res.message) throw new Error('الخدمة بدها موافقة التأمين المسبقة. أدخل رقم الموافقة لما توصل.');
                after();
              }, 'انبعت عرض السعر للمريض')}>احسب وأرسل العرض</button>
            </section>
          )}

          {latestQuote && (
            <section className="action">
              <h3>عرض السعر v{latestQuote.version} <Pill status={latestQuote.status === 'SENT' ? 'QUOTED' : latestQuote.status === 'ACCEPTED' ? 'ACCEPTED' : 'CANCELLED'} label={latestQuote.status === 'SENT' ? 'مُرسل' : latestQuote.status === 'ACCEPTED' ? 'مقبول' : latestQuote.status} /></h3>
              <table className="mini">
                <thead><tr><th>الخدمة</th><th>الكمية</th><th>الصافي</th><th>التأمين</th><th>المريض</th></tr></thead>
                <tbody>
                  {latestQuote.lines.map((l: any) => (
                    <tr key={l.serviceCode}><td>{services.find((s) => s.code === l.serviceCode)?.name_ar ?? l.serviceCode}</td><td className="mono">{l.qty}</td><td className="mono">{jod(l.net)}</td><td className="mono">{jod(l.payerShare)}</td><td className="mono">{jod(l.patientShare)}</td></tr>
                  ))}
                </tbody>
                <tfoot><tr><td colSpan={2}>المجموع</td><td className="mono">{jod(latestQuote.total)}</td><td className="mono">{jod(latestQuote.payer_total)}</td><td className="mono"><strong>{jod(latestQuote.patient_total)}</strong></td></tr></tfoot>
              </table>
              {latestQuote.valid_until && latestQuote.status === 'SENT' && <p className="small muted">صالح لغاية {fmtTime(latestQuote.valid_until)} (48 ساعة، و4 ساعات لطلبات نفس اليوم)</p>}
              {d.status === 'QUOTED' && (
                <button className="secondary" disabled={busy} onClick={() => run(async () => { await api.post(`/requests/${id}/accept`, { evidence: 'phone' }); after(); }, 'تم تسجيل موافقة المريض')}>
                  المريض وافق بالتلفون
                </button>
              )}
            </section>
          )}

          {['ACCEPTED', 'NO_SHOW'].includes(d.status) && (
            <section className="action">
              <h3>التوجيه والتعيين</h3>
              <div className="seg" role="radiogroup" aria-label="المسار">
                {(['DIRECT', 'ASSESSMENT', 'NURSE'] as const).map((r) => (
                  <button key={r} role="radio" aria-checked={route === r} className={route === r ? 'on' : ''} onClick={() => { setRoute(r); setAssignee(''); }}>{ROUTE_AR[r]}</button>
                ))}
              </div>
              <div className="grid-3">
                <Field label="الكادر" hint="أصحاب نفس منطقة المريض أولاً">
                  <select id="assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                    <option value="">اختر</option>
                    {candidates.map((s) => (
                      <option key={s.id} value={s.id}>{s.name} · {ROLE_AR[s.role]}{s.zone_id === d.patient.zone_id ? ' · نفس المنطقة' : ''}</option>
                    ))}
                  </select>
                </Field>
                <Field label="الموعد"><input id="swhen" type="datetime-local" value={at} onChange={(e) => setWhen(e.target.value)} /></Field>
              </div>
              {d.prepayment?.outstanding > 0 && (
                <div className="notice warn stack">
                  <span>المريض عنده غيابين أو أكثر خلال 30 يوم: لازم يدفع {jod(d.prepayment.outstanding)} مسبقاً قبل الحجز.</span>
                  <div className="row">
                    <Field label="المبلغ (د.أ)"><input inputMode="decimal" value={preAmount} onChange={(e) => setPreAmount(e.target.value)} placeholder={(d.prepayment.outstanding / 1000).toFixed(3)} /></Field>
                    <Field label="الطريقة"><select value={preMethod} onChange={(e) => setPreMethod(e.target.value)}><option value="LINK">رابط دفع</option><option value="CLIQ">CliQ</option><option value="CARD">بطاقة</option><option value="TRANSFER">تحويل</option></select></Field>
                    <button className="secondary" disabled={busy} onClick={() => run(async () => {
                      await api.post(`/requests/${id}/prepayments`, { method: preMethod, amount: Math.round(Number(preAmount || d.prepayment.outstanding / 1000) * 1000) });
                      setPreAmount(''); after();
                    }, 'تم تسجيل الدفعة المسبقة')}>تسجيل الدفعة</button>
                  </div>
                </div>
              )}
              <button className="primary" disabled={busy || !assignee} onClick={() => run(async () => {
                await api.post(`/requests/${id}/schedule`, { route, staffId: Number(assignee), scheduledAt: localToIso(at) });
                after();
              }, 'تم التعيين وإبلاغ المريض والكادر')}>تعيين</button>
            </section>
          )}

          {d.visits.length > 0 && (
            <section className="action">
              <h3>الزيارات</h3>
              <ul className="list">
                {d.visits.map((v: any) => (
                  <li key={v.id} className="list-row"><span>{staff.find((s) => s.id === v.staff_id)?.name} · {fmtTime(v.scheduled_at)}</span><Pill status={v.status} /></li>
                ))}
              </ul>
            </section>
          )}

          {!['COMPLETED', 'CANCELLED', 'CONVERTED_TO_EPISODE', 'REFERRED_OUT', 'IN_PROGRESS'].includes(d.status) && (
            <section className="action danger-zone">
              <h3>إلغاء الطلب</h3>
              <div className="row">
                <Field label="السبب"><input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="مثلاً: السعر مرتفع" /></Field>
                <button className="danger" disabled={busy || reason.trim().length < 3} onClick={() => run(async () => { await api.post(`/requests/${id}/cancel`, { reason, initiatedBy: byCompany ? 'COMPANY' : 'PATIENT' }); after(); }, 'تم الإلغاء')}>إلغاء</button>
              </div>
              <label className="check small"><input type="checkbox" checked={byCompany} onChange={(e) => setByCompany(e.target.checked)} /> الإلغاء من طرفنا (بدون رسوم)</label>
              {!byCompany && d.cancellation?.fee > 0 && <p className="small">رسوم إلغاء على المريض حسب السياسة: <strong>{jod(d.cancellation.fee)}</strong> ({d.cancellation.pct}%). مجاني إذا قبل الموعد بأكثر من 24 ساعة.</p>}
            </section>
          )}

          <section className="action">
            <h3>السجل</h3>
            <ol className="timeline">
              {d.history.map((h: any) => (
                <li key={h.id}><Pill status={h.to_status} /> <span className="muted small">{fmtTime(h.at)}</span> {h.note && <span className="small">· {h.note}</span>}</li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </Drawer>
  );
}

function Board({ staff, services, onAlerts }: { staff: Staff[]; services: Service[]; onAlerts: () => void }) {
  const list = useLoad(() => api.get<RequestRow[]>('/requests?status=' + COLUMNS.flatMap((c) => c.statuses).join(',')));
  const dash = useLoad(() => api.get<Dashboard>('/dashboard/coordinator'));
  const [open, setOpen] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [lateOnly, setLateOnly] = useState(false);
  const refresh = () => { list.reload(); dash.reload(); };
  usePolling(refresh, 30_000);
  const updatedAt = useUpdatedAt(list.data);
  const late = new Map((dash.data?.sla.overdue ?? []).map((x) => [x.id, x]));
  const rows = (list.data ?? [])
    .filter((r) => !q || r.full_name.includes(q) || r.request_no.includes(q) || r.national_id.includes(q))
    .filter((r) => !lateOnly || late.has(r.id));
  return (
    <>
      <KpiStrip d={dash.data} lateOnly={lateOnly} onLateOnly={() => setLateOnly(!lateOnly)} onAlerts={onAlerts} onChanged={dash.reload} />
      <div className="toolbar">
        <input className="search" placeholder="بحث بالاسم أو رقم الطلب أو الرقم الوطني" value={q} onChange={(e) => setQ(e.target.value)} aria-label="بحث" />
        {lateOnly && <button className="chip on" onClick={() => setLateOnly(false)}>المتأخر عن SLA بس ✕</button>}
        <LiveStamp at={updatedAt} onRefresh={refresh} />
      </div>
      {list.error && <p className="error">{list.error}</p>}
      <div className="board">
        {COLUMNS.map((c) => {
          const items = rows.filter((r) => c.statuses.includes(r.status));
          return (
            <section key={c.key} className="col">
              <header><h3>{c.title}</h3><span className="count">{items.length}</span></header>
              <p className="muted small">{c.hint}</p>
              <div className="col-body">
                {items.map((r) => <RequestCard key={r.id} r={r} services={services} late={late.get(r.id)} onOpen={() => setOpen(r.id)} />)}
                {items.length === 0 && <Empty>فاضي</Empty>}
              </div>
            </section>
          );
        })}
      </div>
      {open !== null && <RequestDrawer id={open} onClose={() => setOpen(null)} onChanged={refresh} staff={staff} services={services} />}
    </>
  );
}

function Episodes({ staff }: { staff: Staff[] }) {
  const list = useLoad(() => api.get<any[]>('/episodes?status=ACTIVE'));
  const [open, setOpen] = useState<number | null>(null);
  const detail = useLoad(() => (open ? api.get<any>(`/episodes/${open}`) : Promise.resolve(null)), [open]);
  const { busy, run } = useAction();
  const [start, setStart] = useState(() => { const d = new Date(Date.now() + 86_400_000); d.setHours(7, 0, 0, 0); return isoToLocal(d); });
  const [nurses, setNurses] = useState<number[]>([]);
  const nurseList = staff.filter((s) => s.role === 'NURSE');
  const ep = detail.data;

  return (
    <>
      <div className="card">
        <h2>حالات الرعاية المنزلية النشطة</h2>
        {!list.data?.length && <Empty>ما في حالات نشطة. بتنفتح الحالة لما الطبيب يكمّل زيارة التقييم.</Empty>}
        <table className="table">
          <thead><tr><th>الحالة</th><th>المريض</th><th>التشخيص</th><th>خطة الرعاية</th><th>شفتات مفتوحة</th><th>الفوترة</th><th></th></tr></thead>
          <tbody>
            {list.data?.map((e) => (
              <tr key={e.id}>
                <td className="mono">{e.episode_no}</td><td>{e.full_name}</td><td>{e.diagnosis}</td>
                <td>{e.plan ? <span className="mono">{e.plan}</span> : <Pill status="PENDING_INFO" label="بانتظار الطبيب" />}</td>
                <td className="mono">{e.open_shifts}</td>
                <td>{e.billing_cycle === 'WEEKLY' ? 'أسبوعي' : 'شهري'}</td>
                <td><button className="secondary" onClick={() => { setOpen(e.id); setNurses([]); }}>الشفتات</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Drawer open={open !== null} onClose={() => setOpen(null)} title={ep ? `${ep.episode_no} · ${ep.patient.full_name}` : 'تحميل…'}>
        {ep && (
          <div className="stack">
            {ep.carePlan ? (
              <section className="action">
                <h3>بناء جدول الشفتات</h3>
                <p className="muted small">خطة الطبيب: شفت {ep.carePlan.shift_hours} ساعة، {ep.carePlan.hours_per_day} ساعة باليوم، لمدة {ep.carePlan.duration_days} يوم. الممرضين بيتناوبوا بالترتيب اللي بتختاره.</p>
                <Field label="بداية أول شفت"><input id="rstart" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
                <div className="chips" role="group" aria-label="الممرضين">
                  {nurseList.map((n) => {
                    const i = nurses.indexOf(n.id);
                    return (
                      <button key={n.id} className={i >= 0 ? 'chip on' : 'chip'} onClick={() => setNurses(i >= 0 ? nurses.filter((x) => x !== n.id) : [...nurses, n.id])}>
                        {i >= 0 && <span className="mono">{i + 1}</span>} {n.name}{n.gender === ep.patient.gender ? ' · نفس الجنس' : ''}
                      </button>
                    );
                  })}
                </div>
                <button className="primary" disabled={busy || nurses.length === 0} onClick={() => run(async () => {
                  const r = await api.post<{ shifts: number }>(`/episodes/${ep.id}/roster`, { start: localToIso(start), nurseIds: nurses });
                  detail.reload(); list.reload();
                  return r;
                }, 'تم نشر الجدول على تطبيق الممرضين')}>نشر الجدول</button>
              </section>
            ) : <div className="notice warn">الطبيب لسا ما اعتمد خطة الرعاية.</div>}
            <section className="action">
              <h3>الشفتات</h3>
              {!ep.shifts.length && <Empty>ما في شفتات بعد.</Empty>}
              <ul className="list">
                {ep.shifts.map((s: any) => (
                  <li key={s.id} className="list-row">
                    <span>{fmtTime(s.planned_start)} ← {fmtTime(s.planned_end)} · {staff.find((x) => x.id === s.nurse_id)?.name}</span>
                    <span className="row-tight">{s.billable_minutes != null && <span className="mono small">{(s.billable_minutes / 60).toFixed(2)} س</span>}<Pill status={s.status} /></span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </Drawer>
    </>
  );
}

function Alerts({ staff }: { staff: Staff[] }) {
  const shifts = useLoad(() => api.get<any[]>('/shifts'));
  const esc = useLoad(() => api.get<any[]>('/escalations?status=OPEN'));
  const { busy, run } = useAction();
  const [pick, setPick] = useState<Record<number, string>>({});
  const late = (shifts.data ?? []).filter((s) => s.status === 'LATE');
  const nurses = staff.filter((s) => s.role === 'NURSE');
  const reload = () => { shifts.reload(); esc.reload(); };

  return (
    <div className="split">
      <div className="card">
        <div className="card-head">
          <h2>شفتات بدون حضور</h2>
          <button className="secondary" disabled={busy} onClick={() => run(async () => {
            const r = await api.post<{ late: number[] }>('/shifts/check-late');
            reload();
            if (!r.late.length) throw new Error('ما في تأخير جديد');
          }, 'تم رصد شفتات متأخرة')}>افحص الآن</button>
        </div>
        <p className="muted small">أي شفت ما سجّل فيه الممرض حضور بعد 15 دقيقة من بدايته بيظهر هون.</p>
        {!late.length && <Empty>كل الشفتات الحالية مغطاة.</Empty>}
        <ul className="list">
          {late.map((s) => (
            <li key={s.id} className="list-row">
              <div>
                <strong>{s.full_name}</strong> <span className="mono muted">{s.episode_no}</span>
                <div className="small muted">{fmtTime(s.planned_start)} · {staff.find((x) => x.id === s.nurse_id)?.name}</div>
              </div>
              <div className="row-tight">
                <select aria-label="ممرض بديل" value={pick[s.id] ?? ''} onChange={(e) => setPick({ ...pick, [s.id]: e.target.value })}>
                  <option value="">ممرض بديل</option>
                  {nurses.filter((n) => n.id !== s.nurse_id).map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
                </select>
                <button className="primary" disabled={busy || !pick[s.id]} onClick={() => run(async () => {
                  await api.post(`/shifts/${s.id}/reassign`, { nurseId: Number(pick[s.id]) });
                  reload();
                }, 'انبعت الممرض البديل')}>أرسل</button>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <div className="card">
        <div className="card-head"><h2>تصعيدات مفتوحة</h2><button className="ghost" onClick={reload}>تحديث</button></div>
        {!esc.data?.length && <Empty>ما في تصعيدات مفتوحة.</Empty>}
        <ul className="list">
          {esc.data?.map((e) => (
            <li key={e.id} className="list-row">
              <div>
                <strong>{e.full_name}</strong> <span className="mono muted">{e.episode_no}</span>
                <div className="small">{escalationAr(e.trigger, e.level)}</div>
                <div className="small muted">{fmtTime(e.opened_at)}</div>
              </div>
              <Pill status={e.level} label={{ NEWS2: 'NEWS2', CRITICAL_RESULT: 'نتيجة حرجة', LATE_SHIFT: 'تأخر ممرض', INCIDENT: 'حادثة' }[e.trigger as string] + ` · ${e.level}`} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function Coordinator(_: { me: Staff }) {
  const staff = useLoad(() => api.get<Staff[]>('/staff'));
  const services = useLoad(() => api.get<Service[]>('/services'));
  const [tab, setTab] = useState<'board' | 'episodes' | 'alerts'>('board');
  if (!staff.data || !services.data) return <p className="muted">تحميل…</p>;
  return (
    <>
      <div className="subtabs" role="tablist">
        {([['board', 'الطلبات'], ['episodes', 'الرعاية المنزلية والشفتات'], ['alerts', 'التنبيهات']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'board' && <Board staff={staff.data} services={services.data} onAlerts={() => setTab('alerts')} />}
      {tab === 'episodes' && <Episodes staff={staff.data} />}
      {tab === 'alerts' && <Alerts staff={staff.data} />}
    </>
  );
}
