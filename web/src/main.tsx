import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, ROLE_AR, setStaff, staffName, type Staff } from './api';
import { Loading, ToastHost, useLoad } from './ui';
import { Icon, Logo } from './icons';
import { CallCenter } from './screens/CallCenter';
import { Coordinator } from './screens/Coordinator';
import { FieldApp } from './screens/FieldApp';
import { Finance } from './screens/Finance';
import { Settings } from './screens/Settings';
import { Integrations } from './screens/Integrations';
import { loadPatientToken, PatientApp } from './screens/PatientApp';
import './styles.css';

type View = 'board' | 'intake' | 'field' | 'finance' | 'settings' | 'integrations';

const VIEWS: Record<View, { label: string; short: string; icon: string; roles: string[] }> = {
  board: { label: 'لوحة المنسق', short: 'المنسق', icon: 'board', roles: ['COORDINATOR', 'SUPERVISOR', 'ADMIN'] },
  intake: { label: 'الكول سنتر', short: 'الكول سنتر', icon: 'phone', roles: ['AGENT', 'COORDINATOR', 'ADMIN'] },
  field: { label: 'تطبيق الكادر', short: 'الميدان', icon: 'field', roles: ['NURSE', 'DOCTOR', 'LAB_TECH', 'RADIOGRAPHER', 'DRIVER'] },
  finance: { label: 'المالية', short: 'المالية', icon: 'wallet', roles: ['FINANCE', 'ADMIN'] },
  settings: { label: 'إعدادات المالك', short: 'الإعدادات', icon: 'settings', roles: ['ADMIN'] },
  integrations: { label: 'الربط مع الأنظمة', short: 'الربط', icon: 'plug', roles: ['ADMIN'] },
};

const initial = (name: string) => staffName(name).replace(/^(Dr\.|د\.)\s*/, '').trim().charAt(0).toUpperCase();

const STAFF_GROUPS: { title: string; roles: string[] }[] = [
  { title: 'العمليات وخدمة المرضى', roles: ['AGENT', 'COORDINATOR', 'SUPERVISOR'] },
  { title: 'الكادر الطبي والميداني', roles: ['DOCTOR', 'NURSE', 'LAB_TECH', 'RADIOGRAPHER', 'PHARMACIST', 'DRIVER'] },
  { title: 'الإدارة والمالية', roles: ['FINANCE', 'ADMIN'] },
];

function Brand({ sub = 'رعاية طبية منزلية' }: { sub?: string }) {
  return (
    <div className="brand">
      <Logo size={34} />
      <div className="brand-text"><span className="brand-name">رعاية</span><span className="brand-sub">{sub}</span></div>
    </div>
  );
}

function Login({ onPick, onPatient }: { onPick: (s: Staff) => void; onPatient: () => void }) {
  const { data, error } = useLoad(() => api.get<Staff[]>('/staff'));
  return (
    <main className="login">
      <section className="login-hero">
        <Brand sub="رعاية طبية منزلية · عمّان" />
        <div className="hero-copy">
          <h1>رعاية طبية موثوقة، لعندك عالبيت.</h1>
          <p>فحوصات، أشعة، أجهزة طبية، تمريض وزيارات طبيب. كل خطوة واضحة من أول اتصال لآخر فاتورة.</p>
          <ul className="hero-points">
            <li><Icon name="shield" /> كادر مرخّص وملف طبي محفوظ</li>
            <li><Icon name="clock" /> بتعرف السعر والموعد قبل أي زيارة</li>
            <li><Icon name="receipt" /> فواتير ضريبية إلكترونية معتمدة</li>
          </ul>
        </div>
        <button className="patient-cta" onClick={onPatient}>
          <span className="cta-ic"><Icon name="heart" size={24} /></span>
          <span><strong>أنا مريض أو من عائلة مريض</strong><span className="small">اطلب خدمة، وافق على السعر، وتابع الزيارة</span></span>
          <Icon name="chevron" className="chev" />
        </button>
      </section>

      <section className="login-staff">
        <div className="login-panel">
          <header>
            <span className="eyebrow">دخول الموظفين</span>
            <h2>اختر حسابك</h2>
          </header>
          {error && <div className="notice bad">تعذّر الاتصال بالخادم: {error}</div>}
          {!data && !error && <Loading />}
          {data && STAFF_GROUPS.map((g) => {
            const people = data.filter((s) => g.roles.includes(s.role));
            if (!people.length) return null;
            return (
              <div key={g.title} className="login-group">
                <span>{g.title}</span>
                <div className="login-list">
                  {people.map((s) => (
                    <button key={s.id} className="login-row" onClick={() => onPick(s)}>
                      <span className="avatar">{initial(s.name)}</span>
                      <span><strong>{staffName(s.name)}</strong><small>{ROLE_AR[s.role] ?? s.role}</small></span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          <p className="demo-note"><Icon name="alert" /> نسخة تجريبية: الدخول بكلمة سر وتحقق ثنائي بيجي بالمرحلة الجاية.</p>
        </div>
      </section>
    </main>
  );
}

function App() {
  const [me, setMe] = useState<Staff | null>(() => {
    try { return JSON.parse(localStorage.getItem('hc.me') ?? 'null'); } catch { return null; }
  });
  const [patientMode, setPatientMode] = useState(() => location.hash === '#patient' || !!loadPatientToken());
  const allowed = (Object.keys(VIEWS) as View[]).filter((v) => me && VIEWS[v].roles.includes(me.role));
  const [view, setView] = useState<View>('board');
  setStaff(me?.id ?? null);

  useEffect(() => {
    if (me && !allowed.includes(view)) setView(allowed[0]);
  }, [me, allowed, view]);

  const pick = (s: Staff | null) => {
    try { s ? localStorage.setItem('hc.me', JSON.stringify(s)) : localStorage.removeItem('hc.me'); } catch { /* storage off */ }
    setStaff(s?.id ?? null);
    setMe(s);
  };

  if (patientMode) return <PatientApp onExit={() => { setPatientMode(false); if (location.hash) history.replaceState(null, '', ' '); }} />;
  if (!me) return <Login onPick={pick} onPatient={() => setPatientMode(true)} />;
  return (
    <div className="shell">
      <header className="topbar">
        <Brand />
        <nav className={`tabs ${allowed.length > 1 ? 'has-many' : 'single'}`} aria-label="الشاشات">
          {allowed.map((v) => (
            <button key={v} className={v === view ? 'tab on' : 'tab'} aria-current={v === view ? 'page' : undefined} onClick={() => setView(v)}>
              <Icon name={VIEWS[v].icon} />
              <span className="tab-long">{VIEWS[v].label}</span><span className="tab-short">{VIEWS[v].short}</span>
            </button>
          ))}
        </nav>
        <div className="me">
          <span className="avatar" aria-hidden="true">{initial(me.name)}</span>
          <span className="me-id"><strong>{staffName(me.name)}</strong><span>{ROLE_AR[me.role]}</span></span>
          <button className="ghost icon-btn" onClick={() => pick(null)} aria-label="خروج" title="خروج"><Icon name="logout" /></button>
        </div>
      </header>
      <main className="content">
        {view === 'board' && <Coordinator me={me} />}
        {view === 'intake' && <CallCenter me={me} />}
        {view === 'field' && <FieldApp me={me} />}
        {view === 'finance' && <Finance />}
        {view === 'settings' && <Settings />}
        {view === 'integrations' && <Integrations />}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastHost><App /></ToastHost>
  </StrictMode>,
);
