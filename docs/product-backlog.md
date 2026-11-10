# Product Backlog: Home Care Platform

Owner: Product. Last walk-through: 2026-11-10, run end to end in the real UI as each persona: patient on a phone, call center, coordinator on desktop and phone, nurse, doctor, lab tech, finance.
Business rules and state machines belong to the BA (see `business-requirements.md`). This backlog covers what people see and do. Where a story depends on a rule, the rule is linked and not restated.

**Priority:** P0 means the pilot (Amman, first paying patients) cannot run without it. P1 makes the pilot work well. P2 comes later.
**Status:** ✅ done in this session · ◐ partly done · blank means open.

---

## What the walk-through found

| Persona | Friction or dead end seen |
|---|---|
| Patient | The tracker only refreshed when the patient tapped "تحديث", so they could miss the quote or "team on the way". Nothing was asked after the visit. The only way to change a booking is to cancel it, and the cancel button gives no warning of a fee (BR-23). The invoice is a single line with no breakdown, no way to pay and no way to share it. A prescription can only be entered as a typed number. |
| Call center | After intake, the agent has no view of a caller's open requests ("وين الممرضة؟"), so status questions go to the coordinator. |
| Coordinator | The board had no counts, no SLA and no age on requests, so it was impossible to tell which request was late. Cards showed service codes (`LAB-CBC`) instead of names. The board did not refresh itself after a patient accepted in the app. On a phone the board pushed the whole page sideways. Requests booked in the app have no zone, so "same zone first" never triggers. The staff picker shows nobody's existing visits. Nothing on screen is clickable to call the patient. |
| Nurse / field | The app opens on "شفتاتي" even when all of today's work is under "زياراتي", and the tabs show no counts. There is no map link or call button for the patient address. There is no "today" overview. |
| Doctor / lab | Empty states give no hint of what to do next. Normal outpatient lab results reach the patient without anyone validating them; this is flagged to the BA. |
| Finance | The invoice list has no patient name, no filters and no ageing. Invoices cannot be printed or shared. Cash collected in the field is not reconciled per collector. |
| Everyone | Staff sign in by picking a name with no password. There is no notifications inbox, although the `notifications` table already holds every message. The UI is Arabic only. |

---

## P0: needed for the pilot

| # | Persona | Story | Acceptance criteria | Status |
|---|---|---|---|---|
| P0-1 | Coordinator | As a coordinator I see today's queues and SLA breaches above the board, so I work the late requests first. | KPI strip shows: to review (and how many are past 30 min), awaiting patient, pre-approval, ready to schedule (urgent count), today's visits done/total and in the field, SLA-late count, alerts, CSAT. Tapping SLA filters the board to late requests. Tapping alerts opens the Alerts tab. Each card shows its age and a "متأخر X" badge. SLA targets follow BRD §7.1. The strip works at 390 px with no sideways scroll. API: `GET /api/dashboard/coordinator`, tested. | ✅ |
| P0-2 | Coordinator, Patient | As a coordinator or patient I see changes without reloading. | The board and KPIs poll every 30 s and the patient tracker every 20 s, only while the tab is visible, and refresh as soon as the tab is focused again. An "updated at" stamp is shown, with a "refresh now" button. | ✅ |
| P0-3 | Patient, Supervisor | As a patient I rate my visit, and as a supervisor I call back anyone unhappy (CSAT, BRD §7.2). | After a COMPLETED, CONVERTED or REFERRED request, the app shows "كيف كانت الزيارة؟" with 1–5 stars, tags and a comment. One rating per request, and the prompt shows for 14 days. A score of 2 or less opens a follow-up and notifies the supervisor. Coordinator and supervisor see the open follow-ups and close each with a call note, which is audited. API is tested, including another patient's request (404), a visit not yet done (409) and a duplicate rating (409). | ✅ |
| P0-4 | All staff | As staff I sign in with my own credentials and see only my role's screens. | Phone and password or SSO. The `x-staff-id` header is no longer trusted. The session expires. The demo picker is hidden in production. | |
| P0-5 | Patient | As a patient I can move my appointment instead of cancelling it. | "تغيير الموعد" on SCHEDULED requests offers 3 slots (BR-21). The fee window from BR-23 is shown before confirming. The coordinator gets a notice, and the staff member and the visit code are updated. *The rule belongs to the BA; the UI waits on it.* | |
| P0-6 | Patient | Before cancelling I see any fee. | The cancel sheet shows "free", "50%" or "100%" with the amount, following BR-23, before the confirm button. | |
| P0-7 | Coordinator | Requests from the app get a zone, so same-zone matching works. | The zone is taken from the patient's GPS or address. The coordinator can override it in the drawer. The "نفس المنطقة" hint appears for app patients. | |
| P0-8 | Call center | As an agent I can answer "where is my visit?" in one search. | A national ID or phone search shows the caller's open requests with status, visit time, staff name and the quote. The same SLA badges as the board are shown. | |

## P1: makes the pilot work well

| # | Persona | Story | Acceptance criteria | Status |
|---|---|---|---|---|
| P1-1 | Nurse, Driver, Tech | The app opens on my next job. | The app lands on the tab that has today's work. Tabs show counts. A "اليوم" card shows the next visit or shift with a countdown, the address, a **map** link and a **call patient** button. | |
| P1-2 | All staff, Patient | I have a notifications inbox. | A bell in the top bar with an unread count, fed from `notifications`, filtered by `staff:<id>`, `role:<ROLE>` or `patient:<id>`. Tapping an item deep-links to the request or episode. Items can be marked read. | |
| P1-3 | Patient, Finance | I can open, print or share an invoice. | The invoice page shows line detail, the insurer and patient split, payments and the balance. It has a print stylesheet and a share link. A "pay" button appears once the payment gateway exists. | |
| P1-4 | Coordinator | When assigning, I see the candidate's day. | The staff picker shows each person's visits and shifts for that date and a clash warning before submitting, so a double-booking is caught before the API rejects it. | |
| P1-5 | Coordinator | Filter the board by zone, urgency, channel and line. | Filter chips that combine, kept per user in local storage. | |
| P1-6 | Finance | I can find and chase money. | The invoice list shows the patient name, status and date filters, and an ageing summary (0–30/31–60/61–90/90+). A daily cash report per collector. | |
| P1-7 | Patient | I can upload a prescription photo. | Camera upload on the request, shown in the coordinator drawer, which clears the "prescription" missing item. | |
| P1-8 | Patient | I see an ETA once the team is on the way. | The "بالطريق" step shows the staff name, an ETA and a call button. | |
| P1-9 | Coordinator | One-tap call and WhatsApp from the drawer. | `tel:` and `wa.me` links on the patient and emergency-contact phone numbers. | |
| P1-10 | Supervisor | A CSAT report by staff and service line. | Average, response rate and low-score themes by tag, for 7 or 30 days. Builds on P0-3. | ◐ (the data and the follow-up queue exist) |

## P2: later

| # | Persona | Story | Status |
|---|---|---|---|
| P2-1 | All | English UI toggle (the BRD calls for Arabic and English). | |
| P2-2 | Family | Guardian portal: read-only alerts, visit log and invoices (G12). | |
| P2-3 | Nurse | Offline capture of vitals and notes with sync (G19). | |
| P2-4 | Patient | Real-time push (WebSocket or SSE) instead of polling, once there is a push gateway. | |
| P2-5 | Patient | NPS at discharge, alongside the per-visit CSAT. | |
| P2-6 | Management | KPI pack (§7.2): conversion, on-time %, utilisation, DSO. | |

---

## Questions for the BA

1. **SLA targets.** P0-1 uses the targets in BRD §7.1 and adds two of its own: a quote with no reply is followed up after 24 h, and a routine accepted request must be assigned within 24 h. Please confirm both and move all the targets into contract config.
2. **Outpatient lab results** go to the patient straight from the field (`/visits/:id/complete`) with no validation step. Should there be a lab-tech or doctor validation first?
3. **Rating window and threshold.** The product defaults are 14 days and a score of 2 or less. Should a low score also count towards the staff KPI (BR-25)?
4. **Zone for app requests** (P0-7). Derive it from GPS, or ask the patient to pick a zone?
