// End-to-end smoke test: every persona, through the browser, against a fresh server.
// Each step is recorded as PASS/FAIL (the run continues after a failure) into OUT/report.md and OUT/report.json.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const B = process.env.BASE_URL || 'http://localhost:3800';
const OUT = process.env.OUT || 'e2e/out';
const SHOTS = path.join(OUT, 'screens');
fs.mkdirSync(SHOTS, { recursive: true });

const HOME = { latitude: 31.9539, longitude: 35.9106 };
const results = [];
const consoleErrors = [];
let browser;

async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t });
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t, error: String(e.message || e).split('\n')[0] });
    console.log(`FAIL  ${name}\n      ${String(e.message || e).split('\n')[0]}`);
  }
}

async function page(kind = 'desk', extra = {}) {
  const vp = kind === 'phone' ? { width: 390, height: 844 } : { width: 1360, height: 900 };
  const ctx = await browser.newContext({ viewport: vp, locale: 'ar', geolocation: HOME, permissions: ['geolocation'], ...extra });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => consoleErrors.push(`${kind}: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error' && !/404 \(Not Found\)|409 \(Conflict\)|400 \(Bad Request\)/.test(m.text())) consoleErrors.push(`${kind}: ${m.text()}`); });
  return p;
}
async function login(p, name) {
  await p.goto(B);
  await p.getByRole('button', { name }).first().click();
  await p.waitForTimeout(500);
}
async function lastToast(p) {
  await p.waitForTimeout(600);
  return (await p.locator('.toast').last().textContent({ timeout: 4000 }).catch(() => '')) || '';
}
async function expectToast(p, re) {
  const t = await lastToast(p);
  if (!re.test(t)) throw new Error(`unexpected message: "${t}"`);
}
async function noOverflow(p, label) {
  const o = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (o > 1) throw new Error(`${label}: page scrolls sideways by ${o}px`);
}
async function shot(p, name) { await p.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false }); }
async function api(method, url, body, staffId) {
  const r = await fetch(B + '/api' + url, { method, headers: { 'content-type': 'application/json', ...(staffId ? { 'x-staff-id': String(staffId) } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${j.error || ''}`);
  return j;
}
const isoLocal = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

(async () => {
  browser = await chromium.launch();
  const tomorrow9 = new Date(Date.now() + 86_400_000); tomorrow9.setHours(9, 0, 0, 0);

  // ---------------------------------------------------------------- owner setup
  await step('Owner: switch on e-invoicing (mock) and seller data from settings', async () => {
    const p = await page();
    await login(p, /^Admin/);
    await p.getByRole('button', { name: 'إعدادات المالك' }).click();
    await p.locator('.settings-nav button', { hasText: 'الفوترة الإلكترونية' }).click();
    await p.locator('#set-einvoiceProvider').selectOption('MOCK');
    await p.locator('#set-sellerTin').fill('12345678');
    await p.locator('#set-sellerName').fill('شركة رعاية للخدمات الطبية المنزلية');
    await p.locator('#set-incomeSourceSequence').fill('9876543');
    await p.locator('.settings-side').getByRole('button', { name: 'حفظ' }).click();
    await expectToast(p, /تم حفظ/);
    await shot(p, 'owner-settings');
    await p.close();
  });

  let apiKey = '';
  await step('Owner: create an ERP API key', async () => {
    const p = await page();
    await login(p, /^Admin/);
    await p.getByRole('button', { name: 'الربط مع الأنظمة' }).click();
    await p.getByRole('button', { name: 'إنشاء مفتاح' }).click();
    await expectToast(p, /انعمل المفتاح/);
    apiKey = (await p.locator('code.key').first().textContent()).trim();
    if (!apiKey.startsWith('hc_')) throw new Error('no key shown');
    await shot(p, 'owner-integrations');
    await p.close();
  });

  // ---------------------------------------------------------------- patient app
  await step('Patient: sign up with SMS code, request a lab test, complete profile', async () => {
    const p = await page('phone');
    await p.goto(B + '/#patient');
    await p.getByLabel('الرقم الوطني').fill('9881231231');
    await p.getByLabel('رقم الموبايل').fill('0791231231');
    await p.getByRole('button', { name: 'أرسل رمز التحقق' }).click();
    await p.getByLabel('الاسم الكامل').fill('سلمى يوسف');
    await p.getByRole('button', { name: 'أرسل رمز التحقق' }).click();
    const code = (await p.locator('.notice strong').first().textContent()).trim();
    await p.getByLabel('الرمز').fill(code);
    await p.getByRole('button', { name: 'دخول' }).click();
    await p.getByRole('tab', { name: 'طلب خدمة' }).click();
    await p.getByText('تعداد دم كامل').click();
    await p.getByRole('button', { name: 'أرسل الطلب' }).click();
    await expectToast(p, /وصل طلبك/);
    await p.getByRole('tab', { name: 'ملفي' }).click();
    await p.getByLabel('تاريخ الميلاد').fill('1979-04-04');
    await p.getByLabel('الجنس').selectOption('F');
    await p.getByLabel('العنوان بالتفصيل').fill('عمّان، الجبيهة، شارع الجامعة');
    await p.getByRole('button', { name: 'استخدم موقعي الحالي' }).click();
    await p.getByLabel('رقم شخص للطوارئ').fill('زوجها 0790000000');
    await p.getByRole('button', { name: 'حفظ', exact: true }).click();
    await expectToast(p, /تم حفظ/);
    await noOverflow(p, 'patient app');
    await shot(p, 'patient-file');
    await p.close();
  });

  // ---------------------------------------------------------------- call center
  await step('Call center: register a doctor visit by phone for a new patient', async () => {
    const p = await page();
    await login(p, /Lina/);
    await p.getByLabel('الرقم الوطني').fill('9861112223');
    await p.getByRole('button', { name: 'بحث' }).click();
    await p.getByLabel('الاسم الكامل').fill('فاطمة أحمد');
    await p.getByLabel('تاريخ الميلاد').fill('1950-05-05');
    await p.getByLabel('الجنس').selectOption('F');
    await p.getByLabel('الهاتف').fill('0795551234');
    await p.getByLabel('جهة اتصال للطوارئ').fill('ابنها 0791112223');
    await p.getByLabel('العنوان').fill('عمّان، خلدا، عمارة 12');
    await p.getByLabel('خط العرض (GPS)').fill('31.9539');
    await p.getByLabel(/خط الطول/).fill('35.9106');
    await p.getByText('ساعة تمريض').click();
    await shot(p, 'callcenter-intake');
    await p.getByRole('button', { name: 'تسجيل الطلب' }).click();
    await expectToast(p, /تم تسجيل الطلب/);
    await p.close();
  });

  // ---------------------------------------------------------------- coordinator: lab request
  await step('Coordinator: price the patient-app request, patient accepts in app, assign lab tech', async () => {
    const p = await page();
    await login(p, /Omar/);
    await p.locator('.req-card', { hasText: 'سلمى يوسف' }).first().click();
    await p.getByRole('button', { name: 'احسب وأرسل العرض' }).click();
    await expectToast(p, /انبعت عرض السعر/);
    await p.keyboard.press('Escape');
    // patient accepts in the app
    const pp = await page('phone');
    await pp.goto(B + '/#patient');
    await pp.getByLabel('الرقم الوطني').fill('9881231231');
    await pp.getByLabel('رقم الموبايل').fill('0791231231');
    await pp.getByRole('button', { name: 'أرسل رمز التحقق' }).click();
    const code = (await pp.locator('.notice strong').first().textContent()).trim();
    await pp.getByLabel('الرمز').fill(code);
    await pp.getByRole('button', { name: 'دخول' }).click();
    await pp.getByRole('button', { name: 'موافق', exact: true }).click();
    await expectToast(pp, /موافقتك/);
    await pp.close();
    await p.reload();
    await p.locator('.req-card', { hasText: 'سلمى يوسف' }).first().click();
    const sel = p.getByLabel('الكادر');
    const v = await sel.locator('option', { hasText: 'Yousef' }).getAttribute('value');
    await sel.selectOption(v);
    await p.getByLabel('الموعد').fill(isoLocal(new Date(Date.now() + 3600_000)));
    await shot(p, 'coordinator-drawer');
    await p.getByRole('button', { name: 'تعيين', exact: true }).click();
    await expectToast(p, /تم التعيين/);
    await p.keyboard.press('Escape');
    await shot(p, 'coordinator-board');
    await p.close();
  });

  // ---------------------------------------------------------------- lab tech
  await step('Lab tech (phone): on my way, GPS check-in with consent, result + cash', async () => {
    const p = await page('phone');
    await login(p, /Yousef/);
    await p.getByRole('button', { name: 'أنا بالطريق' }).click();
    await expectToast(p, /بالطريق/);
    await p.getByText(/ما في موافقة على الملف/).click();
    await p.getByRole('button', { name: /وصلت/ }).click();
    await expectToast(p, /تم تسجيل الوصول/);
    await p.getByRole('button', { name: 'إنهاء الزيارة' }).click();
    await p.getByLabel(/النتيجة/).fill('CBC طبيعي');
    await p.getByLabel(/المبلغ المحصّل/).fill('8');
    await noOverflow(p, 'field app');
    await shot(p, 'field-lab');
    await p.getByRole('button', { name: 'حفظ وإنهاء' }).click();
    await expectToast(p, /اكتملت الزيارة/);
    await p.close();
  });

  await step('Patient sees the result and a tax invoice with QR', async () => {
    await new Promise((r) => setTimeout(r, 2500)); // background job sends the e-invoice
    const p = await page('phone');
    await p.goto(B + '/#patient');
    await p.getByLabel('الرقم الوطني').fill('9881231231');
    await p.getByLabel('رقم الموبايل').fill('0791231231');
    await p.getByRole('button', { name: 'أرسل رمز التحقق' }).click();
    const code = (await p.locator('.notice strong').first().textContent()).trim();
    await p.getByLabel('الرمز').fill(code);
    await p.getByRole('button', { name: 'دخول' }).click();
    await p.getByRole('tab', { name: 'ملفي' }).click();
    await p.getByText('CBC طبيعي').waitFor({ timeout: 5000 });
    await p.locator('button.list-row').first().click();
    await p.locator('.invoice-doc .qr svg').waitFor({ timeout: 8000 });
    await noOverflow(p, 'patient invoice');
    await shot(p, 'patient-invoice');
    await p.close();
  });

  // ---------------------------------------------------------------- home care path
  await step('Coordinator schedules a doctor assessment for the nursing request', async () => {
    const reqs = await api('GET', '/requests?status=UNDER_REVIEW', null, 3);
    const r = reqs.find((x) => x.full_name === 'فاطمة أحمد');
    if (!r) throw new Error('call-center request not on the board');
    await api('POST', `/requests/${r.id}/quote`, {}, 3);
    await api('POST', `/requests/${r.id}/accept`, { evidence: 'phone' }, 3);
    const p = await page();
    await login(p, /Omar/);
    await p.locator('.req-card', { hasText: 'فاطمة أحمد' }).first().click();
    await p.getByRole('radio', { name: /تقييم/ }).click();
    const sel = p.getByLabel('الكادر');
    await sel.selectOption(await sel.locator('option', { hasText: 'Dr. Sami' }).getAttribute('value'));
    await p.getByLabel('الموعد').fill(isoLocal(new Date(Date.now() + 2 * 3600_000)));
    await p.getByRole('button', { name: 'تعيين', exact: true }).click();
    await expectToast(p, /تم التعيين/);
    await p.close();
  });

  await step('Doctor (phone): assessment opens the episode, care plan, lab order', async () => {
    const p = await page('phone');
    await login(p, /Dr\. Sami/);
    await p.getByRole('button', { name: 'أنا بالطريق' }).click();
    await expectToast(p, /بالطريق/);
    await p.getByRole('button', { name: /وصلت/ }).click();
    const t = await lastToast(p);
    if (!/تم تسجيل الوصول/.test(t)) {
      await p.getByText(/ما في موافقة على الملف/).click();
      await p.getByRole('button', { name: /وصلت/ }).click();
      await expectToast(p, /تم تسجيل الوصول/);
    }
    await p.getByRole('button', { name: 'إنهاء الزيارة' }).click();
    await p.getByLabel('التشخيص').fill('رعاية بعد جلطة دماغية');
    await p.getByLabel(/Braden/).fill('14');
    await p.getByLabel('الحساسية').fill('بنسلين');
    await p.getByRole('button', { name: 'حفظ', exact: true }).click();
    await expectToast(p, /انفتح ملف/);
    await p.getByRole('tab', { name: 'حالاتي' }).click();
    await p.locator('.visit-head').first().click();
    await p.getByLabel('طول الشفت').selectOption('8');
    await p.getByLabel('ساعات باليوم').fill('8');
    await p.getByLabel('المدة (أيام)').fill('2');
    await p.getByRole('button', { name: 'اعتماد الخطة' }).click();
    await expectToast(p, /اعتُمدت خطة/);
    await p.getByLabel('الخدمة').selectOption('LAB-PANEL');
    await p.getByRole('button', { name: 'إرسال' }).click();
    await expectToast(p, /انبعت الأوردر/);
    await noOverflow(p, 'doctor app');
    await shot(p, 'field-doctor');
    await p.close();
  });

  await step('Lab worklist: critical result goes to the doctor, doctor acknowledges', async () => {
    const p = await page('phone');
    await login(p, /Yousef/);
    await p.getByRole('tab', { name: 'أوردرات القسم' }).click();
    await p.getByRole('button', { name: 'استلام' }).click();
    await expectToast(p, /استلمت/);
    await p.getByLabel('النتيجة').fill('K+ 6.8 mmol/L');
    await p.getByText('نتيجة حرجة').click();
    await p.getByRole('button', { name: 'اعتماد وإرسال' }).click();
    await expectToast(p, /انبعتت النتيجة/);
    await p.close();
    const d = await page('phone');
    await login(d, /Dr\. Sami/);
    await d.getByRole('tab', { name: 'حالاتي' }).click();
    await d.locator('.visit-head').first().click();
    await d.getByRole('button', { name: 'راجعت' }).click();
    await expectToast(d, /تمت المراجعة/);
    await d.close();
  });

  await step('Coordinator builds the roster from the care plan', async () => {
    const p = await page();
    await login(p, /Omar/);
    await p.getByRole('tab', { name: /الرعاية المنزلية/ }).click();
    await p.getByRole('button', { name: 'الشفتات' }).first().click();
    await p.getByLabel('بداية أول شفت').fill(isoLocal(new Date(Date.now() - 3600_000)));
    await p.getByRole('button', { name: /Rana/ }).click();
    await p.getByRole('button', { name: /Maya/ }).click();
    await p.getByRole('button', { name: 'نشر الجدول' }).click();
    await expectToast(p, /تم نشر الجدول/);
    await shot(p, 'coordinator-roster');
    await p.close();
  });

  await step('Nurse (phone): check in, abnormal vitals → NEWS2 escalation, notes, handover', async () => {
    const p = await page('phone');
    await login(p, /Rana/);
    await p.getByRole('button', { name: 'تسجيل حضور الشفت' }).click();
    await expectToast(p, /تم تسجيل الحضور/);
    await p.getByLabel('التنفس /د').fill('22');
    await p.getByLabel('النبض /د').fill('115');
    await p.getByLabel('الحرارة °C').fill('38.5');
    await p.getByRole('button', { name: /حساب NEWS2/ }).click();
    await p.locator('.news').waitFor();
    const n = await p.locator('.news').textContent();
    if (!/5/.test(n)) throw new Error(`NEWS2 shown: ${n}`);
    await shot(p, 'field-nurse-news2');
    await p.getByLabel('الملاحظة').fill('المريض مرتاح بعد خافض الحرارة');
    await p.getByRole('button', { name: 'حفظ الملاحظة' }).click();
    await expectToast(p, /تم حفظ الملاحظة/);
    await p.getByLabel(/ملخص التسليم/).fill('حرارة 38.5 بعد خافض، تبليغ الطبيب، المتابعة كل ساعة');
    await p.getByRole('button', { name: 'Check-out' }).click();
    await expectToast(p, /انتهى الشفت/);
    await noOverflow(p, 'nurse app');
    await p.close();
  });

  await step('Coordinator alerts show the open NEWS2 escalation', async () => {
    const p = await page();
    await login(p, /Omar/);
    await p.getByRole('tab', { name: 'التنبيهات' }).click();
    await p.getByText('NEWS2').first().waitFor({ timeout: 5000 });
    await shot(p, 'coordinator-alerts');
    await p.close();
  });

  // ---------------------------------------------------------------- finance
  await step('Finance: weekly billing run, issue, pay; e-invoice accepted with QR', async () => {
    const p = await page();
    await login(p, /Huda/);
    const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    await p.getByLabel('تاريخ التشغيل').fill(nextWeek);
    await p.getByRole('button', { name: 'تشغيل الفوترة الدورية' }).click();
    await expectToast(p, /طلعت الفواتير/);
    const row = p.locator('tr', { hasText: 'دورية' }).first();
    await row.getByRole('button', { name: 'فتح' }).click();
    await p.getByRole('button', { name: 'مطابقة مع الحضور وإصدار' }).click();
    await expectToast(p, /صدرت الفاتورة/);
    await p.getByLabel('المبلغ (د.أ)').fill('1');
    await p.getByRole('button', { name: 'تسجيل' }).click();
    await expectToast(p, /تم تسجيل الدفعة/);
    await p.waitForTimeout(2500);
    await p.getByRole('button', { name: 'الفاتورة الضريبية' }).click();
    await p.locator('.invoice-doc .qr svg').waitFor({ timeout: 8000 });
    await shot(p, 'finance-invoice');
    await p.keyboard.press('Escape');
    await p.getByRole('tab', { name: /الفوترة الإلكترونية/ }).click();
    await p.getByText('مقبولة').first().waitFor();
    await shot(p, 'finance-einvoice');
    await p.close();
  });

  // ---------------------------------------------------------------- ERP
  await step('ERP API: invoices with tax + e-invoice, ack, idempotent payment', async () => {
    const h = { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
    const list = await (await fetch(`${B}/api/erp/v1/invoices?unsynced=true`, { headers: h })).json();
    if (!list.data?.length) throw new Error('no invoices exported');
    const inv = list.data.find((x) => x.eInvoice?.status === 'ACCEPTED');
    if (!inv) throw new Error('no accepted e-invoice in export');
    const ack = await fetch(`${B}/api/erp/v1/invoices/${inv.id}/ack`, { method: 'POST', headers: h, body: JSON.stringify({ erpDocumentNo: '1800000001' }) });
    if (!ack.ok) throw new Error(`ack ${ack.status}`);
    const open = list.data.find((x) => x.status !== 'PAID');
    if (open) {
      const body = JSON.stringify({ invoiceId: open.id, amount: '1.000', reference: 'SAP 14000001' });
      const a = await fetch(`${B}/api/erp/v1/payments`, { method: 'POST', headers: { ...h, 'Idempotency-Key': 'e2e-1' }, body });
      const b = await fetch(`${B}/api/erp/v1/payments`, { method: 'POST', headers: { ...h, 'Idempotency-Key': 'e2e-1' }, body });
      const [ja, jb] = [await a.json(), await b.json()];
      if (ja.paymentId !== jb.paymentId) throw new Error('payment posted twice');
    }
  });

  // ---------------------------------------------------------------- layout checks
  await step('Every screen fits a phone (no sideways scroll)', async () => {
    const screens = [
      [/Omar/, null], [/Omar/, 'الرعاية المنزلية والشفتات'], [/Omar/, 'التنبيهات'], [/Lina/, null], [/Huda/, null], [/^Admin/, null],
    ];
    for (const [who, tab] of screens) {
      const p = await page('phone');
      await login(p, who);
      if (tab) await p.getByRole('tab', { name: tab }).click();
      await p.waitForTimeout(300);
      await noOverflow(p, `${who} ${tab ?? ''}`);
      await p.close();
    }
  });

  await step('No JavaScript errors in the browser during the run', async () => {
    if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 5).join(' | '));
  });

  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  const md = [
    `# E2E smoke run · ${new Date().toISOString()}`, '', `**${passed}/${results.length} steps passed**`, '',
    '| # | Step | Result | Time |', '|---|---|---|---|',
    ...results.map((r, i) => `| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : `FAIL: ${r.error.replace(/\|/g, '/')}`} | ${(r.ms / 1000).toFixed(1)} s |`),
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'report.md'), md + '\n');
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ results, consoleErrors }, null, 2));
  console.log(`\n${passed}/${results.length} passed · report: ${path.join(OUT, 'report.md')}`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
