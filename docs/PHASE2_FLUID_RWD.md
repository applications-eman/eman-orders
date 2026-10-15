# Phase 2: Fluid responsive architecture (scope of work)

Status: PLANNED. Starts only after the switch-over, once the balance and money side is stable (see "Start conditions").
Owner: Shafeeq. Prepared 16 Oct 2026. Rough effort numbers are estimates, not promises.

## 1. Goal

One layout that adapts by itself to any phone, tablet or computer (iPhone, Android, Safari, Chrome, Edge, home-screen app),
instead of three fixed layouts and many one-off fixes. Built on relative units, Flexbox/Grid and container queries.

## 2. What is NOT touched

- Order, payment, credit note, tray and balance logic.
- The server, the database and everything that posts to Odoo.
- Printed paper layouts (A4 day statement, receipt slip): paper has a fixed size, so they stay as they are.
- Look and feel (colours, fonts, icons, wording) stay the same unless the owner asks.

## 3. Where we are today (measured on public/index.html, 1,491 lines)

| Item | Today | Target |
|---|---|---|
| Fixed pixel values in the style sheet | 728 | only hairlines, borders, shadows |
| Fixed pixel values inside screen templates (script) | 171 | none for sizes and spacing |
| Inline style attributes in screen templates | 202 | moved into named classes |
| Font sizes written in px | 97 | all in rem/clamp (text follows the user's text-size setting) |
| `rem` units | 0 | the base for type and spacing |
| `clamp()` fluid sizes | 5 | used for type scale, spacing, paddings |
| Container queries | 0 | on cards, tiles, list rows, tables, panels |
| Fixed-width columns / widths in px | 58 widths, 10 grid columns | fluid (`minmax`, `fr`, `auto-fit`) |
| Layout switches by screen width | 3 fixed (760 / 900 / 1100 px) | at most 1-2 documented switch points |
| Layout decisions made in JavaScript by width | 5 places (phone quantity card, cart drop-down, etc.) | CSS-driven; one shared helper if JS is unavoidable |
| iPhone-only special cases | bottom space under the bar (24 px minimum) | one safe-area system used everywhere |
| Tablet test steps failing | 10 (cause not yet investigated) | 0 |

## 4. Principles

1. Relative units: `rem` for type and spacing, `clamp()` for fluid steps, `%`/`fr`/`minmax()` for widths. `px` only for 1 px lines.
2. Components adapt to the box they sit in (container queries), not only to the screen width.
3. One navigation pattern that changes by available space: bottom bar, side rail, full sidebar. No per-screen tweaks.
4. Safe areas, keyboard and browser bars handled in one place (`svh/dvh`, `env(safe-area-inset-*)`, page scrolls as one normal page).
5. Tap targets at least 44 x 44 px. Text readable and nothing clipped at 130% text size.
6. No horizontal scrolling at any width from 320 px to 1920 px.
7. Every change is checked in a Chromium and a WebKit browser and on real devices by the owner.

## 5. Work packages

| # | Package | What it covers | Est. sessions |
|---|---|---|---|
| A | Diagnose tablet | Find out why 10 tablet test steps fail (layout bug or test bug) and write it down. Do this first. | 0.5 |
| B | Foundation | Design tokens (type scale, spacing scale, radii) in rem/clamp; one breakpoint policy; safe-area system; page-scroll model; shared helper for the few width checks in JS. | 1-2 |
| C | Navigation | Bottom bar / rail / sidebar as one component that adapts; centre New button; header; More sheet; cart panel (desktop panel, tablet and phone drop-down) unified. | 1 |
| D | Shared components | Cards, stat tiles, list rows, tables, forms, buttons, chips, modals and sheets, confirm window, toasts, notification pop-over: convert to rem and container queries. | 1-2 |
| E | Screens, group 1 (daily use, phone-first) | See section 6, group 1. | 2 |
| F | Screens, group 2 (office use) | See section 6, group 2. | 1-2 |
| G | Screens, group 3 (admin) | See section 6, group 3. | 1 |
| H | Hardening | Full device matrix, text-size test, dark/light, standalone iPhone app, Chrome/Edge/Safari; fix findings; remove the old fixed-size rules. | 1-2 |

Total estimate: about 9-13 working sessions. Packages A-D come before any screen work.

## 6. Screens in scope

Priority 1 = used all day on phones. Priority 3 = admin, mostly on computers.

### Group 1 (priority 1)
| Screen | Notes for this project |
|---|---|
| Landing and Login | Hero image, form width, safe areas, keyboard |
| Home | Getting-started checklist, stat tiles, pending list, recent activity, quick buttons |
| New order, step 1 Branch | Big option buttons |
| New order, step 2 Customer | Search + list rows with balance |
| New order, step 3 Incoming trays (pop-up) | Centered pop-up, number box, notes |
| New order, step 4 Product picker | Category chips, pieces-per-packet buttons, product tiles, zoom on desktop and tablet, quantity card on phone |
| Order cart | Desktop side panel, tablet bar and sheet, phone drop-down from the header |
| Pending orders | Cards with countdown |
| Finalize order (pop-up) | Trays taken out number pad, totals |
| Order created / receipt (pop-up) | Print and Done buttons |
| Payments (Receive payment) | Method buttons, split across customers, customer picker |
| Bottom bar, header, More sheet | Part of package C |

### Group 2 (priority 2)
| Screen | Notes |
|---|---|
| Orders list and Order details (pop-up) | Tabs, search, wide table |
| Edit order | Same picker as new order |
| Cancel order and Reverse payment (pop-ups) | Reason field |
| Credit notes | Customer picker, reasons, recent list |
| Day statement list, Preview (pop-up) | On-screen layout only; paper layouts excluded |
| Trays: Overview, Movements, Move trays (pop-up) | Tables, filters |
| Customers: list and customer detail | Balance, trays held, prices |
| Odoo sync | Status table, retry buttons |

### Group 3 (priority 3, admin)
| Screen | Notes |
|---|---|
| Admin: Users and User form (pop-up) | Access toggles list |
| Admin: Products and Product form (pop-up) | Table + form |
| Admin: Customers and prices | Wide price table |
| Admin: Opening trays and trays file upload | Preview table |
| Admin: Data and Odoo | Import, balances, readiness, compare |
| Admin: Audit log | Long table |
| Admin: Settings | Form |

### Shared (covered by packages C and D)
Confirm window ("Cancel this order?", "Log out?"), toasts, notifications pop-over, progress pop-up, installation hint in More.

## 7. Test matrix

- Phones: 320 x 568, 375 x 667, 393 x 852, 430 x 932 (iPhone); 360 x 640, 412 x 915 (Android). Portrait and landscape.
- Tablets: 768 x 1024, 820 x 1180, 1024 x 1366. Portrait and landscape.
- Computers: 1280, 1440, 1920 wide.
- Text size 100% and 130%. Light and dark mode.
- Safari, Chrome and Edge on iPhone; home-screen app on iPhone; Chrome and Edge on Android.
- Automated: the existing server tests, the quick click-through and the full click-through in Chromium and WebKit,
  plus new checks: no horizontal scroll, bottom bar at the bottom edge, tap targets >= 44 px, nothing clipped at 130% text.
- By the owner on real phones: the home-screen iPhone app, and at least one Android phone, before sign-off.

## 8. Done means

1. Fixed pixel values for sizes and spacing are gone except 1 px lines, borders and shadows. Font sizes are rem/clamp.
2. Container queries are used by the shared components (cards, tiles, list rows, tables, panels).
3. At most 1-2 documented layout switch points; no per-screen or per-device special cases.
4. The tablet click-through passes with 0 failing steps, and so do phone and computer, in Chromium and WebKit.
5. No horizontal scroll from 320 to 1920 px; bottom bar fully visible on iPhone, Android and tablet.
6. Balances, payments, credit notes and trays behave exactly as before (server tests unchanged and green).
7. The owner signs off on real devices.

## 9. Start conditions (all must be true)

1. The switch-over is done: the final import from 15 Oct onward is posted and every customer's balance is checked against Odoo.
2. "Compare balances" shows 0 differences on the checks of 5 working days in a row (proposed).
3. No open money, balance or posting problem.
4. The owner says "go" for Phase 2.

## 10. How it will be delivered (proposal)

- Work happens on a separate branch and is tried on a preview address first, so the live app is not disturbed while screens are being converted.
- Screens are released in groups (1, then 2, then 3), each after the owner has looked at it on his own phone.
- The old fixed-size rules stay until the group is signed off, then they are deleted.

## 11. Risks

- iPhone home-screen app behaves differently from Safari and cannot be fully reproduced outside a real phone (the bottom-bar problem took many rounds). Mitigation: real-device checks per group; the "Screen info" line in More stays until sign-off.
- Visual regressions on screens that look fine today. Mitigation: before/after screenshots for every screen in the matrix.
- Tablet failures may point to a deeper layout problem. Mitigation: package A first.

## 12. Decisions needed from the owner

1. Which devices matter most (the phones and tablets your team really uses)?
2. Is a preview address acceptable before going live, or should every change go straight to the live app as now?
3. Minimum supported old phones (older iPhones or Android versions)?
4. Should the printed A4 and slip layouts stay as they are (recommended)?
