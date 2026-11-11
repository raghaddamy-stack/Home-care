// Stock in the ERP, shown right before dispensing: what will be taken from the store and whether it is there.
// The pharmacist can list the exact materials; others see the service's mapped material.
import { useEffect, useState } from 'react';
import { api } from './api';
import { Icon } from './icons';

export interface StockItem { material: string; qty: number }

interface Check { provider: string; mode: string; checked: boolean; error?: string; lines: { material: string; qty: number; available: number | null; enough: boolean | null }[] }

export function StockBox({ serviceCode, editable, onItems }: { serviceCode: string; editable?: boolean; onItems?: (items: StockItem[] | undefined) => void }) {
  const [items, setItems] = useState<StockItem[] | null>(null);
  const [check, setCheck] = useState<Check | null>(null);

  useEffect(() => {
    let live = true;
    const body = items?.length ? { items } : { serviceCode };
    const t = setTimeout(() => {
      api.post<Check>('/stock/check', body).then((c) => live && setCheck(c)).catch(() => live && setCheck(null));
    }, items ? 400 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [serviceCode, JSON.stringify(items)]);

  useEffect(() => { onItems?.(items?.filter((i) => i.material && i.qty > 0)); }, [JSON.stringify(items)]);

  if (!check || check.provider === 'OFF') return null;
  const rows = check.lines;
  const short = rows.some((l) => l.enough === false);
  return (
    <div className={`stock-box ${short ? 'short' : check.error ? 'unknown' : 'ok'}`}>
      <div className="stock-head">
        <Icon name={short ? 'alert' : 'check'} size={16} />
        <strong>{check.error ? 'ما قدرنا نفحص المخزون' : short ? (check.mode === 'BLOCK' ? 'الكمية مش متوفرة: الصرف ممنوع' : 'الكمية مش كافية') : rows.length ? 'متوفر بالمخزن' : 'ما في مادة مربوطة بهاي الخدمة'}</strong>
      </div>
      {rows.length > 0 && (
        <ul>
          {rows.map((l) => (
            <li key={l.material}>
              <bdi dir="ltr" className="mono">{l.material}</bdi> · المطلوب <span className="mono">{l.qty}</span>
              {l.available !== null && <> · الموجود <span className="mono">{l.available}</span></>}
            </li>
          ))}
        </ul>
      )}
      {check.error && <p className="small">{check.error}</p>}
      {editable && (
        <details>
          <summary>المواد اللي انصرفت فعلاً</summary>
          {(items ?? [{ material: rows[0]?.material ?? '', qty: rows[0]?.qty ?? 1 }]).map((it, i, arr) => (
            <div className="row-tight" key={i}>
              <input aria-label="رقم المادة" dir="ltr" placeholder="MAT-…" value={it.material} onChange={(e) => setItems(arr.map((x, j) => (j === i ? { ...x, material: e.target.value } : x)))} />
              <input aria-label="الكمية" type="number" min={0} step="any" style={{ width: 90 }} value={it.qty} onChange={(e) => setItems(arr.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) } : x)))} />
            </div>
          ))}
          <button type="button" className="ghost" onClick={() => setItems([...(items ?? [{ material: rows[0]?.material ?? '', qty: rows[0]?.qty ?? 1 }]), { material: '', qty: 1 }])}><Icon name="plus" />مادة</button>
        </details>
      )}
    </div>
  );
}
