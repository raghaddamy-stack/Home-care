// Call center: register a request on the phone, and follow up on requests with missing data.
import { useMemo, useState } from 'react';
import { api, ApiError, isoToLocal, jod, localToIso, type RequestRow, type Service, type Staff } from '../api';
import { Empty, Field, Pill, useAction, useLoad } from '../ui';

interface PatientForm {
  nationalId: string; fullName: string; dob: string; gender: '' | 'M' | 'F'; phone: string;
  address: string; lat: string; lng: string; emergencyContact: string;
}
const blank: PatientForm = { nationalId: '', fullName: '', dob: '', gender: '', phone: '', address: '', lat: '', lng: '', emergencyContact: '' };

function patientPayload(p: PatientForm) {
  const out: Record<string, unknown> = { nationalId: p.nationalId.trim(), fullName: p.fullName.trim() };
  if (p.dob) out.dob = p.dob;
  if (p.gender) out.gender = p.gender;
  if (p.phone) out.phone = p.phone;
  if (p.address) out.address = p.address;
  if (p.lat && p.lng) { out.lat = Number(p.lat); out.lng = Number(p.lng); }
  if (p.emergencyContact) out.emergencyContact = p.emergencyContact;
  return out;
}

function PatientFields({ p, set }: { p: PatientForm; set: (p: PatientForm) => void }) {
  const f = (k: keyof PatientForm) => ({ value: p[k], onChange: (e: { target: { value: string } }) => set({ ...p, [k]: e.target.value }) });
  return (
    <div className="grid-3">
      <Field label="الاسم الكامل"><input id="pf-name" {...f('fullName')} required /></Field>
      <Field label="تاريخ الميلاد"><input id="pf-dob" type="date" {...f('dob')} /></Field>
      <Field label="الجنس">
        <select id="pf-gender" {...f('gender')}><option value="">—</option><option value="M">ذكر</option><option value="F">أنثى</option></select>
      </Field>
      <Field label="الهاتف"><input id="pf-phone" inputMode="tel" {...f('phone')} /></Field>
      <Field label="جهة اتصال للطوارئ"><input id="pf-emg" {...f('emergencyContact')} /></Field>
      <Field label="العنوان"><input id="pf-addr" {...f('address')} placeholder="المدينة، الحي، العمارة" /></Field>
      <Field label="خط العرض (GPS)"><input id="pf-lat" inputMode="decimal" {...f('lat')} placeholder="31.95" /></Field>
      <Field label="خط الطول (GPS)" hint="من رابط الموقع اللي بيبعته المريض"><input id="pf-lng" inputMode="decimal" {...f('lng')} placeholder="35.91" /></Field>
    </div>
  );
}

function NewRequest({ onCreated }: { onCreated: () => void }) {
  const services = useLoad(() => api.get<Service[]>('/services'));
  const payers = useLoad(() => api.get<{ id: number; name: string; type: string }[]>('/payers'));
  const { busy, run } = useAction();

  const [p, setP] = useState<PatientForm>(blank);
  const [found, setFound] = useState<'new' | 'existing' | null>(null);
  const [items, setItems] = useState<Record<string, number>>({});
  const [urgency, setUrgency] = useState('ROUTINE');
  const [preferred, setPreferred] = useState(() => { const d = new Date(Date.now() + 86_400_000); d.setHours(9, 0, 0, 0); return isoToLocal(d); });
  const [notes, setNotes] = useState('');
  const [rx, setRx] = useState('');
  const [payerId, setPayerId] = useState('');
  const [memberNo, setMemberNo] = useState('');
  const [result, setResult] = useState<{ request_no: string; status: string; missing: string[] } | null>(null);

  const chosen = Object.entries(items).filter(([, q]) => q > 0);
  const needsRx = chosen.some(([c]) => services.data?.find((s) => s.code === c)?.requires_prescription);
  const estimate = chosen.reduce((a, [c, q]) => a + (services.data?.find((s) => s.code === c)?.cash_price ?? 0) * q, 0);
  const byLine = useMemo(() => {
    const g: Record<string, Service[]> = {};
    for (const s of services.data ?? []) (g[s.line] ??= []).push(s);
    return g;
  }, [services.data]);

  const lookup = () => run(async () => {
    try {
      const x = await api.get<any>(`/patients?nationalId=${encodeURIComponent(p.nationalId.trim())}`);
      setP({
        nationalId: x.national_id, fullName: x.full_name ?? '', dob: x.dob ?? '', gender: x.gender ?? '', phone: x.phone ?? '',
        address: x.address ?? '', lat: x.lat?.toString() ?? '', lng: x.lng?.toString() ?? '', emergencyContact: x.emergency_contact ?? '',
      });
      setFound('existing');
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) { setFound('new'); setP({ ...blank, nationalId: p.nationalId }); }
      else throw e;
    }
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const res = await api.post<any>('/requests', {
        channel: 'CALL_CENTER',
        patient: patientPayload(p),
        items: chosen.map(([serviceCode, qty]) => ({ serviceCode, qty })),
        urgency,
        preferredAt: preferred ? localToIso(preferred) : undefined,
        clinicalNotes: notes || undefined,
        prescriptionRef: rx || undefined,
        insurance: payerId && memberNo ? { payerId: Number(payerId), memberNo } : undefined,
      });
      setResult(res);
      setP(blank); setFound(null); setItems({}); setNotes(''); setRx(''); setPayerId(''); setMemberNo('');
      onCreated();
    }, 'تم تسجيل الطلب');
  };

  const LINE_AR: Record<string, string> = { LAB: 'مختبر', IMG: 'أشعة', DEV: 'أجهزة ومعدات', DOC: 'طبيب', NRS: 'تمريض' };

  return (
    <form className="card" onSubmit={submit}>
      <h2>طلب جديد بالتلفون</h2>
      {result && (
        <div className={`notice ${result.missing.length ? 'warn' : 'ok'}`}>
          <strong>{result.request_no}</strong>{' '}
          {result.missing.length ? `ناقص: ${result.missing.join('، ')}. الطلب بقائمة المتابعة.` : 'تحوّل للمنسق للتسعير.'}
        </div>
      )}

      <section className="step">
        <h3><span className="num">1</span> المريض</h3>
        <div className="row">
          <Field label="الرقم الوطني"><input id="nid" value={p.nationalId} onChange={(e) => { setP({ ...p, nationalId: e.target.value }); setFound(null); }} inputMode="numeric" required /></Field>
          <button type="button" className="secondary" onClick={lookup} disabled={busy || p.nationalId.trim().length < 5}>بحث</button>
          {found === 'existing' && <Pill status="ACTIVE" label="ملف موجود" />}
          {found === 'new' && <Pill status="UNDER_REVIEW" label="مريض جديد" />}
        </div>
        {found && <PatientFields p={p} set={setP} />}
      </section>

      <section className="step">
        <h3><span className="num">2</span> الخدمة</h3>
        {Object.entries(byLine).map(([line, list]) => (
          <div key={line} className="svc-group">
            <span className="svc-line">{LINE_AR[line] ?? line}</span>
            <div className="svc-list">
              {list.map((s) => (
                <label key={s.code} className={items[s.code] ? 'svc on' : 'svc'}>
                  <input type="checkbox" checked={!!items[s.code]} onChange={(e) => setItems({ ...items, [s.code]: e.target.checked ? 1 : 0 })} />
                  <span>{s.name_ar}</span>
                  <span className="muted mono">{jod(s.cash_price)}{s.unit === 'DAY' ? '/يوم' : s.unit === 'HOUR' ? '/ساعة' : ''}</span>
                  {items[s.code] > 0 && (s.unit === 'DAY' || s.unit === 'HOUR') && (
                    <input className="qty" type="number" min={1} value={items[s.code]} aria-label="الكمية"
                      onChange={(e) => setItems({ ...items, [s.code]: Math.max(1, Number(e.target.value)) })} />
                  )}
                </label>
              ))}
            </div>
          </div>
        ))}
        <div className="grid-3">
          <Field label="الأولوية">
            <select id="urg" value={urgency} onChange={(e) => setUrgency(e.target.value)}>
              <option value="ROUTINE">عادي</option><option value="SAME_DAY">نفس اليوم</option><option value="URGENT">عاجل</option>
            </select>
          </Field>
          <Field label="الوقت المفضّل"><input id="pref" type="datetime-local" value={preferred} onChange={(e) => setPreferred(e.target.value)} /></Field>
          <Field label="رقم الوصفة" hint={needsRx ? 'مطلوبة لهاي الخدمة' : undefined}><input id="rx" value={rx} onChange={(e) => setRx(e.target.value)} /></Field>
        </div>
        <Field label="ملاحظات سريرية"><textarea id="notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </section>

      <section className="step">
        <h3><span className="num">3</span> الدفع</h3>
        <div className="grid-3">
          <Field label="جهة الدفع">
            <select id="payer" value={payerId} onChange={(e) => setPayerId(e.target.value)}>
              <option value="">نقدي</option>
              {payers.data?.filter((x) => x.type !== 'SELF').map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </Field>
          {payerId && <Field label="رقم العضوية"><input id="member" value={memberNo} onChange={(e) => setMemberNo(e.target.value)} required /></Field>}
        </div>
      </section>

      <footer className="form-foot">
        <span className="muted">تقدير نقدي: <strong className="mono">{jod(estimate)}</strong> (السعر النهائي من المنسق)</span>
        <button className="primary" disabled={busy || !found || chosen.length === 0 || !p.fullName}>تسجيل الطلب</button>
      </footer>
    </form>
  );
}

function PendingInfo({ tick }: { tick: number }) {
  const list = useLoad(() => api.get<RequestRow[]>('/requests?status=PENDING_INFO'), [tick]);
  const { busy, run } = useAction();
  const [open, setOpen] = useState<number | null>(null);
  const [p, setP] = useState<PatientForm>(blank);
  const [rx, setRx] = useState('');

  const start = async (r: RequestRow) => {
    const x = await api.get<any>(`/patients/${r.patient_id}`);
    setP({ nationalId: x.national_id, fullName: x.full_name, dob: x.dob ?? '', gender: x.gender ?? '', phone: x.phone ?? '', address: x.address ?? '', lat: x.lat?.toString() ?? '', lng: x.lng?.toString() ?? '', emergencyContact: x.emergency_contact ?? '' });
    setRx('');
    setOpen(r.id);
  };

  return (
    <div className="card">
      <h2>متابعة بيانات ناقصة</h2>
      {!list.data?.length && <Empty>ما في طلبات ناقصة حالياً.</Empty>}
      <ul className="list">
        {list.data?.map((r) => (
          <li key={r.id}>
            <div className="list-row">
              <div>
                <strong>{r.full_name}</strong> <span className="muted mono">{r.request_no}</span>
                <div className="muted small">{r.last_note} · {r.phone ?? 'بدون هاتف'}</div>
              </div>
              <button className="secondary" onClick={() => start(r)}>استكمال</button>
            </div>
            {open === r.id && (
              <form className="inline-form" onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  const { nationalId, ...rest } = patientPayload(p) as any;
                  const res = await api.post<{ status: string; missing: string[] }>(`/requests/${r.id}/complete-info`, { ...rest, prescriptionRef: rx || undefined });
                  if (res.missing.length) throw new Error(`لسا ناقص: ${res.missing.join('، ')}`);
                  setOpen(null);
                  list.reload();
                }, 'اكتملت البيانات وتحوّل الطلب للمنسق');
              }}>
                <PatientFields p={p} set={setP} />
                <Field label="رقم الوصفة (إذا مطلوبة)"><input value={rx} onChange={(e) => setRx(e.target.value)} /></Field>
                <button className="primary" disabled={busy}>حفظ</button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CallCenter(_: { me: Staff }) {
  const [tick, setTick] = useState(0);
  return (
    <div className="split">
      <NewRequest onCreated={() => setTick((t) => t + 1)} />
      <PendingInfo tick={tick} />
    </div>
  );
}
