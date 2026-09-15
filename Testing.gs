/**
 * Testing.gs — the bench queue.
 *
 * A batch is "3 × APC RBC17, came back from Science Lab 204, returned by Dana".
 * No serial numbers, no unit identity. A tech opens the queue, tests the units,
 * and splits the batch: some back to the shelf, some to disposal. Partial
 * resolutions are fine — the batch stays open with whatever's left.
 */

function getTestingQueue(departmentId) {
  getCurrentUser();
  var data = readSheet(CONFIG.SHEETS.TESTING);
  var dept = cleanText(departmentId, 20);

  return data.rows
    .filter(function (row) {
      if (!cell(row, data.col, 'Batch ID')) return false;
      var state = CONFIG.TESTING_STATUS[cell(row, data.col, 'Status')];
      if (!state || !state.open) return false;
      if (dept && cell(row, data.col, 'Department') !== dept) return false;
      return (Number(cell(row, data.col, 'Qty Pending')) || 0) > 0;
    })
    .map(function (row) {
      return {
        batchId: cell(row, data.col, 'Batch ID'),
        created: formatDate(cell(row, data.col, 'Created')),
        itemId: cell(row, data.col, 'Item ID'),
        itemName: cell(row, data.col, 'Item Name'),
        pending: Number(cell(row, data.col, 'Qty Pending')) || 0,
        cameFrom: cell(row, data.col, 'Came From'),
        returnedBy: cell(row, data.col, 'Returned By'),
        notes: cell(row, data.col, 'Notes'),
        resolutionNote: cell(row, data.col, 'Resolution Note'),
        stale: daysSince(cell(row, data.col, 'Created')) >= setting('bench.staleAfterDays'),
        status: cell(row, data.col, 'Status'),
        sentToVendor: formatDay(cell(row, data.col, 'Sent To Vendor')),
        vendorRef: cell(row, data.col, 'Vendor Ref'),
        ageDays: daysSince(cell(row, data.col, 'Created')),
        // Days since it went to the vendor, which is the clock that matters for
        // a warranty batch — its bench age stopped being interesting the day it
        // left the building.
        awayDays: daysSince(cell(row, data.col, 'Sent To Vendor')),
        chaseVendor: CONFIG.TESTING_STATUS[cell(row, data.col, 'Status')].atVendor
          && daysSince(cell(row, data.col, 'Sent To Vendor')) >= setting('bench.vendorChaseAfterDays')
      };
    })
    .sort(function (a, b) { return b.ageDays - a.ageDays; });
}

/** Quantity summary only. Vendor stock is never labelled as physical bench stock. */
function testingTotals(batches) {
  var totals = {};
  batches.forEach(function (b) {
    var t = totals[b.itemId] || (totals[b.itemId] = { bench: 0, vendor: 0 });
    t[b.status === 'Out for warranty' ? 'vendor' : 'bench'] += b.pending;
  });
  return totals;
}

/**
 * Resolve some or all of a batch.
 *
 * payload: { batchId, toShelf, toIssue, toDispose, destination, disposalReason, notes }
 * The three together must not exceed what's pending.
 *
 * WHY THERE ARE THREE. A tested-good UPS often does not go back on the shelf at
 * all — it goes straight out to the lab that is waiting for it. Until 3.2 the
 * only way to record that was Return to Shelf followed by a Take, which
 * invented a shelf visit that never happened and, worse, logged a phantom pull
 * that inflated the burn rate for exactly the item class that cycles through the
 * bench. 'Issued from Bench' is one movement: out of the testing bucket, never
 * onto the shelf, counted as real demand, with the destination recorded because
 * knowing where it went is the whole point of this system.
 */
function resolveTestingBatch(payload) {
  var user = requirePerm('testing.resolve');

  var toShelf = toQty(payload.toShelf, { min: 0 });
  var toIssue = toQty(payload.toIssue === undefined ? 0 : payload.toIssue, { min: 0 });
  var toDispose = toQty(payload.toDispose, { min: 0 });
  if (toShelf + toIssue + toDispose === 0) {
    throw new Error('Enter how many go back to the shelf, how many go straight out, how many get disposed, or any mix.');
  }

  var destination = cleanText(payload.destination, 120);
  if (toIssue > 0 && !destination && setting('take.requireDestination')) {
    throw new Error('Say where the issued units are going. An admin can make this optional on the Config tab.');
  }

  var disposalReason = '';
  if (toDispose > 0) {
    disposalReason = setting('bench.disposalRequiresReason')
      ? requireText(payload.disposalReason, 'Disposal reason', 200)
      : cleanText(payload.disposalReason, 200);
  }
  var notes = cleanText(payload.notes, 500);

  return withLock(function () {
    var queue = readSheet(CONFIG.SHEETS.TESTING);
    var b = findRow(queue.rows, queue.col['Batch ID'], payload.batchId);
    if (b === -1) throw new Error('That testing batch no longer exists.');

    var batchRow = queue.rows[b];
    var batchState = CONFIG.TESTING_STATUS[cell(batchRow, queue.col, 'Status')];
    if (!batchState || !batchState.open) {
      throw new Error('Someone already resolved that batch.');
    }

    var pending = Number(cell(batchRow, queue.col, 'Qty Pending')) || 0;
    var moving = toShelf + toIssue + toDispose;
    if (moving > pending) {
      throw new Error('Only ' + pending + ' unit(s) are waiting in that batch.');
    }

    var itemId = cell(batchRow, queue.col, 'Item ID');
    var inv = readSheet(CONFIG.SHEETS.INVENTORY);
    var i = findRow(inv.rows, inv.col['Item ID'], itemId);
    if (i === -1) throw new Error('The item for that batch no longer exists.');

    var invRow = inv.rows[i];
    var testing = Number(cell(invRow, inv.col, 'Qty In Testing')) || 0;

    if (moving > testing) {
      throw new Error('The testing count for this item is out of step with the queue. Ask an admin to run a stock correction.');
    }

    // Two movements from the same table the rest of the app uses, rather than
    // a third private copy of the bucket arithmetic.
    var newShelf = Number(cell(invRow, inv.col, 'Qty On Shelf')) || 0;
    var newTesting = testing;
    function move(action, qty) {
      if (qty <= 0) return;
      var r = applyMovement(invRow, inv.col, action, qty);
      newShelf = r.shelfAfter; newTesting = r.testingAfter;
    }
    move('Return to Shelf', toShelf);
    move('Issued from Bench', toIssue);
    move('Dispose', toDispose);
    stampRow(invRow, inv.col, user);
    writeRow(inv.sheet, i, invRow);

    var item = itemFromRow(invRow, inv.col);

    if (toShelf > 0) {
      logTransaction({
        itemId: item.id, itemName: item.name, department: item.department,
        action: 'Return to Shelf', quantity: toShelf,
        shelfAfter: newShelf, testingAfter: newTesting,
        notes: 'Passed testing. ' + notes, reference: payload.batchId, user: user
      });
    }
    if (toIssue > 0) {
      logTransaction({
        itemId: item.id, itemName: item.name, department: item.department,
        action: 'Issued from Bench', quantity: toIssue,
        shelfAfter: newShelf, testingAfter: newTesting,
        destination: destination,
        notes: 'Passed testing, issued without going back on the shelf. ' + notes,
        reference: payload.batchId, user: user
      });
    }
    if (toDispose > 0) {
      logTransaction({
        itemId: item.id, itemName: item.name, department: item.department,
        action: 'Dispose', quantity: toDispose,
        shelfAfter: newShelf, testingAfter: newTesting,
        notes: disposalReason + (notes ? ' — ' + notes : ''),
        reference: payload.batchId, user: user
      });
    }

    var remaining = pending - moving;
    batchRow[queue.col['Qty Pending']] = remaining;
    if (remaining === 0) {
      batchRow[queue.col['Status']] = 'Resolved';
      batchRow[queue.col['Resolved By']] = user.name;
      batchRow[queue.col['Resolved At']] = formatDate(now());
    }
    var note = toShelf + ' to shelf, '
      + (toIssue ? toIssue + ' issued to ' + (destination || 'unspecified') + ', ' : '')
      + toDispose + ' disposed'
      + (disposalReason ? ' (' + disposalReason + ')' : '');
    // Newest first: cleanText truncates the END, so appending meant the most
    // recent note was the one that got cut off after a few partial resolutions.
    batchRow[queue.col['Resolution Note']] =
      cleanText(note + ' | ' + cell(batchRow, queue.col, 'Resolution Note'), 500)
        .replace(/\s*\|\s*$/, '');
    writeRow(queue.sheet, b, batchRow);

    clearItemCache();

    // Scrapping most of a batch is a reorder signal in its own right. Waiting
    // for the shelf to fall under its minimum means ordering replacements a
    // week later than the moment you knew you needed them.
    var ordered = false;
    if (toDispose > 0 && payload.reorderDisposed) {
      try {
        // createReorderRow(), NOT requestReorder(). We are inside withLock, and
        // requestReorder takes the lock itself — whose finally would release the
        // lock this block is still inside. See the note in withLock().
        if (!findOpenReorder(item.id)) {
          createReorderRow(item, toDispose, user.name,
            'Replacing ' + toDispose + ' scrapped at the bench: ' + disposalReason);
          ordered = true;
        }
      } catch (e) {
        Logger.log('Could not raise replacement reorder for %s: %s', item.id, e.message);
      }
    }

    maybeRaiseLowStock(item, user);
    return { item: item, remaining: remaining, reorderRaised: ordered };
  });
}

/** Used when a "Return to Testing" transaction gets voided. */
function closeTestingBatch(batchId, user, note) {
  if (!batchId) return;
  var queue = readSheet(CONFIG.SHEETS.TESTING);
  var b = findRow(queue.rows, queue.col['Batch ID'], batchId);
  if (b === -1) return;

  var row = queue.rows[b];
  row[queue.col['Qty Pending']] = 0;
  row[queue.col['Status']] = 'Cancelled';
  row[queue.col['Resolved By']] = user.name;
  row[queue.col['Resolved At']] = formatDate(now());
  row[queue.col['Resolution Note']] = cleanText(note, 400);
  writeRow(queue.sheet, b, row);
}

/**
 * Some or all of a batch goes back to the vendor under warranty.
 *
 * Without this state, a unit sent off for an RMA sits on the bench as Pending
 * for however many weeks the vendor takes, and the daily backlog nudge chases
 * a tech every morning about something they have already dealt with. People
 * stop reading the nudge, and then it stops working for the batches that
 * really are stuck.
 *
 * The units stay in the testing bucket, because they are still not shelf
 * stock. What comes back gets resolved normally; what does not gets disposed.
 */
function sendBatchToVendor(payload) {
  var user = requirePerm('testing.resolve');
  var vendorRef = requireText(payload.vendorRef, 'RMA or case reference', 120);
  var notes = cleanText(payload.notes, 400);

  return withLock(function () {
    var queue = readSheet(CONFIG.SHEETS.TESTING);
    var b = findRow(queue.rows, queue.col['Batch ID'], payload.batchId);
    if (b === -1) throw new Error('That testing batch no longer exists.');

    var row = queue.rows[b];
    var state = CONFIG.TESTING_STATUS[cell(row, queue.col, 'Status')];
    if (!state || !state.onBench) {
      throw new Error('Only a batch still waiting on the bench can be sent to a vendor.');
    }

    var pending = Number(cell(row, queue.col, 'Qty Pending')) || 0;
    row[queue.col['Status']] = 'Out for warranty';
    row[queue.col['Sent To Vendor']] = formatDay(now());
    row[queue.col['Vendor Ref']] = vendorRef;
    row[queue.col['Resolution Note']] = cleanText(
      'Sent to vendor ' + formatDay(now()) + ' (' + vendorRef + ')'
      + (notes ? ': ' + notes : '') + ' | ' + cell(row, queue.col, 'Resolution Note'), 500
    ).replace(/\s*\|\s*$/, '');
    writeRow(queue.sheet, b, row);

    // The quantity does not move — these units are still not available stock —
    // so the only thing logged is the fact that they left the building.
    logTransaction({
      itemId: cell(row, queue.col, 'Item ID'),
      itemName: cell(row, queue.col, 'Item Name'),
      department: cell(row, queue.col, 'Department'),
      action: 'Send to Vendor', quantity: pending,
      shelfAfter: '', testingAfter: '',
      destination: vendorRef,
      notes: notes, reference: payload.batchId, user: user
    });

    return { batchId: payload.batchId, status: 'Out for warranty' };
  });
}

/** A warranty batch comes back from the vendor and rejoins the bench queue. */
function returnBatchFromVendor(batchId, note) {
  var user = requirePerm('testing.resolve');

  return withLock(function () {
    var queue = readSheet(CONFIG.SHEETS.TESTING);
    var b = findRow(queue.rows, queue.col['Batch ID'], batchId);
    if (b === -1) throw new Error('That testing batch no longer exists.');

    var row = queue.rows[b];
    var state = CONFIG.TESTING_STATUS[cell(row, queue.col, 'Status')];
    if (!state || !state.atVendor) {
      throw new Error('That batch is not with a vendor.');
    }

    row[queue.col['Status']] = 'Pending';
    row[queue.col['Resolution Note']] = cleanText(
      'Back from vendor ' + formatDay(now()) + (note ? ': ' + cleanText(note, 200) : '')
      + ' | ' + cell(row, queue.col, 'Resolution Note'), 500
    ).replace(/\s*\|\s*$/, '');
    writeRow(queue.sheet, b, row);

    return { batchId: batchId, status: 'Pending' };
  });
}
