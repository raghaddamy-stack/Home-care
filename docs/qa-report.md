# QA report — تقرير فحص النظام

**Date:** 2026-11-10 · **Branch:** `claude/dazzling-edison-qu99yx`

## Summary

| Layer | What | Result |
|---|---|---|
| Unit (domain rules) | NEWS2, pricing and tax, cancellation and no-show policy, rosters and working-time limits, billing periods, consent, escalation timers, state machine | 35 / 35 pass |
| API integration | Full flows through the HTTP API on a fresh database per test: intake → quote → schedule → visit → invoice; home-care episode → roster → shifts → billing; patient app; owner settings; e-invoicing; ERP API; webhooks | 62 / 62 pass |
| Security | Every staff endpoint refuses anonymous callers; role checks; patient isolation; ERP keys; malformed or oversized input | 28 / 28 pass |
| End-to-end UI (browser) | 17 steps across every persona on a real server, in desktop and phone sizes (`e2e/run.sh`) | 17 / 17 pass |
| Exploratory | Hostile and invalid input probes (bad ids, SQL-like strings, script tags, negative amounts, wrong types, 2 MB bodies) | All handled with 4xx after fixes |

Run it yourself:
```bash
cd backend && npm test        # 125 API/unit tests
./e2e/run.sh                  # browser walkthrough of every persona; report in e2e/out/report.md
```

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
17. The browser logs no JavaScript errors during the run.

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
