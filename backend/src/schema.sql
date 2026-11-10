-- Home care platform schema (SQLite for development; portable to PostgreSQL).
-- Money columns are integer fils (1 JOD = 1000 fils). Timestamps are ISO-8601 text.

CREATE TABLE IF NOT EXISTS zones (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  surcharge INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('AGENT','COORDINATOR','DOCTOR','NURSE','LAB_TECH','RADIOGRAPHER','PHARMACIST','DRIVER','FINANCE','SUPERVISOR','ADMIN')),
  gender TEXT CHECK (gender IN ('M','F')),
  zone_id INTEGER REFERENCES zones(id),
  skills TEXT NOT NULL DEFAULT '[]',          -- JSON array
  licence_expiry TEXT,                        -- assignment blocked after this date (BR-36)
  phone TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS payers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('SELF','INSURER','CORPORATE','GOVERNMENT'))
);

CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY,
  national_id TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  dob TEXT,
  gender TEXT CHECK (gender IN ('M','F')),
  phone TEXT,
  address TEXT,
  lat REAL,
  lng REAL,
  zone_id INTEGER REFERENCES zones(id),
  emergency_contact TEXT,
  allergies TEXT NOT NULL DEFAULT '[]',
  chronic_conditions TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS guardians (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  name TEXT NOT NULL,
  relation TEXT NOT NULL,
  phone TEXT,
  can_consent INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS insurance_policies (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  payer_id INTEGER NOT NULL REFERENCES payers(id),
  member_no TEXT NOT NULL,
  copay_pct REAL NOT NULL DEFAULT 20,
  copay_cap INTEGER,
  covered_codes TEXT NOT NULL DEFAULT '[]',
  valid_to TEXT
);

CREATE TABLE IF NOT EXISTS services (
  code TEXT PRIMARY KEY,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  line TEXT NOT NULL CHECK (line IN ('LAB','IMG','DEV','DOC','NRS')),
  unit TEXT NOT NULL CHECK (unit IN ('VISIT','TEST','HOUR','DAY','ITEM')),
  department TEXT NOT NULL CHECK (department IN ('LAB','RADIOLOGY','PHARMACY','EQUIPMENT','CLINICAL')),
  requires_preapproval INTEGER NOT NULL DEFAULT 0,
  requires_prescription INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS price_items (
  id INTEGER PRIMARY KEY,
  payer_id INTEGER REFERENCES payers(id),     -- NULL = cash price list
  service_code TEXT NOT NULL REFERENCES services(code),
  unit_price INTEGER NOT NULL,
  UNIQUE (payer_id, service_code)
);

CREATE TABLE IF NOT EXISTS service_requests (
  id INTEGER PRIMARY KEY,
  request_no TEXT NOT NULL UNIQUE,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  channel TEXT NOT NULL CHECK (channel IN ('APP','CALL_CENTER')),
  created_by INTEGER REFERENCES staff(id),
  status TEXT NOT NULL,
  route TEXT CHECK (route IN ('DIRECT','ASSESSMENT','NURSE')),
  urgency TEXT NOT NULL DEFAULT 'ROUTINE' CHECK (urgency IN ('ROUTINE','SAME_DAY','URGENT')),
  preferred_at TEXT,
  clinical_notes TEXT,
  prescription_ref TEXT,
  policy_id INTEGER REFERENCES insurance_policies(id),
  coordinator_id INTEGER REFERENCES staff(id),
  cancel_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS request_items (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES service_requests(id),
  service_code TEXT NOT NULL REFERENCES services(code),
  qty REAL NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS request_history (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES service_requests(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_id INTEGER,
  note TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES service_requests(id),
  version INTEGER NOT NULL,
  lines TEXT NOT NULL,                        -- JSON QuoteLine[]
  discount_pct REAL NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  payer_total INTEGER NOT NULL,
  patient_total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'SENT' CHECK (status IN ('SENT','ACCEPTED','SUPERSEDED','REJECTED')),
  accepted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (request_id, version)
);

CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY,
  request_id INTEGER REFERENCES service_requests(id),
  order_id INTEGER REFERENCES orders(id),
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  kind TEXT NOT NULL CHECK (kind IN ('ASSESSMENT','NURSE','LAB','IMAGING','DEVICE','DOCTOR')),
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED','DISPATCHED','CHECKED_IN','COMPLETED','NO_SHOW','CANCELLED')),
  otp TEXT,
  check_in_at TEXT,
  check_in_method TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY,
  episode_no TEXT NOT NULL UNIQUE,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  request_id INTEGER REFERENCES service_requests(id),
  doctor_id INTEGER REFERENCES staff(id),
  diagnosis TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ON_HOLD','DISCHARGED','REFERRED_OUT')),
  billing_cycle TEXT NOT NULL DEFAULT 'WEEKLY' CHECK (billing_cycle IN ('WEEKLY','MONTHLY')),
  shift_service_code TEXT REFERENCES services(code),
  policy_id INTEGER REFERENCES insurance_policies(id),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  discharged_at TEXT,
  discharge_summary TEXT
);

CREATE TABLE IF NOT EXISTS assessments (
  id INTEGER PRIMARY KEY,
  episode_id INTEGER NOT NULL REFERENCES episodes(id),
  by_staff_id INTEGER NOT NULL REFERENCES staff(id),
  history TEXT,
  fall_risk_score INTEGER,
  braden_score INTEGER,
  suitable INTEGER NOT NULL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS care_plans (
  id INTEGER PRIMARY KEY,
  episode_id INTEGER NOT NULL REFERENCES episodes(id),
  version INTEGER NOT NULL,
  shift_hours INTEGER NOT NULL CHECK (shift_hours IN (8,12,24)),
  hours_per_day INTEGER NOT NULL,
  duration_days INTEGER NOT NULL,
  goals TEXT,
  approved_by INTEGER REFERENCES staff(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  episode_id INTEGER REFERENCES episodes(id),
  request_id INTEGER REFERENCES service_requests(id),
  service_code TEXT NOT NULL REFERENCES services(code),
  department TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'ROUTINE' CHECK (priority IN ('ROUTINE','URGENT','STAT')),
  ordered_by INTEGER REFERENCES staff(id),
  status TEXT NOT NULL DEFAULT 'PLACED' CHECK (status IN ('PLACED','ACCEPTED','IN_PROGRESS','RESULTED','VALIDATED','ACKNOWLEDGED','CANCELLED')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  report TEXT NOT NULL,
  critical INTEGER NOT NULL DEFAULT 0,
  validated_by INTEGER REFERENCES staff(id),
  acknowledged_by INTEGER REFERENCES staff(id),
  released_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY,
  episode_id INTEGER NOT NULL REFERENCES episodes(id),
  nurse_id INTEGER NOT NULL REFERENCES staff(id),
  planned_start TEXT NOT NULL,
  planned_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','LATE','CHECKED_IN','COMPLETED','MISSED','CANCELLED')),
  check_in_at TEXT,
  check_out_at TEXT,
  billable_minutes INTEGER,
  replaced_shift_id INTEGER REFERENCES shifts(id),
  invoice_id INTEGER REFERENCES invoices(id)
);

CREATE TABLE IF NOT EXISTS shift_notes (
  id INTEGER PRIMARY KEY,
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  type TEXT NOT NULL DEFAULT 'PROGRESS' CHECK (type IN ('PROGRESS','HANDOVER','INCIDENT','MEDICATION')),
  text TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS vitals (
  id INTEGER PRIMARY KEY,
  episode_id INTEGER NOT NULL REFERENCES episodes(id),
  shift_id INTEGER REFERENCES shifts(id),
  data TEXT NOT NULL,                         -- JSON Vitals
  news2_total INTEGER NOT NULL,
  band TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS escalations (
  id INTEGER PRIMARY KEY,
  episode_id INTEGER NOT NULL REFERENCES episodes(id),
  trigger TEXT NOT NULL CHECK (trigger IN ('NEWS2','CRITICAL_RESULT','LATE_SHIFT','INCIDENT')),
  level TEXT NOT NULL,
  ref_id INTEGER,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKED','RESOLVED')),
  acked_by INTEGER REFERENCES staff(id),
  opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS rentals (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  request_id INTEGER REFERENCES service_requests(id),
  episode_id INTEGER REFERENCES episodes(id),
  service_code TEXT NOT NULL REFERENCES services(code),
  serial_no TEXT,
  start_date TEXT NOT NULL,
  expected_return TEXT NOT NULL,
  returned_at TEXT,
  daily_rate INTEGER NOT NULL,
  deposit INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RETURNED'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  invoice_no TEXT NOT NULL UNIQUE,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  episode_id INTEGER REFERENCES episodes(id),
  request_id INTEGER REFERENCES service_requests(id),
  kind TEXT NOT NULL CHECK (kind IN ('VISIT','PERIODIC','FINAL')),
  period_from TEXT,
  period_to TEXT,
  total INTEGER NOT NULL,
  payer_total INTEGER NOT NULL,
  patient_total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ISSUED','PARTIALLY_PAID','PAID','VOID')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (episode_id, period_from)
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  source_type TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  description TEXT NOT NULL,
  qty REAL NOT NULL,
  unit_price INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  payer_amount INTEGER NOT NULL,
  patient_amount INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  method TEXT NOT NULL CHECK (method IN ('CASH','CARD','LINK','TRANSFER','CLIQ')),
  amount INTEGER NOT NULL,
  reference TEXT,
  collected_by INTEGER REFERENCES staff(id),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  recipient TEXT NOT NULL,                    -- e.g. patient:12, staff:3, role:COORDINATOR
  channel TEXT NOT NULL CHECK (channel IN ('SMS','PUSH','CALL')),
  message TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  detail TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Patient app sign-in: one-time codes sent by SMS, then a bearer session token.
CREATE TABLE IF NOT EXISTS patient_otps (
  id INTEGER PRIMARY KEY,
  national_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  full_name TEXT,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS patient_sessions (
  token_hash TEXT PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  expires_at TEXT NOT NULL
);

-- Patient satisfaction after a finished visit (one rating per request). Low scores open a supervisor follow-up.
CREATE TABLE IF NOT EXISTS visit_feedback (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL UNIQUE REFERENCES service_requests(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  staff_id INTEGER REFERENCES staff(id),
  score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  tags TEXT NOT NULL DEFAULT '[]',            -- JSON array of FEEDBACK_TAGS
  comment TEXT,
  follow_up TEXT NOT NULL DEFAULT 'NONE' CHECK (follow_up IN ('NONE','OPEN','CLOSED')),
  follow_up_note TEXT,
  closed_by INTEGER REFERENCES staff(id),
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- BR-80 / BR-03: consent signed by the patient or a guardian before the first visit.
CREATE TABLE IF NOT EXISTS consents (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  type TEXT NOT NULL,                         -- domain/consent.ts CONSENT_TYPES
  signed_by TEXT NOT NULL,                    -- name of the person who signed
  relation TEXT NOT NULL DEFAULT 'SELF',      -- SELF or the guardian's relation
  method TEXT NOT NULL,                       -- APP | OTP | ESIGN | PAPER
  recorded_by INTEGER REFERENCES staff(id),   -- NULL when signed in the patient app
  signed_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);

-- BR-24 / BR-15: money collected before the visit; applied to the visit invoice on completion.
CREATE TABLE IF NOT EXISTS prepayments (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES service_requests(id),
  method TEXT NOT NULL CHECK (method IN ('CASH','CARD','LINK','TRANSFER','CLIQ')),
  amount INTEGER NOT NULL,
  reference TEXT,
  collected_by INTEGER REFERENCES staff(id),
  applied_invoice_id INTEGER REFERENCES invoices(id),
  at TEXT NOT NULL
);

-- Owner-configurable settings (src/settings.ts holds the defaults and validation).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,                        -- JSON
  updated_by INTEGER REFERENCES staff(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings_history (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT NOT NULL,
  changed_by INTEGER REFERENCES staff(id),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- E-invoices sent to the tax authority (JoFotara). One row per invoice; uuid and ICV are fixed at first attempt.
CREATE TABLE IF NOT EXISTS einvoices (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL UNIQUE REFERENCES invoices(id),
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACCEPTED','REJECTED','FAILED')),
  uuid TEXT NOT NULL,
  icv INTEGER NOT NULL,
  type_code TEXT NOT NULL,
  xml TEXT,
  qr TEXT,
  einv_number TEXT,
  message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  submitted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Outbox of business events for the ERP: delivered by webhook (if configured) and readable by polling.
CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED','SKIPPED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- API keys for ERP / external systems. Only a hash of the key is stored.
CREATE TABLE IF NOT EXISTS api_clients (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES staff(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at TEXT
);

-- Idempotency for ERP writes: the same Idempotency-Key returns the first response.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  client_id INTEGER NOT NULL REFERENCES api_clients(id),
  key TEXT NOT NULL,
  response TEXT NOT NULL,
  status INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (client_id, key)
);
