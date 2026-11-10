# Home Care Platform — نظام الرعاية المنزلية

An integrated home-care system covering intake (app and call center), coordinator review, pricing and quotes, routing and dispatch, outpatient services (lab, imaging, devices), home-care episodes (EMR, orders, care plan), nurse shifts and attendance, NEWS2 escalation, and weekly or monthly billing.

## Documents

| File | What it is |
|---|---|
| [`docs/workflow-bpmn.html`](docs/workflow-bpmn.html) | BPMN 2.0 swimlane diagram of the full process. Click a step to see who does it and which system module covers it. |
| [`docs/business-requirements.md`](docs/business-requirements.md) | Business requirements: roles and permissions, data model, state machines, business rules, gaps in the original workflow, KPIs, and a phased roadmap. |

## Run it

```bash
cd backend && npm install && cd ../web && npm install && npm run build
cd ../backend && npm run dev     # API + web console on http://localhost:3000
```

For UI development run `npm run dev` in `web/` too (http://localhost:5173, proxies `/api` to the backend).

## Web console (`web/`)

React + Vite, Arabic right-to-left, light and dark themes. Pick a demo account on the login screen. Each role sees its own screens:

| Role | Screen | What it does |
|---|---|---|
| Call center | الكول سنتر | Phone intake: national-ID lookup or new file, services with cash estimate, insurance, and a follow-up list for requests with missing data |
| Coordinator | لوحة المنسق | Request board (review → patient approval → scheduling → in the field); drawer to price (discount approval, pre-approval no.), record phone acceptance, route and assign staff (same-zone first), cancel with reason, history. Home-care tab builds rosters from the doctor's care plan. Alerts tab: late check-ins with backup nurse, open escalations |
| Nurse / doctor / lab / radiology / driver | تطبيق الكادر | Mobile layout. Visits: on my way, check in by GPS or patient code, no-show, finish with result / device handover / payment. Assessment visits open the episode or refer out. Nurses: shifts, vitals with live NEWS2, notes, handover and check-out. Doctors: case list with escalations, results to review, care plan, orders, discharge. Departments: order worklist |
| Finance | المالية | Run the weekly/monthly cycle, review lines, issue (blocked if hours ≠ attendance), record payments |

## Backend (`backend/`)

Node 22 + TypeScript + Express. Uses the built-in `node:sqlite` for development, and the schema is plain SQL so it can move to PostgreSQL.

```bash
cd backend
npm install
npm test          # domain rules + end-to-end flows
npm run dev       # API on http://localhost:3000 (seeds demo data into homecare.db)
```

Authentication is a placeholder: send `x-staff-id` (see `src/seed.ts` for demo staff). Send `x-now` to pin the clock in demos.

### Modules → BPMN

| BPMN phase | Endpoints |
|---|---|
| Intake | `POST /api/requests`, `POST /api/requests/:id/complete-info`, `GET /api/patients?nationalId=` |
| Pricing & routing | `POST /api/requests/:id/quote`, `/accept`, `/cancel`, `/schedule` |
| Dispatch | `POST /api/visits/:id/dispatch`, `/check-in` (GPS ≤150 m or OTP), `/no-show` |
| Outpatient | `POST /api/visits/:id/complete` (result, device rental, payment) |
| Home care | `POST /api/episodes`, `/episodes/:id/care-plan`, `/episodes/:id/orders`, `GET /api/orders?department=`, `POST /api/orders/:id/result`, `POST /api/results/:id/acknowledge` |
| Shifts | `POST /api/episodes/:id/roster`, `POST /api/shifts/check-late`, `/shifts/:id/reassign`, `/check-in`, `/vitals` (NEWS2), `/notes`, `/check-out` |
| Billing & discharge | `POST /api/billing/run`, `/invoices/:id/issue`, `/invoices/:id/payments`, `/episodes/:id/discharge`, `/episodes/:id/final-invoice` |

### Key rules already enforced

- Request lifecycle state machine (`src/domain/requestStatus.ts`).
- Mandatory data before pricing; prescription required for imaging and oxygen.
- Payer price list over cash list, co-pay % and cap, after-hours ×1.25, discounts above 10% need a supervisor.
- Insurer pre-approval holds the quote.
- Staff role must match the visit type; expired licence blocks assignment; no double booking.
- No-show fee: 50% of the visit, minimum 10 JOD.
- Roster from the care plan (8/12/24 h), 15-min check-in grace with backup nurse, handover required at check-out.
- Billable time = actual attendance rounded to 15 min (up to 10 min lateness forgiven).
- NEWS2 auto-score: single-parameter 3 → urgent review, 5–6 → on-call doctor, ≥7 → emergency and episode on hold.
- Critical results stay open until the doctor acknowledges them.
- Billing runs per episode cycle (weekly Sat–Sat or monthly), can be run more than once without duplicate invoices, and invoice hours must match attendance before issue.

### Next steps

1. Real authentication and role-based access (JWT/SSO) plus an audit of clinical reads.
2. Patient app (booking, quote acceptance by OTP, live tracking, results, invoices) and native packaging of the staff app.
3. Consent forms, MAR and medication reconciliation, guardian portal (see BRD §6).
4. SMS/push gateway, payment gateway, LIS/PACS and insurer integrations.
