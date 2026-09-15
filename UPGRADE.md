# Upgrading to 3.2

No migration, no new stack, no schema rewrite. Everything is code and one new
row on the Roles tab. Your data stays exactly where it is.

3.2 is a correctness-and-reach release: it fixes one arithmetic bug that was
quietly understating every burn rate, stops the chat webhook from being called
while the script lock is held, and connects six things that were already written
but had no button anywhere in the app.

## Deploy order

1. **Copy every file into the Apps Script project**, all 13 `.gs` files plus
   `WebForm.html` and `Welcome.html`.

2. **Run `IT Hallway → 1. Run setup`.** Safe to re-run; it never touches values
   you have set. It adds the new permission row, the dropdowns for the Action
   and Status columns, and nothing else. No new sheet columns this time.

3. **Run `IT Hallway → 2. Check my configuration`.** Two new checks. One of them
   (the testing-bucket reconciliation, below) may well find something.

4. **Deploy a new version of the web app** so people get the new front end.

`installTriggers()` does not need re-running. No new triggers.

## The one arithmetic fix, and what it will do to your numbers

Out-of-stock stretches were being measured with an unclamped subtraction, so a
stretch that started *and* ended before the reporting window produced a negative
number, which then cancelled out genuine outages inside the window.

Two consequences, both of them silent:

- Burn rates read low, because the denominator included days the shelf was
  empty. On a worked example: 0.44/day reported where the real figure was
  0.50/day, and 18 days of cover shown where there were 16.
- The **"ran out during this period"** warning did not appear on some of the
  exact items it was written for, because the total it checks had gone negative.

**Expect burn rates to rise slightly after you deploy this**, especially for
anything that has run out at some point. That is the fix working. Nothing about
your logged data changes, only how it is read.

## Webhooks no longer block the shelf

Chat and email were being sent from inside the script lock. One unresponsive
webhook meant the next person at the shelf waited out the whole lock timeout and
then got *"Someone else is saving right now."* With
`alerts.notifyEveryTransaction` switched on, that was an outbound HTTP call
inside the lock on every single take.

Everything now goes through `queueNotice()` and is flushed by `withLock()` once
the lock is released. If you had that setting off because the app felt slow, it
is worth trying again.

There is also a comment on `withLock()` explaining why nesting it is never
safe, `resolveTestingBatch` was calling `requestReorder`, whose `finally`
released the lock the outer block was still inside.

## Six things that existed with no way to use them

All of these were already implemented server-side in 3.1 and unreachable:

| What | Where it is now |
|---|---|
| Undo a mistaken movement | A button on the confirmation, plus the new **Log** tab |
| Reverse anything (manager) | **Log** tab, on any row |
| See recent activity | The **Log** tab, and a per-item list in the item sheet |
| Cancel a reorder | **Cancel** on any order row |
| Retire an item | **Retire this item**, at the bottom of the edit sheet |
| Acknowledge an alert | **Seen**, at the top of the **Orders** tab |

**Undo is the one that matters.** Wrong taps happen at a shelf, and before this
the only fix was to ask an admin to edit the spreadsheet, which in practice
meant the wrong entry stayed and the burn rate was wrong in a way nobody could
see. It is deliberately narrow: your own movement, only a kind that reverses
cleanly (never a disposal or anything touching money), and only for
`app.undoMinutes`. The original row is kept and marked, never deleted.

This needs the new **`txn.undoOwn`** permission, which Setup grants to staff and
above, as wide as `item.take`, because whoever can make the mistake should be
able to fix it. Set the staff column to No on the Roles tab if you disagree.

## Weeks of supply, on the shelf tag

The headline figure used to live only on the Usage tab. It is now on each tag,
under the count: **`14` · `about 3 weeks` at 2.1/week**.

It arrives in a third load phase, after the stock list is already on screen, so
first paint is unchanged. The figure is cached for
`tech.coverCacheSeconds` (15 minutes), warmed every morning by the daily check
and again by the weekly report, and calculated from the same pass as the Usage
tab so the two can never disagree. There is a **Recalculate usage rates now**
menu item for after a bulk tidy-up of the Inventory tab.

## Forecasting changes worth knowing about

- **Slow movers get a count instead of a blank.** A projector lamp taken twice a
  year will never clear `minEventsForRate` at any window length, so 3.1 showed
  nothing for it. Now it says *"2 taken over the 214 days on record"*, which is
  the number you would actually plan a yearly order from.
- **A second, shorter window** (`report.recentWindowDays`, default 30) runs
  alongside the main one and says only whether something is *picking up*,
  *steady* or *slowing down*. No seasonal model, and it stays silent below two
  recent movements. This is the honest answer to the 90-vs-30 window question in
  the 3.1 notes: leave the main window at 90 for sample size and let the short
  one handle recency. **Do not** drop `report.usageWindowDays` to 30 any more.
- **"Running out soonest" now includes items that are out or below minimum even
  without a measurable rate.** An empty shelf is a fact; it should not need three
  movements to qualify for the list that warns you about it.
- **It sorts by cover including stock already on order.** Five days of cover with
  forty arriving tomorrow is not the emergency.
- **Lead times use the median, not the mean,** and report the worst delivery seen
  alongside. A threshold built on a mean is short about half the time, and one
  60-day backorder used to inflate every suggestion afterwards for good.
- **Overdue deliveries are flagged**, in the app, the dashboard, the weekly
  report and a daily chat message. The forecast counts an ordered item as stock
  on the way, so cover stayed optimistic forever on something that was never
  coming.
- **"More returned than taken" is now reported** instead of silently hiding the
  item. Because the net figure clamps at zero, one mistyped return used to make
  an item report *"nothing used yet"* and vanish from the forecast with no
  visible cause.

## Returns: one state and one route that were missing

- **Straight out from the bench.** The resolve sheet has a third column now. A
  tested-good UPS often does not go back on the shelf at all, it goes to
  whoever is waiting for it. Recording that as *back to shelf* then *take*
  invented a shelf visit that never happened and logged a phantom pull that
  inflated the burn rate for exactly the items that cycle through the bench. It
  is one movement, `Issued from Bench`, with the destination recorded.
- **Damaged consumables have somewhere to go.** The second return button now
  reads *"Damaged, to the bench"* for a consumable. A kinked cable previously
  had no route but back onto the shelf.
- **Warranty batches get chased.** 3.1 correctly stopped nagging a tech every
  morning about a batch sitting at a vendor, and then nothing chased it at all,
  so its units stayed counted as unavailable until somebody remembered. There is
  now a weekly message after `bench.vendorChaseAfterDays` (default 21), aged
  from the day it was sent, and the bench row shows the days-away count.

## New health check: the testing bucket

`Qty In Testing` is the one number in the system that can rot silently, nobody
eyeballs it the way they would a count of boxes on a shelf, and every unit stuck
in it is a unit the forecast believes is unavailable. `checkConfiguration()` now
compares it against the sum of open bench batches and names any item where the
two disagree, with both figures.

**Run the configuration check after deploying.** If it finds drift, resolve or
cancel the stale batches and then run a stock correction on the item.

## Suggested order quantities

Where an item has a measured rate, `Flag for reorder` no longer just tops up to
the *Reorder To* figure somebody typed once. It asks for enough to cover the
delivery time, plus the spare-cover margin, plus `reorder.coverDays` (default
30) of actual demand, or the plain top-up figure, whichever is larger. On a
worked example the top-up figure was 6 and the measured figure was 40.

It reads the cached rates only, so asking for a suggestion never costs a pass
over the transaction log. Set `reorder.coverDays` to 0 to go back to topping up.

## Extensibility, for when you next add something

Four things moved out of scattered code and into tables in `Config.gs`,
alongside the `ACTIONS` table that was already there:

- **`ITEM_CLASSES`**: a class is now a row with its own label, return route and
  "may staff shelve this themselves" flag. It used to be a ternary in
  `itemClassOf()`, a branch in `putBackOnShelf()` and two functions in
  `WebForm.html`, so a third class meant editing five places in two languages.
  `bootstrap` ships the table, so the front end reads the same rules the server
  enforces.
- **`TESTING_STATUS`**: `open` / `onBench` / `atVendor`, replacing inline
  quoted status names across two files.
- **`ACTIONS`** gained `consumes` and `disposes` flags, so what counts as demand
  is declared per action rather than hardcoded as `action === 'Take'`.
- **The Manage People screen reads the role list from the Roles tab.** It
  hardcoded five names, so a role added by adding a column was invisible in the
  only place you could assign it.

## Smaller things

- Errors from an action appear **inside the open sheet** and stay there, not only
  in a toast that times out after four seconds.
- The **destination carries over** from your last pull. With
  `take.requireDestination` on, that was an extra mandatory tap every time for a
  value the app already knew.
- **A "Yours, recently" section** at the top of the stock list, from the last six
  items you touched. Kept in your browser, not the sheet.
- `window.prompt` is gone. Declining, cancelling, reversing and retiring all use
  the same reason sheet.
- Receiving a pallet no longer fails with an error about the *take* limit.
- `refresh()` stopped reading the Reorders sheet twice per save, and
  `computeUsage()` stopped reading it twice per report.
- The Usage tab's two full passes over the transaction log became one.

## Tests

`tests/` holds a Node harness that stubs the Apps Script APIs and runs the real
`.gs` files against a fake spreadsheet, 89 assertions covering the burn-rate
arithmetic, the undo rules, the three-way bench resolve, lock nesting, whether
any webhook fires while the lock is held, and how many times each request reads
each tab.

```
cd tests && node run.js
```

It needs Node and nothing else, and it does not touch your spreadsheet. If you
change the forecasting arithmetic, run it first.

## Rollback

Every change is in code. Re-paste the 3.1 files and everything works; the extra
Roles row is harmless to leave in place and the old code ignores permissions it
does not know about.
