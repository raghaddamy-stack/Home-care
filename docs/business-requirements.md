# Home Care Platform — Business Requirements Document (BRD)

> نظام الرعاية المنزلية المتكامل — وثيقة المتطلبات التشغيلية

| Item | Value |
|---|---|
| Version | 0.2 (draft for client review). 0.2 clarifies BR-12, BR-23, BR-24, BR-33, BR-80 and the §5.5 timers as built; see `docs/ba-gap-analysis.md` |
| Date | 2026-11-10 |
| Market | Jordan first, GCC-ready (KSA, UAE) |
| Scope | Intake, coordination, scheduling and dispatch, outpatient home services (lab, imaging, devices), home-care episodes (nursing and doctor), escalation, billing and insurance, discharge |
| Source | Client workflow PDF (summarised). Items marked **[Proposed]** are BA recommendations that the client has not stated and must confirm. |

---

## 1. Scope and Service Lines

| Code | Service line | Arabic | Pathway |
|---|---|---|---|
| LAB | Home lab sampling | سحب عينات منزلي | Direct service |
| IMG | Portable imaging (X-ray, ultrasound) | أشعة متنقلة | Direct service |
| DEV | Medical equipment rental or sale (bed, oxygen concentrator, wheelchair) | تأجير أجهزة طبية | Direct service |
| DOC | Doctor home visit (one-off or assessment) | زيارة طبيب | Direct service or care path |
| NRS | Nursing: single visit or shift-based (8/12/24h) | تمريض منزلي | Care path (Episode of Care) |

**Two pathways:**
- **Direct service (خدمة مباشرة):** Request → Quote → Schedule → Execute → Result/Handover → Pay → Close.
- **Care path (مسار رعاية):** Request → Quote → Assessment → Episode of Care → Care Plan → Shifts/Orders → Escalation (if needed) → Billing cycles → Discharge.

**Channels:** patient mobile app, call-centre agent (back-office web). **[Proposed]** WhatsApp Business and a web booking form, both feeding the same request form.

---

## 2. Actors, Roles and Permissions

### 2.1 Roles

| # | Role | Arabic | Main responsibilities |
|---|---|---|---|
| R1 | Patient | المريض | Books services, accepts quotes, pays, views results, rates service |
| R2 | Family member / Guardian | ولي الأمر / المرافق | Acts for a minor or incapacitated patient; receives alerts; signs consent |
| R3 | Call-centre agent | موظف مركز الاتصال | Registers patients, creates requests, follows up on quotes and payments |
| R4 | Coordinator | المنسق | Reviews requests, prices them, gets pre-approval, routes, schedules, handles no-shows |
| R5 | Doctor | الطبيب | Assessment, admission decision, care plan, orders, reviews results |
| R6 | Nurse | الممرض/ة | Visits and shifts, vitals, MAR, procedures, sample collection, notes |
| R7 | On-call doctor | الطبيب المناوب | Responds to NEWS2 escalations within the SLA |
| R8 | Medical director | المدير الطبي | Escalation backstop, clinical governance, referral-out approval |
| R9 | Lab tech / Pathologist | فني مختبر / أخصائي علم الأمراض | Receives samples, runs tests, validates and releases results |
| R10 | Radiographer / Radiologist | فني أشعة / أخصائي أشعة | Takes images at home, uploads to PACS, writes the report |
| R11 | Pharmacist | الصيدلي | Verifies and dispenses medication orders, controlled-drug register |
| R12 | Logistics / Equipment driver | السائق / وحدة اللوجستيات | Transports staff, samples (cold chain) and devices; installs and picks up devices |
| R13 | Finance officer | المالية | Invoices, claims, collections, reconciliation |
| R14 | Nursing supervisor | مشرف التمريض | Roster approval, weekly audit, backup nurse, quality |
| R15 | System admin | مدير النظام | Users, roles, catalogues, price lists, zones, configuration |
| R16 | **[Proposed]** Pricing approver / Ops manager | مدير العمليات | Approves discounts above the coordinator's limit and manual price overrides |
| R17 | **[Proposed]** Insurance desk (may be a Coordinator sub-role) | موظف التأمين | Pre-approvals, claim submission, rejection handling |

### 2.2 Permissions Matrix

Legend: **C** create · **R** read · **U** update · **A** approve/validate · **O** own records only · **Z** own zone or assigned patients only · — none

| Function / Data | Pat | Guard | Agent | Coord | Doc | Nurse | OnCall | MedDir | Lab | Rad | Pharm | Driver | Fin | Sup | Admin |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Patient demographics | RU(O) | RU(O) | CRU | CRU | R | R(Z) | R | R | R* | R* | R* | R* | R | R | R |
| Service request | C R(O) | C R(O) | CRU | CRUA | R | R(Z) | R | R | R | R | R | R* | R | R | R |
| Price / quote | R(O) A† | R(O) A† | R | CRU | — | — | — | — | — | — | — | — | RU | R | CRU |
| Discount above limit | — | — | — | C | — | — | — | — | — | — | — | — | R | — | A (R16) |
| Insurance pre-approval | R(O) | R(O) | R | CRU | R | — | — | — | — | — | — | — | R | — | — |
| Scheduling / assignment | R(O) | R(O) | R | CRU | R | R(O) | R | R | R | R | — | R(O) | — | RU | — |
| Clinical record (EMR) | R‡ | R‡ | — | R(limited) | CRUA | CRU(Z) | CRU(Z) | R A | — | — | R | — | — | R | — |
| Assessment / admission decision | — | — | — | R | CRUA | CRU | — | A | — | — | — | — | — | R | — |
| Care plan | R‡ | R‡ | — | R | CRUA | R(Z) | RU | R A | — | — | R | — | R(hours) | R | — |
| Orders (Lab/Rad/Pharm/Equip) | — | — | — | R | CRUA | C§ R | CRU | R | RU | RU | RUA | R(equip) | R | R | — |
| Results | R‡ | R‡ | — | R(status) | RA | R(Z) | R | R | CRUA | CRUA | — | — | — | — | — |
| Vitals / NEWS2 / MAR | R‡ | R‡ | — | R(alerts) | R | CRU(Z) | R | R | — | — | R(MAR) | — | — | R | — |
| Controlled drug register | — | — | — | — | A | C(witnessed) | A | R | — | — | CRUA | — | — | R | — |
| Escalation / incident | R‡ | R(notified) | — | R | RU | C | RU A | RU A | — | — | — | — | — | R | — |
| Shift roster | — | — | — | CRU | R | R(O) | R | R | — | — | — | — | R | CRUA | — |
| Attendance (check-in/out) | — | — | — | R | — | C(O) | — | — | — | — | — | C(O) | R | RUA | — |
| Device inventory and rental | R(O) | R(O) | R | CRU | R | R | — | — | — | — | — | RU | R | — | CRU |
| Invoice / claim / payment | R(O) pay | R(O) pay | R | R | — | — | — | — | — | — | — | collect cash | CRUA | R | R |
| Catalogue, price lists, zones, users | — | — | — | R | — | — | — | — | — | — | — | — | R | — | CRU |
| Audit log | — | — | — | — | — | — | — | R | — | — | — | — | — | R | R |

\* Only the minimum needed for the task (name, address, sample/device ID). No clinical history.
† Patient/guardian "accepts" or "cancels" the quote.
‡ Only released results and patient-facing summaries; no internal notes. Guardian access needs a recorded consent or legal authority.
§ Nurse may enter verbal/telephone orders that the doctor must co-sign within 24 h **[Proposed]**.

**Cross-cutting access rules**
- Role-based plus record-based access: nurses and drivers see only patients assigned to them today ±24 h.
- "Break-the-glass" emergency access to the full EMR, with a mandatory reason and supervisor review.
- Every read of clinical data is written to the audit log.

---

## 3. Core Entities (Data Model — Key Fields)

> PK = primary key, FK = foreign key. Money is stored as currency plus minor units (JOD has 3 decimals, fils). Every entity has `created_at/by` and `updated_at/by`.

| Entity | Key fields | Notes |
|---|---|---|
| **Patient** المريض | id, national_id (JO 10 digits) / passport / iqama / Emirates ID, id_type, nationality, full_name_ar, full_name_en, dob, gender, phones[], preferred_language, blood_group, allergies[], chronic_conditions[], primary_payer_id, completeness_status, consent_flags, deceased_flag | Unique on (id_type, id_number). Completeness check blocks quoting until the mandatory fields are present. |
| **Guardian** ولي الأمر | id, patient_id, name, relation, national_id, phone, is_legal_guardian, can_consent, can_pay, can_view_results, proof_document | Many per patient. One is the "primary contact". |
| **Address / Zone** العنوان / المنطقة | address_id, patient_id, label, governorate, city, district, street, building, floor, landmark, gps_lat/lng, access_notes (stairs, elevator, pets), zone_id. Zone: id, name, polygon, service_lines[], travel_buffer_min, surcharge | Zones drive routing, staff matching and surcharges. |
| **ServiceCatalog** دليل الخدمات | service_id, code (internal and CPT/LOINC/SNOMED mapping), name_ar/en, service_line, unit (visit, hour, shift, day, test, item), duration_min, required_skills[], requires_preapproval, requires_doctor_order, prep_instructions, sample_type, tat_hours | |
| **PriceList / PriceItem** قائمة الأسعار | price_list_id, name, type (cash, corporate, insurer), payer_id, currency, valid_from/to, status; item: service_id, unit_price, min_qty, zone_surcharge, after_hours_multiplier, tax_code | Versioned. Only one active list per payer per date. |
| **Payer / Contract** الجهة الدافعة / العقد | payer_id, type (self, insurer, TPA, corporate, government), name, contract_no, price_list_id, billing_cycle (per-visit, weekly, monthly), payment_terms_days, credit_limit, claim_format, contacts | |
| **InsurancePolicy** وثيقة التأمين | policy_id, patient_id, payer_id, member_no, class/network, valid_from/to, copay_pct, copay_cap, deductible, covered_service_lines[], card_image | Checked for eligibility at quote time. |
| **ServiceRequest** طلب الخدمة | request_no, patient_id, requester (patient, guardian, agent), channel, service_lines[], items[], address_id, preferred_date/time window, urgency (routine, same-day, urgent), clinical_notes, referral_doc, attachments, pathway (direct, care), status, cancel_reason, assigned_coordinator | |
| **Quote** عرض السعر | quote_no, request_id, version, lines[] (service, qty, unit_price, discount, payer_share, patient_share), total, deposit_required, valid_until, sent_via (SMS, app, WhatsApp), accepted_at, accepted_by, acceptance_evidence (OTP or click), status | A new version is created on every change. |
| **PreApproval** الموافقة المسبقة | id, request_id/episode_id, payer_id, policy_id, services[], requested_qty, approved_qty, approval_no, valid_from/to, status (draft, submitted, approved, partial, rejected, expired), rejection_reason, documents | Quantities used are tracked against approved_qty. |
| **Assignment / Visit** الزيارة | visit_id, request_id/episode_id, service_line, staff_id(s), vehicle_id, scheduled_start/end, eta, check_in (time, gps, otp), check_out, status, no_show_party (patient, staff), outcome, signature | One request can have many visits. |
| **Staff** الكادر | staff_id, role, skills[], licence_no, licence_authority, licence_expiry, BLS/ACLS expiry, gender, languages, home_zone, max_hours_week, employment_type (staff, freelance), rating | **[Proposed]** credential tracking. |
| **EpisodeOfCare** حلقة الرعاية | episode_no, patient_id, admitting_doctor_id, primary_nurse_id, diagnosis (ICD-10), start_date, expected_end, status, payer_id, preapproval_id, billing_cycle, discharge_type, discharge_summary_id | |
| **Assessment** التقييم | id, episode_id, type (initial, reassessment, discharge), history, vitals, Morse fall score, Braden score, pain score, functional status (ADL/Barthel), cognitive status, home safety checklist, infection risk, suitability (yes, no), refer_out_reason, signed_by | |
| **CarePlan** خطة الرعاية | id, episode_id, version, goals[], interventions[], shift_pattern (8/12/24h), hours_per_day, days_per_week, duration_weeks, skill_level (RN, PN, caregiver), review_date, approved_by, status | Changes need doctor approval and may need a new pre-approval. |
| **Order** الطلب الطبي | order_no, episode_id/request_id, type (lab, rad, pharm, equip, consult), items[], priority (routine, urgent, STAT), ordered_by, verbal_order_flag, cosigned_at, target_department, status | |
| **Result** النتيجة | result_id, order_id, type, values[] (analyte, value, unit, ref_range, flag), PACS study UID, report_text, critical_flag, validated_by, validated_at, released_to_patient_at, acknowledged_by_doctor_at | |
| **Specimen** العينة | barcode, order_id, sample_type, collected_by, collected_at, temp_log[], received_at_lab, condition (ok, haemolysed, rejected) | Cold-chain tracking. |
| **Shift** المناوبة | shift_id, episode_id, roster_id, type (8/12/24h), planned_start/end, nurse_id, backup_nurse_id, status, handover_from_shift_id | |
| **Attendance** الحضور | id, shift_id/visit_id, staff_id, check_in_time, check_in_gps, check_in_method (GPS, OTP, QR), check_out_time, billable_minutes, variance_reason, approved_by | Source of truth for hours billing and payroll. |
| **VitalSigns / NEWS2** العلامات الحيوية | id, episode_id, shift_id, taken_at, RR, SpO2, spo2_scale (1 or 2), on_O2, temp, SBP, HR, consciousness (ACVPU), news2_total, any_single_3, risk_band, device_source (manual, BLE) | |
| **MAR** سجل إعطاء الأدوية | id, episode_id, medication_order_id, drug, dose, route, scheduled_time, given_time, given_by, status (given, held, refused, missed), reason, witness_id (controlled drugs), batch_no | |
| **ShiftNote** ملاحظات المناوبة | id, shift_id, note_type (progress, handover SBAR, incident), text, attachments, signed_by | |
| **Escalation / Incident** التصعيد / الحادثة | id, episode_id, trigger (NEWS2, critical result, fall, med error, no-show, other), level, opened_at, notified[] with timestamps, responded_by/at, actions, outcome (resolved, ambulance, transfer), closed_at, RCA_required | |
| **Device / Inventory** المعدات | asset_id, serial_no, model, category, status, location, last_maintenance, next_maintenance, cleaning_status, purchase_cost | |
| **Rental** عقد التأجير | rental_no, patient_id, asset_id, start_date, expected_return_date, actual_return_date, daily/monthly_rate, deposit_amount, deposit_status, handover_form (signed), training_done, return_condition, damage_charge, status | |
| **Invoice / InvoiceLine** الفاتورة | invoice_no, patient_id, payer_id, episode_id/request_id, period_from/to, type (patient, payer claim, final), lines[] (source_type: visit, shift, rental, supply, order; source_id; qty; unit_price; payer_amount; patient_amount; tax), totals, status, due_date | Every line must link to a source record. |
| **Payment** الدفعة | payment_id, invoice_id, method (cash, card on device, payment link, bank transfer, CliQ), amount, reference, collected_by, received_at, reconciled | |
| **Claim** المطالبة | claim_no, payer_id, invoice_ids[], preapproval_no, submitted_at, amount_claimed, amount_approved, rejection_codes[], resubmission_count, status | |
| **Consent** الموافقة | id, patient_id, type (treatment, invasive procedure, imaging, data sharing, photo, guardian access, telemonitoring), signed_by, relation, method (app, OTP, e-sign, paper scan), recorded_by, signed_at, expires_at, revoked_at | Never deleted; revoking sets `revoked_at` |
| **Prepayment** الدفعة المسبقة | id, request_id, method, amount, reference, collected_by, at, applied_invoice_id | Money taken before a visit (BR-15, BR-24); applied to the visit invoice on completion |
| **Notification** الإشعار | id, recipient, channel (SMS, push, WhatsApp, email, call), template_id, language, payload, sent_at, delivered_at, read_at, status | |
| **AuditLog** سجل التدقيق | id, actor_id, role, action, entity, entity_id, before/after (hashed for clinical), ip/device, timestamp, reason (for break-the-glass) | Append-only. |

---

## 4. Status Lifecycles (State Machines)

### 4.1 ServiceRequest

```
Draft → Submitted → UnderReview ─┬→ PendingInfo → UnderReview
                                 ├→ PendingPreApproval → Quoted
                                 └→ Quoted ─┬→ Accepted → Scheduled → InProgress → Completed → Closed
                                            ├→ Expired (quote validity passed) ─┬→ Quoted (new version)
                                            │                                   └→ Cancelled
                                            └→ Cancelled (reason required)
Any state before InProgress, including Dispatched (team on the way) → Cancelled (reason; fee rules in §5.3)
Accepted (care path) → ConvertedToEpisode
Scheduled → NoShow → Rescheduled → Scheduled
```
Rules: `Closed` needs all results released, payment settled or invoiced, and devices handed over.
An `Expired` request cannot be accepted; the coordinator re-prices it (new quote version, new validity) or cancels it. Rescheduling replaces the booked visit: the earlier visit is cancelled, not kept.

### 4.2 Order

```
Draft → Placed → (Verified: pharmacy only) → Accepted by department → Scheduled → InProgress
      → ResultPending → Resulted → Validated → Released → Acknowledged (doctor)
Branches: Placed/Accepted → Rejected (reason) ; any open state → Cancelled ; Resulted → Amended (keeps version)
```
Critical results skip the queue: `Validated` triggers a critical alert, and the doctor must acknowledge (see §5.5).

### 4.3 Shift

```
Planned → Published → Confirmed (nurse accepts) → CheckedIn → InProgress → HandedOver → CheckedOut → Verified (supervisor) → Billed
Branches: Published → Declined → Reassigned
          Confirmed → LateAlert (grace exceeded) → BackupDispatched → CheckedIn
          Confirmed → Missed (no cover) ; any pre-CheckedIn → Cancelled (by patient or company)
```

### 4.4 Episode of Care

```
Referral → AssessmentScheduled → Assessed ─┬→ NotSuitable → ReferredOut (closed)
                                           └→ Admitted (Active) ⇄ OnHold (hospital transfer, travel, payer pending)
Active → PendingDischarge → Discharged → Closed (final invoice paid or written off)
Active → Deceased → Closed
```
`OnHold` stops roster generation and billing. It is reviewed every 72 h **[Proposed]**.

### 4.5 Invoice

```
Draft (auto-generated) → UnderReview (finance vs attendance) ─┬→ Discrepancy → Corrected → UnderReview
                                                              └→ Approved → Issued → PartiallyPaid → Paid → Closed
Issued → Overdue → InCollection → Paid | WrittenOff (approval required)
Issued → Voided (credit note; never delete)
Payer portion: Claimed → Submitted → Approved | PartiallyApproved | Rejected → Resubmitted
```

### 4.6 Rental

```
Reserved → Dispatched → Installed (training done + handover form signed) → Active
Active → Extended → Active ; Active → ReturnDue (reminder) → Overdue
Active/Overdue → PickupScheduled → Returned → Inspected ─┬→ Closed (deposit refunded)
                                                         └→ DamageCharged → Closed
Device after return: Cleaning → Maintenance (if due) → Available
```

---

## 5. Business Rules (Defaults are configurable per contract or zone)

> All numeric limits and policy choices in this section are now owner settings (screen **إعدادات المالك**, `backend/src/settings.ts`). The values below are the shipped defaults; the owner's choices override them.

### 5.1 Intake and Patient Data
| ID | Rule | Default |
|---|---|---|
| BR-01 | Look up the patient by national ID first. If the ID is not found, also search by phone plus DOB to avoid duplicates. | Duplicate merge only by Admin |
| BR-02 | Mandatory fields before quoting: name, ID, DOB, gender, phone, address with GPS pin, payer, emergency contact. Care path also needs diagnosis or referral. | Block quote |
| BR-03 | A patient under 18 or lacking capacity needs a guardian with `can_consent=true`. | Hard stop |
| BR-04 | Service area check: GPS outside all zones means outside the service area. Coordinator may override with a surcharge. | Override is logged |

### 5.2 Pricing, Quote and Pre-approval
| ID | Rule | Default |
|---|---|---|
| BR-10 | Price source order: active contract price list, then insurer list, then cash list. Manual price changes need a reason. | — |
| BR-11 | Discount authority: Coordinator up to 10%. Ops manager up to 25%. Above that, the General Manager. | Approval workflow |
| BR-12 | Quote valid for the period on the right, counted from when it is sent; the patient sees the end time. An acceptance after that time is refused and the request becomes `Expired`; a scheduled sweep also expires open quotes. The coordinator sends a new version with current prices. | 48 h (same-day and urgent requests: 4 h) |
| BR-13 | Quote acceptance must be recorded through an app click or an SMS OTP. A verbal acceptance taken by an agent must be recorded with the call ID. | — |
| BR-14 | Pre-approval needed when the policy says so for that service line. If not approved, offer a cash quote or cancel. | Pre-approval SLA: follow up every 4 h |
| BR-15 | Deposit / prepayment: cash patients pay 100% for direct services, 1 week in advance for shift-based nursing, and a rental deposit (BR-60). | — |
| BR-16 | After-hours (20:00–07:00), Fridays and public holidays | ×1.25 multiplier |

### 5.3 Scheduling, No-show and Cancellation
| ID | Rule | Default |
|---|---|---|
| BR-20 | Matching order: required skill/licence, then gender preference, then zone, then continuity (same nurse), then workload, then travel time. | — |
| BR-21 | If no resource fits the slot, propose the 3 nearest alternative slots. | — |
| BR-22 | Notify the patient on assignment (staff name, photo, ETA), 24 h before, and on "on the way". | SMS + push |
| BR-23 | Patient cancellation: free if more than 24 h before. 50% of the visit fee from 24 h to 2 h before. 100% if less than 2 h before or once the team is on the way (dispatched). No fee when nothing is booked yet or when the company cancels (no staff, outside area, clinical reason). The agent sees the fee before confirming; the fee goes on a draft invoice for Finance. "Visit fee" = the patient's share of the accepted quote **[Client to confirm for insured patients]**. | Configurable per contract |
| BR-24 | Patient no-show (staff arrives, waits 15 min, calls twice, no answer): one no-show fee equal to 50% of the visit fee (minimum 10 JOD). Reschedule offered. From the 2nd no-show in 30 days, the next booking needs prepayment of the visit fee before staff can be assigned; the prepayment is applied to the visit invoice when the visit is completed. **[Client to confirm]** whether the 10 JOD minimum is capped at the visit price. | — |
| BR-25 | Staff late or no-show: no fee to the patient. After 2 missed visits the patient gets a service credit. Recorded against the staff KPI. | — |
| BR-26 | Check-in valid if GPS is within 150 m of the address, or the patient's OTP is entered. Manual check-in needs supervisor approval. | — |

### 5.4 Shift and Attendance
| ID | Rule | Default |
|---|---|---|
| BR-30 | Check-in grace period. After it: alert the coordinator, call the nurse, and dispatch a backup if no ETA within 15 min. | 15 min |
| BR-31 | A shift cannot end without a handover to the next nurse or a patient/guardian sign-off. For 24 h coverage, no gap is allowed. | — |
| BR-32 | Billable hours = actual attendance, rounded to 15 min. Up to 10 min late is tolerated if the shift is complete. Overtime is billable only if pre-approved. | — |
| BR-33 | Nurse hour limits: at most 60 h in any 7 days, at most 2 back-to-back 24 h shifts, at least 11 h rest between shifts **[Proposed]** (check with Jordan labour law: 48 h normal week, the rest is consented overtime). Checked when the roster is built and when a backup nurse is assigned. | Hard warning: blocked unless a nursing supervisor overrides with a reason (audited) |
| BR-34 | Roster published at least 7 days ahead. Reminders 24 h and 2 h before the shift. | — |
| BR-35 | Weekly supervisor audit: at least 1 unannounced or remote audit per active episode per week, plus a 10% documentation sample. | — |
| BR-36 | No assignment if the licence, BLS or required certificate has expired. Alerts at 60/30/7 days before expiry. | Hard stop |

### 5.5 Clinical Escalation (NEWS2 and Critical Results)
| NEWS2 | Band | Required response | Timers |
|---|---|---|---|
| 0 | Low | Routine, vitals at least every 12 h (or per care plan) | — |
| 1–4 | Low | Inform the nurse-in-charge. Vitals every 4–6 h. | — |
| **3 in any single parameter** **[Proposed]** | Low-medium | Urgent doctor review (the client's workflow misses this NEWS2 rule) | Doctor reply ≤ 30 min |
| 5–6 | Medium | Recheck in 15 min. If still ≥5, page the on-call doctor. | On-call reply ≤ 15 min, else auto-escalate to the medical director (reply ≤ 15 min) |
| ≥7 | High | Call an ambulance (Jordan 911 / KSA 997 / UAE 998), notify the doctor and family, start BLS, transfer to hospital, put the episode **OnHold** | Auto-notification at the moment of the reading |

- SpO2 **Scale 2** (target 88–92%) only for documented hypercapnic COPD patients. A doctor must set it.
- NEWS2 is **not valid** for under-16s or pregnancy. Use PEWS or MEOWS, or doctor-defined thresholds **[Proposed]**.
- Patient has a DNR / limits-of-care order: the escalation path follows the advance directive.
- Critical lab/imaging result (home-care and outpatient): phone the ordering or on-call doctor within 30 min of validation and record a read-back. If not acknowledged in 30 min, escalate to the medical director. A **critical** result is released to the patient app only after a doctor has acknowledged it. A non-critical result is released after doctor review or after 24 h, whichever comes first.
- Timers run as a scheduled check every minute: each escalation stores its response deadline, and an unanswered escalation past its deadline goes to the next level once (medical director for clinical triggers, nursing supervisor for a late shift). For NEWS2 5–6 the nurse is also reminded to recheck if no new reading arrives within 15 min. NEWS2 ≥7 notifies the medical director at the moment of the reading.
- Every escalation is documented in the EMR with timestamps. Level ≥7 or a missed SLA needs a medical director review within 72 h.

### 5.6 Lab, Imaging, Devices
| ID | Rule | Default |
|---|---|---|
| BR-50 | Sample barcode printed or scanned at the bedside. Two identifiers (name + DOB/ID) are checked before collection. | — |
| BR-51 | Cold chain: 2–8 °C, delivered to the lab within 2 h (or per test). A temperature deviation gives a rejected sample and a free recollection. | — |
| BR-52 | Lab TAT: routine 24 h, urgent 4 h. Imaging report: routine 24 h, urgent 2 h. | — |
| BR-53 | Portable X-ray: radiation-safety checklist (pregnancy check, bystanders more than 2 m away, lead apron). Licensed radiographer only. | — |
| BR-60 | Rental deposit = the larger of 1 month's rent or 20% of device value. It is refundable within 7 working days after inspection. Insurer-covered rentals: deposit waived if the pre-approval covers it. | Configurable per device category |
| BR-61 | Minimum rental 7 days. Overdue past the return date: charged at the daily rate, reminders at D-3, D0 and D+3. Pickup automatically scheduled at D+7. | — |
| BR-62 | The handover form (condition, accessories, training done, emergency contact) must be signed before rental status becomes Active. | — |

### 5.7 Billing and Collections
| ID | Rule | Default |
|---|---|---|
| BR-70 | Billing cycle set per patient or contract: per-visit (direct services), weekly (cash nursing), monthly (insurer or corporate). | Cash nursing: weekly in advance |
| BR-71 | Invoice lines are generated only from verified sources: verified shifts, completed visits, consumed supplies (MAR or usage log), active rental days. | — |
| BR-72 | Finance review: invoiced hours must equal attendance hours. A variance above 0% blocks issue until the cause is explained. | — |
| BR-73 | Insurance split: payer share by contract. Patient share is co-pay % up to the cap, plus anything not covered. Pre-approved quantity is exceeded: the excess goes to the patient only with signed acknowledgement. | — |
| BR-74 | Collection reminders at due date +3 / +7 / +14 days. At +30, services pause (except clinically unsafe stops, which need medical director approval). | — |
| BR-75 | Write-off above 100 JOD needs Finance Manager approval. Invoices are never deleted; use credit notes. | — |
| BR-76 | Tax: Jordan general sales tax (GST) applies per item tax code (most medical services are exempt, equipment may not be). KSA/UAE VAT and e-invoicing (ZATCA/FTA) when the company expands. | Finance to confirm |
| BR-77 | Cash collected in the field is handed in within 24 h and reconciled daily per collector. | — |

### 5.8 Consent, Privacy and Discharge
| ID | Rule | Default |
|---|---|---|
| BR-80 | General consent to home treatment is signed before the first visit. Specific consent needed for invasive procedures, imaging, photography and sharing data with family. Checked at visit and shift check-in (imaging visits also need imaging consent). The patient can sign in the app when accepting the price; otherwise staff capture the signature on their device at the door. A patient under 18 needs a guardian's signature (BR-03). A revoked or expired consent blocks the next visit. | Hard stop |
| BR-81 | Guardian portal access only after consent from the patient or proof of legal authority. | — |
| BR-82 | Discharge needs: discharge summary signed by the doctor, medication reconciliation, device pickup scheduled, final invoice, satisfaction survey sent within 24 h. | — |
| BR-83 | Data retention: clinical records kept at least 10 years (minors: until age 28) **[Proposed — confirm with MoH]**. | — |

---

## 6. Gaps and Risks in the Client Workflow

| # | Gap / Risk | Impact | Recommendation |
|---|---|---|---|
| G1 | **No consent management** (treatment, procedures, data sharing, guardian access) | Legal exposure, MoH audit failure | Consent entity, e-sign/OTP, hard stops (BR-80/81) |
| G2 | **No home safety and environment assessment** (stairs, electricity for devices, oxygen fire risk, pets, violence risk, lone-worker safety) | Staff injury, device failure | Safety checklist in the first assessment; panic button and lone-worker check-ins for staff |
| G3 | **No infection prevention and control** (isolation status, PPE, sharps and medical waste disposal, device disinfection between patients) | Cross-infection, regulatory breach | IPC flags on the patient, PPE checklist, waste pickup, device cleaning log |
| G4 | **No medication reconciliation** at admission, transfer and discharge; MAR has no source order | Medication errors | Reconcile against the home medication list; pharmacist verification; allergy checks |
| G5 | **Controlled drugs** (opioids for palliative care) not covered | JFDA licence risk | Witnessed administration, register, counts, return/destruction log |
| G6 | **Data privacy** (Jordan PDPL No. 24/2023, KSA PDPL, UAE PDPL); live GPS tracking of staff and patients; data hosting location | Fines, loss of trust | Privacy notice, purpose limitation, in-country hosting option, retention, data subject requests |
| G7 | **Staff credentials** — licence, BLS and vaccination expiry not checked before assignment | Unlicensed practice | Credential registry plus hard stop (BR-36) |
| G8 | **Price and discount approval authority** not defined | Revenue leakage | Approval limits (BR-11) |
| G9 | **No SLAs** for intake response, quote, pre-approval, dispatch, TAT, doctor response outside escalation | Unmeasurable service | SLA table (§7) |
| G10 | **NEWS2 incomplete**: single-parameter score of 3, Scale 2, children/pregnancy, DNR | Missed deterioration | §5.5 |
| G11 | **Critical result workflow** has no acknowledgement or read-back and no timer | Patient harm | Acknowledgement loop with escalation |
| G12 | **Family / guardian portal** missing (alerts, visit log, invoices) | Higher call-centre load, complaints | Guardian role with scoped access |
| G13 | **No complaints, incident reporting or adverse event process** (falls, med errors, pressure injuries) separate from NEWS2 | No learning loop | Incident module with RCA and medical director sign-off |
| G14 | **Insurance rejections and resubmission**, pre-approval expiry or quantity overrun not handled | Bad debt | Pre-approval quantity tracking and rejection workflow |
| G15 | **Staff safety and gender preference** (female patient, female nurse culturally expected) | Complaints, safety | Gender matching rule; chaperone option |
| G16 | **Advance directives / DNR, end-of-life and death at home** (death certificate, police notification) | Legal, clinical | Death-at-home protocol |
| G17 | **Nurse care plan** (nursing diagnosis, wound care photos, pressure-injury staging) only implied | Weak documentation | Structured templates |
| G18 | **Payroll and freelancer payment** from attendance not covered | Disputes | Export attendance to HR/payroll |
| G19 | **Offline mode** for the nurse app (weak coverage) | Lost data | Offline capture with sync and conflict rules |
| G20 | **Integrations** not specified: LIS, PACS/RIS, payment gateway, SMS, insurer/TPA, national e-health (Hakeem in Jordan, NPHIES in KSA, Malaffi/NABIDH in UAE) | Rework, delay | Integration inventory in Phase 1 design |
| G21 | **Device maintenance, recalls and biomedical safety checks** | Device failure in the home | Preventive maintenance schedule |
| G22 | **Business continuity**: system downtime, paper fallback, after-hours on-call coverage roster | Service failure | Downtime procedure, on-call roster in the system |

---

## 7. SLAs, KPIs and Reports

### 7.1 Service SLAs (proposed targets)
| SLA | Target |
|---|---|
| Call answered | 80% within 20 s |
| App request reviewed by a coordinator | ≤ 30 min (working hours) |
| Quote sent after a complete request | ≤ 1 h |
| Pre-approval decision followed up | every 4 h; escalate after 24 h |
| Same-day lab visit dispatched | ≤ 3 h from acceptance |
| Nursing start after acceptance | ≤ 24 h (assessment), ≤ 48 h (first shift) |
| Lab TAT / imaging report | 24 h routine, 4 h / 2 h urgent |
| Device delivery and install | ≤ 24 h (oxygen ≤ 4 h) |
| On-call response to NEWS2 5–6 | ≤ 15 min |

### 7.2 KPIs
| Area | KPI |
|---|---|
| Access | Requests by channel; conversion rate (quote → accepted); cancellation rate by reason; time to first visit |
| Operations | On-time arrival %; staff no-show / late %; patient no-show %; backup dispatches; utilisation (billable h / paid h); travel time per visit; nurse continuity % (same nurse) |
| Clinical quality | NEWS2 escalations by band; escalation SLA compliance %; unplanned hospital transfers per 1,000 patient-days; falls; new pressure injuries; medication errors; critical-result acknowledgement time; 30-day readmission |
| Lab / imaging | TAT compliance; sample rejection rate; recollection rate; report amendment rate |
| Equipment | Fleet utilisation %; overdue returns; damage rate; maintenance compliance |
| Finance | Revenue by service line and payer; DSO (days sales outstanding); claim rejection rate and top codes; pre-approval approval rate; attendance–invoice variance; cash reconciliation gaps; bad-debt % |
| Experience | CSAT/NPS after visit and at discharge; complaint rate and closure time |
| Workforce | Credential expiry pipeline; overtime hours; audit scores; staff turnover |

### 7.3 Standard Reports
Daily dispatch board · Shift coverage and gaps (next 7 days) · Escalation log · Critical results log · Pending pre-approvals · Open quotes · Ageing receivables (0–30/31–60/61–90/90+) · Claims status · Attendance vs invoice reconciliation · Rental register and overdue devices · Credential expiry · Episode census (active, on hold, discharged) · Weekly supervisor audit summary · Monthly management pack.

---

## 8. Phased MVP Roadmap

### Phase 1 — Direct Services MVP (≈ 4–5 months)
Goal: start taking revenue with lab, doctor visit and device rental, cash and simple insurance.
- Patient registry (national ID lookup, duplicate check, completeness), guardian, addresses with GPS and zones.
- Call-centre console plus a basic patient app (book, accept quote by OTP, track, pay, view results).
- Service catalogue, cash price list plus 1–2 insurer price lists, quote versioning, discount approval.
- Manual pre-approval tracking (no insurer API).
- Scheduling by zone and skill, staff mobile app (assignments, navigation, GPS/OTP check-in), no-show and cancellation fees.
- Lab: barcode, specimen chain of custody, LIS result import (or manual entry with validation), critical result alert and acknowledgement.
- Device rental: inventory, deposit, handover e-form, return reminders, pickup.
- Payments: cash with daily reconciliation, card on POS, payment link. Per-visit invoicing.
- Consent (general plus data sharing), credential registry with hard stop, audit log, SMS/push notifications in Arabic and English.
- Basic reports: dispatch board, open quotes, revenue, receivables.

### Phase 2 — Home Care Episodes (≈ 4 months)
Goal: shift-based nursing and the doctor care path with safe escalation.
- Episode of Care, assessment templates (history, vitals, Morse, Braden, home safety, IPC), refer-out.
- Care plan with versions; roster engine (8/12/24h), publish, reminders, continuity matching, 15-min grace with backup flow.
- Nurse EMR: vitals with NEWS2 auto-score and the full escalation engine (timers, auto-page, medical director fallback, ambulance protocol, OnHold).
- MAR with medication reconciliation and pharmacy verification; controlled-drug register.
- Orders to Lab, Radiology, Pharmacy and Equipment, results back to the EMR, doctor review queue. Portable imaging with PACS link.
- Shift notes, SBAR handover, check-out, supervisor weekly audit, incident reporting.
- Weekly or monthly billing cycles from verified attendance, finance review screen, insurance split and co-pay, claims batch export.
- Discharge summary, final invoice, satisfaction survey.
- Guardian/family portal (read-only alerts, visit log, invoices).

### Phase 3 — Scale and Optimise (≈ 3–4 months)
- Insurer/TPA and national integrations (e-claims, eligibility, pre-approval API; NPHIES/eClaimLink when entering the GCC; Hakeem in Jordan where available).
- Route optimisation and auto-scheduling, live ETA sharing with the patient.
- Bluetooth vitals devices and remote monitoring, teleconsultation with the doctor.
- Offline-first nurse app, payroll/HR export, freelancer marketplace.
- Advanced analytics: KPI dashboards, predictive deterioration and readmission, demand forecasting by zone.
- Multi-entity and multi-country: currencies, VAT and e-invoicing (ZATCA/FTA), data residency.
- Accreditation support (JCI home care standards / Jordan HCAC): document control, quality indicators.

### Open Questions for the Client
1. Are nurses employees, freelancers, or both? This affects payroll and liability.
2. Which insurers and TPAs are in scope for Phase 1, and do they have APIs?
3. Lab and imaging: in-house LIS/PACS, or partner labs? Which systems?
4. Is an in-house pharmacy licensed for home delivery and controlled drugs?
5. Who has authority to approve prices, discounts and write-offs?
6. Do any regulatory accreditation targets (MoH licence for home care, HCAC) apply?
7. Must data be hosted in-country?
8. Which tax treatment applies per service and device category? Finance and the tax adviser must confirm.
