# Home Care Platform — نظام الرعاية المنزلية

An integrated home-care system covering intake (app and call center), coordinator review, pricing and quotes, routing and dispatch, outpatient services (lab, imaging, devices), home-care episodes (EMR, orders, care plan), nurse shifts and attendance, NEWS2 escalation, and weekly or monthly billing.

## Documents

| File | What it is |
|---|---|
| [`docs/workflow-bpmn.html`](docs/workflow-bpmn.html) | BPMN 2.0 swimlane diagram of the full process. Click a step to see who does it and which system module covers it. |
| [`docs/user-manual.md`](docs/user-manual.md) | User manual in Arabic for every role, with screenshots (`docs/manual/img/`). |
| [`docs/qa-report.md`](docs/qa-report.md) | Test results, defects fixed, known limitations. Re-run with `cd backend && npm test` and `./e2e/run.sh`. |
| [`docs/ui-ux-review.md`](docs/ui-ux-review.md) | UI/UX audit and the before/after screenshots in `docs/ui-ux/`. |
| [`docs/erp-and-tax-integration.md`](docs/erp-and-tax-integration.md) | Tax on invoices, Jordan e-invoicing (JoFotara) with QR, and the ERP API (SAP mapping, webhooks, API keys). |
| [`docs/business-requirements.md`](docs/business-requirements.md) | Business requirements: roles and permissions, data model, state machines, business rules, gaps in the original workflow, KPIs, and a phased roadmap. |

## Run it

**Quickest:** open the repo in GitHub Codespaces (Code → Codespaces → Create codespace on this branch). It installs, builds and opens the app on port 3000 by itself.

**On your computer** (Node.js 22+): `./start.sh` (macOS/Linux) or `start.bat` (Windows), then open http://localhost:3000.

**Manually:**

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
| Patient / family | تطبيق المريض (`/#patient`) | Sign in with national ID + SMS code (shown on screen in dev), book services, complete the file (GPS from the phone), approve or decline the price, track the request step by step, see the visit time, staff name and visit code, results and invoices |
| Finance | المالية | Run the weekly/monthly cycle, review lines, issue (blocked if hours ≠ attendance), record payments |

## Owner settings (إعدادات المالك)

Every business rule with a number or a choice is configurable by the owner (ADMIN role) from the **إعدادات المالك** screen, without a code change. Defaults and validation live in `backend/src/settings.ts`; values are stored in the `settings` table and every change is recorded in `settings_history` (who, when, old → new). Changes apply to the next action; existing quotes and invoices are not touched.

| Group | Settings |
|---|---|
| Pricing & time | time zone, after-hours multiplier, hours, whole days (e.g. Friday/Saturday), public holidays, coordinator discount limit, quote validity (routine / urgent) |
| Cancellation & no-show | fee base (patient share or full price), free-cancel and full-fee notice, partial %, no-show %, minimum fee, cap at visit price, repeat no-show prepayment threshold and window |
| Payment & billing | cash direct services paid at the door or before booking, nursing billed in arrears or in advance (planned roster, settled against attendance on the next run), rounding, late tolerance |
| Staff & shifts | staff gender preference (off / warn / block), max hours per 7 days, minimum rest, consecutive 24 h shifts, check-in grace, GPS radius |
| Clinical | medical director, on-call doctors, critical-result and NEWS2 response times, recheck time, auto-release of normal results (0 = doctor review only), consent hard stop, age of majority |
| Tax & e-invoicing | prices include tax, tax category and rate per service line, JoFotara on/mock/off, endpoint, Client ID and Secret Key (encrypted), seller TIN, name and income-source sequence, auto-submit, cash/receivable type |
| ERP stock | check stock before dispensing (mock / generic REST / SAP), block or warn, behaviour when the ERP is down, plant, storage location, movement type, material per service; goods issues posted with retry |
| ERP | webhook URL and signing secret, revenue G/L account per line, ERP tax code per category, cost center |
| SLA, patient app, feedback | SLA targets on the coordinator board, OTP validity and attempts, session length, low-rating threshold and rating window |

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
- Quotes expire after 48 h (4 h same-day); late patient cancellations carry a fee by notice time; the 2nd no-show in 30 days needs prepayment.
- General consent is required before the first visit (guardian for minors).
- Escalation timers: unanswered critical results and NEWS2 5–6 go to the medical director (`POST /api/escalations/check-timers`, run every minute).
- Nurse working-time limits on rosters and backups (11 h rest, 60 h / 7 days), supervisor override with reason.
- Gap analysis of the BRD vs the code: [`docs/ba-gap-analysis.md`](docs/ba-gap-analysis.md).
- Billing runs per episode cycle (weekly Sat–Sat or monthly), can be run more than once without duplicate invoices, and invoice hours must match attendance before issue.

### Next steps

1. Real authentication and role-based access (JWT/SSO) plus an audit of clinical reads.
2. Staff sign-in with passwords/SSO (staff routes still trust `x-staff-id`), SMS gateway for patient codes, native packaging of the apps.
3. Consent forms, MAR and medication reconciliation, guardian portal (see BRD §6).
4. SMS/push gateway, payment gateway, LIS/PACS and insurer integrations.
