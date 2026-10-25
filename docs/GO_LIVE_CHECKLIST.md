# Go-live checklist (plain language)

Owner: Shafeeq. Written 18 Oct 2026. Update this file whenever a step is done.

## The goal
Replace the old ordering app (Vercel + Supabase) with the new Eman Orders app, so that:
- Orders, trays and branches live in the new app's own database.
- Invoices, payments and credit notes (discounts) are posted automatically into Odoo (Accounting only, SAR, no VAT), under the name of the person who made them.
- Every customer's balance is the same in the new app and in Odoo. Nothing is claimed as matching without a per-customer check.
- It is production ready: safe to use every day by the team, with a way back.

## What goes where
| In Odoo (posted automatically) | Only in the app's database |
|---|---|
| Invoices (when an order is finalized), with cash rounding "Round to 1 SAR (0.50 up)" | Orders that are not finalized yet, and cancelled orders |
| Payments (cash and transfers), matched to the oldest invoices first | Trays (append-only ledger) and branch stock |
| Credit notes (discounts) on account 500100, no rounding | Branches, users, access rights, audit log |

## Why the DEMO Odoo first
LIVE stays read-only until the owner says "go" in words. The DEMO company ("Eman Bakery Demo") is the rehearsal:
history is imported there and checked customer by customer, and the app is tested against it. Mistakes in DEMO cost nothing.

## Done so far
- [x] Old-app history 1-14 Oct imported into DEMO, posted and matched oldest-first; all 90 customers match the old app (total SAR 1,065,300.10).
- [x] Orders app built (create, finalize, payments, credit notes, trays, day statement, queue and retry, admin console).
- [x] Cash rule: today only, one customer. Transfers: changeable date, split between customers.
- [x] Phone, tablet and desktop layouts; confirmation windows; own Gregorian calendar.
- [x] Phase 2 (fluid layout) planned: docs/PHASE2_FLUID_RWD.md.

## Still to do (in this order)
1. [ ] Deploy the latest version on Render (Auto-Deploy is Off, so use Manual Deploy). Check the commit number.
2. [ ] Old app: confirm the "System update in progress" notice is removed, so the team can work (needs the owner's word).
3. [ ] Check the new app has no test orders, payments or credit notes (they would have posted into DEMO and break the match). If any exist: cancel them in Odoo and reset the app database.
4. [ ] Test round on DEMO (see "Test round" below). All checks must pass.
5. [ ] Choose the switch-over day. On that day, in this order:
   1. Freeze the old app (nobody enters anything).
   2. Import everything from 15 Oct up to that day into DEMO (invoices, payments, credit notes), post, match, and prove all 90 customers equal the old app.
   3. New app, Admin > Data and Odoo: test connection (must say Eman Bakery Demo for the rehearsal), Load starting balances from Odoo, Continue numbers, Compare balances (0 differences).
   4. Admin > Opening trays: load the trays file and branch stock as of that day (trays move every day in the old app, so use that day's numbers).
   5. Team starts in the new app.
6. [ ] LIVE Odoo: only after the owner says "go". Replicate the setup (journals, accounts, products, customers, cash rounding, users and their own API keys), confirm the company name, then repeat step 5 on LIVE. Decision needed: load the full history into LIVE too, or only opening balances.
7. [ ] After a stable period (5 working days with 0 differences): Phase 2.

## Test round on DEMO (nothing counts as passed until checked in Odoo)
| # | Test | Expected result in Odoo and in the app |
|---|---|---|
| 1 | Create an order, finalize it | One invoice appears in Odoo DEMO for the right customer, right products and quantities, created by the right user, total rounded to whole riyals; the invoice number is shown on the order |
| 2 | Finalize twice / retry | No second invoice (same reference is checked first) |
| 3 | Cancel an unfinalized order | Nothing is posted |
| 4 | Credit note (discount) | A credit note on account 500100, exact amount, no rounding, matched to the oldest open invoice |
| 5 | Cash payment | One payment, today's date, one customer, matched oldest invoice first |
| 6 | Transfer split between 2-3 customers, backdated | One payment per customer with the chosen date, each matched oldest first; extra stays as credit |
| 7 | Reverse a payment | Cancelled in Odoo (never deleted); balance goes back up |
| 8 | Odoo unreachable (wrong address in a test copy) | Finalized items wait in the queue; after Odoo is back, Retry posts them once |
| 9 | Each user (Alsaman, Sidheek, Jasil, Shinaj, Akhil) posts one invoice | Odoo shows each person as creator |
| 10 | Trays in, trays out, move trays between branches | Ledger and branch stock correct; nothing appears in Odoo except the note on the invoice |
| 11 | Compare balances after the test | 0 differences for all customers (test records are cancelled or accounted for) |
| 12 | Day statement | Lists that customer's invoices and credit notes of the day only |
| 13 | Phone check by the team (iPhone and Android) | Every screen usable; keyboard, bottom bar and pop-ups behave |

## Production-ready checklist (to confirm before handover)
- [x] Where the database lives: a new Supabase project (ref rifycduhnpfnfgkqfrrb), separate from the old app's project. Confirmed by the owner on 25 Oct 2026.
- [ ] That Supabase project's plan (a free project can pause itself after a period of no use), backups, and a restore test. Also whether the Render web service is on a free plan that sleeps.
- [ ] A restore test: can the database be brought back from a backup.
- [ ] Strong admin password changed from the first one; every user has their own app password and their own Odoo key; keys never in chat or files.
- [ ] Only one copy of the app runs against one database.
- [ ] A rollback plan: the old app stays untouched and available for a few days after the switch.
- [ ] Short training for the team (create order, finalize, payment, credit note, trays).
- [ ] A named person to call when something fails, and a routine: every morning check Odoo sync (nothing waiting or failed) and Compare balances.
- [ ] Handover note: where each secret is kept, how to deploy, how to restore.
