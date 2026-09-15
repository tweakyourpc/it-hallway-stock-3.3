/**
 * Reorder.gs — the procurement loop.
 *
 *   [Pending approval] →  Needed  →  Ordered  →  Partially Received  →  Received
 *
 * The approval step only exists if "Must a manager approve a request before it
 * can be ordered?" is set to Yes on the Config tab. With it off, requests go
 * straight to Needed and the ordering manager works from there.
 *
 *   Needed   Anyone (staff and up) flags an item, or the daily check raises it
 *            automatically when shelf stock hits the minimum.
 *   Ordered  The ordering manager records vendor, PO or p-card reference, qty
 *            and unit cost. Manager role only.
 *   Received A tech counts what turned up and enters it. That quantity is added
 *            to the shelf automatically and logged as a Receive transaction, so
 *            you never have to add stock by hand. Short shipments stay open.
 *
 * A NOTE ON PAYMENT DETAILS: the "PO / Payment Ref" field is a reference, not a
 * card number. Put "PO 44821" or "P-card – J. Rivera – Jul" in it. Never a full
 * card number: this is a spreadsheet, not a payment system.
 */

function getReorders(departmentId, includeClosed) {
  getCurrentUser();
  return reordersFrom(readSheet(CONFIG.SHEETS.REORDER), departmentId, includeClosed);
}

/**
 * The same list, from a Reorders sheet the caller has already read.
 *
 * refresh() reads that sheet for the summary and then used to call getReorders(),
 * which read the whole thing again — a second full read of the same data in the
 * same request, on every single save.
 */
function reordersFrom(data, departmentId, includeClosed) {
  var dept = cleanText(departmentId, 20);
  var open = openReorderStatuses();

  return data.rows
    .filter(function (row) {
      if (!cell(row, data.col, 'Reorder ID')) return false;
      if (dept && cell(row, data.col, 'Department') !== dept) return false;
      if (!includeClosed && open.indexOf(cell(row, data.col, 'Status')) === -1) return false;
      return true;
    })
    .map(function (row) {
      return {
        id: cell(row, data.col, 'Reorder ID'),
        created: formatDate(cell(row, data.col, 'Created')),
        itemId: cell(row, data.col, 'Item ID'),
        itemName: cell(row, data.col, 'Item Name'),
        requested: Number(cell(row, data.col, 'Qty Requested')) || 0,
        requestedBy: cell(row, data.col, 'Requested By'),
        status: cell(row, data.col, 'Status'),
        approvedBy: cell(row, data.col, 'Approved By'),
        vendor: cell(row, data.col, 'Vendor'),
        poRef: cell(row, data.col, 'PO / Payment Ref'),
        unitCost: cell(row, data.col, 'Unit Cost'),
        ordered: Number(cell(row, data.col, 'Qty Ordered')) || 0,
        orderedBy: cell(row, data.col, 'Ordered By'),
        orderedDate: formatDay(cell(row, data.col, 'Ordered Date')),
        expectedDate: formatDay(cell(row, data.col, 'Expected Date')),
        received: Number(cell(row, data.col, 'Qty Received')) || 0,
        receivedDate: formatDay(cell(row, data.col, 'Received Date')),
        outstanding: Math.max(0, (Number(cell(row, data.col, 'Qty Ordered')) || 0)
                               - (Number(cell(row, data.col, 'Qty Received')) || 0)),
        // An expected date was captured all along and never read. An order past
        // its date is still counted as inbound supply by the forecast, so cover
        // stays optimistic forever on something that is never coming.
        overdueDays: overdueDaysFor(cell(row, data.col, 'Status'),
                                    cell(row, data.col, 'Expected Date')),
        notes: cell(row, data.col, 'Notes')
      };
    })
    .sort(function (a, b) { return String(b.created).localeCompare(String(a.created)); });
}

/**
 * Whole days an order is past its expected date, or 0.
 *
 * Only orders actually waiting on a delivery can be late. A blank expected date
 * means nobody promised anything, which is not the same as being on time.
 */
function overdueDaysFor(status, expectedDate) {
  if (status !== 'Ordered' && status !== 'Partially Received') return 0;
  if (!expectedDate) return 0;
  var due = new Date(expectedDate);
  if (isNaN(due.getTime())) return 0;
  var days = Math.floor((now().getTime() - due.getTime()) / 86400000);
  return days > 0 ? days : 0;
}

/**
 * One idea of what a new reorder row looks like, shared by the human path and
 * the automatic one.
 *
 * Deliberately NOT wrapped in withLock(): both callers are already inside one,
 * and a nested lock releases it early on the way out. See the note in withLock.
 */
function createReorderRow(item, qty, requestedBy, notes) {
  var reorderId = generateId('REQ');
  appendRecord(CONFIG.SHEETS.REORDER, {
      'Reorder ID': reorderId,
      'Created': formatDate(now()),
      'Item ID': item.id,
      'Item Name': item.name,
      'Department': item.department,
      'Qty Requested': qty,
      'Requested By': requestedBy,
      'Status': setting('reorder.requiresApproval') ? 'Pending approval' : 'Needed',
      'Vendor': item.vendor || '',
      'Unit Cost': item.unitCost || '',
      'Notes': cleanText(notes, 400)
  });
  return { id: reorderId, qty: qty };
}

/**
 * How many to ask for.
 *
 * The fallback — and what every version before 3.2 did — is to top back up to
 * the Reorder To figure someone typed once. Where a measured burn rate exists,
 * that figure is second-guessed: order enough to cover the delivery, the safety
 * buffer, and reorder.coverDays of actual demand on top. This is the same
 * arithmetic suggestedMin already does for thresholds, applied one field over.
 *
 * It reads the cover map only if it is already warm in the cache, so asking for
 * a suggestion never costs a pass over the transaction log. A cold cache just
 * gets the top-up figure, which is what it always was.
 */
function suggestedOrderQty(item) {
  var topUp = Math.max(1, (item.reorderTo || item.min * 2 || 1) - item.shelf);

  var cover = cachedCoverFor(item.department, item.id);
  if (!cover || !cover.reliable || !cover.perDay || !setting('reorder.coverDays')) return topUp;

  var days = cover.leadTimeDays + setting('report.reorderBufferDays') + setting('reorder.coverDays');
  var wanted = Math.ceil(cover.perDay * days) - item.shelf;
  return Math.max(topUp, wanted, 1);
}

/** Read-only preview; saving still checks the current item and open request. */
function getReorderSuggestion(itemId) {
  getCurrentUser();
  var item = getItem(itemId);
  var rate = cachedCoverFor(item.department, item.id);
  var measured = rate && rate.reliable && rate.perDay && setting('reorder.coverDays');
  var existing = findOpenReorder(itemId);
  return {
    quantity: suggestedOrderQty(item),
    explanation: measured
      ? 'Uses the recent measured rate across ' + rate.leadTimeDays + ' delivery days, '
        + setting('report.reorderBufferDays') + ' buffer days and ' + setting('reorder.coverDays')
        + ' days of demand, less available shelf stock; at least the top-up target.'
      : 'Tops up available shelf stock to the item target. No measured-rate suggestion is being used.',
    existingId: existing ? existing.id : '',
    existingStatus: existing ? existing.status : ''
  };
}

/**
 * Flag an item for reorder. If there's already an open request for it, this
 * bumps the quantity instead of creating a duplicate line for the manager.
 */
function requestReorder(payload) {
  var user = requirePerm('reorder.request');
  var notes = cleanText(payload.notes, 400);

  return withLock(function () {
    var inv = readSheet(CONFIG.SHEETS.INVENTORY);
    var i = findRow(inv.rows, inv.col['Item ID'], payload.itemId);
    if (i === -1) throw new Error('That item no longer exists.');
    var item = itemFromRow(inv.rows[i], inv.col);

    var qty = payload.quantity
      ? toQty(payload.quantity, { cap: ORDER_QTY_CAP })
      : suggestedOrderQty(item);

    var existing = findOpenReorder(item.id);
    if (existing) {
      return bumpReorder(existing, qty, user, notes);
    }

    var created = createReorderRow(item, qty, user.name, notes);
    notifyReorderNeeded(item, qty, user);
    return { id: created.id, qty: qty, created: true };
  });
}

/** Statuses that mean a line is still live and shouldn't be duplicated. */
function openReorderStatuses() {
  return Object.keys(CONFIG.REORDER_FLOW).filter(function (status) {
    return CONFIG.REORDER_FLOW[status].length > 0;
  });
}

/**
 * One place that knows which status may follow which.
 *
 * Each step used to carry its own idea of its legal predecessors, so adding a
 * status such as Backordered meant finding every one of them and hoping none
 * was missed. Now it is a row in CONFIG.REORDER_FLOW.
 */
function requireTransition(from, to) {
  var allowed = CONFIG.REORDER_FLOW[from] || [];
  if (allowed.indexOf(to) === -1) {
    throw new Error(
      'A request that is "' + from + '" cannot become "' + to + '".'
      + (allowed.length ? ' From here it can only be: ' + allowed.join(', ') + '.' : '')
    );
  }
}

function findOpenReorder(itemId) {
  var data = readSheet(CONFIG.SHEETS.REORDER);
  var open = openReorderStatuses();
  for (var i = 0; i < data.rows.length; i++) {
    var row = data.rows[i];
    if (cell(row, data.col, 'Item ID') === itemId && open.indexOf(cell(row, data.col, 'Status')) !== -1) {
      return { data: data, index: i, row: row, id: cell(row, data.col, 'Reorder ID'), status: cell(row, data.col, 'Status') };
    }
  }
  return null;
}

function bumpReorder(existing, qty, user, notes) {
  if (existing.status !== 'Needed' && existing.status !== 'Pending approval') {
    return { id: existing.id, created: false, status: existing.status, message: 'Already ordered; view the existing order.' };
  }
  var current = Number(cell(existing.row, existing.data.col, 'Qty Requested')) || 0;
  existing.row[existing.data.col['Qty Requested']] = Math.max(current, qty);
  if (notes) {
    existing.row[existing.data.col['Notes']] =
      cleanText(cell(existing.row, existing.data.col, 'Notes') + ' | ' + notes, 500);
  }
  writeRow(existing.data.sheet, existing.index, existing.row);
  var next = Math.max(current, qty);
  return { id: existing.id, created: false, status: existing.status, qty: next,
    message: next === current ? 'Existing request remains at ' + next + '.' : 'Existing request increased to ' + next + '.' };
}

/**
 * Approve or decline a request. Only reachable when approval is switched on.
 */
function approveReorder(reorderId, approve, note) {
  var user = requirePerm('reorder.approve');
  var comment = cleanText(note, 300);
  if (!approve && !comment) throw new Error('Give a reason when declining a request.');

  return withLock(function () {
    var data = readSheet(CONFIG.SHEETS.REORDER);
    var i = findRow(data.rows, data.col['Reorder ID'], reorderId);
    if (i === -1) throw new Error('No reorder with that ID.');

    var row = data.rows[i];
    var next = approve ? 'Needed' : 'Declined';
    requireTransition(cell(row, data.col, 'Status'), next);

    row[data.col['Status']] = next;
    row[data.col['Approved By']] = user.name;
    row[data.col['Approved At']] = formatDate(now());
    if (comment) {
      row[data.col['Notes']] = cleanText(cell(row, data.col, 'Notes') + ' | '
        + (approve ? 'Approved' : 'Declined') + ' by ' + user.name + ': ' + comment, 500);
    }
    writeRow(data.sheet, i, row);

    queueNotice(cell(row, data.col, 'Department'),
      (approve ? '*Approved for ordering* — ' : '*Request declined* — ')
      + cell(row, data.col, 'Item Name') + '\nby ' + user.name
      + (comment ? '\n' + comment : ''));

    return { id: reorderId, status: row[data.col['Status']] };
  });
}

/** Manager records that the order has actually been placed. */
function markOrdered(payload) {
  var user = requirePerm('reorder.order');

  var vendor = requireText(payload.vendor, 'Vendor', 120);
  var poRef = requireText(payload.poRef, 'PO or payment reference', 120);
  var qtyOrdered = toQty(payload.qtyOrdered, { cap: ORDER_QTY_CAP });
  var unitCost = payload.unitCost === '' || payload.unitCost === undefined ? '' : Number(payload.unitCost) || 0;
  var expected = cleanText(payload.expectedDate, 20);

  if (/\b\d{13,19}\b/.test(poRef)) {
    throw new Error('That looks like a full card number. Use a PO number or a short reference instead.');
  }

  return withLock(function () {
    var data = readSheet(CONFIG.SHEETS.REORDER);
    var i = findRow(data.rows, data.col['Reorder ID'], payload.reorderId);
    if (i === -1) throw new Error('No reorder with that ID.');

    var row = data.rows[i];
    // No second, hand-written idea of which statuses may be ordered from.
    // CONFIG.REORDER_FLOW says 'Pending approval' cannot become 'Ordered', and
    // requireTransition already explains what it can become instead.
    requireTransition(cell(row, data.col, 'Status'), 'Ordered');

    row[data.col['Status']] = 'Ordered';
    row[data.col['Vendor']] = vendor;
    row[data.col['PO / Payment Ref']] = poRef;
    row[data.col['Qty Ordered']] = qtyOrdered;
    row[data.col['Unit Cost']] = unitCost;
    row[data.col['Ordered By']] = user.name;
    row[data.col['Ordered Date']] = formatDay(now());
    row[data.col['Expected Date']] = expected;
    if (payload.notes) {
      row[data.col['Notes']] = cleanText(cell(row, data.col, 'Notes') + ' | ' + cleanText(payload.notes, 300), 500);
    }
    writeRow(data.sheet, i, row);

    notifyOrdered({
      itemName: cell(row, data.col, 'Item Name'),
      department: cell(row, data.col, 'Department'),
      qty: qtyOrdered, vendor: vendor, poRef: poRef, expected: expected
    }, user);

    return { id: payload.reorderId, status: 'Ordered' };
  });
}

/**
 * Goods arrive. Enter what actually turned up; it goes straight onto the shelf.
 * If fewer arrive than were ordered the line stays open as Partially Received.
 */
function receiveOrder(payload) {
  var user = requirePerm('reorder.receive');
  var qty = toQty(payload.qtyReceived, { cap: ORDER_QTY_CAP });
  var notes = cleanText(payload.notes, 400);

  return withLock(function () {
    var data = readSheet(CONFIG.SHEETS.REORDER);
    var i = findRow(data.rows, data.col['Reorder ID'], payload.reorderId);
    if (i === -1) throw new Error('No reorder with that ID.');

    var row = data.rows[i];
    var recvStatus = cell(row, data.col, 'Status');

    var ordered = Number(cell(row, data.col, 'Qty Ordered')) || 0;
    var already = Number(cell(row, data.col, 'Qty Received')) || 0;
    var total = already + qty;
    if (ordered && total > ordered) {
      throw new Error('That would be ' + total + ' received against ' + ordered + ' ordered. Check the count.');
    }

    // Work out where this receipt actually lands, then ask whether that move is
    // legal. It used to validate a move to 'Partially Received' and then
    // sometimes write 'Received' — a status it had never checked. Harmless while
    // both happen to be reachable from both states, and a silent hole the day
    // someone adds one that isn't.
    var nextStatus = (!ordered || total >= ordered) ? 'Received' : 'Partially Received';
    requireTransition(recvStatus, nextStatus);

    var itemId = cell(row, data.col, 'Item ID');
    var inv = readSheet(CONFIG.SHEETS.INVENTORY);
    var j = findRow(inv.rows, inv.col['Item ID'], itemId);
    if (j === -1) throw new Error('The item for this order no longer exists.');

    var invRow = inv.rows[j];
    var newShelf = applyMovement(invRow, inv.col, 'Receive', qty).shelfAfter;

    // Keep vendor and cost current on the item for next time.
    var vendor = cell(row, data.col, 'Vendor');
    var unitCost = cell(row, data.col, 'Unit Cost');
    if (vendor && inv.col['Vendor'] !== undefined) invRow[inv.col['Vendor']] = vendor;
    if (unitCost !== '' && inv.col['Unit Cost'] !== undefined) invRow[inv.col['Unit Cost']] = unitCost;

    stampRow(invRow, inv.col, user);
    writeRow(inv.sheet, j, invRow);

    var item = itemFromRow(invRow, inv.col);
    logTransaction({
      itemId: item.id, itemName: item.name, department: item.department,
      action: 'Receive', quantity: qty,
      shelfAfter: newShelf, testingAfter: item.testing,
      notes: 'Received against ' + cell(row, data.col, 'PO / Payment Ref') + '. ' + notes,
      reference: payload.reorderId, user: user
    });

    row[data.col['Qty Received']] = total;
    row[data.col['Received By']] = user.name;
    row[data.col['Received Date']] = formatDay(now());
    row[data.col['Status']] = nextStatus;
    if (notes) {
      row[data.col['Notes']] = cleanText(cell(row, data.col, 'Notes') + ' | ' + notes, 500);
    }
    writeRow(data.sheet, i, row);

    clearItemCache();
    resolveLowStockAlert(item.id);
    return { item: item, status: row[data.col['Status']], received: total, ordered: ordered };
  });
}

/**
 * Drop a request.
 *
 * Reachable from the app since 3.2 — it existed for a version with no button,
 * which mattered because reorder.autoRaiseOnLowStock opens requests on its own
 * and the only way to close a wrong one was to edit the spreadsheet.
 *
 * Anyone who may request may cancel a line nobody has acted on yet; once money
 * is involved it takes reorder.order.
 */
function cancelReorder(reorderId, reason) {
  var user = requirePerm('reorder.request');
  var why = requireText(reason, 'Reason', 300);

  return withLock(function () {
    var data = readSheet(CONFIG.SHEETS.REORDER);
    var i = findRow(data.rows, data.col['Reorder ID'], reorderId);
    if (i === -1) throw new Error('No reorder with that ID.');

    var row = data.rows[i];
    var status = cell(row, data.col, 'Status');
    if (status !== 'Needed' && status !== 'Pending approval' && !can(user, 'reorder.order')) {
      throw new Error('That order has already been placed. A manager has to cancel it.');
    }
    requireTransition(status, 'Cancelled');
    row[data.col['Status']] = 'Cancelled';
    row[data.col['Notes']] = cleanText(
      cell(row, data.col, 'Notes') + ' | Cancelled by ' + user.name + ': ' + why, 500
    );
    writeRow(data.sheet, i, row);
    return true;
  });
}
