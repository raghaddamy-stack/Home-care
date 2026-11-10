// Owner settings: every business rule the owner can tune, grouped, with defaults and change history.
import { useEffect, useMemo, useState } from 'react';
import { api, fmtTime, ROLE_AR } from '../api';
import { Empty, Field, Pill, useAction, useLoad } from '../ui';

interface Meta {
  key: string; group: string; label: string; help?: string; kind: string;
  min?: number; max?: number; step?: number; unit?: string; options?: { value: string; label: string }[]; roles?: string[]; default: unknown;
}
interface Payload { values: Record<string, any>; meta: Meta[]; staff: { id: number; name: string; role: string }[]; history: any[] }

const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

function display(m: Meta, v: any, staff: Payload['staff']): string {
  if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) return '—';
  switch (m.kind) {
    case 'boolean': return v ? 'نعم' : 'لا';
    case 'money': return `${(v / 1000).toFixed(3)} د.أ`;
    case 'select': return m.options?.find((o) => o.value === v)?.label ?? String(v);
    case 'weekdays': return (v as number[]).map((d) => DAYS[d]).join('، ');
    case 'dates': return (v as string[]).join('، ');
    case 'staff': return staff.find((s) => s.id === v)?.name ?? `#${v}`;
    case 'staffList': return (v as number[]).map((id) => staff.find((s) => s.id === id)?.name ?? `#${id}`).join('، ');
    default: return `${v}${m.unit ? ` ${m.unit}` : ''}`;
  }
}

function Control({ m, value, onChange, staff }: { m: Meta; value: any; onChange: (v: any) => void; staff: Payload['staff'] }) {
  const id = `set-${m.key}`;
  switch (m.kind) {
    case 'boolean':
      return (
        <div className="seg" role="radiogroup" aria-label={m.label}>
          <button type="button" className={value ? 'on' : ''} onClick={() => onChange(true)}>نعم</button>
          <button type="button" className={!value ? 'on' : ''} onClick={() => onChange(false)}>لا</button>
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
            return <button type="button" key={d} className={on ? 'chip on' : 'chip'} onClick={() => onChange(on ? value.filter((x: number) => x !== i) : [...value, i])}>{d}</button>;
          })}
        </div>
      );
    case 'dates':
      return <DatesControl value={value} onChange={onChange} />;
    case 'staff':
      return (
        <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
          <option value="">غير محدد (تنبيه لكل أصحاب الدور)</option>
          {staff.filter((s) => !m.roles || m.roles.includes(s.role)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      );
    case 'staffList':
      return (
        <div className="chips" role="group" aria-label={m.label}>
          {staff.filter((s) => !m.roles || m.roles.includes(s.role)).map((s) => {
            const on = (value as number[]).includes(s.id);
            return <button type="button" key={s.id} className={on ? 'chip on' : 'chip'} onClick={() => onChange(on ? value.filter((x: number) => x !== s.id) : [...value, s.id])}>{s.name} · {ROLE_AR[s.role]}</button>;
          })}
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
        {value.map((x) => <button type="button" key={x} className="chip on" onClick={() => onChange(value.filter((y) => y !== x))} aria-label={`حذف ${x}`}>{x} ✕</button>)}
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
  if (data.error) return <p className="error">{data.error}</p>;
  if (!data.data) return <p className="muted">تحميل…</p>;
  const { meta, staff, history, values } = data.data;
  const changed = meta.filter((m) => JSON.stringify(draft[m.key]) !== JSON.stringify(values[m.key]));
  const labelOf = (k: string) => meta.find((m) => m.key === k)?.label ?? k;
  const pretty = (k: string, raw: string | null) => { const m = meta.find((x) => x.key === k); return m && raw != null ? display(m, JSON.parse(raw), staff) : raw ?? '—'; };

  return (
    <div className="settings">
      <aside className="settings-nav" aria-label="أقسام الإعدادات">
        {groups.map((x) => {
          const n = meta.filter((m) => m.group === x && JSON.stringify(values[m.key]) !== JSON.stringify(m.default)).length;
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
            <p className="small muted">أي تغيير بيطبّق على العمليات الجديدة مباشرة، وما بيغيّر فواتير أو عروض أسعار طلعت قبل.</p>
          </div>
        </div>
        <div className="settings-list">
          {meta.filter((m) => m.group === g).map((m) => {
            const dirty = JSON.stringify(draft[m.key]) !== JSON.stringify(values[m.key]);
            const custom = JSON.stringify(values[m.key]) !== JSON.stringify(m.default);
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
                  {draft[m.key] !== undefined && <Control m={m} value={draft[m.key]} staff={staff} onChange={(v) => setDraft({ ...draft, [m.key]: v })} />}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <aside className="card settings-side">
        <h3>التغييرات</h3>
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
        ) : <p className="small muted">عدّل أي إعداد وبيظهر هون قبل الحفظ.</p>}

        <h3>سجل التعديلات</h3>
        {!history.length && <Empty>ما في تعديلات بعد.</Empty>}
        <ol className="timeline">
          {history.slice(0, 15).map((h) => (
            <li key={h.id} className="small">
              <strong>{labelOf(h.key)}</strong>: {pretty(h.key, h.old_value)} ← {pretty(h.key, h.new_value)}
              <div className="muted">{h.changed_by_name ?? '—'} · {fmtTime(h.at)}</div>
            </li>
          ))}
        </ol>
        <Pill status="RESOLVED" label="بيتحفظ مين غيّر وإيمتى" />
      </aside>
    </div>
  );
}
