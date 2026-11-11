// Owner-configurable business settings. Every policy number or choice the business may want to change
// lives here with a default; the owner edits them from the settings screen (ADMIN role).
// Domain code reads `cfg()` at call time, so a change applies to the next action without a restart.
import type { Db } from './db.js';
import { decrypt, encrypt, maskSecret } from './secrets.js';

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // Sun..Sat

export interface Settings {
  // Pricing
  timezone: string;
  afterHoursMultiplier: number;
  afterHoursStart: number; // hour, local time
  afterHoursEnd: number;
  afterHoursDays: Weekday[];
  holidays: string[]; // YYYY-MM-DD, priced as after-hours
  coordinatorDiscountLimit: number;
  quoteValidityRoutineH: number;
  quoteValidityUrgentH: number;
  // Patient fees
  feeBase: 'PATIENT_SHARE' | 'FULL_PRICE';
  noShowFeePct: number;
  noShowMinFee: number; // fils
  noShowCapAtVisitPrice: boolean;
  noShowPrepayThreshold: number;
  noShowWindowDays: number;
  freeCancelNoticeH: number;
  fullFeeNoticeH: number;
  partialCancelPct: number;
  // Payment & billing
  directServicePayment: 'AT_DOOR' | 'BEFORE_BOOKING';
  nursingBillingMode: 'ARREARS' | 'ADVANCE';
  interimInvoicing: boolean;
  // Staffing
  genderMatch: 'OFF' | 'WARN' | 'BLOCK';
  maxHoursPer7Days: number;
  minRestHours: number;
  maxConsecutive24h: number;
  checkInGraceMin: number;
  checkInRadiusM: number;
  billingRoundMin: number;
  lateToleranceMin: number;
  // Clinical
  medicalDirectorId: number | null;
  onCallDoctorIds: number[];
  criticalResultAckMin: number;
  news2MediumResponseMin: number;
  news2LowMediumResponseMin: number;
  news2RecheckMin: number;
  resultAutoReleaseH: number; // 0 = only after doctor review
  requireConsent: boolean;
  adultAge: number;
  // Patient app
  otpTtlMin: number;
  otpMaxAttempts: number;
  sessionDays: number;
  // Service levels (minutes)
  slaReviewMin: number;
  slaPreapprovalMin: number;
  slaQuoteMin: number;
  slaScheduleUrgentMin: number;
  slaScheduleRoutineMin: number;
  // Feedback
  feedbackLowScore: number;
  feedbackWindowDays: number;
  // Tax
  pricesIncludeTax: boolean;
  taxRules: Record<TaxLine, { category: TaxCategory; rate: number }>;
  // E-invoicing (Jordan national e-invoicing system, JoFotara)
  einvoiceProvider: 'NONE' | 'MOCK' | 'JOFOTARA';
  einvoiceEndpoint: string;
  einvoiceClientId: string;
  einvoiceSecretKey: string;
  sellerTin: string;
  sellerName: string;
  incomeSourceSequence: string;
  einvoiceAutoSubmit: boolean;
  einvoicePaymentType: 'AUTO' | 'CASH' | 'RECEIVABLE';
  // ERP integration
  erpWebhookUrl: string;
  erpWebhookSecret: string;
  erpGlAccounts: Record<TaxLine, string>;
  erpTaxCodes: Record<TaxCategory, string>;
  erpCostCenter: string;
  // Stock (inventory) in the ERP
  stockProvider: 'OFF' | 'MOCK' | 'GENERIC' | 'SAP';
  stockMode: 'WARN' | 'BLOCK';
  stockOnError: 'ALLOW' | 'BLOCK';
  stockBaseUrl: string;
  stockUser: string;
  stockApiKey: string;
  stockPlant: string;
  stockLocation: string;
  stockMovementType: string;
  stockMaterials: Record<string, string>;
}

/** Revenue lines used for tax and accounting: the service lines, plus fees (cancellation / no-show). */
export const TAX_LINES = ['LAB', 'IMG', 'DEV', 'DOC', 'NRS', 'FEE'] as const;
export type TaxLine = (typeof TAX_LINES)[number];
/** UN/ECE 5305 categories used by JoFotara: S standard, Z zero-rated, O exempt / out of scope. */
export const TAX_CATEGORIES = ['S', 'Z', 'O'] as const;
export type TaxCategory = (typeof TAX_CATEGORIES)[number];

export const DEFAULTS: Settings = {
  timezone: 'Asia/Amman',
  afterHoursMultiplier: 1.25,
  afterHoursStart: 20,
  afterHoursEnd: 7,
  afterHoursDays: [5],
  holidays: [],
  coordinatorDiscountLimit: 10,
  quoteValidityRoutineH: 48,
  quoteValidityUrgentH: 4,
  feeBase: 'PATIENT_SHARE',
  noShowFeePct: 50,
  noShowMinFee: 10_000,
  noShowCapAtVisitPrice: false,
  noShowPrepayThreshold: 2,
  noShowWindowDays: 30,
  freeCancelNoticeH: 24,
  fullFeeNoticeH: 2,
  partialCancelPct: 50,
  directServicePayment: 'AT_DOOR',
  nursingBillingMode: 'ARREARS',
  interimInvoicing: true,
  genderMatch: 'WARN',
  maxHoursPer7Days: 60,
  minRestHours: 11,
  maxConsecutive24h: 2,
  checkInGraceMin: 15,
  checkInRadiusM: 150,
  billingRoundMin: 15,
  lateToleranceMin: 10,
  medicalDirectorId: null,
  onCallDoctorIds: [],
  criticalResultAckMin: 30,
  news2MediumResponseMin: 15,
  news2LowMediumResponseMin: 30,
  news2RecheckMin: 15,
  resultAutoReleaseH: 24,
  requireConsent: true,
  adultAge: 18,
  otpTtlMin: 5,
  otpMaxAttempts: 5,
  sessionDays: 30,
  slaReviewMin: 30,
  slaPreapprovalMin: 240,
  slaQuoteMin: 1440,
  slaScheduleUrgentMin: 180,
  slaScheduleRoutineMin: 1440,
  feedbackLowScore: 2,
  feedbackWindowDays: 14,
  pricesIncludeTax: true,
  taxRules: {
    LAB: { category: 'O', rate: 0 }, IMG: { category: 'O', rate: 0 }, DOC: { category: 'O', rate: 0 },
    NRS: { category: 'O', rate: 0 }, DEV: { category: 'S', rate: 16 }, FEE: { category: 'S', rate: 16 },
  },
  einvoiceProvider: 'NONE',
  einvoiceEndpoint: 'https://backend.jofotara.gov.jo/core/invoices/',
  einvoiceClientId: '',
  einvoiceSecretKey: '',
  sellerTin: '',
  sellerName: '',
  incomeSourceSequence: '',
  einvoiceAutoSubmit: true,
  einvoicePaymentType: 'AUTO',
  erpWebhookUrl: '',
  erpWebhookSecret: '',
  erpGlAccounts: { LAB: '', IMG: '', DEV: '', DOC: '', NRS: '', FEE: '' },
  erpTaxCodes: { S: '', Z: '', O: '' },
  erpCostCenter: '',
  stockProvider: 'OFF',
  stockMode: 'BLOCK',
  stockOnError: 'ALLOW',
  stockBaseUrl: '',
  stockUser: '',
  stockApiKey: '',
  stockPlant: '',
  stockLocation: '',
  stockMovementType: '201',
  stockMaterials: {},
};

type Kind = 'number' | 'money' | 'boolean' | 'select' | 'weekdays' | 'dates' | 'staff' | 'staffList' | 'text' | 'url' | 'secret' | 'taxMap' | 'lineMap' | 'categoryMap' | 'serviceMap';

/** Settings stored encrypted and never sent back to the browser. */
export const SECRET_KEYS: (keyof Settings)[] = ['einvoiceClientId', 'einvoiceSecretKey', 'erpWebhookSecret', 'stockApiKey'];

export interface SettingMeta {
  key: keyof Settings;
  group: string;
  label: string;
  help?: string;
  kind: Kind;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { value: string; label: string }[];
  /** For staff pickers: allowed roles. */
  roles?: string[];
}

/** Metadata the settings screen renders. Labels are Arabic (the owner's language). */
export const META: SettingMeta[] = [
  { key: 'timezone', group: 'التسعير والمواعيد', label: 'المنطقة الزمنية', kind: 'select', options: [
    { value: 'Asia/Amman', label: 'عمّان' }, { value: 'Asia/Riyadh', label: 'الرياض' }, { value: 'Asia/Dubai', label: 'دبي' }, { value: 'Asia/Kuwait', label: 'الكويت' }] },
  { key: 'afterHoursMultiplier', group: 'التسعير والمواعيد', label: 'معامل سعر بعد الدوام', kind: 'number', min: 1, max: 3, step: 0.05, unit: '×' },
  { key: 'afterHoursStart', group: 'التسعير والمواعيد', label: 'بداية فترة بعد الدوام', kind: 'number', min: 0, max: 23, unit: 'ساعة' },
  { key: 'afterHoursEnd', group: 'التسعير والمواعيد', label: 'نهاية فترة بعد الدوام', kind: 'number', min: 0, max: 23, unit: 'ساعة' },
  { key: 'afterHoursDays', group: 'التسعير والمواعيد', label: 'أيام بسعر بعد الدوام طول اليوم', kind: 'weekdays' },
  { key: 'holidays', group: 'التسعير والمواعيد', label: 'العطل الرسمية (بسعر بعد الدوام)', kind: 'dates' },
  { key: 'coordinatorDiscountLimit', group: 'التسعير والمواعيد', label: 'أعلى خصم بدون موافقة مشرف', kind: 'number', min: 0, max: 100, unit: '%' },
  { key: 'quoteValidityRoutineH', group: 'التسعير والمواعيد', label: 'صلاحية عرض السعر (طلب عادي)', kind: 'number', min: 1, max: 720, unit: 'ساعة' },
  { key: 'quoteValidityUrgentH', group: 'التسعير والمواعيد', label: 'صلاحية عرض السعر (عاجل / نفس اليوم)', kind: 'number', min: 1, max: 72, unit: 'ساعة' },

  { key: 'feeBase', group: 'رسوم الإلغاء والغياب', label: 'الرسوم بتنحسب من', kind: 'select', options: [
    { value: 'PATIENT_SHARE', label: 'حصة المريض فقط' }, { value: 'FULL_PRICE', label: 'السعر الكامل' }] },
  { key: 'freeCancelNoticeH', group: 'رسوم الإلغاء والغياب', label: 'إلغاء مجاني إذا قبل الموعد بأكثر من', kind: 'number', min: 0, max: 168, unit: 'ساعة' },
  { key: 'fullFeeNoticeH', group: 'رسوم الإلغاء والغياب', label: 'رسوم كاملة إذا قبل الموعد بأقل من', kind: 'number', min: 0, max: 48, unit: 'ساعة' },
  { key: 'partialCancelPct', group: 'رسوم الإلغاء والغياب', label: 'نسبة الرسوم بين الحدّين', kind: 'number', min: 0, max: 100, unit: '%' },
  { key: 'noShowFeePct', group: 'رسوم الإلغاء والغياب', label: 'رسوم No-show', kind: 'number', min: 0, max: 100, unit: '%' },
  { key: 'noShowMinFee', group: 'رسوم الإلغاء والغياب', label: 'الحد الأدنى لرسوم No-show', kind: 'money', min: 0, max: 1_000_000 },
  { key: 'noShowCapAtVisitPrice', group: 'رسوم الإلغاء والغياب', label: 'رسوم No-show ما بتزيد عن سعر الزيارة', kind: 'boolean' },
  { key: 'noShowPrepayThreshold', group: 'رسوم الإلغاء والغياب', label: 'عدد مرات No-show اللي بعدها الدفع مسبق', kind: 'number', min: 1, max: 10 },
  { key: 'noShowWindowDays', group: 'رسوم الإلغاء والغياب', label: 'خلال فترة', kind: 'number', min: 1, max: 365, unit: 'يوم' },

  { key: 'directServicePayment', group: 'الدفع والفوترة', label: 'دفع الخدمات المباشرة (نقدي)', kind: 'select', options: [
    { value: 'AT_DOOR', label: 'عند الباب بعد الخدمة' }, { value: 'BEFORE_BOOKING', label: 'مسبقاً قبل حجز الموعد' }] },
  { key: 'nursingBillingMode', group: 'الدفع والفوترة', label: 'فوترة التمريض الدوري', kind: 'select',
    help: 'مقدّماً: الفاتورة بتطلع على الشفتات المخططة للفترة الجاية، والفرق بالحضور الفعلي بيتسوّى بالفاتورة اللي بعدها.',
    options: [{ value: 'ARREARS', label: 'بعد انتهاء الفترة (حسب الحضور)' }, { value: 'ADVANCE', label: 'مقدّماً (حسب الجدول)' }] },
  { key: 'interimInvoicing', group: 'الدفع والفوترة', label: 'المالية بتقدر تطلّع فاتورة مرحلية (مثلاً شهرية) والمريض لسا بالعلاج', kind: 'boolean',
    help: 'فاتورة لكل اللي ما انفوتر لحد تاريخ بتختاره المالية، غير الدورة الأسبوعية أو الشهرية التلقائية. ما في شي بيتفوتر مرتين.' },
  { key: 'billingRoundMin', group: 'الدفع والفوترة', label: 'تقريب ساعات الحضور لأقرب', kind: 'number', min: 1, max: 60, unit: 'دقيقة' },
  { key: 'lateToleranceMin', group: 'الدفع والفوترة', label: 'تأخير مسموح بدون خصم من الساعات', kind: 'number', min: 0, max: 60, unit: 'دقيقة' },

  { key: 'genderMatch', group: 'الكادر والشفتات', label: 'تطابق جنس الكادر مع تفضيل المريض', kind: 'select', options: [
    { value: 'OFF', label: 'بدون فحص' }, { value: 'WARN', label: 'تنبيه فقط' }, { value: 'BLOCK', label: 'منع التعيين' }] },
  { key: 'maxHoursPer7Days', group: 'الكادر والشفتات', label: 'أقصى ساعات للممرض خلال 7 أيام', kind: 'number', min: 8, max: 168, unit: 'ساعة', help: 'قانون العمل الأردني: 48 ساعة أسبوعياً كأصل.' },
  { key: 'minRestHours', group: 'الكادر والشفتات', label: 'أقل راحة بين شفتين', kind: 'number', min: 0, max: 48, unit: 'ساعة' },
  { key: 'maxConsecutive24h', group: 'الكادر والشفتات', label: 'أقصى شفتات 24 ساعة متتالية', kind: 'number', min: 1, max: 14 },
  { key: 'checkInGraceMin', group: 'الكادر والشفتات', label: 'مهلة تسجيل الحضور قبل التنبيه', kind: 'number', min: 0, max: 120, unit: 'دقيقة' },
  { key: 'checkInRadiusM', group: 'الكادر والشفتات', label: 'أقصى بعد عن بيت المريض لتسجيل الحضور', kind: 'number', min: 20, max: 5000, unit: 'متر' },

  { key: 'medicalDirectorId', group: 'السريري والتصعيد', label: 'المدير الطبي', kind: 'staff', roles: ['DOCTOR'] },
  { key: 'onCallDoctorIds', group: 'السريري والتصعيد', label: 'الأطباء المناوبين', kind: 'staffList', roles: ['DOCTOR'] },
  { key: 'criticalResultAckMin', group: 'السريري والتصعيد', label: 'مهلة تأكيد النتيجة الحرجة قبل التصعيد', kind: 'number', min: 5, max: 240, unit: 'دقيقة' },
  { key: 'news2MediumResponseMin', group: 'السريري والتصعيد', label: 'مهلة رد الطبيب على NEWS2 بين 5 و6', kind: 'number', min: 5, max: 120, unit: 'دقيقة' },
  { key: 'news2LowMediumResponseMin', group: 'السريري والتصعيد', label: 'مهلة رد الطبيب على قراءة وحدة بدرجة 3', kind: 'number', min: 5, max: 240, unit: 'دقيقة' },
  { key: 'news2RecheckMin', group: 'السريري والتصعيد', label: 'إعادة قياس العلامات بعد', kind: 'number', min: 5, max: 120, unit: 'دقيقة' },
  { key: 'resultAutoReleaseH', group: 'السريري والتصعيد', label: 'إرسال النتيجة العادية للمريض بدون مراجعة بعد', kind: 'number', min: 0, max: 720, unit: 'ساعة', help: '0 = ما بتوصل للمريض إلا بعد ما يراجعها الطبيب.' },
  { key: 'requireConsent', group: 'السريري والتصعيد', label: 'موافقة موقّعة إلزامية قبل أول زيارة', kind: 'boolean' },
  { key: 'adultAge', group: 'السريري والتصعيد', label: 'عمر الرشد (تحته بيوقّع ولي الأمر)', kind: 'number', min: 14, max: 21, unit: 'سنة' },

  { key: 'slaReviewMin', group: 'مؤشرات الخدمة (SLA)', label: 'مراجعة وتسعير الطلب', kind: 'number', min: 5, max: 1440, unit: 'دقيقة' },
  { key: 'slaPreapprovalMin', group: 'مؤشرات الخدمة (SLA)', label: 'متابعة موافقة التأمين', kind: 'number', min: 15, max: 4320, unit: 'دقيقة' },
  { key: 'slaQuoteMin', group: 'مؤشرات الخدمة (SLA)', label: 'متابعة عرض سعر بدون رد', kind: 'number', min: 15, max: 4320, unit: 'دقيقة' },
  { key: 'slaScheduleUrgentMin', group: 'مؤشرات الخدمة (SLA)', label: 'تعيين كادر لطلب عاجل', kind: 'number', min: 15, max: 1440, unit: 'دقيقة' },
  { key: 'slaScheduleRoutineMin', group: 'مؤشرات الخدمة (SLA)', label: 'تعيين كادر لطلب عادي', kind: 'number', min: 15, max: 10080, unit: 'دقيقة' },

  { key: 'otpTtlMin', group: 'تطبيق المريض', label: 'صلاحية رمز الدخول', kind: 'number', min: 1, max: 30, unit: 'دقيقة' },
  { key: 'otpMaxAttempts', group: 'تطبيق المريض', label: 'محاولات الرمز قبل القفل', kind: 'number', min: 1, max: 10 },
  { key: 'sessionDays', group: 'تطبيق المريض', label: 'مدة بقاء المريض مسجّل دخول', kind: 'number', min: 1, max: 365, unit: 'يوم' },
  { key: 'feedbackLowScore', group: 'تطبيق المريض', label: 'تقييم بيفتح متابعة إذا كان أقل من أو يساوي', kind: 'number', min: 1, max: 4, unit: 'نجوم' },
  { key: 'feedbackWindowDays', group: 'تطبيق المريض', label: 'نطلب التقييم خلال', kind: 'number', min: 1, max: 90, unit: 'يوم' },

  { key: 'pricesIncludeTax', group: 'الضريبة', label: 'الأسعار المعروضة شاملة الضريبة', kind: 'boolean',
    help: 'نعم: السعر اللي بيشوفه المريض هو النهائي والضريبة بتنفصل منه. لا: الضريبة بتنضاف فوق السعر.' },
  { key: 'taxRules', group: 'الضريبة', label: 'فئة ونسبة الضريبة لكل نوع خدمة', kind: 'taxMap',
    help: 'S خاضع بنسبة، Z نسبة صفر، O معفى. راجع المحاسب الضريبي لتحديد فئة كل خدمة.' },

  { key: 'einvoiceProvider', group: 'الفوترة الإلكترونية', label: 'ربط الفواتير مع دائرة الضريبة', kind: 'select', options: [
    { value: 'NONE', label: 'متوقف' }, { value: 'MOCK', label: 'تجريبي (بدون إرسال حقيقي)' }, { value: 'JOFOTARA', label: 'نظام الفوترة الوطني JoFotara' }] },
  { key: 'einvoiceEndpoint', group: 'الفوترة الإلكترونية', label: 'رابط الإرسال', kind: 'url', help: 'من الدليل الفني لنظام الفوترة الوطني.' },
  { key: 'einvoiceClientId', group: 'الفوترة الإلكترونية', label: 'Client ID', kind: 'secret', help: 'من نظام الفوترة: ربط الأجهزة. كل تسلسل إله Client ID و Secret Key.' },
  { key: 'einvoiceSecretKey', group: 'الفوترة الإلكترونية', label: 'Secret Key', kind: 'secret' },
  { key: 'sellerTin', group: 'الفوترة الإلكترونية', label: 'الرقم الضريبي للشركة', kind: 'text' },
  { key: 'sellerName', group: 'الفوترة الإلكترونية', label: 'اسم الشركة المسجّل', kind: 'text' },
  { key: 'incomeSourceSequence', group: 'الفوترة الإلكترونية', label: 'رقم تسلسل مصدر الدخل', kind: 'text' },
  { key: 'einvoiceAutoSubmit', group: 'الفوترة الإلكترونية', label: 'إرسال الفاتورة تلقائياً عند إصدارها', kind: 'boolean' },
  { key: 'einvoicePaymentType', group: 'الفوترة الإلكترونية', label: 'نوع الفاتورة', kind: 'select', options: [
    { value: 'AUTO', label: 'تلقائي: نقدية إذا انْدفعت عند الإصدار، وإلا ذمم' }, { value: 'CASH', label: 'نقدية دائماً' }, { value: 'RECEIVABLE', label: 'ذمم دائماً' }] },

  { key: 'erpWebhookUrl', group: 'ربط ERP', label: 'رابط استقبال الأحداث (Webhook)', kind: 'url', help: 'نظام الـ ERP بيستقبل عليه: فاتورة صدرت، دفعة، فاتورة إلكترونية انقبلت. فاضي = متوقف.' },
  { key: 'erpWebhookSecret', group: 'ربط ERP', label: 'مفتاح توقيع الـ Webhook', kind: 'secret', help: 'بنوقّع كل رسالة HMAC-SHA256 بهاد المفتاح.' },
  { key: 'erpGlAccounts', group: 'ربط ERP', label: 'حساب الإيراد لكل نوع خدمة', kind: 'lineMap', help: 'مثلاً رقم الـ G/L Account بـ SAP.' },
  { key: 'erpTaxCodes', group: 'ربط ERP', label: 'رمز الضريبة بالـ ERP لكل فئة', kind: 'categoryMap', help: 'مثلاً Tax Code بـ SAP (O1, S1…).' },
  { key: 'erpCostCenter', group: 'ربط ERP', label: 'مركز الكلفة', kind: 'text' },

  { key: 'stockProvider', group: 'المخزون (ERP)', label: 'فحص المخزون قبل الصرف', kind: 'select',
    help: 'قبل ما الصيدلية أو التوصيل يصرفوا أي مادة، النظام بيسأل الـ ERP عن الكمية، وبعد الصرف بيسجّل حركة صرف (Goods Issue).',
    options: [{ value: 'OFF', label: 'متوقف' }, { value: 'MOCK', label: 'تجريبي (مخزون داخلي للتجربة)' }, { value: 'GENERIC', label: 'ERP عام (REST)' }, { value: 'SAP', label: 'SAP S/4HANA (OData)' }] },
  { key: 'stockMode', group: 'المخزون (ERP)', label: 'إذا الكمية مش كافية', kind: 'select', options: [
    { value: 'BLOCK', label: 'امنع الصرف' }, { value: 'WARN', label: 'اسمح ونبّه' }] },
  { key: 'stockOnError', group: 'المخزون (ERP)', label: 'إذا الـ ERP ما رد', kind: 'select', options: [
    { value: 'ALLOW', label: 'اسمح بالصرف وسجّل الحركة لما يرجع' }, { value: 'BLOCK', label: 'امنع الصرف' }] },
  { key: 'stockBaseUrl', group: 'المخزون (ERP)', label: 'رابط الـ ERP', kind: 'url', help: 'SAP: رابط السيرفر (مثلاً https://my-s4.example.com). ERP عام: أساس الـ API.' },
  { key: 'stockUser', group: 'المخزون (ERP)', label: 'اسم المستخدم (اختياري)', kind: 'text', help: 'إذا انكتب، الدخول بـ Basic Auth بالمستخدم والمفتاح. وإذا فاضي، المفتاح بينبعت كـ Bearer token.' },
  { key: 'stockApiKey', group: 'المخزون (ERP)', label: 'كلمة السر أو المفتاح', kind: 'secret' },
  { key: 'stockPlant', group: 'المخزون (ERP)', label: 'المصنع / الفرع (Plant)', kind: 'text' },
  { key: 'stockLocation', group: 'المخزون (ERP)', label: 'موقع التخزين (Storage Location)', kind: 'text' },
  { key: 'stockMovementType', group: 'المخزون (ERP)', label: 'نوع حركة الصرف (Movement Type)', kind: 'text', help: 'SAP: 201 صرف على مركز كلفة (الافتراضي).' },
  { key: 'stockMaterials', group: 'المخزون (ERP)', label: 'رقم المادة بالـ ERP لكل خدمة', kind: 'serviceMap', help: 'الخدمات اللي إلها رقم مادة بس بيتفحص مخزونها وبينسجّل صرفها. الصيدلي بيقدر يحدد مواد إضافية وقت الصرف.' },
];

let current: Settings = structuredClone(DEFAULTS);

/** Current settings. Domain code calls this at the moment it needs a value. */
export const cfg = (): Settings => current;

export function loadSettings(db: Db): Settings {
  const merged = structuredClone(DEFAULTS) as any;
  for (const row of db.all<{ key: string; value: string }>('SELECT key, value FROM settings')) {
    if (!(row.key in DEFAULTS)) continue;
    const v = JSON.parse(row.value);
    merged[row.key] = SECRET_KEYS.includes(row.key as keyof Settings) && typeof v === 'string' && v ? decrypt(v) : v;
  }
  current = merged;
  return current;
}

export class SettingsError extends Error {}

function validate(meta: SettingMeta, v: unknown, db: Db): unknown {
  const fail = (msg: string) => { throw new SettingsError(`${meta.label}: ${msg}`); };
  switch (meta.kind) {
    case 'number':
    case 'money': {
      if (typeof v !== 'number' || !Number.isFinite(v)) fail('لازم يكون رقم');
      const n = v as number;
      if (meta.min !== undefined && n < meta.min) fail(`أقل قيمة ${meta.min}`);
      if (meta.max !== undefined && n > meta.max) fail(`أعلى قيمة ${meta.max}`);
      return meta.kind === 'money' ? Math.round(n) : n;
    }
    case 'boolean':
      if (typeof v !== 'boolean') fail('لازم يكون نعم/لا');
      return v;
    case 'select':
    case 'text':
      if (typeof v !== 'string') fail('قيمة غير صحيحة');
      if (meta.options && !meta.options.some((o) => o.value === v)) fail('خيار غير معروف');
      return v;
    case 'weekdays':
      if (!Array.isArray(v) || v.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) fail('أيام غير صحيحة');
      return [...new Set(v as number[])].sort();
    case 'dates':
      if (!Array.isArray(v) || v.some((d) => typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d))) fail('التواريخ لازم تكون YYYY-MM-DD');
      return [...new Set(v as string[])].sort();
    case 'url': {
      if (typeof v !== 'string') fail('لازم يكون رابط');
      if (v && !/^https:\/\/[^\s]+$/.test(v as string)) fail('لازم يبدأ بـ https://');
      return (v as string).trim();
    }
    case 'secret':
      if (typeof v !== 'string' || (v as string).length > 500) fail('قيمة غير صحيحة');
      return (v as string).trim();
    case 'taxMap': {
      const m = v as Record<string, { category: string; rate: number }>;
      if (!m || typeof m !== 'object') fail('قيمة غير صحيحة');
      for (const line of TAX_LINES) {
        const r = m[line];
        if (!r || !TAX_CATEGORIES.includes(r.category as TaxCategory)) fail(`فئة ضريبة غير صحيحة لـ ${line}`);
        if (typeof r.rate !== 'number' || r.rate < 0 || r.rate > 100) fail(`نسبة غير صحيحة لـ ${line}`);
        if (r.category !== 'S' && r.rate !== 0) fail(`الفئة ${r.category} نسبتها لازم 0 (${line})`);
        if (r.category === 'S' && r.rate === 0) fail(`الفئة S لازم إلها نسبة (${line})`);
      }
      return Object.fromEntries(TAX_LINES.map((l) => [l, { category: m[l].category, rate: m[l].rate }]));
    }
    case 'serviceMap': {
      const m = v as Record<string, unknown>;
      if (!m || typeof m !== 'object' || Array.isArray(m)) fail('قيمة غير صحيحة');
      const out: Record<string, string> = {};
      for (const [code, mat] of Object.entries(m)) {
        if (!db.get('SELECT 1 FROM services WHERE code = ?', code)) fail(`خدمة غير معروفة: ${code}`);
        if (typeof mat !== 'string' || mat.length > 40) fail(`رقم مادة غير صحيح لـ ${code}`);
        if ((mat as string).trim()) out[code] = (mat as string).trim();
      }
      return out;
    }
    case 'lineMap':
    case 'categoryMap': {
      const keys: readonly string[] = meta.kind === 'lineMap' ? TAX_LINES : TAX_CATEGORIES;
      const m = v as Record<string, unknown>;
      if (!m || typeof m !== 'object' || keys.some((k) => typeof (m[k] ?? '') !== 'string')) fail('قيمة غير صحيحة');
      return Object.fromEntries(keys.map((k) => [k, String(m[k] ?? '').trim()]));
    }
    case 'staff':
    case 'staffList': {
      const ids = meta.kind === 'staff' ? (v === null ? [] : [v]) : v;
      if (!Array.isArray(ids)) fail('قائمة غير صحيحة');
      for (const id of ids as unknown[]) {
        const s = db.get<{ role: string }>('SELECT role FROM staff WHERE id = ? AND active = 1', Number(id));
        if (!s || (meta.roles && !meta.roles.includes(s.role))) fail(`الموظف ${id} مش مناسب لهاد الدور`);
      }
      return meta.kind === 'staff' ? v : [...new Set((ids as number[]).map(Number))];
    }
  }
}

/** Validate and save a partial change. Each changed key is written to the history table. */
export function saveSettings(db: Db, patch: Record<string, unknown>, actorId: number): { changed: string[] } {
  const before = cfg() as any;
  const next = { ...before };
  const changed: string[] = [];
  for (const [key, raw] of Object.entries(patch)) {
    const meta = META.find((m) => m.key === key);
    if (!meta) throw new SettingsError(`إعداد غير معروف: ${key}`);
    const value = validate(meta, raw, db);
    if (JSON.stringify(value) !== JSON.stringify(before[key])) {
      next[key] = value;
      changed.push(key);
    }
  }
  if (next.fullFeeNoticeH > next.freeCancelNoticeH) throw new SettingsError('حد الرسوم الكاملة لازم يكون أقل من حد الإلغاء المجاني');
  db.tx(() => {
    for (const key of changed) {
      db.run(
        `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        key, JSON.stringify(SECRET_KEYS.includes(key as keyof Settings) && next[key] ? encrypt(next[key]) : next[key]), actorId, new Date().toISOString(),
      );
      const shown = (x: unknown) => JSON.stringify(SECRET_KEYS.includes(key as keyof Settings) ? (x ? '••••' : '') : x);
      db.insert('settings_history', { key, old_value: shown(before[key]), new_value: shown(next[key]), changed_by: actorId });
    }
  });
  loadSettings(db);
  return { changed };
}

export function resetSetting(db: Db, key: string, actorId: number) {
  if (!(key in DEFAULTS)) throw new SettingsError(`إعداد غير معروف: ${key}`);
  return saveSettings(db, { [key]: (DEFAULTS as any)[key] }, actorId);
}

// ---- Helpers used by domain code ----------------------------------------------------

/** Local wall-clock parts of `at` in the configured time zone. */
export function localParts(at: Date, tz = cfg().timezone): { date: string; hour: number; weekday: Weekday } {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), weekday: days.indexOf(p.weekday) as Weekday };
}

/** Staff to call for an escalation level, falling back to a role broadcast when none is configured. */
export function escalationRecipients(to: 'MEDICAL_DIRECTOR' | 'ONCALL_DOCTOR' | 'SUPERVISOR'): string[] {
  const s = cfg();
  if (to === 'MEDICAL_DIRECTOR' && s.medicalDirectorId) return [`staff:${s.medicalDirectorId}`];
  if (to === 'ONCALL_DOCTOR' && s.onCallDoctorIds.length) return s.onCallDoctorIds.map((id) => `staff:${id}`);
  return [`role:${to}`];
}

/** Settings as the owner's screen may see them: secrets replaced by a mask. */
export function publicView(s: Settings = cfg()): Record<string, unknown> {
  const out: Record<string, unknown> = { ...s };
  for (const k of SECRET_KEYS) out[k] = maskSecret(s[k] as string);
  return out;
}
