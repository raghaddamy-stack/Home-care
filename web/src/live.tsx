// "Live-ish" screens: poll while the tab is visible, refresh at once when the user comes back to it.
import { useEffect, useRef, useState } from 'react';

export function usePolling(fn: () => void, ms: number, enabled = true) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    const tick = () => { if (document.visibilityState === 'visible') ref.current(); };
    const t = setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', tick); };
  }, [ms, enabled]);
}

/** Time the given data last changed (for the "updated at" stamp). */
export function useUpdatedAt(data: unknown): Date {
  const [at, setAt] = useState(() => new Date());
  useEffect(() => { if (data) setAt(new Date()); }, [data]);
  return at;
}

export function LiveStamp({ at, onRefresh }: { at: Date; onRefresh?: () => void }) {
  return (
    <span className="live small muted" aria-live="off">
      <span className="live-dot" aria-hidden="true" />
      تحديث تلقائي · {at.toLocaleTimeString('ar-JO', { hour: '2-digit', minute: '2-digit' })}
      {onRefresh && <button className="ghost live-btn" onClick={onRefresh}>حدّث الآن</button>}
    </span>
  );
}

/** "قبل 5 د" / "قبل ساعتين" style age, from minutes. */
export function ageAr(minutes: number): string {
  if (minutes < 1) return 'هلّق';
  if (minutes < 60) return `${minutes} د`;
  const h = Math.floor(minutes / 60);
  if (h < 24) return `${h} س${minutes % 60 ? ` ${minutes % 60} د` : ''}`;
  return `${Math.floor(h / 24)} يوم`;
}

export const agoAr = (minutes: number) => (minutes < 1 ? 'هلّق' : `قبل ${ageAr(minutes)}`);

export const minutesSince = (iso: string, now = Date.now()) => Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
