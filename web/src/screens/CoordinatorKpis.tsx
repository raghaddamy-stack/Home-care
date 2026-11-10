// Coordinator board header: today's queues, SLA breaches, field activity and patient satisfaction.
import { useState } from 'react';
import { api, fmtTime } from '../api';
import { ageAr } from '../live';
import { Drawer, Empty, Field, useAction, useLoad } from '../ui';

export interface Dashboard {
  asOf: string;
  queues: { toReview: number; pendingInfo: number; preapproval: number; quoted: number; toSchedule: number; urgentOpen: number };
  today: { newRequests: number; visits: number; visitsDone: number; inField: number; noShows: number };
  alerts: { lateShifts: number; openEscalations: number };
  sla: { overdueCount: number; overdue: { id: number; requestNo: string; kind: string; waitedMinutes: number; slaMinutes: number }[] };
  csat: { avg: number | null; responses: number; openFollowUps: number };
}

export const SLA_KIND_AR: Record<string, string> = {
  review: 'مراجعة وتسعير', preapproval: 'متابعة التأمين', quote: 'متابعة موافقة المريض', schedule: 'تعيين الكادر',
};

function Kpi({ label, value, sub, tone, onClick, pressed }: {
  label: string; value: string | number; sub?: string; tone?: 'bad' | 'warn' | 'ok'; onClick?: () => void; pressed?: boolean;
}) {
  const body = (
    <>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value mono">{value}</span>
      {sub && <span className="kpi-sub">{sub}</span>}
    </>
  );
  const cls = `kpi${tone ? ` kpi-${tone}` : ''}${pressed ? ' on' : ''}`;
  return onClick
    ? <button className={cls} onClick={onClick} aria-pressed={pressed}>{body}</button>
    : <div className={cls}>{body}</div>;
}

export function KpiStrip({ d, lateOnly, onLateOnly, onAlerts, onChanged }: {
  d: Dashboard | null; lateOnly: boolean; onLateOnly: () => void; onAlerts: () => void; onChanged: () => void;
}) {
  const [fb, setFb] = useState(false);
  if (!d) return <div className="kpis" aria-busy="true" />;
  const reviewLate = d.sla.overdue.filter((x) => x.kind === 'review').length;
  const alerts = d.alerts.lateShifts + d.alerts.openEscalations;
  return (
    <>
      <section className="kpis" aria-label="مؤشرات اليوم">
        <Kpi label="للمراجعة والتسعير" value={d.queues.toReview} sub={reviewLate ? `${reviewLate} تعدّى 30 د` : d.queues.pendingInfo ? `${d.queues.pendingInfo} بيانات ناقصة` : 'ضمن الوقت'} tone={reviewLate ? 'bad' : undefined} />
        <Kpi label="بانتظار المريض" value={d.queues.quoted} sub={d.queues.preapproval ? `${d.queues.preapproval} بانتظار التأمين` : undefined} />
        <Kpi label="جاهز للجدولة" value={d.queues.toSchedule} sub={d.queues.urgentOpen ? `${d.queues.urgentOpen} عاجل/نفس اليوم مفتوح` : undefined} tone={d.queues.urgentOpen ? 'warn' : undefined} />
        <Kpi label="زيارات اليوم" value={`${d.today.visitsDone}/${d.today.visits}`} sub={`${d.today.inField} بالميدان${d.today.noShows ? ` · ${d.today.noShows} no-show` : ''}`} />
        <Kpi
          label="متأخر عن SLA" value={d.sla.overdueCount} tone={d.sla.overdueCount ? 'bad' : 'ok'}
          sub={d.sla.overdueCount ? (lateOnly ? 'عم نعرض المتأخر بس' : 'اضغط لعرضها') : 'كله ضمن الوقت'}
          onClick={d.sla.overdueCount || lateOnly ? onLateOnly : undefined} pressed={lateOnly}
        />
        <Kpi label="تنبيهات الشفتات والمرضى" value={alerts} tone={alerts ? 'bad' : undefined}
          sub={alerts ? `${d.alerts.lateShifts} تأخير · ${d.alerts.openEscalations} تصعيد` : 'ما في'} onClick={alerts ? onAlerts : undefined} />
        <Kpi label="رضا المرضى (30 يوم)" value={d.csat.avg === null ? '—' : `${d.csat.avg}/5`}
          sub={d.csat.openFollowUps ? `${d.csat.openFollowUps} بدها اتصال` : `${d.csat.responses} تقييم`}
          tone={d.csat.openFollowUps ? 'warn' : undefined} onClick={() => setFb(true)} />
      </section>
      {fb && <FeedbackDrawer onClose={() => { setFb(false); onChanged(); }} />}
    </>
  );
}

const TAG_AR: Record<string, string> = {
  ON_TIME: 'وصلوا بالوقت', LATE: 'تأخير', KIND_STAFF: 'تعامل لطيف', CLEAR_EXPLANATION: 'شرح واضح', PAIN: 'وجع/إزعاج',
  PRICE: 'السعر', HYGIENE: 'النظافة', COMMUNICATION: 'التواصل',
};
export const FEEDBACK_TAG_AR = TAG_AR;

function FeedbackDrawer({ onClose }: { onClose: () => void }) {
  const list = useLoad(() => api.get<any[]>('/feedback'));
  const { busy, run } = useAction();
  const [notes, setNotes] = useState<Record<number, string>>({});
  const open = (list.data ?? []).filter((f) => f.follow_up === 'OPEN');
  const rest = (list.data ?? []).filter((f) => f.follow_up !== 'OPEN');
  const Item = ({ f }: { f: any }) => (
    <div className="stack fb-item">
      <div className="list-row">
        <div>
          <strong>{f.full_name}</strong> <span className="mono muted small">{f.request_no}</span>
          <div className="small muted">{f.staff_name ?? '—'} · {fmtTime(f.created_at)}</div>
        </div>
        <span className={`stars s${f.score}`} aria-label={`${f.score} من 5`}>{'★'.repeat(f.score)}<span className="muted">{'★'.repeat(5 - f.score)}</span></span>
      </div>
      {(f.tags.length > 0 || f.comment) && (
        <p className="small" style={{ margin: 0 }}>{f.tags.map((t: string) => TAG_AR[t] ?? t).join('، ')}{f.tags.length && f.comment ? ' · ' : ''}{f.comment}</p>
      )}
      {f.follow_up === 'CLOSED' && <p className="small muted" style={{ margin: 0 }}>تمت المتابعة: {f.follow_up_note}</p>}
    </div>
  );
  return (
    <Drawer open onClose={onClose} title="رضا المرضى">
      <div className="stack">
        <section className="action">
          <h3>بدها اتصال ({open.length})</h3>
          <p className="muted small">أي تقييم 2 من 5 أو أقل. اتصل بالمريض، سجّل شو صار، وسكّر المتابعة.</p>
          {!open.length && <Empty>ما في تقييمات منخفضة مفتوحة.</Empty>}
          <ul className="list">
            {open.map((f) => (
              <li key={f.id} className="stack">
                <Item f={f} />
                <div className="row">
                  <Field label="نتيجة الاتصال"><input value={notes[f.id] ?? ''} onChange={(e) => setNotes({ ...notes, [f.id]: e.target.value })} placeholder={`اتصلت على ${f.phone ?? 'المريض'}…`} /></Field>
                  <button className="primary" disabled={busy || (notes[f.id] ?? '').trim().length < 3} onClick={() => run(async () => {
                    await api.post(`/feedback/${f.id}/close`, { note: notes[f.id] });
                    list.reload();
                  }, 'تم إغلاق المتابعة')}>إغلاق المتابعة</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
        <section className="action">
          <h3>آخر التقييمات</h3>
          {!rest.length && <Empty>لسا ما وصل تقييمات.</Empty>}
          <ul className="list">{rest.map((f) => <li key={f.id}><Item f={f} /></li>)}</ul>
        </section>
      </div>
    </Drawer>
  );
}

/** Small badge for a request card: how late it is against its SLA. */
export function SlaBadge({ waited, sla, kind }: { waited: number; sla: number; kind: string }) {
  return <span className="sla-late" title={`SLA ${SLA_KIND_AR[kind] ?? kind}: ${ageAr(sla)}`}>متأخر {ageAr(waited - sla)}</span>;
}
