// Patient app (mobile): sign in by SMS code, book a service, approve the price, track the visit, see results and invoices.
import { useEffect, useMemo, useState } from 'react';
import { api, fmtTime, isoToLocal, jod, localToIso, setPatientToken, type Service } from '../api';
import { Empty, Field, Pill, useAction, useLoad } from '../ui';
import { LiveStamp, usePolling, useUpdatedAt } from '../live';
import { RatePrompts } from './PatientFeedback';

const TOKEN_KEY = 'hc.patientToken';
export const loadPatientToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
const saveToken = (t: string | null) => {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* storage off */ }
  setPatientToken(t);
};

// ---- Sign in ------------------------------------------------------------------
function SignIn({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const { busy, run } = useAction();
  const [nid, setNid] = useState('');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [needsName, setNeedsName] = useState(false);
  const [sent, setSent] = useState<{ devCode?: string } | null>(null);
  const [code, setCode] = useState('');

  const ask = () => run(async () => {
    const r = await api.post<any>('/patient-auth/request-otp', { nationalId: nid.trim(), phone, fullName: name || undefined });
    if (r.needsName) { setNeedsName(true); return; }
    setSent(r);
  });
  const verify = () => run(async () => {
    const r = await api.post<{ token: string }>('/patient-auth/verify', { nationalId: nid.trim(), code });
    saveToken(r.token);
    onDone();
  });

  return (
    <main className="login">
      <div className="login-card">
        <span className="eyebrow">Home Care · للمرضى</span>
        <h1>رعاية</h1>
        {!sent ? (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); ask(); }}>
            <p className="muted">خدمات طبية لعندك عالبيت: فحوصات، أشعة، أجهزة، تمريض وزيارات طبيب.</p>
            <Field label="الرقم الوطني"><input id="p-nid" inputMode="numeric" value={nid} onChange={(e) => setNid(e.target.value)} required /></Field>
            <Field label="رقم الموبايل"><input id="p-phone" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07XXXXXXXX" required /></Field>
            {needsName && <Field label="الاسم الكامل" hint="أول مرة؟ رح نفتحلك ملف"><input id="p-name" value={name} onChange={(e) => setName(e.target.value)} required /></Field>}
            <button className="primary block" disabled={busy}>أرسل رمز التحقق</button>
            <button type="button" className="ghost" onClick={onBack}>دخول الموظفين</button>
          </form>
        ) : (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); verify(); }}>
            <p className="muted">بعتنالك رمز من 6 أرقام على {phone}.</p>
            {sent.devCode && <div className="notice warn">نسخة تجريبية بدون SMS: الرمز <strong className="mono">{sent.devCode}</strong></div>}
            <Field label="الرمز"><input id="p-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required /></Field>
            <button className="primary block" disabled={busy || code.length !== 6}>دخول</button>
            <button type="button" className="ghost" onClick={() => { setSent(null); setCode(''); }}>تغيير الرقم</button>
          </form>
        )}
      </div>
    </main>
  );
}

// ---- Request tracking -------------------------------------------------------------
const STEPS = ['الطلب', 'التسعير', 'موافقتك', 'الموعد', 'بالطريق', 'تمت'];
const STEP_OF: Record<string, number> = {
  SUBMITTED: 0, PENDING_INFO: 0, UNDER_REVIEW: 1, PENDING_PREAPPROVAL: 1, QUOTED: 2, EXPIRED: 2, ACCEPTED: 3, NO_SHOW: 3,
  SCHEDULED: 3, DISPATCHED: 4, IN_PROGRESS: 5, COMPLETED: 5, CONVERTED_TO_EPISODE: 5, REFERRED_OUT: 5,
};
const PATIENT_STATUS: Record<string, string> = {
  PENDING_INFO: 'بدنا كم معلومة منك', UNDER_REVIEW: 'المنسق بيجهّز السعر', PENDING_PREAPPROVAL: 'بانتظار موافقة التأمين',
  QUOTED: 'السعر جاهز، بانتظار موافقتك', ACCEPTED: 'وافقت، عم نحجزلك موعد', SCHEDULED: 'تم حجز الموعد', DISPATCHED: 'الفريق بالطريق',
  IN_PROGRESS: 'الفريق عندك', COMPLETED: 'تمت الخدمة', CONVERTED_TO_EPISODE: 'بدأت الرعاية المنزلية', REFERRED_OUT: 'حوّلناك لجهة مختصة',
  EXPIRED: 'انتهت صلاحية عرض السعر، المنسق رح يبعتلك سعر محدّث', CANCELLED: 'ملغي', NO_SHOW: 'ما لقيناك بالبيت، رح نتواصل معك لموعد جديد',
};

function Stepper({ status }: { status: string }) {
  if (status === 'CANCELLED') return null;
  const at = STEP_OF[status] ?? 0;
  return (
    <ol className="stepper" aria-label="مراحل الطلب">
      {STEPS.map((s, i) => <li key={s} className={i < at ? 'done' : i === at ? 'now' : ''}><span />{s}</li>)}
    </ol>
  );
}

function RequestCard({ r, reload, goProfile }: { r: any; reload: () => void; goProfile: () => void }) {
  const { busy, run } = useAction();
  const [declining, setDeclining] = useState(false);
  const [consent, setConsent] = useState(false);
  const [reason, setReason] = useState('');
  const MISSING_AR: Record<string, string> = { dob: 'تاريخ الميلاد', gender: 'الجنس', phone: 'الهاتف', address: 'العنوان', 'gps location': 'موقعك على الخريطة', 'emergency contact': 'رقم للطوارئ', prescription: 'الوصفة الطبية' };
  return (
    <li className="visit">
      <div className="visit-head">
        <div>
          <strong>{r.items.map((i: any) => i.name_ar).join('، ')}</strong>
          <div className="small muted"><span className="mono">{r.requestNo}</span> · {fmtTime(r.createdAt)}</div>
        </div>
        {r.status === 'CANCELLED' && <Pill status="CANCELLED" />}
      </div>
      <Stepper status={r.status} />
      <p className="status-line">{PATIENT_STATUS[r.status] ?? r.status}</p>

      {r.status === 'PENDING_INFO' && (
        <div className="notice warn">
          ناقص: {r.missing.map((m: string) => MISSING_AR[m] ?? m).join('، ')}
          {r.missing.some((m: string) => m !== 'prescription') && <button className="secondary" onClick={goProfile}>أكمل ملفي</button>}
          {r.missing.includes('prescription') && <span className="small">ابعتلنا صورة الوصفة على الواتساب أو أعطيها للمنسق لما يتصل فيك.</span>}
        </div>
      )}

      {r.quote && (
        <div className="quote">
          <table className="mini">
            <tbody>
              {r.quote.lines.map((l: any) => <tr key={l.serviceCode}><td>{r.items.find((i: any) => i.service_code === l.serviceCode)?.name_ar} ×{l.qty}</td><td className="mono">{jod(l.patientShare)}</td></tr>)}
            </tbody>
            <tfoot>
              {r.quote.payerTotal > 0 && <tr><td className="small muted">يغطّيه التأمين</td><td className="mono small muted">{jod(r.quote.payerTotal)}</td></tr>}
              <tr><td>المطلوب منك</td><td className="mono"><strong>{jod(r.quote.patientTotal)}</strong></td></tr>
            </tfoot>
          </table>
          {r.status === 'QUOTED' && r.quote.validUntil && <p className="small muted">السعر صالح لغاية {fmtTime(r.quote.validUntil)}</p>}
          {r.status === 'QUOTED' && !declining && (
            <label className="check small"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> أوافق على تلقّي الرعاية والخدمات الطبية في البيت (الموافقة العامة)</label>
          )}
          {r.status === 'QUOTED' && !declining && (
            <div className="grid-2">
              <button className="primary" disabled={busy} onClick={() => run(async () => { await api.post(`/me/requests/${r.id}/accept`, { consentGeneral: consent }); reload(); }, 'وصلت موافقتك، رح نحجزلك موعد')}>موافق</button>
              <button className="ghost" onClick={() => setDeclining(true)}>مش موافق</button>
            </div>
          )}
        </div>
      )}

      {declining && (
        <div className="stack">
          <Field label="ليش؟ (بيساعدنا نتحسّن)"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="السعر، الموعد، غيّرت رأيي…" /></Field>
          <button className="danger" disabled={busy || reason.trim().length < 3} onClick={() => run(async () => { await api.post(`/me/requests/${r.id}/cancel`, { reason }); reload(); }, 'تم إلغاء الطلب')}>إلغاء الطلب</button>
        </div>
      )}

      {r.visit && ['SCHEDULED', 'DISPATCHED', 'CHECKED_IN'].includes(r.visit.status) && (
        <div className="visit-box">
          <div>
            <span className="small muted">الموعد</span>
            <strong>{fmtTime(r.visit.scheduled_at)}</strong>
            <span className="small">{r.visit.staff_name}</span>
          </div>
          {r.visit.otp && (
            <div className="otp">
              <span className="small muted">رمز الزيارة</span>
              <strong className="mono">{r.visit.otp}</strong>
              <span className="small muted">أعطيه للفريق لما يوصل</span>
            </div>
          )}
        </div>
      )}

      {['SUBMITTED', 'PENDING_INFO', 'UNDER_REVIEW', 'PENDING_PREAPPROVAL', 'ACCEPTED', 'SCHEDULED'].includes(r.status) && !declining && (
        <button className="ghost small" onClick={() => setDeclining(true)}>إلغاء الطلب</button>
      )}
    </li>
  );
}

// ---- New request ------------------------------------------------------------------
function NewRequest({ onDone }: { onDone: () => void }) {
  const services = useLoad(() => api.get<Service[]>('/services'));
  const { busy, run } = useAction();
  const [items, setItems] = useState<Record<string, number>>({});
  const [when, setWhen] = useState(() => { const d = new Date(Date.now() + 86_400_000); d.setHours(9, 0, 0, 0); return isoToLocal(d); });
  const [notes, setNotes] = useState('');
  const [rx, setRx] = useState('');
  const [urgent, setUrgent] = useState(false);
  const chosen = Object.entries(items).filter(([, q]) => q > 0);
  const LINES: [string, string][] = [['LAB', 'فحوصات مخبرية'], ['IMG', 'أشعة بالبيت'], ['DEV', 'أجهزة ومعدات طبية'], ['DOC', 'زيارة طبيب'], ['NRS', 'تمريض']];
  const byLine = useMemo(() => {
    const g: Record<string, Service[]> = {};
    for (const s of services.data ?? []) if (s.code !== 'PHA-DELIVERY') (g[s.line] ??= []).push(s);
    return g;
  }, [services.data]);
  const needsRx = chosen.some(([c]) => services.data?.find((s) => s.code === c)?.requires_prescription);

  return (
    <form className="stack" onSubmit={(e) => {
      e.preventDefault();
      run(async () => {
        await api.post('/me/requests', {
          items: chosen.map(([serviceCode, qty]) => ({ serviceCode, qty })), preferredAt: localToIso(when),
          urgency: urgent ? 'SAME_DAY' : 'ROUTINE', clinicalNotes: notes || undefined, prescriptionRef: rx || undefined,
        });
        onDone();
      }, 'وصل طلبك، رح يتواصل معك المنسق بالسعر');
    }}>
      {LINES.map(([line, title]) => byLine[line] && (
        <section key={line} className="svc-group">
          <span className="svc-line">{title}</span>
          <div className="svc-list">
            {byLine[line].map((s) => (
              <label key={s.code} className={items[s.code] ? 'svc on' : 'svc'}>
                <input type="checkbox" checked={!!items[s.code]} onChange={(e) => setItems({ ...items, [s.code]: e.target.checked ? (s.unit === 'DAY' ? 7 : 1) : 0 })} />
                <span>{s.name_ar}</span>
                <span className="muted mono small">من {jod(s.cash_price)}{s.unit === 'DAY' ? '/يوم' : s.unit === 'HOUR' ? '/ساعة' : ''}</span>
                {items[s.code] > 0 && (s.unit === 'DAY' || s.unit === 'HOUR') && (
                  <input className="qty" type="number" min={1} value={items[s.code]} aria-label={s.unit === 'DAY' ? 'عدد الأيام' : 'عدد الساعات'}
                    onChange={(e) => setItems({ ...items, [s.code]: Math.max(1, Number(e.target.value)) })} />
                )}
              </label>
            ))}
          </div>
        </section>
      ))}
      <Field label="الموعد اللي بناسبك"><input id="n-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
      <label className="check"><input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} /> بدي ياها بنفس اليوم</label>
      {needsRx && <Field label="رقم الوصفة الطبية" hint="هاي الخدمة بدها وصفة طبيب"><input id="n-rx" value={rx} onChange={(e) => setRx(e.target.value)} /></Field>}
      <Field label="شو الحالة؟ (اختياري)"><textarea id="n-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <p className="small muted">السعر النهائي بيوصلك من المنسق قبل أي شي، وما في دفع قبل موافقتك.</p>
      <button className="primary block" disabled={busy || chosen.length === 0}>أرسل الطلب</button>
    </form>
  );
}

// ---- My file ---------------------------------------------------------------------
function MyFile({ me, reload }: { me: any; reload: () => void }) {
  const { busy, run } = useAction();
  const [f, setF] = useState({
    dob: me.dob ?? '', gender: me.gender ?? '', address: me.address ?? '', emergencyContact: me.emergencyContact ?? '', preferredStaffGender: me.preferredStaffGender ?? '',
    lat: me.lat as number | null, lng: me.lng as number | null,
  });
  const locate = () => run(() => new Promise<void>((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('الجهاز ما بيدعم تحديد الموقع'));
    navigator.geolocation.getCurrentPosition(
      (p) => { setF((x) => ({ ...x, lat: p.coords.latitude, lng: p.coords.longitude })); resolve(); },
      () => reject(new Error('ما قدرنا نحدد موقعك. اسمح للتطبيق باستخدام الموقع.')),
    );
  }), 'تم تحديد موقعك');

  return (
    <div className="stack">
      <form className="card" onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          await api.post('/me/profile', {
            dob: f.dob || undefined, gender: f.gender || undefined, address: f.address || undefined,
            emergencyContact: f.emergencyContact || undefined, preferredStaffGender: f.preferredStaffGender || null, lat: f.lat ?? undefined, lng: f.lng ?? undefined,
          });
          reload();
        }, 'تم حفظ بياناتك');
      }}>
        <h2>بياناتي</h2>
        <div className="grid-2">
          <Field label="تاريخ الميلاد"><input id="m-dob" type="date" value={f.dob} onChange={(e) => setF({ ...f, dob: e.target.value })} /></Field>
          <Field label="الجنس">
            <select id="m-gender" value={f.gender} onChange={(e) => setF({ ...f, gender: e.target.value })}><option value="">—</option><option value="M">ذكر</option><option value="F">أنثى</option></select>
          </Field>
        </div>
        <Field label="العنوان بالتفصيل"><input id="m-addr" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} placeholder="المدينة، الحي، الشارع، العمارة، الطابق" /></Field>
        <div className="row">
          <button type="button" className="secondary" disabled={busy} onClick={locate}>استخدم موقعي الحالي</button>
          <span className="small muted">{f.lat != null ? `تم تحديد الموقع (${f.lat.toFixed(4)}, ${f.lng!.toFixed(4)})` : 'الموقع مش محدد'}</span>
        </div>
        <Field label="بتفضّل الممرض/الطبيب يكون" hint="بنحاول نلتزم فيه قدر الإمكان">
          <select id="m-pref" value={f.preferredStaffGender} onChange={(e) => setF({ ...f, preferredStaffGender: e.target.value })}><option value="">ما بتفرق</option><option value="F">أنثى</option><option value="M">ذكر</option></select>
        </Field>
        <Field label="رقم شخص للطوارئ"><input id="m-emg" value={f.emergencyContact} onChange={(e) => setF({ ...f, emergencyContact: e.target.value })} placeholder="الاسم والرقم" /></Field>
        <button className="primary" disabled={busy}>حفظ</button>
      </form>

      <div className="card">
        <h2>نتائجي</h2>
        {!me.results.length && <Empty>لما تجهز نتيجة بتلاقيها هون.</Empty>}
        <ul className="list">{me.results.map((r: any) => <li key={r.id}><strong>{r.name_ar}</strong> <span className="small muted">{fmtTime(r.released_at)}</span><p className="small">{r.report}</p></li>)}</ul>
      </div>

      <div className="card">
        <h2>فواتيري</h2>
        {!me.invoices.length && <Empty>ما في فواتير.</Empty>}
        <ul className="list">
          {me.invoices.map((i: any) => (
            <li key={i.id} className="list-row">
              <div><span className="mono">{i.invoice_no}</span><div className="small muted">{i.period_from ? `${i.period_from.slice(0, 10)} ← ${i.period_to.slice(0, 10)}` : fmtTime(i.created_at)}</div></div>
              <div className="row-tight"><span className="mono">{jod(i.patient_total - i.paid)}</span><Pill status={i.status} /></div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ---- Shell -------------------------------------------------------------------------
function Home({ onLogout }: { onLogout: () => void }) {
  const me = useLoad(() => api.get<any>('/me'));
  const reqs = useLoad(() => api.get<any[]>('/me/requests'));
  const [tab, setTab] = useState<'requests' | 'new' | 'file'>('requests');
  usePolling(reqs.reload, 20_000, tab === 'requests');
  const updatedAt = useUpdatedAt(reqs.data);
  useEffect(() => {
    if (me.error) { saveToken(null); onLogout(); }
  }, [me.error, onLogout]);
  if (!me.data) return <p className="muted" style={{ padding: 16 }}>تحميل…</p>;
  const active = (reqs.data ?? []).filter((r) => !['COMPLETED', 'CANCELLED', 'CONVERTED_TO_EPISODE', 'REFERRED_OUT'].includes(r.status));
  const past = (reqs.data ?? []).filter((r) => !active.includes(r));

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">رعاية</div>
        <div className="me">
          <span>أهلاً {me.data.fullName.split(' ')[0]}</span>
          <button className="ghost" onClick={async () => { await api.post('/patient-auth/logout').catch(() => {}); saveToken(null); onLogout(); }}>خروج</button>
        </div>
      </header>
      <main className="content phone">
        <div className="subtabs" role="tablist">
          {([['requests', 'طلباتي'], ['new', 'طلب خدمة'], ['file', 'ملفي']] as const).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        {tab === 'requests' && (
          <div className="stack">
            <RatePrompts tick={reqs.data} />
            {!active.length && (
              <div className="empty">
                <p>ما عندك طلبات حالية.</p>
                <button className="primary" onClick={() => setTab('new')}>اطلب خدمة</button>
              </div>
            )}
            <ul className="visits">{active.map((r) => <RequestCard key={r.id} r={r} reload={() => { reqs.reload(); me.reload(); }} goProfile={() => setTab('file')} />)}</ul>
            {past.length > 0 && (
              <details className="card">
                <summary>طلبات سابقة ({past.length})</summary>
                <ul className="list">{past.map((r) => <li key={r.id} className="list-row"><span>{r.items.map((i: any) => i.name_ar).join('، ')} · <span className="small muted">{fmtTime(r.createdAt)}</span></span><Pill status={r.status} /></li>)}</ul>
              </details>
            )}
            <LiveStamp at={updatedAt} onRefresh={() => { reqs.reload(); me.reload(); }} />
          </div>
        )}
        {tab === 'new' && <NewRequest onDone={() => { reqs.reload(); setTab('requests'); }} />}
        {tab === 'file' && <MyFile me={me.data} reload={() => { me.reload(); reqs.reload(); }} />}
      </main>
    </div>
  );
}

export function PatientApp({ onExit }: { onExit: () => void }) {
  const [token, setToken] = useState(loadPatientToken);
  setPatientToken(token);
  if (!token) return <SignIn onDone={() => setToken(loadPatientToken())} onBack={onExit} />;
  return <Home onLogout={() => setToken(null)} />;
}
