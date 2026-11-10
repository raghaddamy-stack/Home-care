// Thin client for the backend API. The logged-in staff id travels in `x-staff-id`.

export interface Staff { id: number; name: string; role: string; gender: string | null; zone_id: number | null; licence_expiry: string | null }
export interface Service { code: string; name_ar: string; name_en: string; line: string; unit: string; department: string; requires_preapproval: number; requires_prescription: number; cash_price: number }
export interface RequestRow {
  id: number; request_no: string; patient_id: number; channel: string; status: string; route: string | null; urgency: string;
  preferred_at: string | null; clinical_notes: string | null; created_at: string; full_name: string; phone: string | null;
  national_id: string; services: string; patient_total: number | null; quote_total: number | null; last_note: string | null; policy_id: number | null;
}

let staffId: number | null = null;
export const setStaff = (id: number | null) => { staffId = id; };

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (staffId) headers['x-staff-id'] = String(staffId);
  const res = await fetch(`/api${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const issues = data.issues?.map((i: any) => `${i.path.join('.')}: ${i.message}`).join('، ');
    throw new ApiError(res.status, issues ? `${data.error} (${issues})` : data.error ?? `HTTP ${res.status}`);
  }
  return data as T;
}

export const api = {
  get: <T,>(url: string) => call<T>('GET', url),
  post: <T,>(url: string, body: unknown = {}) => call<T>('POST', url, body),
};

/** Fils → "12.500 د.أ" */
export const jod = (fils: number | null | undefined) =>
  fils === null || fils === undefined ? '—' : `${(fils / 1000).toFixed(3)} د.أ`;

export const fmtTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('ar-JO', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

/** Value for <input type="datetime-local"> → ISO string. */
export const localToIso = (v: string) => new Date(v).toISOString();
export const isoToLocal = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const STATUS_AR: Record<string, string> = {
  SUBMITTED: 'جديد', PENDING_INFO: 'بيانات ناقصة', UNDER_REVIEW: 'للمراجعة', PENDING_PREAPPROVAL: 'بانتظار التأمين',
  QUOTED: 'عرض سعر مُرسل', ACCEPTED: 'مقبول', SCHEDULED: 'مجدول', DISPATCHED: 'بالطريق', IN_PROGRESS: 'قيد التنفيذ',
  NO_SHOW: 'No-show', COMPLETED: 'مكتمل', CONVERTED_TO_EPISODE: 'رعاية منزلية', REFERRED_OUT: 'محوّل', CANCELLED: 'ملغي',
  PLANNED: 'مخطط', LATE: 'متأخر', CHECKED_IN: 'حاضر', MISSED: 'فائت', ACTIVE: 'نشط', ON_HOLD: 'معلّق', DISCHARGED: 'منتهي',
  OPEN: 'مفتوح', ACKED: 'تم الرد', RESOLVED: 'مغلق', DRAFT: 'مسودة', ISSUED: 'صادرة', PAID: 'مدفوعة', PARTIALLY_PAID: 'مدفوعة جزئياً',
};

export const ROLE_AR: Record<string, string> = {
  ADMIN: 'مدير النظام', AGENT: 'كول سنتر', COORDINATOR: 'منسق', DOCTOR: 'طبيب', NURSE: 'ممرض/ة', LAB_TECH: 'فني مختبر',
  RADIOGRAPHER: 'فني أشعة', PHARMACIST: 'صيدلي', DRIVER: 'وحدة التوصيل', FINANCE: 'مالية', SUPERVISOR: 'مشرف تمريض',
};

export const ROUTE_AR: Record<string, string> = { DIRECT: 'خدمة مباشرة', ASSESSMENT: 'تقييم طبيب/ممرض', NURSE: 'ممرض مباشرة' };

/** Arabic wording for escalation actions (the API stores English text for integrations). */
export function escalationAr(trigger: string, level: string): string {
  if (trigger === 'NEWS2') {
    if (level === 'HIGH') return 'طوارئ: إسعاف، إبلاغ الطبيب والعائلة، تعليق الرعاية';
    if (level === 'MEDIUM') return 'إعادة القياس بعد 15 دقيقة، وإذا لسا ≥ 5 بيتبلّغ الطبيب المناوب (يرد خلال 15 دقيقة)';
    if (level === 'LOW_MEDIUM') return 'قراءة وحدة بدرجة 3: مراجعة عاجلة من الطبيب';
  }
  if (trigger === 'CRITICAL_RESULT') return 'نتيجة حرجة: الطبيب لازم يؤكد استلامها خلال 30 دقيقة';
  if (trigger === 'LATE_SHIFT') return 'الممرض ما سجّل حضور: اتصل فيه، وابعت بديل إذا ما في وقت وصول خلال 15 دقيقة';
  if (trigger === 'INCIDENT') return 'حادثة: مراجعة المشرف';
  return level;
}
