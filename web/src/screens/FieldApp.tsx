// Mobile-first app for field staff: visits, nurse shifts (vitals / NEWS2 / notes / handover),
// doctor case list (care plan, orders, results), and department worklists.
import { useState } from 'react';
import { api, escalationAr, fmtTime, jod, ROLE_AR, staffName, type Service, type Staff } from '../api';
import { Empty, Field, Loading, Pill, useAction, useLoad, useToast } from '../ui';
import { Icon } from '../icons';
import { Devices } from './Devices';
import { StockBox, type StockItem } from '../StockBox';

type Pos = { lat: number; lng: number };

/** Browser GPS with a manual fallback (for desktops / demos). */
function useGps() {
  const [manual, setManual] = useState<{ lat: string; lng: string } | null>(null);
  const get = () => new Promise<Pos>((resolve, reject) => {
    if (manual) return resolve({ lat: Number(manual.lat), lng: Number(manual.lng) });
    if (!navigator.geolocation) return reject(new Error('الجهاز ما بيدعم تحديد الموقع'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => { setManual({ lat: '', lng: '' }); reject(new Error('ما قدرنا نحدد موقعك. أدخله يدوياً أو استخدم رمز المريض.')); },
      { enableHighAccuracy: true, timeout: 8000 },
    );
  });
  const manualFields = manual && (
    <div className="grid-2">
      <Field label="خط العرض"><input inputMode="decimal" value={manual.lat} onChange={(e) => setManual({ ...manual, lat: e.target.value })} /></Field>
      <Field label="خط الطول"><input inputMode="decimal" value={manual.lng} onChange={(e) => setManual({ ...manual, lng: e.target.value })} /></Field>
    </div>
  );
  return { get, manualFields };
}

// ---- Visits -----------------------------------------------------------------
const KIND_AR: Record<string, string> = { ASSESSMENT: 'زيارة تقييم', NURSE: 'زيارة تمريض', DOCTOR: 'زيارة طبيب', LAB: 'سحب عينة', IMAGING: 'تصوير', DEVICE: 'توصيل جهاز' };

function VisitCard({ v, reload }: { v: any; reload: () => void }) {
  const { busy, run } = useAction();
  const gps = useGps();
  const [otp, setOtp] = useState('');
  const [open, setOpen] = useState(false);
  // BR-80: general consent captured on the device when the patient has none on file.
  const [consented, setConsented] = useState(false);
  const [signer, setSigner] = useState('');
  const [relation, setRelation] = useState('SELF');
  const req = useLoad(() => (open ? api.get<any>(`/requests/${v.request_id}`) : Promise.resolve(null)), [open]);

  // completion form state
  const [report, setReport] = useState('');
  const [critical, setCritical] = useState(false);
  const [serial, setSerial] = useState('');
  const [ret, setRet] = useState('');
  const [signed, setSigned] = useState(false);
  const [deposit, setDeposit] = useState('');
  const [method, setMethod] = useState('CASH');
  const [paid, setPaid] = useState('');
  // episode form state
  const [dx, setDx] = useState('');
  const [hx, setHx] = useState('');
  const [fall, setFall] = useState('');
  const [braden, setBraden] = useState('');
  const [allergies, setAllergies] = useState('');
  const [suitable, setSuitable] = useState(true);
  const [refer, setRefer] = useState('');
  const [cycle, setCycle] = useState('WEEKLY');

  const due = req.data?.quotes?.find((q: any) => q.status === 'ACCEPTED')?.patient_total as number | undefined;
  const route = req.data?.route;

  const checkIn = () => run(async () => {
    const body: Record<string, unknown> = otp ? { otp } : await gps.get();
    if (!v.has_consent && consented) body.consent = { signedBy: signer || v.full_name, relation, method: 'ESIGN' };
    await api.post(`/visits/${v.id}/check-in`, body);
    reload();
  }, 'تم تسجيل الوصول');

  return (
    <li className={`visit${v.status !== 'SCHEDULED' ? ' is-now' : ''}`}>
      <div className="visit-head" onClick={() => setOpen(!open)}>
        <div>
          <span className="small muted">{KIND_AR[v.kind]}</span>
          <strong>{v.full_name}</strong>
          <div className="visit-meta">
            <span><Icon name="clock" size={15} />{fmtTime(v.scheduled_at)}</span>
            {v.address && <span><Icon name="pin" size={15} />{v.address}</span>}
          </div>
        </div>
        <Pill status={v.status} />
      </div>
      {v.status === 'SCHEDULED' && (
        <button className="primary block" disabled={busy} onClick={() => run(async () => { await api.post(`/visits/${v.id}/dispatch`); reload(); }, 'المريض وصله إشعار إنك بالطريق')}><Icon name="send" />أنا بالطريق</button>
      )}
      {v.status === 'DISPATCHED' && (
        <div className="stack">
          <div className="visit-status"><Icon name="pin" />لما توصل سجّل حضورك بالموقع، أو اطلب رمز الزيارة من المريض.</div>
          {gps.manualFields}
          <Field label="رمز الزيارة من المريض (اختياري)"><input className="mono" inputMode="numeric" value={otp} onChange={(e) => setOtp(e.target.value)} maxLength={4} placeholder="• • • •" /></Field>
          {!v.has_consent && (
            <div className="notice warn stack">
              <label className="check"><input type="checkbox" checked={consented} onChange={(e) => setConsented(e.target.checked)} /> ما في موافقة على الملف: المريض أو ولي الأمر وقّع الموافقة العامة على العلاج{v.kind === 'IMAGING' ? ' وموافقة التصوير' : ''} على الجهاز</label>
              {consented && (
                <div className="grid-2">
                  <Field label="اسم الموقّع"><input value={signer} onChange={(e) => setSigner(e.target.value)} placeholder={v.full_name} /></Field>
                  <Field label="صلة القرابة" hint="أقل من 18 سنة: ولي الأمر يوقّع">
                    <select value={relation} onChange={(e) => setRelation(e.target.value)}>
                      <option value="SELF">المريض نفسه</option><option value="PARENT">أب / أم</option><option value="SPOUSE">زوج / زوجة</option>
                      <option value="CHILD">ابن / ابنة</option><option value="SIBLING">أخ / أخت</option><option value="LEGAL_GUARDIAN">وصي قانوني</option>
                    </select>
                  </Field>
                </div>
              )}
            </div>
          )}
          <button className="primary block cta-sticky" disabled={busy} onClick={checkIn}><Icon name="check" />وصلت · تسجيل الحضور</button>
          <button className="ghost block" disabled={busy} onClick={() => run(async () => {
            const r = await api.post<{ fee: number }>(`/visits/${v.id}/no-show`);
            reload();
            return r;
          }, 'تم تسجيل No-show وإبلاغ المنسق')}>المريض مش موجود</button>
        </div>
      )}
      {v.status === 'CHECKED_IN' && !open && <button className="primary block" onClick={() => setOpen(true)}><Icon name="check" />إنهاء الزيارة</button>}
      {v.status === 'CHECKED_IN' && open && !req.data && <Loading />}
      {v.status === 'CHECKED_IN' && open && req.data && route === 'DIRECT' && (
        <form className="stack" onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            await api.post(`/visits/${v.id}/complete`, {
              result: (v.kind === 'LAB' || v.kind === 'IMAGING') && report ? { report, critical } : undefined,
              rental: v.kind === 'DEVICE' ? { serialNo: serial, expectedReturn: ret, handoverSigned: signed || undefined, deposit: Math.round(Number(deposit || 0) * 1000) } : undefined,
              payment: paid ? { method, amount: Math.round(Number(paid) * 1000) } : undefined,
            });
            reload();
          }, 'اكتملت الزيارة');
        }}>
          {(v.kind === 'LAB' || v.kind === 'IMAGING') && (
            <>
              <Field label={v.kind === 'LAB' ? 'النتيجة / ملاحظات العينة' : 'التقرير'}><textarea rows={3} value={report} onChange={(e) => setReport(e.target.value)} /></Field>
              <label className="check"><input type="checkbox" checked={critical} onChange={(e) => setCritical(e.target.checked)} /> نتيجة حرجة (بتتبلّغ للطبيب فوراً)</label>
            </>
          )}
          {v.kind === 'DEVICE' && (
            <div className="grid-2">
              <Field label="الرقم التسلسلي"><input value={serial} onChange={(e) => setSerial(e.target.value)} required /></Field>
              <Field label="تاريخ الإرجاع"><input type="date" value={ret} onChange={(e) => setRet(e.target.value)} required /></Field>
              <Field label="التأمين (د.أ)"><input inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} /></Field>
              <label className="check"><input type="checkbox" checked={signed} onChange={(e) => setSigned(e.target.checked)} required /> العائلة تدرّبت ووقّعت نموذج الاستلام</label>
            </div>
          )}
          <div className="notice ok"><div className="list-row"><span>المستحق على المريض</span><strong className="mono" style={{ fontSize: 20 }}>{jod(due)}</strong></div></div>
          <div className="grid-2">
            <Field label="طريقة الدفع">
              <select value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="CASH">كاش</option><option value="CARD">بطاقة</option><option value="LINK">رابط دفع</option><option value="CLIQ">CliQ</option>
              </select>
            </Field>
            <Field label="المبلغ المحصّل (د.أ)"><input inputMode="decimal" value={paid} onChange={(e) => setPaid(e.target.value)} placeholder={due ? (due / 1000).toFixed(3) : ''} /></Field>
          </div>
          <button className="primary block cta-sticky" disabled={busy}><Icon name="check" />حفظ وإنهاء الزيارة</button>
        </form>
      )}
      {v.status === 'CHECKED_IN' && open && req.data && route !== 'DIRECT' && (
        <form className="stack" onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            await api.post('/episodes', {
              requestId: v.request_id, diagnosis: dx, history: hx || undefined,
              fallRiskScore: fall ? Number(fall) : undefined, bradenScore: braden ? Number(braden) : undefined,
              suitable, referReason: suitable ? undefined : refer, billingCycle: cycle,
              allergies: allergies ? allergies.split(/[,،]/).map((s) => s.trim()).filter(Boolean) : undefined,
            });
            reload();
          }, suitable ? 'انفتح ملف الرعاية المنزلية' : 'تم تسجيل التحويل');
        }}>
          <h3>تقييم الحالة وفتح الملف</h3>
          <Field label="التشخيص"><input value={dx} onChange={(e) => setDx(e.target.value)} required /></Field>
          <Field label="التاريخ المرضي"><textarea rows={3} value={hx} onChange={(e) => setHx(e.target.value)} /></Field>
          <div className="grid-2">
            <Field label="Morse (خطر السقوط)"><input type="number" min={0} max={125} value={fall} onChange={(e) => setFall(e.target.value)} /></Field>
            <Field label="Braden (قرح الفراش)" hint="6–23، أقل = خطر أعلى"><input type="number" min={6} max={23} value={braden} onChange={(e) => setBraden(e.target.value)} /></Field>
          </div>
          <Field label="الحساسية" hint="افصل بفاصلة"><input value={allergies} onChange={(e) => setAllergies(e.target.value)} /></Field>
          <div className="seg" role="radiogroup" aria-label="القرار">
            <button type="button" className={suitable ? 'on' : ''} onClick={() => setSuitable(true)}>مناسبة للرعاية المنزلية</button>
            <button type="button" className={!suitable ? 'on' : ''} onClick={() => setSuitable(false)}>تحويل لمستشفى</button>
          </div>
          {suitable ? (
            <Field label="دورة الفوترة">
              <select value={cycle} onChange={(e) => setCycle(e.target.value)}><option value="WEEKLY">أسبوعي</option><option value="MONTHLY">شهري</option></select>
            </Field>
          ) : (
            <Field label="سبب التحويل"><input value={refer} onChange={(e) => setRefer(e.target.value)} required /></Field>
          )}
          <button className="primary block cta-sticky" disabled={busy}><Icon name="check" />حفظ التقييم</button>
        </form>
      )}
    </li>
  );
}

function Visits({ me }: { me: Staff }) {
  const list = useLoad(() => api.get<any[]>(`/visits?staffId=${me.id}`));
  if (!list.data) return list.error ? <div className="notice bad">{list.error}</div> : <Loading card />;
  const active = (list.data ?? []).filter((v) => ['SCHEDULED', 'DISPATCHED', 'CHECKED_IN'].includes(v.status));
  const done = (list.data ?? []).filter((v) => !['SCHEDULED', 'DISPATCHED', 'CHECKED_IN'].includes(v.status)).slice(0, 10);
  return (
    <div className="stack">
      {!active.length && <Empty icon="calendar" title="ما عندك زيارات قادمة">أول ما المنسق يعيّنلك زيارة بتظهر هون.</Empty>}
      <ul className="visits">{active.map((v) => <VisitCard key={v.id} v={v} reload={list.reload} />)}</ul>
      {done.length > 0 && (
        <details className="card">
          <summary>زيارات سابقة ({done.length})</summary>
          <ul className="list">{done.map((v) => <li key={v.id} className="list-row"><span><strong>{v.full_name}</strong><span className="cell-sub">{KIND_AR[v.kind]} · {fmtTime(v.scheduled_at)}</span></span><Pill status={v.status} /></li>)}</ul>
        </details>
      )}
    </div>
  );
}

// ---- Nurse shifts -----------------------------------------------------------
const BAND_AR: Record<string, string> = { LOW: 'منخفض', LOW_MEDIUM: 'مراجعة عاجلة', MEDIUM: 'متوسط', HIGH: 'مرتفع · طوارئ' };

function ShiftPanel({ s, reload }: { s: any; reload: () => void }) {
  const { busy, run } = useAction();
  const gps = useGps();
  const [v, setV] = useState({ respRate: '16', spo2: '97', onOxygen: false, systolicBp: '120', heartRate: '78', consciousness: 'A', temperature: '37.0' });
  const [news, setNews] = useState<any>(null);
  const [note, setNote] = useState('');
  const [noteType, setNoteType] = useState('PROGRESS');
  const [handover, setHandover] = useState('');

  if (s.status === 'PLANNED' || s.status === 'LATE') {
    return (
      <div className="stack">
        {gps.manualFields}
        {s.status === 'LATE' && <div className="visit-status warn"><Icon name="alert" />الشفت بلّش وما سجّلت حضور. المنسق وصله تنبيه.</div>}
        <button className="primary block" disabled={busy} onClick={() => run(async () => { await api.post(`/shifts/${s.id}/check-in`, await gps.get()); reload(); }, 'تم تسجيل الحضور')}><Icon name="pin" />تسجيل حضور الشفت</button>
      </div>
    );
  }
  if (s.status !== 'CHECKED_IN') return null;

  const num = (k: keyof typeof v) => ({ value: v[k] as string, inputMode: 'decimal' as const, onChange: (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value }) });
  return (
    <div className="stack">
      <form className="action" onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          const r = await api.post<any>(`/shifts/${s.id}/vitals`, {
            respRate: Number(v.respRate), spo2: Number(v.spo2), onOxygen: v.onOxygen, systolicBp: Number(v.systolicBp),
            heartRate: Number(v.heartRate), consciousness: v.consciousness, temperature: Number(v.temperature),
          });
          setNews(r.news2);
        });
      }}>
        <h3><Icon name="pulse" />العلامات الحيوية</h3>
        <div className="grid-3 vitals">
          <Field label="التنفس /د"><input {...num('respRate')} /></Field>
          <Field label="SpO₂ %"><input {...num('spo2')} /></Field>
          <Field label="الضغط الانقباضي"><input {...num('systolicBp')} /></Field>
          <Field label="النبض /د"><input {...num('heartRate')} /></Field>
          <Field label="الحرارة °C"><input {...num('temperature')} /></Field>
          <Field label="الوعي (ACVPU)">
            <select value={v.consciousness} onChange={(e) => setV({ ...v, consciousness: e.target.value })}>
              <option value="A">A · واعي</option><option value="C">C · تشوّش جديد</option><option value="V">V · يستجيب للصوت</option><option value="P">P · يستجيب للألم</option><option value="U">U · لا يستجيب</option>
            </select>
          </Field>
        </div>
        <label className="check"><input type="checkbox" checked={v.onOxygen} onChange={(e) => setV({ ...v, onOxygen: e.target.checked })} /> على أكسجين</label>
        <button className="primary block" disabled={busy}>حفظ وحساب NEWS2</button>
        {news && (
          <div className={`news band-${news.band}`}>
            <div className="news-score"><span className="mono">{news.total}</span><span>NEWS2</span></div>
            <div><strong>{BAND_AR[news.band]}</strong><p className="small">{escalationAr('NEWS2', news.band) === news.band ? 'متابعة روتينية' : escalationAr('NEWS2', news.band)}</p></div>
          </div>
        )}
      </form>

      <form className="action" onSubmit={(e) => {
        e.preventDefault();
        run(async () => { await api.post(`/shifts/${s.id}/notes`, { type: noteType, text: note }); setNote(''); }, 'تم حفظ الملاحظة');
      }}>
        <h3><Icon name="list" />ملاحظات ومستجدات</h3>
        <div className="seg" role="radiogroup" aria-label="نوع الملاحظة">
          {([['PROGRESS', 'متابعة'], ['MEDICATION', 'أدوية'], ['INCIDENT', 'حادثة']] as const).map(([k, l]) => (
            <button type="button" key={k} className={noteType === k ? 'on' : ''} onClick={() => setNoteType(k)}>{l}</button>
          ))}
        </div>
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} aria-label="الملاحظة" placeholder="شو صار خلال الشفت؟" required />
        <button className="secondary block" disabled={busy}>حفظ الملاحظة</button>
      </form>

      <form className="action" onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          const r = await api.post<{ billableMinutes: number }>(`/shifts/${s.id}/check-out`, { handover });
          reload();
          return r;
        }, 'انتهى الشفت وتسجّلت الساعات');
      }}>
        <h3><Icon name="logout" />تسليم وإنهاء الشفت</h3>
        <Field label="ملخص التسليم للممرض اللي بعدك" hint="الحالة، الأدوية، أي شي لازم ينتبه عليه"><textarea rows={3} value={handover} onChange={(e) => setHandover(e.target.value)} required minLength={5} /></Field>
        <button className="primary block" disabled={busy}>إنهاء الشفت · Check-out</button>
      </form>
    </div>
  );
}

function Shifts({ me }: { me: Staff }) {
  const list = useLoad(() => api.get<any[]>(`/shifts?nurseId=${me.id}`));
  const [open, setOpen] = useState<number | null>(null);
  if (!list.data) return list.error ? <div className="notice bad">{list.error}</div> : <Loading card />;
  const now = Date.now();
  const upcoming = (list.data ?? []).filter((s) => ['PLANNED', 'LATE', 'CHECKED_IN'].includes(s.status) && new Date(s.planned_end).getTime() > now - 6 * 3600_000);
  const current = upcoming.find((s) => s.status === 'CHECKED_IN');
  const shown = open ?? current?.id ?? upcoming[0]?.id;
  return (
    <div className="stack">
      {!upcoming.length && <Empty icon="calendar" title="ما عندك شفتات قادمة">لما المنسق ينشر جدول جديد بتلاقي شفتاتك هون.</Empty>}
      <ul className="visits">
        {upcoming.slice(0, 14).map((s) => (
          <li key={s.id} className={`visit ${shown === s.id ? 'open' : ''}`}>
            <div className="visit-head" onClick={() => setOpen(s.id)}>
              <div>
                <span className="small muted mono">{s.episode_no}</span>
                <strong>{s.full_name}</strong>
                <div className="visit-meta">
                  <span><Icon name="clock" size={15} />{fmtTime(s.planned_start)} ← {fmtTime(s.planned_end)}</span>
                  {s.address && <span><Icon name="pin" size={15} />{s.address}</span>}
                </div>
              </div>
              <Pill status={s.status} />
            </div>
            {shown === s.id && <ShiftPanel s={s} reload={list.reload} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- Doctor case list -------------------------------------------------------
function DoctorCase({ id, services }: { id: number; services: Service[] }) {
  const ep = useLoad(() => api.get<any>(`/episodes/${id}`), [id]);
  const { busy, run } = useAction();
  const [plan, setPlan] = useState({ shiftHours: '12', hoursPerDay: '24', durationDays: '14', goals: '' });
  const [order, setOrder] = useState({ serviceCode: '', priority: 'ROUTINE', notes: '' });
  const [decision, setDecision] = useState<Record<number, string>>({});
  const [holdNote, setHoldNote] = useState('');
  const d = ep.data;
  if (!d) return <Loading />;
  const pending = d.results.filter((r: any) => !r.acknowledged_by);
  const openEsc = d.escalations.filter((e: any) => e.status !== 'RESOLVED' && e.trigger !== 'CRITICAL_RESULT');
  const orderable = services.filter((s) => s.department !== 'CLINICAL');

  return (
    <div className="stack">
      <div className="facts">
        <div><span className="k">التشخيص</span><span>{d.diagnosis}</span></div>
        <div><span className="k">الحالة</span><Pill status={d.status} /></div>
        <div><span className="k">الحساسية</span><span>{JSON.parse(d.patient.allergies).join('، ') || '—'}</span></div>
        <div><span className="k">آخر NEWS2</span><span className="mono">{d.vitals[0] ? `${d.vitals[0].news2_total} · ${fmtTime(d.vitals[0].at)}` : '—'}</span></div>
      </div>

      {['ACTIVE', 'ON_HOLD'].includes(d.status) && (
        <div className={`notice ${d.status === 'ON_HOLD' ? 'warn' : 'ok'}`}>
          {d.status === 'ON_HOLD' ? <strong>الرعاية معلّقة: {d.hold_reason ?? '—'}</strong> : <strong>الرعاية مستمرة</strong>}
          <div className="row">
            <input aria-label="ملاحظة التعليق أو الاستئناف" placeholder={d.status === 'ON_HOLD' ? 'رجع للبيت ومستقر…' : 'سبب التعليق: دخول مستشفى…'} value={holdNote} onChange={(x) => setHoldNote(x.target.value)} />
            <button className={d.status === 'ON_HOLD' ? 'primary' : 'ghost'} disabled={busy || holdNote.trim().length < 3} onClick={() => run(async () => {
              if (d.status === 'ON_HOLD') await api.post(`/episodes/${id}/resume`, { note: holdNote });
              else await api.post(`/episodes/${id}/hold`, { reason: holdNote });
              setHoldNote(''); ep.reload();
            }, d.status === 'ON_HOLD' ? 'رجعت الرعاية، والمنسق انبلغ' : 'انعلّقت الرعاية')}>{d.status === 'ON_HOLD' ? 'استئناف الرعاية' : 'تعليق الرعاية'}</button>
          </div>
        </div>
      )}

      {openEsc.map((e: any) => (
        <div key={e.id} className="notice bad">
          <div className="notice-head"><Icon name="alert" /><span><strong>{e.trigger === 'NEWS2' ? `NEWS2 · ${e.level}` : e.trigger}</strong> {escalationAr(e.trigger, e.level)}</span></div>
          <div className="row">
            <input aria-label="القرار" placeholder="القرار: تعديل علاج، زيارة، تحويل…" value={decision[e.id] ?? ''} onChange={(x) => setDecision({ ...decision, [e.id]: x.target.value })} />
            <button className="primary" disabled={busy || !decision[e.id]} onClick={() => run(async () => { await api.post(`/escalations/${e.id}/ack`, { decision: decision[e.id], resolve: true }); ep.reload(); }, 'تم توثيق القرار')}>توثيق وإغلاق</button>
          </div>
        </div>
      ))}

      {pending.length > 0 && (
        <section className="action">
          <h3>نتائج بانتظار مراجعتك</h3>
          <ul className="list">
            {pending.map((r: any) => (
              <li key={r.id} className="list-row">
                <span>{r.critical ? <Pill status="HIGH" label="حرجة" /> : null} {r.report}</span>
                <button className="secondary" disabled={busy} onClick={() => run(async () => { await api.post(`/results/${r.id}/acknowledge`); ep.reload(); }, 'تمت المراجعة ووصلت للمريض')}>راجعت</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <form className="action" onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          await api.post(`/episodes/${id}/care-plan`, { shiftHours: Number(plan.shiftHours), hoursPerDay: Number(plan.hoursPerDay), durationDays: Number(plan.durationDays), goals: plan.goals || undefined });
          ep.reload();
        }, 'اعتُمدت خطة الرعاية وانبعتت للمنسق');
      }}>
        <h3>خطة الرعاية {d.carePlan && <span className="muted small">الحالية: نسخة {d.carePlan.version} · شفت {d.carePlan.shift_hours} س · {d.carePlan.hours_per_day} س/يوم · {d.carePlan.duration_days} يوم</span>}</h3>
        <div className="grid-3">
          <Field label="طول الشفت">
            <select value={plan.shiftHours} onChange={(e) => setPlan({ ...plan, shiftHours: e.target.value })}><option value="8">8 ساعات</option><option value="12">12 ساعة</option><option value="24">24 ساعة</option></select>
          </Field>
          <Field label="ساعات باليوم"><input type="number" min={1} max={24} value={plan.hoursPerDay} onChange={(e) => setPlan({ ...plan, hoursPerDay: e.target.value })} /></Field>
          <Field label="المدة (أيام)"><input type="number" min={1} value={plan.durationDays} onChange={(e) => setPlan({ ...plan, durationDays: e.target.value })} /></Field>
        </div>
        <Field label="الأهداف"><textarea rows={2} value={plan.goals} onChange={(e) => setPlan({ ...plan, goals: e.target.value })} /></Field>
        <button className="primary" disabled={busy}>اعتماد الخطة</button>
      </form>

      <form className="action" onSubmit={(e) => {
        e.preventDefault();
        run(async () => { await api.post(`/episodes/${id}/orders`, { ...order, notes: order.notes || undefined }); setOrder({ serviceCode: '', priority: 'ROUTINE', notes: '' }); ep.reload(); }, 'انبعت الأوردر للقسم');
      }}>
        <h3>أوردر جديد</h3>
        <div className="grid-3">
          <Field label="الخدمة">
            <select value={order.serviceCode} onChange={(e) => setOrder({ ...order, serviceCode: e.target.value })} required>
              <option value="">اختر</option>
              {orderable.map((s) => <option key={s.code} value={s.code}>{s.name_ar}</option>)}
            </select>
          </Field>
          <Field label="الأولوية">
            <select value={order.priority} onChange={(e) => setOrder({ ...order, priority: e.target.value })}><option value="ROUTINE">عادي</option><option value="URGENT">عاجل</option><option value="STAT">فوري</option></select>
          </Field>
          <Field label="ملاحظة"><input value={order.notes} onChange={(e) => setOrder({ ...order, notes: e.target.value })} /></Field>
        </div>
        <button className="secondary" disabled={busy}><Icon name="send" />إرسال الأوردر</button>
        {d.orders.length > 0 && (
          <ul className="list">{d.orders.map((o: any) => <li key={o.id} className="list-row"><span>{services.find((s) => s.code === o.service_code)?.name_ar} · {o.priority}</span><Pill status={o.status === 'ACKNOWLEDGED' ? 'RESOLVED' : o.status === 'VALIDATED' ? 'ACKED' : 'PLANNED'} label={{ PLACED: 'مُرسل', ACCEPTED: 'مستلم', IN_PROGRESS: 'قيد التنفيذ', VALIDATED: 'نتيجة جاهزة', ACKNOWLEDGED: 'تمت المراجعة' }[o.status as string]} /></li>)}</ul>
        )}
      </form>

      <DischargeBox id={id} onDone={ep.reload} />
    </div>
  );
}

function DischargeBox({ id, onDone }: { id: number; onDone: () => void }) {
  const { busy, run } = useAction();
  const [summary, setSummary] = useState('');
  return (
    <details className="action">
      <summary>إنهاء الرعاية (ملخص خروج)</summary>
      <Field label="ملخص الخروج"><textarea rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} /></Field>
      <button className="danger" disabled={busy || summary.length < 10} onClick={() => run(async () => { await api.post(`/episodes/${id}/discharge`, { summary }); onDone(); }, 'انتهت الرعاية وانبعت استبيان الرضا')}>إنهاء</button>
    </details>
  );
}

function Doctor({ me }: { me: Staff }) {
  const list = useLoad(() => api.get<any[]>('/episodes'));
  const services = useLoad(() => api.get<Service[]>('/services'));
  const mine = (list.data ?? []).filter((e) => e.doctor_id === me.id && ['ACTIVE', 'ON_HOLD'].includes(e.status));
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="stack">
      {!list.data && <Loading card />}
      {list.data && !mine.length && <Empty icon="heart" title="ما عندك حالات نشطة">حالات الرعاية المنزلية اللي انت طبيبها بتظهر هون.</Empty>}
      <ul className="visits">
        {mine.map((e) => (
          <li key={e.id} className={`visit${open === e.id ? ' open' : ''}`}>
            <div className="visit-head" onClick={() => setOpen(open === e.id ? null : e.id)} role="button" aria-expanded={open === e.id}>
              <div><span className="small muted mono">{e.episode_no}</span><strong>{e.full_name}</strong><div className="small muted">{e.diagnosis}</div></div>
              <Pill status={e.status} />
            </div>
            {open === e.id && services.data && <DoctorCase id={e.id} services={services.data} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- Department worklist ------------------------------------------------------
const ROLE_DEPT: Record<string, string> = { LAB_TECH: 'LAB', RADIOGRAPHER: 'RADIOLOGY', PHARMACIST: 'PHARMACY', DRIVER: 'EQUIPMENT' };

function Worklist({ me }: { me: Staff }) {
  const dept = ROLE_DEPT[me.role];
  const list = useLoad(() => api.get<any[]>(`/orders?department=${dept}`));
  const { busy, run } = useAction();
  const [rep, setRep] = useState<Record<number, { text: string; critical: boolean }>>({});
  const [serial, setSerial] = useState<Record<number, string>>({});
  const [stockItems, setStockItems] = useState<Record<number, StockItem[] | undefined>>({});
  const toast = useToast();
  return (
    <div className="stack">
      {!list.data && <Loading card />}
      {list.data && !list.data.length && <Empty icon="lab" title="ما في أوردرات مفتوحة">أوردرات الأطباء لقسمك بتظهر هون أول بأول.</Empty>}
      <ul className="visits">
        {list.data?.map((o) => (
          <li key={o.id} className="visit">
            <div className="visit-head">
              <div><span className="small muted mono">#{o.id}</span><strong>{o.name_ar}</strong><div className="small muted">{fmtTime(o.created_at)} {o.notes && `· ${o.notes}`}</div></div>
              <Pill status={o.priority === 'ROUTINE' ? 'PLANNED' : 'HIGH'} label={{ ROUTINE: 'عادي', URGENT: 'عاجل', STAT: 'فوري' }[o.priority as string]} />
            </div>
            {o.status === 'PLACED' ? (
              <button className="secondary block" disabled={busy} onClick={() => run(async () => { await api.post(`/orders/${o.id}/accept`); list.reload(); }, 'استلمت الأوردر')}><Icon name="check" />استلام الأوردر</button>
            ) : (
              <div className="stack">
                <textarea rows={2} aria-label="النتيجة" placeholder={dept === 'EQUIPMENT' ? 'تم التوصيل والتركيب…' : 'النتيجة / التقرير'} value={rep[o.id]?.text ?? ''} onChange={(e) => setRep({ ...rep, [o.id]: { text: e.target.value, critical: rep[o.id]?.critical ?? false } })} />
                {(dept === 'LAB' || dept === 'RADIOLOGY') && (
                  <label className="check"><input type="checkbox" checked={rep[o.id]?.critical ?? false} onChange={(e) => setRep({ ...rep, [o.id]: { text: rep[o.id]?.text ?? '', critical: e.target.checked } })} /> نتيجة حرجة</label>
                )}
                {dept !== 'LAB' && dept !== 'RADIOLOGY' && <StockBox serviceCode={o.service_code} editable={dept === 'PHARMACY'} onItems={(items) => setStockItems((x) => ({ ...x, [o.id]: items }))} />}
                {dept === 'EQUIPMENT' && <Field label="الرقم التسلسلي للجهاز"><input value={serial[o.id] ?? ''} onChange={(e) => setSerial({ ...serial, [o.id]: e.target.value })} /></Field>}
                <button className="primary block" disabled={busy || !rep[o.id]?.text} onClick={() => run(async () => { const out = await api.post<{ stockWarnings?: string[] }>(`/orders/${o.id}/result`, { report: rep[o.id].text, critical: rep[o.id].critical, serialNo: serial[o.id] || undefined, stockItems: stockItems[o.id]?.length ? stockItems[o.id] : undefined }); if (out.stockWarnings?.length) toast(`تنبيه مخزون: ${out.stockWarnings.join('، ')}`, 'err'); list.reload(); }, dept === 'EQUIPMENT' ? 'انسجّل التسليم وبدأ الإيجار' : 'انبعتت النتيجة')}>اعتماد وإرسال</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function FieldApp({ me }: { me: Staff }) {
  const tabs: [string, string][] = [['visits', 'زياراتي']];
  if (me.role === 'NURSE') tabs.unshift(['shifts', 'شفتاتي']);
  if (me.role === 'DOCTOR') tabs.push(['cases', 'حالاتي']);
  if (ROLE_DEPT[me.role]) tabs.push(['work', 'أوردرات القسم']);
  if (me.role === 'DRIVER') tabs.push(['pickups', 'استرجاع الأجهزة']);
  const [tab, setTab] = useState(tabs[0][0]);
  const TAB_IC: Record<string, string> = { visits: 'calendar', shifts: 'clock', cases: 'steth', work: 'lab', pickups: 'refresh' };
  const today = new Date().toLocaleDateString('ar-JO-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long' });
  return (
    <div className="phone">
      <div className="app-hello">
        <div>
          <h1>أهلاً {staffName(me.name)}</h1>
          <p>{today} · {ROLE_AR[me.role]}</p>
        </div>
      </div>
      <div className={`subtabs${tabs.length > 1 ? ' app-nav' : ''}`} role="tablist">
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}><Icon name={TAB_IC[k]} />{l}</button>)}
      </div>
      {tab === 'visits' && <Visits me={me} />}
      {tab === 'shifts' && <Shifts me={me} />}
      {tab === 'cases' && <Doctor me={me} />}
      {tab === 'work' && <Worklist me={me} />}
      {tab === 'pickups' && <Devices pickupOnly canExtend={false} />}
    </div>
  );
}
