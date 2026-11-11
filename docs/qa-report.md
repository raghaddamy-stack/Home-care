# QA report — تقرير فحص النظام

**Date:** 2026-11-10 · **Branch:** `claude/dazzling-edison-qu99yx`

## Summary

| Layer | What | Result |
|---|---|---|
| Unit (domain rules) | NEWS2, pricing and tax, cancellation and no-show policy, rosters and working-time limits, billing periods, consent, escalation timers, state machine | 35 / 35 pass |
| Full cycles | Five complete business cycles to a closed state (see below) | 5 / 5 pass |
| API integration | Full flows through the HTTP API on a fresh database per test: intake → quote → schedule → visit → invoice; home-care episode → roster → shifts → billing; patient app; owner settings; e-invoicing; ERP API; webhooks | 62 / 62 pass |
| Security | Every staff endpoint refuses anonymous callers; role checks; patient isolation; ERP keys; malformed or oversized input | 28 / 28 pass |
| End-to-end UI (browser) | 18 steps across every persona, through the closing of the account on a real server, in desktop and phone sizes (`e2e/run.sh`) | 18 / 18 pass |
| Exploratory | Hostile and invalid input probes (bad ids, SQL-like strings, script tags, negative amounts, wrong types, 2 MB bodies) | All handled with 4xx after fixes |

Run it yourself:
```bash
cd backend && npm test        # 130 API/unit tests incl. 5 full cycles
./e2e/run.sh                  # browser walkthrough of every persona; report in e2e/out/report.md
```

## Full business cycles (end to end, every loop closed)

`backend/test/cycles.test.ts` drives five complete cycles through the API with a controlled clock. The browser suite repeats the home-care one, through the account closing, in the real UI.

| # | Cycle | Ends in |
|---|---|---|
| 1 | Home care, insured: pre-approval → assessment → episode → orders to lab, pharmacy and equipment → oxygen device delivered (rental starts) → shifts → NEWS2 emergency puts care **on hold** (no check-in, no late alerts) → doctor **resumes** → weekly invoice with shifts, **orders** and **rental days**, co-pay only on covered services → patient pays → **insurer pays through the ERP** → discharge → final invoice blocked until the **device is collected** → final invoice → paid | **Account closed** (`episode.closed` event), both e-invoices accepted, the ERP holds both invoices |
| 2 | Outpatient X-ray, insurer **refuses** pre-approval → **cash quote** → scan → report written **later** from the radiology worklist → patient file | Invoice paid, e-invoice accepted, ERP acknowledged |
| 3 | Bed rental, 7 days paid → **extended** → returned late and **damaged** | Extra days and damage invoiced and paid, deposit refund flagged |
| 4 | Wrong invoice → **void** → **credit note** (381, referencing the original) to the tax system | Original void, credit note accepted |
| 5 | Late cancellation → fee draft → issued → paid | Paid, fee taxed as standard |

### Broken links found by walking the cycles, and fixed

| Link | Before | Now |
|---|---|---|
| Device return | No way to record it, so rentals never ended | Return (condition, damage), extension, overdue and "pickup due" lists for the coordinator and the driver |
| Episode on hold | NEWS2 ≥ 7 put care on hold forever; nurses could still check in | Hold and resume (doctor, supervisor, coordinator); check-in and late alerts paused while on hold |
| Home-care orders | Lab, imaging and pharmacy orders were done but **never invoiced** (lost revenue); a delivered device started no rental | Orders billed on the periodic or final invoice at the payer's price, with insurer cover per service; an equipment delivery starts a rental billed by day |
| Outpatient result later | A sample taken without a result could never get one (404) | Resulted from the department worklist and released to the patient (critical results go to the on-call doctor) |
| Wrong invoices | No void, no credit note | Void with reason; issued invoices get a mirrored credit note sent to the tax system; billed items return to billing |
| Insurer share | Nowhere to record the insurer's payment | Insurer payments (screen or ERP `method: INSURER`), and an open insurer balances list |
| Insurer refusal | The request stayed stuck in "waiting for the insurer" | Re-quote as cash |
| Account closure | No closed state | Closes automatically once discharged, devices back, final billing done and every invoice issued and paid |
| Pharmacy | No pharmacist account, so pharmacy orders could not be completed | Pharmacist added to the demo staff |

## E2E scenario (browser)

1. **Owner** turns on e-invoicing (mock mode) and fills in the seller details from the settings screen.
2. **Owner** creates an ERP API key.
3. **Patient** signs up with an SMS code, requests a lab test and completes the file with GPS from the phone.
4. **Call center** registers a nursing request by phone for a new patient.
5. **Coordinator** prices the app request. The patient approves the price in the app, and the coordinator assigns the lab tech.
6. **Lab tech (phone):** on my way → check-in by GPS with consent signed at the door → result and cash payment.
7. **Patient** sees the result and the tax invoice with the QR code.
8. **Coordinator** routes the nursing request to a doctor assessment.
9. **Doctor (phone)** opens the episode from the assessment, approves a care plan and orders a lab panel.
10. **Lab worklist:** a critical result goes to the doctor, who acknowledges it.
11. **Coordinator** publishes the roster from the care plan.
12. **Nurse (phone):** check-in → abnormal vitals (NEWS2 = 5) → escalation → note → handover and check-out.
13. **Coordinator alerts** show the open NEWS2 escalation.
14. **Finance:** weekly billing run → issue → payment → the e-invoice is accepted and the QR is printed on the invoice.
15. **ERP API:** pulls invoices with tax and the e-invoice, acknowledges the posting, and posts a payment idempotently.
16. Every screen fits a 390 px phone with no sideways scroll.
17. **Closing (since this round):** the doctor orders an oxygen device; the driver delivers it; the doctor puts care on hold, then resumes it, and discharges the patient. The driver collects the device and finance runs the final invoice. Once everything is paid, the account closes.
18. The browser logs no JavaScript errors during the run.

## Defects found and fixed in this round

| # | Severity | Defect | Fix |
|---|---|---|---|
| 1 | **High (privacy)** | Several read endpoints answered without a staff identity: patient list and file, requests, visits, episodes, shifts, orders, escalations, notifications, consents. | All of them now require a signed-in staff member. A security test suite covers every staff endpoint. |
| 2 | High | Time-based rules (late check-in alert, escalation deadlines, quote expiry) only ran when someone called the sweep endpoint by hand. | The server runs them in the background with the e-invoice queue and webhooks. The manual endpoints are now limited to coordinators and supervisors. |
| 3 | Medium | The invoice list and invoice detail were readable without finance or coordinator rights. | Restricted to those roles. |
| 4 | Low | Malformed JSON or a body over 1 MB returned **500 Internal error**. | Now returns 400 (not valid JSON) or 413 (too large). |

After the UI/UX redesign was merged, the browser suite was updated for the renamed buttons and re-run: **17/17 pass**, with no sideways scroll on phones and no JavaScript errors. The runner now stops its own server process tree and refuses to start if the port is busy, because a leftover server from an earlier run had made results unreliable.

Earlier rounds (Product Owner and Business Analyst reviews, settings) fixed further issues; see `docs/ba-gap-analysis.md` and `docs/product-backlog.md`.

## Known limitations (not defects, need decisions or setup)

| Area | Status |
|---|---|
| Staff sign-in | **Demo only:** staff pick their name, with no password. Real login (passwords or SSO, sessions) is required before going live. The demo login list of staff names is public on purpose. |
| SMS | No SMS gateway. The patient's sign-in code is shown on screen in development and hidden when `NODE_ENV=production`. A gateway (e.g. a local Jordanian SMS provider) must be connected. |
| JoFotara live | Tested with the mock and with a simulated JoFotara server. A first **real** invoice must be validated against the tax department with real Client ID and Secret Key (see `docs/erp-and-tax-integration.md`). |
| Secrets | Set `HC_SECRET_KEY` on the server. Without it, saved credentials are encrypted with a development key (the settings screen warns about this). |
| Database | SQLite (`node:sqlite`) is fine for a pilot on one server. For production, move to PostgreSQL with backups. The SQL is portable. |
| Background jobs | They run inside the web process every 30 s. A single server instance is assumed. |
| Load and performance | Not load-tested. The pilot scale (tens of staff, hundreds of patients) is far below the limits of this design. |
