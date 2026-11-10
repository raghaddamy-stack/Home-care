import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, ROLE_AR, setStaff, type Staff } from './api';
import { ToastHost, useLoad } from './ui';
import { CallCenter } from './screens/CallCenter';
import { Coordinator } from './screens/Coordinator';
import { FieldApp } from './screens/FieldApp';
import { Finance } from './screens/Finance';
import { Settings } from './screens/Settings';
import { loadPatientToken, PatientApp } from './screens/PatientApp';
import './styles.css';

type View = 'board' | 'intake' | 'field' | 'finance' | 'settings';

const VIEWS: Record<View, { label: string; roles: string[] }> = {
  board: { label: 'لوحة المنسق', roles: ['COORDINATOR', 'SUPERVISOR', 'ADMIN'] },
  intake: { label: 'الكول سنتر', roles: ['AGENT', 'COORDINATOR', 'ADMIN'] },
  field: { label: 'تطبيق الكادر', roles: ['NURSE', 'DOCTOR', 'LAB_TECH', 'RADIOGRAPHER', 'DRIVER'] },
  finance: { label: 'المالية', roles: ['FINANCE', 'ADMIN'] },
  settings: { label: 'إعدادات المالك', roles: ['ADMIN'] },
};

function Login({ onPick, onPatient }: { onPick: (s: Staff) => void; onPatient: () => void }) {
  const { data, error } = useLoad(() => api.get<Staff[]>('/staff'));
  return (
    <main className="login">
      <div className="login-card">
        <span className="eyebrow">Home Care · Operations</span>
        <h1>رعاية</h1>
        <button className="primary block" onClick={onPatient}>أنا مريض أو من عائلة مريض</button>
        <p className="muted">دخول الموظفين: اختر حسابك. (نسخة تجريبية: الدخول بكلمة سر يجي بالمرحلة الجاية.)</p>
        {error && <p className="error">تعذّر الاتصال بالخادم: {error}</p>}
        <div className="login-list">
          {data?.map((s) => (
            <button key={s.id} className="login-row" onClick={() => onPick(s)}>
              <span>{s.name}</span>
              <span className="muted">{ROLE_AR[s.role] ?? s.role}</span>
            </button>
          ))}
        </div>
      </div>
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
        <div className="brand">رعاية <span className="muted">Home Care</span></div>
        <nav className="tabs" aria-label="الشاشات">
          {allowed.map((v) => (
            <button key={v} className={v === view ? 'tab on' : 'tab'} onClick={() => setView(v)}>{VIEWS[v].label}</button>
          ))}
        </nav>
        <div className="me">
          <span>{me.name}</span>
          <span className="muted">{ROLE_AR[me.role]}</span>
          <button className="ghost" onClick={() => pick(null)}>خروج</button>
        </div>
      </header>
      <main className="content">
        {view === 'board' && <Coordinator me={me} />}
        {view === 'intake' && <CallCenter me={me} />}
        {view === 'field' && <FieldApp me={me} />}
        {view === 'finance' && <Finance />}
        {view === 'settings' && <Settings />}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastHost><App /></ToastHost>
  </StrictMode>,
);
