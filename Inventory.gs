/**
 * Inventory.gs — items and the two quantity buckets.
 *
 * THE MODEL, in one paragraph:
 * Every item has Qty On Shelf and Qty In Testing. Only shelf stock can be
 * taken. When a used unit comes back it goes into the testing bucket, which is
 * deliberately NOT available — it's sitting on the bench waiting for a tech to
 * decide. The tech resolves it (Testing.gs) either back to the shelf or to
 * disposal. Nothing is serialised, so we only ever move counts between buckets.
 *
 * This is what fixes the 2.1 bug where sending something out for testing and
 * bringing it back quietly increased your stock.
 */

function getItems(departmentId) {
  getCurrentUser(); // authenticated read; computeItems() in Reports.gs does the work
  return computeItems(departmentId);
}

/**
 * Consumable or testable.
 *
 *   consumable  paper, toner, patch cables. It leaves and it does not come
 *               back. If someone carries some back it was never opened, so it
 *               goes straight on the shelf — no judgement needed, which is why
 *               staff may do it.
 *   testable    UPS units, batteries, adapters. A used one coming back has to
 *               be looked at before anyone can say whether it is stock again.
 *               Only the bench decides, and only a tech resolves the bench.
 *
 * Blank means consumable, because most of the shelf is. checkConfiguration()
 * reports how many items are still unset so the blanks get seen rather than
 * silently assumed.
 */
function itemClassOf(row, col) {
  var raw = String(cell(row, col, 'Item Class') || '').trim().toLowerCase();
  return CONFIG.ITEM_CLASSES[raw] ? raw : CONFIG.DEFAULT_ITEM_CLASS;
}

function itemClasses() {
  return Object.keys(CONFIG.ITEM_CLASSES);
}

/** The rules for one class, falling back to the default rather than throwing. */
function itemClassRule(itemClass) {
  return CONFIG.ITEM_CLASSES[itemClass] || CONFIG.ITEM_CLASSES[CONFIG.DEFAULT_ITEM_CLASS];
}

/**
 * The front end needs the same routing rules the server enforces, or the two
 * drift: a class added to the table would route correctly on the server and
 * show the wrong buttons in the app. bootstrap() ships this.
 */
function itemClassOptions() {
  return itemClasses().map(function (key) {
    var rule = CONFIG.ITEM_CLASSES[key];
    return {
      key: key,
      label: rule.label,
      blurb: rule.blurb,
      returnRoute: rule.returnRoute,
      staffMayReturnToShelf: !!rule.staffMayReturnToShelf
    };
  });
}

/**
 * The only place a quantity moves between buckets.
 *
 * Reads the direction out of CONFIG.ACTIONS rather than having each caller
 * remember which way its own action goes, so a new action is a row in that
 * table instead of a new piece of arithmetic that might get the sign wrong.
 *
 * Mutates `row` and hands back the resulting counts.
 */
function applyMovement(row, col, action, qty) {
  var rule = CONFIG.ACTIONS[action];
  if (!rule) throw new Error('Unknown action "' + action + '".');

  var shelf = Number(cell(row, col, 'Qty On Shelf')) || 0;
  var testing = Number(cell(row, col, 'Qty In Testing')) || 0;
  var name = cell(row, col, 'Item Name');

  var newShelf = shelf + rule.shelf * qty;
  var newTesting = testing + rule.testing * qty;

  if (newShelf < 0) {
    throw new Error('Only ' + shelf + ' of ' + name + ' left on the shelf.');
  }
  if (newTesting < 0) {
    throw new Error('Only ' + testing + ' of ' + name + ' are on the bench.');
  }

  row[col['Qty On Shelf']] = newShelf;
  row[col['Qty In Testing']] = newTesting;
  return { shelfAfter: newShelf, testingAfter: newTesting };
}

function itemFromRow(row, col) {
  var shelf = Number(cell(row, col, 'Qty On Shelf')) || 0;
  var testing = Number(cell(row, col, 'Qty In Testing')) || 0;
  var min = Number(cell(row, col, 'Min Threshold')) || 0;

  return {
    id: cell(row, col, 'Item ID'),
    department: cell(row, col, 'Department'),
    name: cell(row, col, 'Item Name'),
    category: cell(row, col, 'Category') || 'Uncategorised',
    itemClass: itemClassOf(row, col),
    description: cell(row, col, 'Description'),
    location: cell(row, col, 'Location'),
    shelf: shelf,
    testing: testing,
    min: min,
    reorderTo: Number(cell(row, col, 'Reorder To')) || 0,
    unitCost: cell(row, col, 'Unit Cost'),
    vendor: cell(row, col, 'Vendor'),
    sku: cell(row, col, 'Vendor SKU'),
    imageUrl: cell(row, col, 'Image URL') || '',
    notes: cell(row, col, 'Notes'),
    updated: formatDate(cell(row, col, 'Last Updated')),
    updatedBy: cell(row, col, 'Updated By'),
    state: shelf <= 0 ? 'out' : (shelf <= min ? 'low' : 'ok')
  };
}

function getItem(itemId) {
  getCurrentUser();
  var data = readSheet(CONFIG.SHEETS.INVENTORY);
  var i = findRow(data.rows, data.col['Item ID'], itemId);
  if (i === -1) throw new Error('That item no longer exists.');
  return itemFromRow(data.rows[i], data.col);
}

// ─────────────────────────────────────────────────────────────
// The two everyday actions
// ─────────────────────────────────────────────────────────────

/**
 * Take units off the shelf. This is the action student workers do all day.
 * `destination` is where it's going — that's the "where did it all go" data.
 */
function takeItem(payload) {
  var user = requirePerm('item.take');
  var qty = toQty(payload.quantity);
  var destination = cleanText(payload.destination, 120);
  var notes = cleanText(payload.notes, 500);

  if (!destination && setting('take.requireDestination')) {
    throw new Error('Say where this is going. An admin can make this optional on the Config tab.');
  }

  return withLock(function () {
    var found = lockedItemRow(payload.itemId);
    var moved = applyMovement(found.row, found.col, 'Take', qty);
    stampRow(found.row, found.col, user);
    writeRow(found.sheet, found.index, found.row);

    var item = itemFromRow(found.row, found.col);
    logTransaction({
      itemId: item.id, itemName: item.name, department: item.department,
      action: 'Take', quantity: qty,
      shelfAfter: moved.shelfAfter, testingAfter: moved.testingAfter,
      destination: destination, notes: notes, user: user
    });

    clearItemCache();
    maybeRaiseLowStock(item, user);
    return item;
  });
}

/**
 * Unused stock comes straight back to the shelf.
 *
 * Someone took three cables, used one, and is carrying two back still bagged.
 * Before this existed the only logged routes were the test bench — which asks
 * a tech to inspect two unopened cables — or a stock correction, which staff
 * cannot do. So in practice the cables went back on the shelf and nothing was
 * written down, which put the count out AND overstated the burn rate. The
 * headline "weeks of supply left" figure is only as good as this path.
 *
 * Consumables only. A used UPS has to be looked at, and an item marked
 * testable has no way in here unless the person could resolve the bench
 * anyway, in which case they are the one who would have made the call.
 */
function putBackOnShelf(payload) {
  var user = requirePerm('item.return');
  var qty = toQty(payload.quantity);
  var cameFrom = cleanText(payload.cameFrom, 120);
  var notes = cleanText(payload.notes, 500);

  return withLock(function () {
    var found = lockedItemRow(payload.itemId);
    var item = itemFromRow(found.row, found.col);

    if (!itemClassRule(item.itemClass).staffMayReturnToShelf && !can(user, 'testing.resolve')) {
      throw new Error(
        item.name + ' has to go to the test bench so a tech can check it. '
        + 'Use "Send to bench" instead.'
      );
    }

    var moved = applyMovement(found.row, found.col, 'Put Back', qty);
    stampRow(found.row, found.col, user);
    writeRow(found.sheet, found.index, found.row);

    var updated = itemFromRow(found.row, found.col);
    logTransaction({
      itemId: updated.id, itemName: updated.name, department: updated.department,
      action: 'Put Back', quantity: qty,
      shelfAfter: moved.shelfAfter, testingAfter: moved.testingAfter,
      destination: cameFrom,
      notes: 'Returned unused. ' + notes, user: user
    });

    clearItemCache();
    resolveLowStockAlert(updated.id);
    return updated;
  });
}

/**
 * Something on the shelf is scrap — a swollen battery, a crushed box.
 *
 * This used to go through a stock correction, which logs as Adjust. That kept
 * the count right but meant the disposal never reached the disposal figures
 * and never touched the Disposal Reasons list, so "what are we throwing away
 * and why" only ever saw half the story.
 */
function disposeFromShelf(payload) {
  var user = requirePerm('testing.resolve');
  var qty = toQty(payload.quantity);
  var notes = cleanText(payload.notes, 500);

  var reason = setting('bench.disposalRequiresReason')
    ? requireText(payload.disposalReason, 'Disposal reason', 200)
    : cleanText(payload.disposalReason, 200);

  return withLock(function () {
    var found = lockedItemRow(payload.itemId);
    var moved = applyMovement(found.row, found.col, 'Dispose from Shelf', qty);
    stampRow(found.row, found.col, user);
    writeRow(found.sheet, found.index, found.row);

    var item = itemFromRow(found.row, found.col);
    logTransaction({
      itemId: item.id, itemName: item.name, department: item.department,
      action: 'Dispose from Shelf', quantity: qty,
      shelfAfter: moved.shelfAfter, testingAfter: moved.testingAfter,
      notes: reason + (notes ? ' — ' + notes : ''), user: user
    });

    clearItemCache();
    maybeRaiseLowStock(item, user);
    return item;
  });
}

/** Find one inventory row for writing. Always called inside withLock(). */
function lockedItemRow(itemId) {
  var data = readSheet(CONFIG.SHEETS.INVENTORY);
  var i = findRow(data.rows, data.col['Item ID'], itemId);
  if (i === -1) throw new Error('That item no longer exists.');
  return { sheet: data.sheet, col: data.col, rows: data.rows, index: i, row: data.rows[i] };
}

/**
 * A used unit comes back from a lab. It lands in the testing queue, NOT back on
 * the shelf — a tech has to look at it first.
 */
function returnForTesting(payload) {
  var user = requirePerm('item.return');
  var qty = toQty(payload.quantity);
  var cameFrom = cleanText(payload.cameFrom, 120);
  var notes = cleanText(payload.notes, 500);

  return withLock(function () {
    var found = lockedItemRow(payload.itemId);
    var moved = applyMovement(found.row, found.col, 'Return to Testing', qty);
    stampRow(found.row, found.col, user);
    writeRow(found.sheet, found.index, found.row);

    var item = itemFromRow(found.row, found.col);
    var testing = moved.testingAfter;

    var batchId = generateId('TST');
    appendRecord(CONFIG.SHEETS.TESTING, {
        'Batch ID': batchId,
        'Created': formatDate(now()),
        'Item ID': item.id,
        'Item Name': item.name,
        'Department': item.department,
        'Qty Pending': qty,
        'Came From': cameFrom,
        'Returned By': user.name,
        'Notes': notes,
        'Status': 'Pending'
    });

    logTransaction({
      itemId: item.id, itemName: item.name, department: item.department,
      action: 'Return to Testing', quantity: qty,
      shelfAfter: item.shelf, testingAfter: testing,
      destination: cameFrom, notes: notes, reference: batchId, user: user
    });

    clearItemCache();
    return { item: item, batchId: batchId };
  });
}

// ─────────────────────────────────────────────────────────────
// Item management (tech and up)
// ─────────────────────────────────────────────────────────────

function createItem(payload) {
  var user = requirePerm('item.create');

  var name = requireText(payload.name, 'Item name', 200);
  var department = requireOneOf(payload.department, departmentIds(), 'Department');
  var category = requireText(payload.category, 'Category', 120);
  var itemClass = requireOneOf(payload.itemClass || 'consumable', itemClasses(), 'Item class');
  var shelf = toQty(payload.shelf, { min: 0 });
  var min = toQty(payload.min, { min: 0 });
  var reorderTo = toQty(payload.reorderTo, { min: 0 });

  return withLock(function () {
    var data = readSheet(CONFIG.SHEETS.INVENTORY);

    var duplicate = data.rows.some(function (row) {
      return cleanText(cell(row, data.col, 'Item Name'), 200).toLowerCase() === name.toLowerCase()
        && cell(row, data.col, 'Department') === department;
    });
    if (duplicate) throw new Error('"' + name + '" already exists in ' + department + '.');

    var itemId = generateId('ITM');
    appendRecord(CONFIG.SHEETS.INVENTORY, {
      'Item ID': itemId,
      'Department': department,
      'Item Name': name,
      'Category': category,
      'Item Class': itemClass,
      'Description': cleanText(payload.description, 500),
      'Location': cleanText(payload.location, 120),
      'Qty On Shelf': shelf,
      'Qty In Testing': 0,
      'Min Threshold': min,
      'Reorder To': reorderTo,
      'Unit Cost': payload.unitCost === '' || payload.unitCost === undefined ? '' : Number(payload.unitCost) || 0,
      'Vendor': cleanText(payload.vendor, 120),
      'Vendor SKU': cleanText(payload.sku, 120),
      'Image URL': safeImageUrl(payload.imageUrl),
      'Active': true,
      'Notes': cleanText(payload.notes, 500),
      'Last Updated': formatDate(now()),
      'Updated By': user.email
    });

    logTransaction({
      itemId: itemId, itemName: name, department: department,
      action: 'Create', quantity: shelf, shelfAfter: shelf, testingAfter: 0,
      notes: 'Item created', user: user
    });

    clearItemCache();
    return itemId;
  });
}

function updateItem(itemId, updates) {
  var user = requirePerm('item.edit');

  // Quantities are deliberately not editable here — they only move through
  // take / return / resolve / receive / adjust, so the audit log stays honest.
  var editable = {
    'Item Name':      function (v) { return requireText(v, 'Item name', 200); },
    'Category':       function (v) { return requireText(v, 'Category', 120); },
    'Item Class':     function (v) { return requireOneOf(v, itemClasses(), 'Item class'); },
    'Description':    function (v) { return cleanText(v, 500); },
    'Location':       function (v) { return cleanText(v, 120); },
    'Min Threshold':  function (v) { return toQty(v, { min: 0 }); },
    'Reorder To':     function (v) { return toQty(v, { min: 0 }); },
    'Unit Cost':      function (v) { return v === '' ? '' : Number(v) || 0; },
    'Vendor':         function (v) { return cleanText(v, 120); },
    'Vendor SKU':     function (v) { return cleanText(v, 120); },
    'Image URL':      function (v) { return safeImageUrl(v); },
    'Notes':          function (v) { return cleanText(v, 500); },
    'Department':     function (v) { return requireOneOf(v, departmentIds(), 'Department'); }
  };

  return withLock(function () {
    var data = readSheet(CONFIG.SHEETS.INVENTORY);
    var i = findRow(data.rows, data.col['Item ID'], itemId);
    if (i === -1) throw new Error('That item no longer exists.');

    var row = data.rows[i];
    Object.keys(editable).forEach(function (header) {
      if (updates[header] !== undefined && data.col[header] !== undefined) {
        row[data.col[header]] = editable[header](updates[header]);
      }
    });
    stampRow(row, data.col, user);
    writeRow(data.sheet, i, row);

    clearItemCache();
    return itemFromRow(row, data.col);
  });
}

/**
 * Manual stock correction — for when the shelf count and reality disagree
 * (breakage, miscount, someone grabbed one without logging it).
 * Always logged with a reason, never silent.
 */
function adjustStock(itemId, newShelfQty, reason) {
  var user = requirePerm('item.adjust');
  var target = toQty(newShelfQty, { min: 0 });
  var why = requireText(reason, 'Reason for the correction', 300);

  return withLock(function () {
    var data = readSheet(CONFIG.SHEETS.INVENTORY);
    var i = findRow(data.rows, data.col['Item ID'], itemId);
    if (i === -1) throw new Error('That item no longer exists.');

    var row = data.rows[i];
    var before = Number(cell(row, data.col, 'Qty On Shelf')) || 0;
    row[data.col['Qty On Shelf']] = target;
    stampRow(row, data.col, user);
    writeRow(data.sheet, i, row);

    var item = itemFromRow(row, data.col);
    logTransaction({
      itemId: item.id, itemName: item.name, department: item.department,
      action: 'Adjust', quantity: target - before,
      shelfAfter: target, testingAfter: item.testing,
      notes: 'Corrected from ' + before + ' to ' + target + '. ' + why, user: user
    });

    clearItemCache();
    maybeRaiseLowStock(item, user);
    return item;
  });
}

/** Soft delete. The row stays for history; it just stops appearing in the app. */
function archiveItem(itemId, reason) {
  var user = requirePerm('item.archive');
  var why = cleanText(reason, 300);
  return withLock(function () {
    var data = readSheet(CONFIG.SHEETS.INVENTORY);
    var i = findRow(data.rows, data.col['Item ID'], itemId);
    if (i === -1) throw new Error('That item no longer exists.');

    var row = data.rows[i];
    if ((Number(cell(row, data.col, 'Qty In Testing')) || 0) > 0) {
      throw new Error('Clear the testing queue for this item before archiving it.');
    }
    // Otherwise the order stays live and receiving it later puts stock onto a
    // row nobody can see any more.
    var openOrder = findOpenReorder(itemId);
    if (openOrder) {
      throw new Error(
        'There is still an open order for this item (' + openOrder.id + ', '
        + openOrder.status + '). Receive or cancel it first.'
      );
    }
    row[data.col['Active']] = false;
    if (why && data.col['Notes'] !== undefined) {
      row[data.col['Notes']] = cleanText(
        cell(row, data.col, 'Notes') + ' | Retired by ' + user.name + ': ' + why, 500);
    }
    stampRow(row, data.col, user);
    writeRow(data.sheet, i, row);

    clearItemCache();
    return true;
  });
}

function stampRow(row, col, user) {
  if (col['Last Updated'] !== undefined) row[col['Last Updated']] = formatDate(now());
  if (col['Updated By'] !== undefined) row[col['Updated By']] = user.email;
}

// ─────────────────────────────────────────────────────────────
// Transaction log
// ─────────────────────────────────────────────────────────────

function logTransaction(t) {
  var txnId = generateId('TXN');
  appendRecord(CONFIG.SHEETS.TXN, {
      'Transaction ID': txnId,
      'Timestamp': formatDate(now()),
      'Item ID': t.itemId,
      'Item Name': t.itemName,
      'Department': t.department,
      'Action': t.action,
      'Quantity': t.quantity,
      'Shelf After': t.shelfAfter,
      'Testing After': t.testingAfter,
      'Destination': t.destination || '',
      'User Email': t.user.email,
      'User Name': t.user.name,
      'Notes': t.notes || '',
      'Reference': t.reference || '',
      'Voided': '',
      'Void Note': ''
  });

  if (setting('alerts.notifyEveryTransaction')) {
    notifyTransaction(t);
  }
  return txnId;
}

/**
 * Recent movements, newest first.
 *
 * Reachable from the app since 3.2. It existed for a version with no caller, and
 * with it the only way to see what had just happened — or to find a mistake
 * worth reversing — was to open the spreadsheet.
 *
 * `itemId` narrows it to one item, which is what the item sheet asks for: the
 * useful question at a shelf is usually "has somebody already taken these?"
 */
function getTransactions(departmentId, limit, itemId) {
  var user = getCurrentUser();
  var dept = cleanText(departmentId, 20);
  var wantItem = cleanText(itemId, 40);
  var max = Number(limit) || setting('app.historyLimit');
  var undoWindowMs = setting('app.undoMinutes') * 60000;
  var nowMs = now().getTime();

  // Only the tail can contain the most recent `max` rows for any department,
  // so there is no reason to read the whole log to find them. Scan a generous
  // multiple of the limit so a department filter still has rows to work with.
  var data = readSheetTail(CONFIG.SHEETS.TXN, Math.max(max * 10, 500));

  var out = [];
  for (var i = data.rows.length - 1; i >= 0 && out.length < max; i--) {
    var row = data.rows[i];
    if (!cell(row, data.col, 'Transaction ID')) continue;
    if (dept && cell(row, data.col, 'Department') !== dept) continue;
    if (wantItem && cell(row, data.col, 'Item ID') !== wantItem) continue;

    var action = cell(row, data.col, 'Action');
    var email = String(cell(row, data.col, 'User Email') || '').toLowerCase();
    var voided = boolFrom(cell(row, data.col, 'Voided'));
    var when = new Date(cell(row, data.col, 'Timestamp'));
    var ageMs = isNaN(when.getTime()) ? Infinity : nowMs - when.getTime();

    out.push({
      id: cell(row, data.col, 'Transaction ID'),
      timestamp: formatDate(cell(row, data.col, 'Timestamp')),
      itemId: cell(row, data.col, 'Item ID'),
      itemName: cell(row, data.col, 'Item Name'),
      action: action,
      quantity: Number(cell(row, data.col, 'Quantity')) || 0,
      destination: cell(row, data.col, 'Destination'),
      userName: cell(row, data.col, 'User Name'),
      mine: email === user.email,
      notes: cell(row, data.col, 'Notes'),
      voided: voided,
      voidNote: cell(row, data.col, 'Void Note'),
      // Whether THIS person can reverse THIS row, worked out once here so the
      // app never has to reimplement the rule and get it subtly different.
      canReverse: !voided && canReverseTransaction(user, action, email, ageMs, undoWindowMs)
    });
  }
  return out;
}

/**
 * May this person undo this movement?
 *
 * Two routes in. txn.void is the manager's tool and is not time-limited — it is
 * for auditing a mistake found next week. txn.undoOwn is the one that matters at
 * a shelf: your own movement, of a kind that can be cleanly reversed, within
 * app.undoMinutes. Wrong taps happen; before 3.2 the only fix was to ask an
 * admin to edit the spreadsheet, which in practice meant the wrong entry stayed
 * and the burn rate was wrong in a way nobody could see.
 */
function canReverseTransaction(user, action, ownerEmail, ageMs, undoWindowMs) {
  var rule = CONFIG.ACTIONS[action];
  if (!rule || !rule.reversible) return false;
  if (can(user, 'txn.void')) return true;
  if (!can(user, 'txn.undoOwn')) return false;
  return ownerEmail === user.email && ageMs <= undoWindowMs;
}

/**
 * Reverse a mistake. The original row is marked Voided rather than deleted —
 * the old version let anyone delete rows straight out of the audit log.
 * Only actions flagged reversible in CONFIG.ACTIONS can go through here;
 * anything that touched money or disposal gets corrected with an Adjust.
 *
 * Two doors lead in, and they share every line of the work:
 *   voidTransaction()  a manager fixing something found later (txn.void)
 *   undoLastAction()   the person who just mistyped, fixing it themselves
 */
function voidTransaction(txnId, reason) {
  var user = getCurrentUser();
  var why = requireText(reason, 'Reason', 300);
  return withLock(function () {
    return reverseTransaction(user, txnId, why);
  });
}

/**
 * Undo the thing I just did.
 *
 * Deliberately takes no transaction ID. The app shows an Undo next to the toast
 * that confirms a movement, and the honest meaning of that button is "the last
 * thing I did", not "row TXN-4B2F" — which the person standing at the shelf has
 * never seen and should not have to. Finding it server-side also means the
 * window and the ownership rule are enforced where they cannot be edited.
 */
function undoLastAction(reason) {
  var user = getCurrentUser();
  var why = cleanText(reason, 300) || 'Undone by ' + user.name + ' straight after the event';

  var undoWindowMs = setting('app.undoMinutes') * 60000;
  var nowMs = now().getTime();

  // A generous tail rather than the whole log: whatever this person did a
  // moment ago is near the end of it.
  var data = readSheetTail(CONFIG.SHEETS.TXN, 400);

  for (var i = data.rows.length - 1; i >= 0; i--) {
    var row = data.rows[i];
    var txnId = cell(row, data.col, 'Transaction ID');
    if (!txnId) continue;
    if (String(cell(row, data.col, 'User Email') || '').toLowerCase() !== user.email) continue;

    // The FIRST of this person's rows we reach going backwards is the only
    // candidate. Skipping a voided one to reach an older row would mean a double
    // tap on Undo silently reversed the correct movement before the mistake.
    if (boolFrom(cell(row, data.col, 'Voided'))) {
      throw new Error('That is already undone. Use the Log tab to reverse anything else.');
    }

    var when = new Date(cell(row, data.col, 'Timestamp'));
    var ageMs = isNaN(when.getTime()) ? Infinity : nowMs - when.getTime();
    if (ageMs > undoWindowMs) break; // anything older is older still

    var action = cell(row, data.col, 'Action');
    if (!canReverseTransaction(user, action, user.email, ageMs, undoWindowMs)) {
      throw new Error(
        'Your last action was "' + action + '", which cannot be undone because it '
        + 'involved money or disposal. Ask a tech for a stock correction.'
      );
    }

    return withLock(function () {
      return reverseTransaction(user, txnId, why);
    });
  }

  throw new Error(
    'Nothing of yours from the last ' + setting('app.undoMinutes')
    + ' minutes left to undo. Ask a manager to reverse anything older.'
  );
}

/**
 * The actual reversal. Always called inside withLock().
 *
 * Undo is the same movement with the sign flipped, read straight off the same
 * CONFIG.ACTIONS row the original used — so there is no second copy of the
 * bucket arithmetic that could disagree about which way a quantity goes.
 */
function reverseTransaction(user, txnId, why) {
  var data = readSheet(CONFIG.SHEETS.TXN);
  var i = findRow(data.rows, data.col['Transaction ID'], txnId);
  if (i === -1) throw new Error('No transaction with that ID.');

  var row = data.rows[i];
  if (boolFrom(cell(row, data.col, 'Voided'))) throw new Error('That one is already voided.');

  var action = cell(row, data.col, 'Action');
  var rule = CONFIG.ACTIONS[action];
  var qty = Number(cell(row, data.col, 'Quantity')) || 0;
  var itemId = cell(row, data.col, 'Item ID');
  var ownerEmail = String(cell(row, data.col, 'User Email') || '').toLowerCase();

  var when = new Date(cell(row, data.col, 'Timestamp'));
  var ageMs = isNaN(when.getTime()) ? Infinity : now().getTime() - when.getTime();
  var undoWindowMs = setting('app.undoMinutes') * 60000;

  if (!canReverseTransaction(user, action, ownerEmail, ageMs, undoWindowMs)) {
    if (!rule || !rule.reversible) {
      throw new Error(
        '"' + action + '" cannot be reversed, because it involved money or disposal. '
        + 'Use a stock correction instead.'
      );
    }
    throw new Error('You can only undo your own movements, and only for the first '
      + setting('app.undoMinutes') + ' minutes. Ask a manager to reverse this one.');
  }

  var inv = readSheet(CONFIG.SHEETS.INVENTORY);
  var j = findRow(inv.rows, inv.col['Item ID'], itemId);
  if (j === -1) throw new Error('The item for that transaction no longer exists.');
  var invRow = inv.rows[j];

  var shelf = Number(cell(invRow, inv.col, 'Qty On Shelf')) || 0;
  var testing = Number(cell(invRow, inv.col, 'Qty In Testing')) || 0;
  var undoneShelf = shelf - rule.shelf * qty;
  var undoneTesting = testing - rule.testing * qty;

  if (undoneShelf < 0) throw new Error('Those units have already left the shelf.');
  if (undoneTesting < 0) throw new Error('Those units have already been tested and resolved.');

  invRow[inv.col['Qty On Shelf']] = undoneShelf;
  invRow[inv.col['Qty In Testing']] = undoneTesting;

  if (action === 'Return to Testing') {
    var batchId = cell(row, data.col, 'Reference');
    var queue = readSheet(CONFIG.SHEETS.TESTING);
    var batchIndex = findRow(queue.rows, queue.col['Batch ID'], batchId);
    var batch = batchIndex === -1 ? null : queue.rows[batchIndex];
    if (!batch || cell(batch, queue.col, 'Item ID') !== itemId
      || cell(batch, queue.col, 'Status') !== 'Pending'
      || Number(cell(batch, queue.col, 'Qty Pending')) !== qty
      || cell(batch, queue.col, 'Resolution Note') || cell(batch, queue.col, 'Sent To Vendor')) {
      throw new Error('This return batch has already changed or cannot be matched. Open its bench history; the original return cannot be reversed.');
    }
    closeTestingBatch(batchId, user, 'Reversed: ' + why);
  }

  stampRow(invRow, inv.col, user);
  writeRow(inv.sheet, j, invRow);

  row[data.col['Voided']] = true;
  row[data.col['Void Note']] = why + ' (reversed by ' + user.name + ')';
  writeRow(data.sheet, i, row);

  clearItemCache();

  // Reversing a mistaken take puts stock back, so an alert it raised should
  // not stay open; reversing a mistaken put-back may push it under again.
  var item = itemFromRow(invRow, inv.col);
  if (item.shelf > item.min) {
    resolveLowStockAlert(item.id);
  } else {
    maybeRaiseLowStock(item, user);
  }
  return { item: item, action: action, quantity: qty };
}
