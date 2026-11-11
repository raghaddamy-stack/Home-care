// Owner: API keys for the ERP, webhook health, and where to find the API description.
import { useState } from 'react';
import { api, fmtTime } from '../api';
import { Empty, Field, Loading, Pill, useAction, useLoad } from '../ui';
import { Icon } from '../icons';

const SCOPE_AR: Record<string, string> = {
  'invoices:read': 'قراءة الفواتير', 'invoices:ack': 'تأكيد الترحيل', 'payments:read': 'قراءة الدفعات', 'payments:write': 'تسجيل دفعات',
  'customers:read': 'قراءة العملاء', 'customers:write': 'ربط أرقام العملاء', 'catalog:read': 'قائمة الخدمات', 'events:read': 'الأحداث',
};

function IntegrationsMain() {
  const data = useLoad(() => api.get<any>('/integrations'));
  const { busy, run } = useAction();
  const [name, setName] = useState('SAP S/4HANA');
  const [scopes, setScopes] = useState<string[]>(['invoices:read', 'invoices:ack', 'payments:read', 'payments:write', 'customers:read', 'customers:write', 'catalog:read', 'events:read']);
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const d = data.data;
  if (!d) return data.error ? <div className="notice bad">{data.error}</div> : <Loading card />;
  const base = `${location.origin}/api/erp/v1`;

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); }
  };

  return (
    <div className="split">
      <div className="stack">
        <div className="card">
          <div className="card-head"><div><h2>مفاتيح الربط (API Keys)</h2></div></div>
          <p className="small muted">كل نظام خارجي (SAP، Odoo، Oracle…) إله مفتاح خاص بصلاحيات محددة. المفتاح بيظهر مرة وحدة بس، فانسخه وسلّمه لفريق الـ ERP.</p>
          {created && (
            <div className="notice ok">
              <strong>مفتاح {created.name}</strong>
              <code className="key" dir="ltr">{created.key}</code>
              <div className="row-tight">
                <button className="secondary" onClick={() => copy(created.key)}><Icon name={copied ? 'check' : 'list'} />{copied ? 'تم النسخ' : 'نسخ المفتاح'}</button>
                <button className="ghost" onClick={() => { setCreated(null); setCopied(false); }}>تم، خبّيه</button>
              </div>
            </div>
          )}
          <form className="stack" onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const r = await api.post<{ key: string; name: string }>('/integrations/clients', { name, scopes });
              setCreated(r); setCopied(false); data.reload();
            }, 'انعمل المفتاح');
          }}>
            <Field label="اسم النظام"><input id="cl-name" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} /></Field>
            <span className="field-label">الصلاحيات</span>
            <div className="chips" role="group" aria-label="الصلاحيات">
              {d.scopes.map((sc: string) => {
                const on = scopes.includes(sc);
                return <button type="button" key={sc} className={on ? 'chip on' : 'chip'} aria-pressed={on} onClick={() => setScopes(on ? scopes.filter((x) => x !== sc) : [...scopes, sc])}>{SCOPE_AR[sc] ?? sc}</button>;
              })}
            </div>
            <button className="primary" style={{ justifySelf: 'start' }} disabled={busy || !scopes.length}><Icon name="plus" />إنشاء مفتاح</button>
          </form>
        </div>

        <div className="card">
          <h3>المفاتيح الحالية</h3>
          {!d.clients.length && <Empty icon="plug" title="ما في مفاتيح بعد">أنشئ مفتاح لكل نظام خارجي من النموذج فوق.</Empty>}
          <ul className="list">
            {d.clients.map((c: any) => (
              <li key={c.id} className="list-row">
                <div>
                  <div className="li-title"><strong>{c.name}</strong> <span className="mono small muted" dir="ltr">{c.key_prefix}…</span></div>
                  <div className="small muted">{c.scopes.map((x: string) => SCOPE_AR[x] ?? x).join('، ')}</div>
                  <div className="small muted">آخر استخدام: {c.last_used_at ? fmtTime(c.last_used_at) : 'لسا'}</div>
                </div>
                {c.active ? (
                  <button className="danger" disabled={busy} onClick={() => run(async () => { await api.post(`/integrations/clients/${c.id}/revoke`); data.reload(); }, 'تم إيقاف المفتاح')}>إيقاف</button>
                ) : <Pill status="CANCELLED" label="موقوف" />}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="stack">
        <div className="card">
          <h3>عنوان الـ API</h3>
          <code className="key" dir="ltr">{base}</code>
          <p className="small muted">وصف كامل بصيغة OpenAPI (بيستورده SAP Integration Suite و Postman مباشرة):</p>
          <a href={`${base}/openapi.json`} target="_blank" rel="noreferrer" dir="ltr" className="mono small">{base}/openapi.json</a>
          <ul className="small muted bullets">
            <li>الفواتير مع الضريبة ورقم الفاتورة الإلكترونية والـ QR، وحساب الإيراد ورمز الضريبة حسب إعدادات "ربط ERP".</li>
            <li>الـ ERP بيأكد الترحيل برقم المستند، وبيسجّل الدفعات اللي استلمها (مع Idempotency-Key).</li>
            <li>الأحداث بتوصل بالـ Webhook موقّعة HMAC-SHA256، أو بيسحبها من /events.</li>
          </ul>
        </div>
        <div className="card">
          <h3>الـ Webhook</h3>
          {d.webhook.url ? <code className="key" dir="ltr">{d.webhook.url}</code> : <Empty compact icon="plug">متوقف. حط الرابط من إعدادات المالك ← ربط ERP.</Empty>}
          <div className="row-tight">
            {d.webhook.counts.map((c: any) => <Pill key={c.status} status={c.status === 'SENT' ? 'RESOLVED' : c.status === 'FAILED' ? 'HIGH' : 'PLANNED'} label={`${{ SENT: 'انبعت', FAILED: 'فشل', PENDING: 'بالانتظار', SKIPPED: 'بدون Webhook' }[c.status as string] ?? c.status}: ${c.n}`} />)}
          </div>
          {d.webhook.recentFailures.length > 0 && (
            <ul className="list">{d.webhook.recentFailures.map((f: any) => <li key={f.id} className="small"><span className="mono">{f.event}</span> · {f.attempts} محاولات · <span className="error">{f.last_error}</span></li>)}</ul>
          )}
        </div>
      </div>
    </div>
  );
}

const MOVE_AR: Record<string, [string, string]> = { PENDING: ['PLANNED', 'بالانتظار'], POSTED: ['RESOLVED', 'انسجّلت'], FAILED: ['HIGH', 'فشلت'] };

/** Goods issues sent to the ERP when stock is dispensed, and the demo warehouse when the mock is on. */
function StockMonitor() {
  const data = useLoad(() => api.get<any>('/stock/movements'));
  const mock = useLoad(() => api.get<any[]>('/stock/mock'));
  const { busy, run } = useAction();
  const [qty, setQty] = useState<Record<string, string>>({});
  const d = data.data;
  if (!d) return null;
  return (
    <div className="split" style={{ marginTop: 16 }}>
      <div className="card">
        <div className="card-head">
          <div>
            <h2>صرف المخزون (ERP)</h2>
            <p className="small muted">{d.provider === 'OFF' ? 'فحص المخزون متوقف. شغّله من إعدادات المالك ← المخزون (ERP).' : 'كل صرف من الصيدلية أو التوصيل بينبعت للـ ERP كحركة صرف. إذا فشل، بيعيد المحاولة لحاله.'}</p>
          </div>
          <button className="secondary" disabled={busy || d.provider === 'OFF'} onClick={() => run(async () => { await api.post('/stock/process'); data.reload(); mock.reload(); }, 'تمت معالجة حركات المخزون')}>أرسل المعلّق الآن</button>
        </div>
        <div className="row-tight">{d.counts.map((c: any) => <Pill key={c.status} status={MOVE_AR[c.status]?.[0] ?? 'PLANNED'} label={`${MOVE_AR[c.status]?.[1] ?? c.status}: ${c.n}`} />)}</div>
        {!d.items.length && <Empty compact>ما في حركات صرف بعد.</Empty>}
        <ul className="list">
          {d.items.slice(0, 30).map((m: any) => (
            <li key={m.id} className="list-row">
              <div>
                <bdi dir="ltr" className="mono">{m.material}</bdi> × <span className="mono">{m.qty}</span> · <span className="small muted">{m.reference}{m.full_name ? ` · ${m.full_name}` : ''}</span>
                <div className="small muted">{fmtTime(m.created_at)}{m.erp_document ? ` · مستند ${m.erp_document}` : ''}{m.last_error ? ` · ${m.last_error}` : ''}</div>
              </div>
              <Pill status={MOVE_AR[m.status][0]} label={MOVE_AR[m.status][1]} />
            </li>
          ))}
        </ul>
      </div>
      {d.provider === 'MOCK' && mock.data && (
        <div className="card">
          <h2>المخزن التجريبي</h2>
          <p className="small muted">بيقوم مقام مخزون الـ ERP بالوضع التجريبي. عدّل الكميات لتجرّب حالة نقص المخزون.</p>
          <ul className="list">
            {mock.data.map((m: any) => (
              <li key={m.material} className="list-row">
                <bdi dir="ltr" className="mono">{m.material}</bdi>
                <div className="row-tight">
                  <input aria-label={`كمية ${m.material}`} type="number" min={0} style={{ width: 90 }} value={qty[m.material] ?? String(m.available)} onChange={(e) => setQty({ ...qty, [m.material]: e.target.value })} />
                  <button className="ghost" disabled={busy} onClick={() => run(async () => { await api.put('/stock/mock', { material: m.material, available: Number(qty[m.material] ?? m.available) }); mock.reload(); }, 'تم تحديث الكمية')}>حفظ</button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function Integrations() {
  return (
    <>
      <IntegrationsMain />
      <StockMonitor />
    </>
  );
}
