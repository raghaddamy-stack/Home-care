import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { STATUS_AR } from './api';
import { Icon } from './icons';

const TONE: Record<string, string> = {
  PENDING_INFO: 'warn', PENDING_PREAPPROVAL: 'warn', EXPIRED: 'warn', NO_SHOW: 'bad', CANCELLED: 'mute', REFERRED_OUT: 'mute',
  UNDER_REVIEW: 'info', SUBMITTED: 'info', QUOTED: 'info', ACCEPTED: 'ok', SCHEDULED: 'ok', DISPATCHED: 'ok', IN_PROGRESS: 'ok',
  COMPLETED: 'done', CONVERTED_TO_EPISODE: 'done', LATE: 'bad', MISSED: 'mute', CHECKED_IN: 'ok', PLANNED: 'info',
  ACTIVE: 'ok', ON_HOLD: 'bad', DISCHARGED: 'done', OPEN: 'bad', ACKED: 'warn', RESOLVED: 'done',
  LOW: 'ok', LOW_MEDIUM: 'warn', MEDIUM: 'warn', HIGH: 'bad', CRITICAL: 'bad', OPS: 'warn', REVIEW: 'warn',
};

export function Pill({ status, label }: { status: string; label?: string }) {
  return <span className={`pill ${TONE[status] ?? 'info'}`}>{label ?? STATUS_AR[status] ?? status}</span>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  if (!open) return null;
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h2>{title}</h2>
          <button className="ghost icon-btn" onClick={onClose} aria-label="إغلاق"><Icon name="x" /></button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

/** Friendly empty state: optional icon + title, a line of text, and the next action. */
export function Empty({ children, icon, title, action, compact }: { children?: ReactNode; icon?: string; title?: string; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={`empty${compact ? ' compact' : ''}`}>
      {icon && <Icon name={icon} />}
      {title && <strong>{title}</strong>}
      {children && <span>{children}</span>}
      {action}
    </div>
  );
}

/** Skeleton placeholder while data loads. */
export function Loading({ label = 'جاري التحميل…', card }: { label?: string; card?: boolean }) {
  return (
    <div className={`skeleton${card ? ' cardish' : ''}`} role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <i /><i /><i /><i />
    </div>
  );
}

// ---- Toasts -----------------------------------------------------------------
type Toast = { id: number; text: string; kind: 'ok' | 'err' };
const ToastCtx = createContext<(text: string, kind?: 'ok' | 'err') => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, kind }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'err' ? 'alert' : 'status'}><Icon name={t.kind === 'ok' ? 'check' : 'alert'} /><span>{t.text}</span></div>)}
      </div>
    </ToastCtx.Provider>
  );
}

/** Run an async action with a busy flag and toast on success / error. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok);
      return true;
    } catch (e) {
      toast((e as Error).message, 'err');
      return false;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return { busy, run };
}

/** Fetch on mount and on `deps` change; `reload` refetches. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    fn().then((d) => live && (setData(d), setError(null))).catch((e) => live && setError(e.message));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}
