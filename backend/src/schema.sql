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
