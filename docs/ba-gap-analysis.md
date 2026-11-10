# BA Gap Analysis: BRD vs Implementation

| Item | Value |
|---|---|
| Date | 2026-11-10 |
| Compared | `docs/business-requirements.md` v0.1 (§4 state machines, §5 business rules) against `backend/src` at this commit |
| Status values | **Implemented**: the code enforces the rule as written. **Partial**: some of the rule is enforced. **Missing**: nothing enforces it. **Differs**: the code enforces a different rule. **Fixed now**: implemented in this round (see §3) |
| Risk | **H** = patient harm, legal/regulatory exposure or direct revenue loss. **M** = operational failure or complaints. **L** = inefficiency |

File references are `path:line` under `backend/src/` unless stated otherwise.

---

## 1. Business rules (§5)

### 1.1 Intake and patient data

| Rule | Status | Evidence | Risk | Recommendation |
|---|---|---|---|---|
| BR-01 Look up by national ID, then phone + DOB to avoid duplicates | Partial | Lookup by national ID only: `routes/catalog.ts:37`, `routes/requests.ts:68`. No phone + DOB search. ID format is not checked (`z.string().min(5)`, `routes/requests.ts:14`); Jordanian national numbers are 10 digits | M | Validate the ID by `id_type` (JO 10 digits, passport, iqama). Add a phone + DOB duplicate warning at file creation |
| BR-01 (side effect) Existing file is overwritten by intake | Differs | `upsertPatient` overwrites name, phone, address of an existing file with whatever the agent typed (`routes/requests.ts:82`). The patient app signs in by SMS to the phone on file (`routes/patientApp.ts:50`) | **H** | A phone change by the call centre silently moves the patient's app login to a new number. Phone and name changes on an existing file should need verification (OTP to the old number or a supervisor) and be audited |
| BR-02 Mandatory fields before quoting | Partial | `missingInfo` checks DOB, gender, phone, address, GPS, emergency contact, prescription (`routes/requests.ts:45-63`). Not checked: payer choice, diagnosis/referral for the care path | M | Add "diagnosis or referral" when the route is ASSESSMENT/NURSE (check at `/schedule`, since the route is chosen there) |
| BR-03 Minor / no capacity needs a guardian with `can_consent` | Partial (fixed now for consent) | Consent signed as SELF for a patient under 18 is refused (`domain/consent.ts` `signerError`). The `guardians` table is not used anywhere; capacity is not recorded | **H** | Link consents to a `guardians` row with `can_consent=1`; add a "lacks capacity" flag set by the doctor |
| BR-04 Service area by zone polygon, override with surcharge | Missing | `zone_id` is optional free input (`routes/requests.ts:77`); zones have no polygon; surcharge column is never read | M | Point-in-polygon on the GPS pin; "outside area" blocks quoting unless the coordinator overrides with a reason (logged) |

### 1.2 Pricing, quote and pre-approval

| Rule | Status | Evidence | Risk | Recommendation |
|---|---|---|---|---|
| BR-10 Price source: contract → insurer → cash; manual change needs reason | Partial | Payer list over cash list: `routes/requests.ts:350-358`. No contract price lists, no validity dates or versions on price lists, no manual override | M | Price list header with `valid_from/to` and status; one active list per payer and date |
| BR-11 Discount authority 10% / 25% / GM | Differs | One tier: above 10% any SUPERVISOR or ADMIN id passed as `approvedBy` (`routes/requests.ts:332-337`). The approver never confirms; the coordinator just picks a name | **H** | Revenue leakage. Make it an approval request the approver accepts in their own session; add the 25% (Ops manager) and GM tiers |
| BR-12 Quote validity 48 h / 4 h; Expired state | **Fixed now** | `domain/pricing.ts` `quoteValidUntil`, `routes/requests.ts` `acceptQuote` / `expireQuotes`, sweep `POST /api/requests/expire-quotes` | was H | Run the sweep from a scheduler every 5 min (no job runner exists yet; see §2.4) |
| BR-13 Acceptance by app click or SMS OTP; phone acceptance with call ID | Partial | App click recorded (`routes/patientApp.ts:156`). Staff acceptance takes free-text `evidence`, defaulting to "phone" (`routes/requests.ts:385`); no OTP, no call ID | M | Require `callId` for phone acceptance or send an OTP to the patient's phone |
| BR-14 Pre-approval when the policy needs it; if refused offer cash or cancel | Partial | Request parks in PENDING_PREAPPROVAL until a number is typed (`routes/requests.ts:341-345`). No PreApproval record, no approved quantity, validity or rejection | **H** | See §2.1: there is no way to turn a rejected pre-approval into a cash quote. Add a PreApproval entity with status, approved qty and validity (G14) |
| BR-15 Prepayment: cash direct services 100%, nursing 1 week ahead, rental deposit | Partial | Prepayment register added now (`prepayments` table, `POST /api/requests/:id/prepayments`) and applied to the invoice at completion, but only required by BR-24. Field staff can complete without any payment | **H** | Client decision: should cash direct services be blocked at scheduling until paid, or collected at the door? Weekly cash nursing in advance is not built (billing runs in arrears, see BR-70) |
| BR-16 After-hours 20:00–07:00, Fridays, public holidays ×1.25 | Differs | `domain/pricing.ts:44-46` uses the **server's** clock and time zone (`getHours`, `getDay`). On a UTC server Amman is 2–3 h off, so 17:00–18:00 local is charged as after-hours and 04:00–07:00 local is not. Public holidays are not handled. Saturday (part of the Jordanian weekend) is not covered | **H** | Evaluate in `Asia/Amman` (per-country zone for GCC). Add a holiday calendar table. Client to confirm whether Saturday counts |

### 1.3 Scheduling, no-show and cancellation

| Rule | Status | Evidence | Risk | Recommendation |
|---|---|---|---|---|
| BR-20 Matching: skill/licence → gender → zone → continuity → workload → travel | Partial | Role and licence enforced (`routes/requests.ts:116-121`); the coordinator UI sorts by zone. No gender preference on the patient file, no continuity or workload | **H** (cultural, G15) | Add `preferred_staff_gender` and `chaperone_required` to the patient; block or warn on mismatch. Client decision: hard stop or warning |
| BR-21 Propose 3 alternative slots | Missing | Only an error text: `routes/requests.ts:423` | L | Slot search once staff calendars exist |
| BR-22 Notify on assignment, 24 h before, on the way | Partial | Assignment and dispatch notifications exist (`routes/requests.ts:436`, `routes/visits.ts` dispatch). No 24 h reminder | M | Reminder job |
| BR-23 Cancellation fee by notice | **Fixed now** | `domain/patientPolicy.ts` `cancellationFee`; `routes/requests.ts` `cancelRequest`; fee preview in `GET /api/requests/:id` | was H | Client to confirm fee basis for insured patients (see §4) |
| BR-24 No-show fee 50% (min 10 JOD); 2nd in 30 days needs prepayment | **Fixed now** (prepayment); fee was Implemented | `domain/patientPolicy.ts`; `routes/visits.ts:99`; schedule block in `routes/requests.ts:424-427` | was M | The 15-min wait and two calls are not evidenced (no-show can be pressed on arrival). Also the 10 JOD minimum is **higher than some services** (CBC 8 JOD); see §4 |
| BR-25 Staff late/no-show: no fee; credit after 2 missed visits; staff KPI | Missing | No staff no-show state for visits; shift MISSED has no KPI or credit | M | Add `no_show_party` on visits and a service-credit line type |
| BR-26 Check-in GPS ≤150 m or OTP; manual check-in needs supervisor | Partial / **Differs** | Visits: GPS or OTP (`routes/visits.ts:75-86`). The field app lets staff **type coordinates by hand** when GPS fails (`web/src/screens/FieldApp.tsx:9-25`) and the server treats them as GPS. Shift check-in has no OTP option and **skips the geofence entirely when the patient has no GPS pin** (`routes/clinical.ts:337`) | **H** | Attendance drives billing and payroll. Mark hand-typed positions as MANUAL, require supervisor approval, and refuse shift check-in without either GPS match or patient OTP |

### 1.4 Shift and attendance

| Rule | Status | Evidence | Risk | Recommendation |
|---|---|---|---|---|
| BR-30 15-min grace, alert, backup if no ETA in 15 min | Implemented (+ fixed now) | `POST /shifts/check-late` (`routes/clinical.ts:298-310`), reassign. Now the LATE_SHIFT escalation goes to the nursing supervisor after 15 min unanswered | — | Needs a scheduler (§2.4) |
| BR-31 No end without handover or patient sign-off; no gap in 24 h cover | Partial | Check-out needs a handover text ≥ 5 chars (`routes/clinical.ts:395-400`). Not checked: the next nurse has checked in, or a guardian signed. A missed shift with no cover leaves a silent gap | **H** | At check-out of a 24 h-coverage episode, require the next shift's check-in or a guardian sign-off; alert on uncovered gaps |
| BR-32 Billable = attendance rounded to 15 min; ≤10 min late tolerated; overtime only if pre-approved | Implemented | `domain/shifts.ts` `billableMinutes`. Overtime is never billed (no pre-approval path) | L | Add overtime approval when needed |
| BR-33 ≤60 h/week, ≤2 consecutive 24 h, ≥11 h rest | **Fixed now** | `domain/shifts.ts` `workingTimeViolations`; roster and reassign in `routes/clinical.ts:16-37, 274, 321`; supervisor override with reason is audited | was H | Confirm limits against Jordan Labour Law No. 8/1996 (48 h normal week, overtime by consent) and add a weekly rest day rule |
| BR-34 Roster published ≥7 days ahead; reminders 24 h / 2 h | Missing | Roster is "published" on creation; no Published/Confirmed states | M | Shift states Planned → Published → Confirmed (§2.3) |
| BR-35 Weekly supervisor audit per episode | Missing | — | M (accreditation) | Audit task generator per active episode |
| BR-36 No assignment with expired licence/BLS; alerts 60/30/7 days | Partial | Licence expiry only (`routes/requests.ts:120`); no BLS or other certificates; no expiry alerts | **H** | Credential table (type, number, expiry) checked by `assertStaffAvailable` |

### 1.5 Clinical escalation (NEWS2 and critical results)

| Rule | Status | Evidence | Risk | Recommendation |
|---|---|---|---|---|
| NEWS2 scoring and bands incl. single parameter 3 | Implemented | `domain/news2.ts:78-106` | — | — |
| NEWS2 5–6: recheck in 15 min; on-call reply ≤15 min else medical director | **Fixed now** | Escalation `due_at`; sweep `POST /api/escalations/check-timers` (`routes/clinical.ts:53-89`) escalates to the medical director and asks the nurse to recheck | was H | — |
| NEWS2 ≥7: ambulance, doctor and family, OnHold | Implemented (+ fixed now) | `routes/clinical.ts:368-372`. Now also notifies the medical director at once (72 h review) | — | Ambulance is a notification only; record the call time and hospital |
| SpO2 Scale 2 only when a doctor sets it | **Differs** | Scale is chosen per reading by whoever enters vitals (`routes/clinical.ts:102`) | **H** | Scale 2 lowers the score. Store it on the episode, set by a doctor, and ignore the per-reading field |
| NEWS2 not valid under 16 or in pregnancy | Missing | Score is computed for anyone | **H** | Block NEWS2 for under-16s / pregnancy and ask for doctor-defined thresholds |
| DNR / limits of care change the escalation path | Missing | — | **H** | Advance-directive flag on the episode (G16) |
| Critical result: doctor within 30 min, else medical director | **Fixed now** | Sweep escalates both episode and outpatient critical results; `results.escalated_at` | was H | Read-back is not recorded on acknowledge (`routes/clinical.ts:246-255`); any doctor can acknowledge, not only the ordering/on-call doctor |
| Results not released before acknowledgement or 24 h | **Fixed now** (clarified) | Non-critical episode results auto-release after 24 h in the sweep (`routes/clinical.ts:87`). Critical results stay held until a doctor acknowledges (BRD clarified) | — | — |
| On-call doctor and medical director exist to receive alerts | **Missing** | Notifications go to `role:ONCALL_DOCTOR` and `role:MEDICAL_DIRECTOR` (`routes/clinical.ts:374`), but neither role exists in `staff.role` (`schema.sql:13`) and there is no on-call roster | **H** | Every escalation currently lands on a recipient nobody reads. Add the roles and an on-call roster (G22) before go-live |
| Escalation acknowledgement by clinicians | Differs | DOCTOR **or SUPERVISOR** may acknowledge and resolve any escalation, including NEWS2 and critical results (`routes/clinical.ts:385-386`) | **H** | Clinical escalations: doctor only; LATE_SHIFT/INCIDENT: supervisor |

### 1.6 Lab, imaging, devices

| Rule | Status | Evidence | Risk | Recommendation |
|---|---|---|---|---|
| BR-50 Barcode and two identifiers at the bedside | Missing | — | **H** | Specimen entity with barcode scan at collection |
| BR-51 Cold chain 2–8 °C, ≤2 h to lab | Missing | — | M | Temperature log on the specimen |
| BR-52 TAT routine 24 h / urgent 4 h; imaging 24 h / 2 h | Missing | Orders have priority but no due time | M | `due_at` on orders, worklist sorted by it |
| BR-53 Portable X-ray safety checklist, licensed radiographer | Partial | Role check only (`VISIT_ROLES` in `routes/requests.ts`). Imaging consent now required at check-in | M | Checklist fields on imaging completion |
| BR-60 Deposit = max(1 month rent, 20% of value), refund ≤7 working days | Missing | Deposit is free input, default 0 (`routes/visits.ts:118`); no device value | M | Compute the deposit from the device category |
| BR-61 Minimum 7 days; overdue billing, reminders, pickup at D+7 | Missing | No return endpoint at all (see §2.2) | **H** | Rental return / overdue flow |
| BR-62 Handover form signed before Active | Implemented | `handoverSigned: z.literal(true)` (`routes/visits.ts:118`) | — | Store the signed form, not just a flag |

### 1.7 Billing and collections

| Rule | Status | Evidence | Risk | Recommendation |
|---|---|---|---|---|
| BR-70 Cycle per visit / weekly / monthly; cash nursing weekly **in advance** | Differs | Weekly and monthly in **arrears** (`domain/billing.ts:11` `previousPeriod`); week computed with the server's local date | M | Client decision on advance billing for cash nursing; use `Asia/Amman` dates |
| BR-71 Lines only from verified sources | Partial | Shifts billed when COMPLETED; there is no supervisor "Verified" step (`routes/billing.ts` `invoiceEpisode`). No supplies | M | Add the Verified state (§4.3) and bill only verified shifts |
| BR-72 Invoiced hours = attendance; any variance blocks issue | Partial | Check compares invoice qty with `shifts.billable_minutes` (`routes/billing.ts:106`), which the invoice line was copied from, so it can never fail for a fresh invoice | M | Compare with check-in/check-out times and flag edits made after the invoice was built |
| BR-73 Payer share by contract; co-pay % up to cap; pre-approved qty overrun to patient with acknowledgement | Partial / bug | Quote applies % and cap (`domain/pricing.ts:73-80`). Periodic billing ignores the cap and applies the **nursing co-pay to rental lines too**, even when the rental is not covered (`routes/billing.ts:42-43`). No pre-approved quantity | **H** | Per-line coverage in `buildInvoiceLines`, cap per period, pre-approval quantity tracking (G14) |
| BR-74 Reminders +3/+7/+14; pause at +30 | Missing | No due date or Overdue state | M | Due date from payment terms; reminder job |
| BR-75 Write-off approval; never delete, use credit notes | Missing | `VOID` exists in the schema but no endpoint uses it; no credit note | **H** | Void/credit-note flow (§2.2) |
| BR-76 Tax per item tax code | Missing | No tax on lines | M (Finance to confirm) | Tax code on services; equipment rental may carry Jordan GST |
| BR-77 Field cash handed in within 24 h, reconciled daily | Missing | Any NURSE/DRIVER/LAB_TECH can record payments on **any** invoice and overpay it (`routes/billing.ts:115-128`) | **H** | Limit field roles to invoices of their own visits; refuse amounts above the balance; daily cash-up per collector |

### 1.8 Consent, privacy and discharge

| Rule | Status | Evidence | Risk | Recommendation |
|---|---|---|---|---|
| BR-80 General consent before the first visit; specific consents | **Fixed now** (general + imaging) | `domain/consent.ts`, `routes/consent.ts`; hard stop at visit check-in (`routes/visits.ts:91`) and shift check-in (`routes/clinical.ts:342`) | was H | Invasive-procedure, photography and data-sharing consents are recorded but not yet checked at the point of use |
| BR-81 Guardian portal only with consent / legal authority | Missing | No guardian portal | M | Phase 2 |
| BR-82 Discharge: signed summary, med reconciliation, device pickup, final invoice, survey | Partial | Summary required; future shifts cancelled; driver notified of devices; survey SMS (`routes/clinical.ts:408-420`). No med reconciliation, no pickup task, final invoice is a separate manual step | M | Discharge checklist that blocks `Closed` |
| BR-83 Retention | Not applicable yet | — | — | — |

---

## 2. Process-flow problems

### 2.1 Dead ends and missing transitions

| # | Problem | Evidence | Risk | Recommendation |
|---|---|---|---|---|
| F1 | **Outpatient lab sample without a result can never be resulted.** When the lab tech completes the visit without a result, the order stays IN_PROGRESS with no episode. `POST /orders/:id/result` looks up the episode and returns 404 for it | `routes/visits.ts:131`, `routes/clinical.ts:232` | **H** | Most home samples are analysed later at the lab, so this is the normal case. Let the result route handle orders with `request_id`, and notify the patient/ordering doctor from the request |
| F2 | **Pre-approval rejected → no cash path.** PENDING_PREAPPROVAL can only go to QUOTED (with a pre-approval number) or CANCELLED. Quoting always uses the request's policy, so a cash quote is impossible | `domain/requestStatus.ts`, `routes/requests.ts:341-345` | **H** | Add "pre-approval rejected → quote as cash" (drop the policy for this request, keep the reason) |
| F3 | **Episode OnHold has no way back.** After NEWS2 ≥7 the episode is ON_HOLD; care plan, orders and roster all require ACTIVE and there is no resume. Already-planned shifts still run, raise late alerts and are billed | `routes/clinical.ts:370`, care plan/orders/roster ACTIVE checks; billing includes ON_HOLD (`routes/billing.ts:57`) | **H** | `POST /episodes/:id/resume` (doctor, after hospital return) and cancel planned shifts while on hold; 72 h review reminder |
| F4 | **Rental never ends.** Rental status is ACTIVE or RETURNED but nothing sets RETURNED or `returned_at`. Episode rentals are billed every cycle forever; outpatient rentals are billed once from the quote quantity and never again | `schema.sql` rentals, `routes/billing.ts:36`, `routes/visits.ts:141-145` | **H** | Return / pickup / inspection flow (§4.6), overdue charging (BR-61), and periodic billing for outpatient rentals |
| F5 | **Invoices cannot be corrected.** No void, credit note or re-issue; a wrong issued invoice stays | `routes/billing.ts` | **H** | Void with credit note (§4.5), reason and approval |
| F6 | Request `Closed` state is missing; COMPLETED is terminal although results may be pending and payment unsettled | `domain/requestStatus.ts` | M | Close when results released, invoice paid or handed to payer, devices handed over |
| F7 | Rescheduling a booked visit left the old visit SCHEDULED, so the staff saw two visits and the clash check blocked their slot | was `routes/requests.ts` schedule | M | **Fixed now**: the earlier SCHEDULED visit is cancelled on reschedule |
| F8 | A patient could not cancel once the team was dispatched (no DISPATCHED → CANCELLED), so "100% on arrival" (BR-23) could not happen | `domain/requestStatus.ts` | M | **Fixed now** |

### 2.2 Steps a real operation needs that are not modelled

- **Timer jobs.** Late shifts, quote expiry and escalation timers are sweep endpoints that something must call every minute. There is no scheduler in the backend. Until one is added, the timers only fire when someone calls the endpoint.
- **On-call roster** for doctors and the medical director (see §1.5). Without it the escalation path has no real recipient.
- **Specimen logistics:** collection → transport → lab receipt → result, with the driver handing samples to the lab.
- **Staff confirmation of shifts** (Published → Confirmed / Declined) before the shift day.
- **Payer claims:** the payer share of every invoice is computed but never claimed, tracked or reconciled (§4.5 payer branch).
- **Daily cash-up** of field collections (BR-77).

### 2.3 State machines vs BRD §4

| Machine | BRD states missing in code | Notes |
|---|---|---|
| ServiceRequest §4.1 | Draft, Closed, Rescheduled (NoShow → Scheduled covers it) | EXPIRED added now. REFERRED_OUT exists in code (not in BRD) |
| Order §4.2 | Draft, Verified (pharmacy), Scheduled, ResultPending, Resulted, Released, Rejected, Amended | Results are validated by the person who enters them; no separate validation by a pathologist/radiologist |
| Shift §4.3 | Published, Confirmed, Declined, HandedOver, Verified, Billed | LATE and MISSED exist. COMPLETED is billed directly |
| Episode §4.4 | Referral, AssessmentScheduled, Assessed, PendingDischarge, Deceased, Closed | ON_HOLD has no exit (F3) |
| Invoice §4.5 | UnderReview, Discrepancy, Approved, Overdue, InCollection, WrittenOff, Voided (unused), payer claim states | — |
| Rental §4.6 | Everything except ACTIVE/RETURNED | F4 |

### 2.4 Rules that need checking for Jordan

| Topic | Issue | Suggestion |
|---|---|---|
| Weekend | Code treats only Friday as after-hours; the Jordanian public-sector weekend is Friday + Saturday | Client to decide whether Saturday is ×1.25 |
| Time zone | All time-of-day and week logic uses the server clock | Use `Asia/Amman` (UTC+3 all year since 2022) explicitly |
| Public holidays | Eids, Independence Day etc. are not known to the system | Holiday table maintained by Admin |
| Working time | 60 h/week is above the 48 h normal week in the Labour Law; the difference must be consented overtime and paid at the overtime rate | Legal review before go-live; add one rest day per week |
| Emergency number | 911 (Jordan) is in the BRD; the app has no ambulance-call record | Record call time, crew and hospital |
| Tax | General sales tax may apply to equipment rental and sale, not to most medical services | Finance and tax adviser to confirm per item |
| Gender matching | Strong cultural expectation for female patients (G15) | Add patient preference; decide hard stop vs warning |

---

## 3. Changes made in this round

| Rule | What changed | Where |
|---|---|---|
| BR-12 | Quotes get `valid_until` (48 h; 4 h same-day/urgent). Accepting an expired quote is refused and the request moves to the new **EXPIRED** state; re-quoting creates a new version. Sweep `POST /api/requests/expire-quotes`. Validity shown to the patient and coordinator | `domain/pricing.ts`, `domain/requestStatus.ts`, `routes/requests.ts`, `routes/patientApp.ts`; UI: Coordinator, PatientApp |
| BR-23 | Patient cancellation fee by notice: >24 h free, 24–2 h 50%, <2 h or dispatched 100%; company cancellations free. Fee on a draft invoice; preview before confirming. DISPATCHED → CANCELLED allowed. Reschedule cancels the previous booked visit | `domain/patientPolicy.ts`, `routes/requests.ts`, `routes/patientApp.ts`; UI: Coordinator cancel section |
| BR-24 | From the 2nd no-show in 30 days, scheduling is blocked until the visit fee is prepaid. Prepayment register applied to the visit invoice at completion | `domain/patientPolicy.ts`, `routes/requests.ts`, `routes/visits.ts`, `schema.sql` (`prepayments`); UI: Coordinator schedule section |
| BR-80 / BR-03 | Consent entity and endpoints. Visit and shift check-in need valid general consent (imaging also imaging consent). Staff capture it at the door; patients can sign in the app when accepting. Minors need a guardian; revocation blocks the next visit | `domain/consent.ts`, `routes/consent.ts`, `routes/visits.ts`, `routes/clinical.ts`, `schema.sql` (`consents`); UI: FieldApp check-in, PatientApp accept |
| §5.5 | Escalation deadlines and sweep `POST /api/escalations/check-timers`: unanswered critical results (30 min, also outpatient) and NEWS2 5–6 (15 min) go to the medical director; nurse asked to recheck NEWS2 5–6; NEWS2 ≥7 notifies the medical director at once; non-critical results auto-release after 24 h | `domain/escalation.ts`, `routes/clinical.ts` |
| BR-33 | Roster and backup reassignment refuse <11 h rest, >60 h in 7 days, >2 back-to-back 24 h shifts, unless a supervisor gives an override reason (audited) | `domain/shifts.ts`, `routes/clinical.ts` |

Tests: `test/rules.domain.test.ts`, `test/rules.flows.test.ts`.

## 4. Decisions the client must make

1. **No-show minimum fee (BR-24).** 10 JOD is more than some services (CBC 8 JOD). Cap the fee at the visit price?
2. **Fee basis for insured patients (BR-23/24).** The code charges a percentage of the **patient's share** of the quote. Should late cancellations of insured visits charge the full visit price to the patient, since insurers do not pay for cancelled visits?
3. **Prepayment for cash direct services (BR-15).** Block booking until paid, or collect at the door?
4. **Weekly cash nursing in advance (BR-70).** The system bills in arrears today.
5. **Saturday and public holidays** in the after-hours multiplier (BR-16).
6. **Gender preference (G15):** hard stop or warning; who may override.
7. **Nurse working-time limits (BR-33)** after legal review; who may override (today: nursing supervisor with a reason).
8. **Who receives escalations:** names for the on-call doctor rota and the medical director, and the fallback when the medical director does not answer.
9. **Results auto-release after 24 h:** confirm that non-critical results go to the patient app after 24 h without doctor review, and that critical results never auto-release.
