# UI/UX review (demo readiness)

Every screen was audited per persona at desktop 1360×860 and phone 390×844, in light and dark mode, with realistic data
(requests in every board column, a live episode with a checked-in shift and NEWS2 vitals, a late shift, escalations, ratings,
visit and periodic invoices, e-invoices in MOCK mode). Before/after pairs are in [`docs/ui-ux/`](ui-ux/).

## Design decisions

- **Tokens first** (`web/src/styles.css`): colour (light + dark), a type scale (12/13/15/16/18/22/28/36), spacing (4–48),
  radii (6/8/12/16/22), three elevation levels, a focus ring, and a control height of 40px (44px on phones / touch).
- **Brand**: kept the teal family and Readex Pro / IBM Plex Sans Arabic / IBM Plex Mono. Added a small house-and-cross logo mark
  and an Arabic sub-brand ("رعاية طبية منزلية") instead of the Latin "Home Care" mono tag. No gradients except a deep-teal hero.
- **Icons**: a tiny inline-SVG set (`web/src/icons.tsx`), no icon fonts or CDNs.
- **Numbers**: all dates/times now use Latin digits (`ar-JO-u-nu-latn`) so they match amounts, IDs and codes (they were mixed
  Arabic-Indic and Latin before). Amounts and IDs use the mono font with tabular figures.
- **Phones**: the main nav, the field-app tabs and the patient-app tabs become a bottom tab bar; data tables turn into stacked
  cards; the board and KPI strip scroll sideways with snap; the main action of a long form is sticky above the tab bar.
- **States**: one `Loading` skeleton and one `Empty` component (icon + title + next step) used everywhere instead of "تحميل…" / "فاضي".

## Findings

| Screen | Issue | Fix | Done |
|---|---|---|---|
| Login | No brand, patient and staff paths look alike, 12 English names with role hints in one long list | Two-panel branded entry: teal hero with a clear patient card; staff grouped by department with avatars and Arabic roles; demo note | Yes |
| Patient sign-in | Same generic card as staff login, no sense of steps | Dedicated auth card with logo, 2-step indicator, privacy line, large OTP input | Yes |
| App shell | Topbar wraps to 2–3 rows on phones; Latin "Home Care" tag; text "خروج" button | Logo + Arabic sub-brand, icon tabs, avatar chip, icon logout; bottom tab bar on phones; single-view roles hide the nav | Yes |
| All | Dates in Arabic-Indic digits next to Latin amounts and IDs | Latin digits for all formatted dates/times | Yes |
| All | "تحميل…" text and "فاضي" empty states | Skeleton loader and friendly empty states with the next action | Yes |
| All | Touch targets 32–40px on phones (chips, segmented controls, refresh, checkboxes) | 44px minimum on phones / coarse pointers, verified by script | Yes |
| All | Focus state only on some controls | Consistent focus ring on inputs, `:focus-visible` outline on buttons | Yes |
| Call center | Backend notes shown in English ("Missing: dob, gender…") | Translated to Arabic (`noteAr`) | Yes |
| Call center | No guidance before lookup, weak footer | Helper line, search icon, estimate shown large with service count | Yes |
| Coordinator board | Columns visually identical; "فاضي" empties; plain search | Column colour dots, per-column empty text, search with icon, amount aligned end | Yes |
| Coordinator board (phone) | 7 KPI tiles stacked over 4 rows push the board off screen | KPI strip scrolls sideways; board columns 84vw with snap | Yes |
| Coordinator drawers | Close "✕" glyph; phone number not tappable | Icon close button; `tel:` link; history notes translated | Yes |
| Episodes | Care plan in English ("12h × 24h/day × 3d"); table squashed on phones | Arabic plan text; table stacks into cards on phones | Yes |
| Alerts | Escalation level in English ("MEDIUM", "OPS") | Arabic level labels; clearer late-shift line and "أرسل البديل" | Yes |
| Staff names | Demo names include English role hints ("Rana (RN)") next to Arabic roles | Display name strips the hint everywhere (data unchanged) | Yes |
| Field app | Looked like a desktop list; no greeting/context; small meta | Greeting with date and role, icon meta (time, address), state hint, 48px primary per state, sticky main action, bottom tabs | Yes |
| Field app (nurse) | Vitals in one column on phones (7 long rows) | 2-column numeric vitals grid on phones | Yes |
| Field app (doctor) | Plan summary in English units | Arabic summary | Yes |
| Patient app | Stepper bars without numbers; status not emphasised | Numbered stepper with checks, status line with icon, greeting card with "اطلب خدمة" | Yes |
| Patient app | Visit code blended into the card | Dashed code tile with large spaced digits | Yes |
| Patient file | Invoice could not be printed from the patient app | Print / save-as-PDF button under the invoice | Yes |
| Finance | Invoice table wraps into tall unreadable rows on phones | Stacked cards with labels on phones; amounts right-aligned, nowrap on desktop | Yes |
| Finance drawer | Toggle button for lines / tax invoice unclear | Segmented control + status pill + print icon | Yes |
| Tax invoice | Looked like a card, not a document; print kept drawer chrome | Letterhead (logo, seller, TIN), "فاتورة ضريبية / Tax invoice", meta grid, numbered lines, totals box, QR, footer; A4 print shows only the invoice | Yes |
| E-invoice monitor | No explanation; table not responsive | Subtitle, stacked table on phones | Yes |
| Owner settings (phone) | Changes panel and Save button at the very bottom of a long page | Sticky save bar when anything changed; pill-style group nav | Yes |
| Integrations | Plain empty states | Icon empty states, labelled scopes, icon buttons | Yes |
| Dark mode | Hero/brand only defined for light | Dark tokens for hero, tint, ink; checked every screen | Yes |
| Horizontal overflow at 390px | None found before or after | Verified on every screen by script | Yes |
| Console | Only an expected 404 when the call center looks up a new national ID (API answers 404 = new patient) | Left as is (backend contract) | n/a |
