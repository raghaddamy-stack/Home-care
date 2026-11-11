// Owner settings: every business rule the owner can tune, grouped, with defaults and change history.
import { useEffect, useMemo, useState } from 'react';
import { api, fmtTime, ROLE_AR, staffName } from '../api';
import { Empty, Field, Loading, Pill, useAction, useLoad } from '../ui';
import { Icon } from '../icons';

interface Meta {
  key: string; group: string; label: string; help?: string; kind: string;
  min?: number; max?: number; step?: number; unit?: string; options?: { value: string; label: string }[]; roles?: string[]; default: unknown;
}
interface Payload { values: Record<string, any>; meta: Meta[]; staff: { id: number; name: string; role: string }[]; history: any[]; warnings?: string[]; services?: { code: string; name_ar: string }[] }

const LINES_AR: Record<string, string> = { LAB: 'المختبر', IMG: 'الأشعة', DEV: 'الأجهزة', DOC: 'زيارة الطبيب', NRS: 'التمريض', FEE: 'رسوم إلغاء / غياب' };
const CAT_AR: Record<string, string> = { S: 'خاضع (S)', Z: 'صفر (Z)', O: 'معفى (O)' };

const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

function display(m: Meta, v: any, staff: Payload['staff']): string {
  if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) return '—';
  switch (m.kind) {
    case 'boolean': return v ? 'نعم' : 'لا';
    case 'money': return `${(v / 1000).toFixed(3)} د.أ`;
    case 'select': return m.options?.find((o) => o.value === v)?.label ?? String(v);
    case 'weekdays': return (v as number[]).map((d) => DAYS[d]).join('، ');
    case 'dates': return (v as string[]).join('، ');
    case 'staff': return staffName(staff.find((s) => s.id === v)?.name) || `#${v}`;
    case 'staffList': return (v as number[]).map((id) => staffName(staff.find((s) => s.id === id)?.name) || `#${id}`).join('، ');
    case 'secret': return typeof v === 'string' ? (v ? 'قيمة جديدة' : 'فاضي') : v.set ? `محفوظ (…${v.last4})` : 'غير مدخل';
    case 'taxMap': return Object.entries(v as Record<string, any>).map(([k, r]) => `${LINES_AR[k] ?? k}: ${r.category}${r.category === 'S' ? ` ${r.rate}%` : ''}`).join('، ');
    case 'serviceMap': return Object.entries(v as Record<string, string>).map(([k, x]) => `${k}: ${x}`).join('، ') || '—';
    case 'lineMap': case 'categoryMap': return Object.entries(v as Record<string, string>).filter(([, x]) => x).map(([k, x]) => `${LINES_AR[k] ?? k}: ${x}`).join('، ') || '—';
    case 'text': case 'url': return v || '—';
    default: return `${v}${m.unit ? ` ${m.unit}` : ''}`;
  }
}

function Control({ m, value, onChange, staff, services = [] }: { m: Meta; value: any; onChange: (v: any) => void; staff: Payload['staff']; services?: Payload['services'] }) {
  const id = `set-${m.key}`;
  switch (m.kind) {
    case 'boolean':
      return (
        <div className="seg" role="radiogroup" aria-label={m.label}>
          <button type="button" role="radio" aria-checked={!!value} className={value ? 'on' : ''} onClick={() => onChange(true)}>نعم</button>
          <button type="button" role="radio" aria-checked={!value} className={!value ? 'on' : ''} onClick={() => onChange(false)}>لا</button>
        </div>
      );
    case 'select':
      return <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>{m.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
    case 'money':
      return (
        <div className="unit-input">
          <input id={id} type="number" min={0} step={0.5} value={value / 1000} onChange={(e) => onChange(Math.round(Number(e.target.value) * 1000))} />
          <span>د.أ</span>
        </div>
      );
    case 'weekdays':
      return (
        <div className="chips" role="group" aria-label={m.label}>
          {DAYS.map((d, i) => {
            const on = (value as number[]).includes(i);
            return <button type="button" key={d} className={on ? 'chip on' : 'chip'} aria-pressed={on} onClick={() => onChange(on ? value.filter((x: number) => x !== i) : [...value, i])}>{d}</button>;
          })}
        </div>
      );
    case 'dates':
      return <DatesControl value={value} onChange={onChange} />;
    case 'staff':
      return (
        <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
          <option value="">غير محدد (تنبيه لكل أصحاب الدور)</option>
          {staff.filter((s) => !m.roles || m.roles.includes(s.role)).map((s) => <option key={s.id} value={s.id}>{staffName(s.name)}</option>)}
        </select>
      );
    case 'staffList':
      return (
        <div className="chips" role="group" aria-label={m.label}>
          {staff.filter((s) => !m.roles || m.roles.includes(s.role)).map((s) => {
            const on = (value as number[]).includes(s.id);
            return <button type="button" key={s.id} className={on ? 'chip on' : 'chip'} aria-pressed={on} onClick={() => onChange(on ? value.filter((x: number) => x !== s.id) : [...value, s.id])}>{staffName(s.name)} · {ROLE_AR[s.role]}</button>;
          })}
        </div>
      );
    case 'text':
    case 'url':
      return <input id={id} dir={m.kind === 'url' ? 'ltr' : undefined} value={value} onChange={(e) => onChange(e.target.value)} placeholder={m.kind === 'url' ? 'https://' : ''} />;
    case 'secret':
      return (
        <div className="stack">
          <input id={id} type="password" dir="ltr" autoComplete="new-password" value={typeof value === 'string' ? value : ''}
            placeholder={typeof value === 'object' && value?.set ? `محفوظ (…${value.last4}) · اكتب قيمة جديدة لتغييره` : 'أدخل القيمة'}
            onChange={(e) => onChange(e.target.value)} />
        </div>
      );
    case 'taxMap':
      return (
        <div className="map-grid">
          {Object.entries(value as Record<string, { category: string; rate: number }>).map(([k, r]) => (
            <div key={k} className="map-row">
              <span>{LINES_AR[k] ?? k}</span>
              <select aria-label={`فئة ${LINES_AR[k]}`} value={r.category} onChange={(e) => onChange({ ...value, [k]: { category: e.target.value, rate: e.target.value === 'S' ? (r.rate || 16) : 0 } })}>
                {['S', 'Z', 'O'].map((c) => <option key={c} value={c}>{CAT_AR[c]}</option>)}
              </select>
              <div className="unit-input">
                <input type="number" min={0} max={100} aria-label={`نسبة ${LINES_AR[k]}`} disabled={r.category !== 'S'} value={r.rate} onChange={(e) => onChange({ ...value, [k]: { ...r, rate: Number(e.target.value) } })} />
                <span>%</span>
              </div>
            </div>
          ))}
        </div>
      );
    case 'serviceMap':
      return (
        <div className="map-grid">
          {(services ?? []).map((sv) => (
            <div key={sv.code} className="map-row two">
              <span>{sv.name_ar} <bdi dir="ltr" className="mono small muted">{sv.code}</bdi></span>
              <input dir="ltr" aria-label={`رقم المادة لـ ${sv.name_ar}`} placeholder="—" value={(value as Record<string, string>)[sv.code] ?? ''}
                onChange={(e) => { const next = { ...value }; if (e.target.value) next[sv.code] = e.target.value; else delete next[sv.code]; onChange(next); }} />
            </div>
          ))}
        </div>
      );
    case 'lineMap':
    case 'categoryMap':
      return (
        <div className="map-grid">
          {Object.entries(value as Record<string, string>).map(([k, x]) => (
            <div key={k} className="map-row two">
              <span>{m.kind === 'lineMap' ? LINES_AR[k] ?? k : CAT_AR[k] ?? k}</span>
              <input dir="ltr" aria-label={k} value={x} onChange={(e) => onChange({ ...value, [k]: e.target.value })} />
            </div>
          ))}
        </div>
      );
    default:
      return (
        <div className="unit-input">
          <input id={id} type="number" min={m.min} max={m.max} step={m.step ?? 1} value={value} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
          {m.unit && <span>{m.unit}</span>}
        </div>
      );
  }
}

function DatesControl({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [d, setD] = useState('');
  return (
    <div className="stack">
      <div className="row">
        <input type="date" value={d} onChange={(e) => setD(e.target.value)} aria-label="تاريخ عطلة" />
        <button type="button" className="secondary" disabled={!d || value.includes(d)} onClick={() => { onChange([...value, d].sort()); setD(''); }}>إضافة</button>
      </div>
      <div className="chips">
        {value.map((x) => <button type="button" key={x} className="chip on" onClick={() => onChange(value.filter((y) => y !== x))} aria-label={`حذف ${x}`}><span dir="ltr">{x}</span> <Icon name="x" size={14} /></button>)}
        {!value.length && <span className="small muted">ما في عطل مضافة.</span>}
      </div>
    </div>
  );
}

export function Settings() {
  const data = useLoad(() => api.get<Payload>('/settings'));
  const { busy, run } = useAction();
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [group, setGroup] = useState<string | null>(null);

  useEffect(() => { if (data.data) setDraft(data.data.values); }, [data.data]);
  const groups = useMemo(() => [...new Set(data.data?.meta.map((m) => m.group) ?? [])], [data.data]);
  const g = group ?? groups[0];
  if (data.error) return <div className="notice bad">{data.error}</div>;
  if (!data.data) return <Loading card />;
  const { meta, staff, history, values, warnings } = data.data;
  const changed = meta.filter((m) => JSON.stringify(draft[m.key]) !== JSON.stringify(values[m.key]));
  const labelOf = (k: string) => meta.find((m) => m.key === k)?.label ?? k;
  const pretty = (k: string, raw: string | null) => { const m = meta.find((x) => x.key === k); return m && raw != null ? display(m, JSON.parse(raw), staff) : raw ?? '—'; };

  return (
    <div className="settings">
      <aside className="settings-nav" aria-label="أقسام الإعدادات">
        {groups.map((x) => {
          const n = meta.filter((m) => m.group === x && (m.kind === 'secret' ? !!values[m.key]?.set : JSON.stringify(values[m.key]) !== JSON.stringify(m.default))).length;
          return (
            <button key={x} className={x === g ? 'on' : ''} onClick={() => setGroup(x)}>
              <span>{x}</span>{n > 0 && <span className="count" title="معدّل عن الافتراضي">{n}</span>}
            </button>
          );
        })}
      </aside>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>{g}</h2>
            <p>أي تغيير بيطبّق على العمليات الجديدة مباشرة، وما بيغيّر فواتير أو عروض أسعار طلعت قبل.</p>
            {warnings?.map((w) => <div key={w} className="notice warn small"><div className="notice-head"><Icon name="alert" /><span>{w}</span></div></div>)}
          </div>
        </div>
        <div className="settings-list">
          {meta.filter((m) => m.group === g).map((m) => {
            const dirty = JSON.stringify(draft[m.key]) !== JSON.stringify(values[m.key]);
            const custom = m.kind === 'secret' ? !!values[m.key]?.set : JSON.stringify(values[m.key]) !== JSON.stringify(m.default);
            return (
              <div key={m.key} className={`setting ${dirty ? 'dirty' : ''}`}>
                <div className="setting-text">
                  <strong>{m.label}</strong>
                  {m.help && <span className="small muted">{m.help}</span>}
                  <span className="small muted">الافتراضي: {display(m, m.default, staff)}
                    {custom && !dirty && (
                      <> · <button className="link" disabled={busy} onClick={() => run(async () => { await api.post(`/settings/${m.key}/reset`); data.reload(); }, 'رجعت القيمة للافتراضي')}>رجّع للافتراضي</button></>
                    )}
                  </span>
                </div>
                <div className="setting-control">
                  {draft[m.key] !== undefined && <Control m={m} value={draft[m.key]} staff={staff} services={data.data?.services} onChange={(v) => setDraft({ ...draft, [m.key]: v })} />}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <aside className="card settings-side">
        <h3>التغييرات {changed.length > 0 && <span className="count">{changed.length}</span>}</h3>
        {changed.length ? (
          <>
            <ul className="list">
              {changed.map((m) => <li key={m.key} className="small"><strong>{m.label}</strong><div className="muted">{display(m, values[m.key], staff)} ← {display(m, draft[m.key], staff)}</div></li>)}
            </ul>
            <div className="grid-2">
              <button className="primary" disabled={busy} onClick={() => run(async () => {
                await api.put('/settings', Object.fromEntries(changed.map((m) => [m.key, draft[m.key]])));
                data.reload();
              }, 'تم حفظ الإعدادات')}>حفظ</button>
              <button className="ghost" onClick={() => setDraft(values)}>تراجع</button>
            </div>
          </>
        ) : <Empty compact>عدّل أي إعداد وبيظهر هون قبل الحفظ.</Empty>}

        <h3>سجل التعديلات</h3>
        {!history.length && <Empty compact>ما في تعديلات بعد.</Empty>}
        <ol className="timeline">
          {history.slice(0, 15).map((h) => (
            <li key={h.id} className="small">
              <strong>{labelOf(h.key)}</strong>: {pretty(h.key, h.old_value)} ← {pretty(h.key, h.new_value)}
              <div className="muted">{h.changed_by_name ? staffName(h.changed_by_name) : '—'} · {fmtTime(h.at)}</div>
            </li>
          ))}
        </ol>
        <Pill status="RESOLVED" label="بيتحفظ مين غيّر وإيمتى" />
      </aside>
      {changed.length > 0 && (
        <div className="save-bar" role="region" aria-label="حفظ التغييرات">
          <span className="small">{changed.length} تغيير بانتظار الحفظ</span>
          <div className="row-tight">
            <button className="ghost" onClick={() => setDraft(values)}>تراجع</button>
            <button className="primary" disabled={busy} onClick={() => run(async () => {
              await api.put('/settings', Object.fromEntries(changed.map((m) => [m.key, draft[m.key]])));
              data.reload();
            }, 'تم حفظ الإعدادات')}>حفظ</button>
          </div>
        </div>
      )}
    </div>
  );
}
