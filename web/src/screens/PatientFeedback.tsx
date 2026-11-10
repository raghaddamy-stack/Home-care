// Patient app: "How was your visit?" card after a finished visit. One rating per request.
import { useState } from 'react';
import { api } from '../api';
import { useAction, useLoad } from '../ui';

interface Pending { requestId: number; requestNo: string; staffName: string; services: string[] }

const GOOD = [['ON_TIME', 'وصلوا بالوقت'], ['KIND_STAFF', 'تعامل لطيف'], ['CLEAR_EXPLANATION', 'شرحولي منيح']] as const;
const BAD = [['LATE', 'تأخروا'], ['PAIN', 'وجع أو إزعاج'], ['PRICE', 'السعر'], ['HYGIENE', 'النظافة'], ['COMMUNICATION', 'التواصل']] as const;
const SCORE_AR = ['', 'سيئة', 'مش منيحة', 'مقبولة', 'منيحة', 'ممتازة'];

function RateCard({ p, onDone }: { p: Pending; onDone: () => void }) {
  const { busy, run } = useAction();
  const [score, setScore] = useState(0);
  const [tags, setTags] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const options = score >= 4 ? GOOD : score > 0 ? BAD : [];
  const toggle = (t: string) => setTags(tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t]);

  return (
    <li className="visit rate">
      <div>
        <strong>كيف كانت الزيارة؟</strong>
        <div className="small muted">{p.services.join('، ')} · مع {p.staffName}</div>
      </div>
      <div className="stars-input" role="radiogroup" aria-label="التقييم من 5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={score === n} aria-label={`${n} من 5`}
            className={n <= score ? 'star on' : 'star'} onClick={() => { setScore(n); setTags([]); }}>★</button>
        ))}
        {score > 0 && <span className="small">{SCORE_AR[score]}</span>}
      </div>
      {score > 0 && (
        <>
          <div className="chips" role="group" aria-label={score >= 4 ? 'شو عجبك؟' : 'شو ما عجبك؟'}>
            <span className="small muted">{score >= 4 ? 'شو عجبك؟' : 'شو ما عجبك؟'}</span>
            {options.map(([k, l]) => (
              <button key={k} type="button" className={tags.includes(k) ? 'chip on' : 'chip'} aria-pressed={tags.includes(k)} onClick={() => toggle(k)}>{l}</button>
            ))}
          </div>
          <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="بدك تحكيلنا إشي؟ (اختياري)" aria-label="ملاحظات" />
          {score <= 2 && <p className="small muted" style={{ margin: 0 }}>آسفين. مشرف الخدمة رح يتصل فيك ليفهم شو صار.</p>}
          <button className="primary block" disabled={busy} onClick={() => run(async () => {
            await api.post(`/me/requests/${p.requestId}/rating`, { score, tags, comment: comment.trim() || undefined });
            onDone();
          }, 'شكراً على تقييمك')}>أرسل التقييم</button>
        </>
      )}
    </li>
  );
}

export function RatePrompts({ tick }: { tick?: unknown }) {
  const pending = useLoad(() => api.get<Pending[]>('/me/feedback/pending'), [tick]);
  if (!pending.data?.length) return null;
  return <ul className="visits">{pending.data.map((p) => <RateCard key={p.requestId} p={p} onDone={pending.reload} />)}</ul>;
}
