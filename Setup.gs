/**
 * Setup.gs — creates the sheets, formats them, seeds starting data, and
 * migrates an existing 2.1 spreadsheet.
 *
 * Safe to re-run. It adds anything missing and leaves your data alone.
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('IT Hallway')
    .addItem('1. Run setup', 'runSetup')
    .addItem('2. Check my configuration', 'checkConfiguration')
    .addSeparator()
    .addItem('Open the Config tab', 'openConfigTab')
    .addItem('Apply setting changes now', 'applySettingChanges')
    .addSeparator()
    .addItem('Refresh dashboard', 'buildDashboard')
    .addItem('Recalculate usage rates now', 'warmCoverCache')
    .addItem('Run daily check now', 'dailyCheck')
    .addItem('Send weekly report now', 'weeklyReport')
    .addSeparator()
    .addItem('Migrate from version 2.1', 'migrateFrom21')
    .addToUi();
}

function onInstall() {
  onOpen();
}

/** Step 1 of the install. Creates every sheet with headers, formatting and validation. */
/**
 * Creates or repairs every tab. Safe to re-run after an upgrade — it adds
 * what's missing and never overwrites values you've set.
 *
 * Order matters: Roles and Departments have to exist before the Config tab,
 * because Config's dropdowns for "starting role" and "default department" are
 * built from them.
 */
function runSetup() {
  var ss = SpreadsheetApp.getActive();
  clearAllCaches();

  // 1. Data tabs
  Object.keys(CONFIG.HEADERS).forEach(function (sheetName) {
    if (sheetName === CONFIG.SHEETS.DEPARTMENTS) return; // handled below
    var sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
    applyHeaders(sheet, CONFIG.HEADERS[sheetName]);
  });
  if (!ss.getSheetByName(CONFIG.SHEETS.DASHBOARD)) ss.insertSheet(CONFIG.SHEETS.DASHBOARD);

  // 2. Control tabs, in dependency order
  buildRolesSheet();
  buildDepartmentsSheet();
  clearAllCaches();
  buildConfigSheet();
  clearAllCaches();

  // 3. Content
  seedLists();
  applyValidation();
  seedItems();
  orderTabs();
  buildDashboard();

  PropertiesService.getScriptProperties().setProperty('setupCompleted', formatDate(now()));
  return 'Setup complete. Open the Config tab to review your settings.';
}

/** Put the tabs people use most on the left. */
function orderTabs() {
  var ss = SpreadsheetApp.getActive();
  var order = [
    CONFIG.SHEETS.CONFIG, CONFIG.SHEETS.ROLES, CONFIG.SHEETS.DEPARTMENTS,
    CONFIG.SHEETS.LISTS, CONFIG.SHEETS.USERS, CONFIG.SHEETS.INVENTORY,
    CONFIG.SHEETS.REORDER, CONFIG.SHEETS.TESTING, CONFIG.SHEETS.TXN,
    CONFIG.SHEETS.ALERTS, CONFIG.SHEETS.DASHBOARD
  ];
  order.forEach(function (name, i) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) return;
    ss.setActiveSheet(sheet);
    ss.moveActiveSheet(i + 1);
  });
  ss.setActiveSheet(ss.getSheetByName(CONFIG.SHEETS.CONFIG));
}

/**
 * Recalculate every department's usage rates and put them back in the cache.
 *
 * The same thing the daily check does. Here as a menu item because after a bulk
 * tidy-up of the Inventory tab — reclassifying items, fixing thresholds — the
 * cover figures on the shelf tags are the last thing to catch up, and waiting
 * out the cache is a puzzling way to spend fifteen minutes.
 */
function warmCoverCache() {
  clearAllCaches();
  var done = listDepartments().map(function (dept) {
    var map = computeCoverMap(dept.id);
    return dept.label + ': ' + Object.keys(map.items).length + ' item(s) with a measured rate';
  }).join('\n');

  try {
    SpreadsheetApp.getUi().alert('Usage rates recalculated', done, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {
    Logger.log(done);
  }
  return done;
}

function openConfigTab() {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(CONFIG.SHEETS.CONFIG);
  if (!sheet) throw new Error('No Config tab yet. Run Setup first.');
  ss.setActiveSheet(sheet);
}

/**
 * Settings are cached for speed, so a change on the Config tab can take up to
 * a minute to reach everyone. This clears the caches immediately.
 */
function applySettingChanges() {
  clearAllCaches();
  refreshDepartmentStatus();
  var message = 'Setting changes are live.\n\n'
    + 'Note: if you changed a schedule setting (daily check hour, weekly report day '
    + 'or hour), also run installTriggers() from the Apps Script editor.';
  try {
    SpreadsheetApp.getUi().alert('IT Hallway', message, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {
    Logger.log(message);
  }
  return message;
}

/**
 * Writes the header row if the sheet is empty, or appends any headers that are
 * missing. Never reorders or deletes existing columns.
 */
function applyHeaders(sheet, headers) {
  var lastCol = sheet.getLastColumn();
  var existing = lastCol > 0
    ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); })
    : [];

  if (!existing.join('')) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    var missing = headers.filter(function (h) { return existing.indexOf(h) === -1; });
    if (missing.length) {
      sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
    }
  }

  var width = Math.max(sheet.getLastColumn(), headers.length);
  sheet.getRange(1, 1, 1, width)
    .setFontWeight('bold')
    .setBackground('#16202b')
    .setFontColor('#ffffff')
    .setVerticalAlignment('middle');
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 30);
}

function seedLists() {
  var sheet = mustGetSheet(CONFIG.SHEETS.LISTS);
  if (sheet.getLastRow() > 1) return; // already has content, don't touch it

  var headers = CONFIG.HEADERS[CONFIG.SHEETS.LISTS];
  var longest = 0;
  headers.forEach(function (h) {
    longest = Math.max(longest, (CONFIG.SEED_LISTS[h] || []).length);
  });

  var rows = [];
  for (var i = 0; i < longest; i++) {
    rows.push(headers.map(function (h) {
      var list = CONFIG.SEED_LISTS[h] || [];
      return list[i] || '';
    }));
  }
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
  sheet.autoResizeColumns(1, headers.length);
}

/** Dropdowns in the sheet so hand-edits stay consistent with the app. */
function applyValidation() {
  var users = mustGetSheet(CONFIG.SHEETS.USERS);
  var headers = CONFIG.HEADERS[CONFIG.SHEETS.USERS];

  var roles = roleNames();
  var roleCol = headers.indexOf('Role') + 1;
  setValidationSafely(users.getRange(2, roleCol, 500, 1),
    SpreadsheetApp.newDataValidation().requireValueInList(roles, true)
      .setHelpText('What each role can do is set on the Roles tab. Options: ' + roles.join(', '))
      .build(), 'Users > Role');

  var deptIds = departmentIds();
  var deptCol = headers.indexOf('Home Department') + 1;
  setValidationSafely(users.getRange(2, deptCol, 500, 1),
    SpreadsheetApp.newDataValidation().requireValueInList(deptIds, true).build(),
    'Users > Home Department');

  var inv = mustGetSheet(CONFIG.SHEETS.INVENTORY);
  var invHeaders = CONFIG.HEADERS[CONFIG.SHEETS.INVENTORY];
  setValidationSafely(inv.getRange(2, invHeaders.indexOf('Department') + 1, 2000, 1),
    SpreadsheetApp.newDataValidation().requireValueInList(deptIds, true).build(),
    'Inventory > Department');

  setValidationSafely(inv.getRange(2, invHeaders.indexOf('Item Class') + 1, 2000, 1),
    SpreadsheetApp.newDataValidation().requireValueInList(itemClasses(), true)
      .setHelpText('consumable = leaves and does not come back (paper, cables). '
        + 'testable = a used one must be checked at the bench before it is stock again '
        + '(UPS units, batteries).')
      .build(), 'Inventory > Item Class');

  // The Action and Status columns are written by the code and read back by the
  // reports, so a hand-typed value in either produces rows no report can count.
  // Both lists come from the tables in Config.gs, so adding a row there brings
  // the dropdown with it.
  var txn = mustGetSheet(CONFIG.SHEETS.TXN);
  var txnHeaders = CONFIG.HEADERS[CONFIG.SHEETS.TXN];
  setValidationSafely(txn.getRange(2, txnHeaders.indexOf('Action') + 1, 5000, 1),
    SpreadsheetApp.newDataValidation().requireValueInList(Object.keys(CONFIG.ACTIONS), true)
      .setHelpText('Written by the app. Editing this by hand will confuse the usage reports.')
      .build(), 'Transactions > Action');

  var queue = mustGetSheet(CONFIG.SHEETS.TESTING);
  var queueHeaders = CONFIG.HEADERS[CONFIG.SHEETS.TESTING];
  setValidationSafely(queue.getRange(2, queueHeaders.indexOf('Status') + 1, 2000, 1),
    SpreadsheetApp.newDataValidation().requireValueInList(Object.keys(CONFIG.TESTING_STATUS), true)
      .setHelpText('Pending and Out for warranty both still hold units. '
        + 'Out for warranty means the batch has physically left the building.')
      .build(), 'Testing Queue > Status');

  var reorders = mustGetSheet(CONFIG.SHEETS.REORDER);
  var reorderHeaders = CONFIG.HEADERS[CONFIG.SHEETS.REORDER];
  setValidationSafely(reorders.getRange(2, reorderHeaders.indexOf('Status') + 1, 2000, 1),
    SpreadsheetApp.newDataValidation().requireValueInList(Object.keys(CONFIG.REORDER_FLOW), true)
      .build(), 'Reorders > Status');

  inv.getRange(1, invHeaders.indexOf('Item Class') + 1).setNote(
    'consumable — paper, toner, patch cables. Anything carried back unopened goes '
    + 'straight on the shelf, and staff may do that themselves.\n\n'
    + 'testable — UPS units, batteries, adapters. A used one always goes to the bench '
    + 'so a tech can decide.\n\n'
    + 'Blank is treated as consumable.'
  );
}

function seedItems() {
  var data = readSheet(CONFIG.SHEETS.INVENTORY);
  if (data.rows.filter(function (r) { return r[data.col['Item ID']]; }).length) return;

  var headers = data.headers.join('') ? data.headers : CONFIG.HEADERS[CONFIG.SHEETS.INVENTORY];
  var rows = CONFIG.SEED_ITEMS.map(function (s) {
    return buildRow(headers, {
      'Item ID': generateId('ITM'),
      'Department': s.dept,
      'Item Name': s.name,
      'Category': s.cat,
      'Item Class': s.cls,
      'Description': 'Sample row — delete once you enter real stock.',
      'Location': s.loc,
      'Qty On Shelf': s.qty,
      'Qty In Testing': 0,
      'Min Threshold': s.min,
      'Reorder To': s.reorderTo,
      'Unit Cost': '',
      'Vendor': '',
      'Vendor SKU': '',
      'Image URL': '',
      'Active': true,
      'Notes': '',
      'Last Updated': formatDate(now()),
      'Updated By': 'setup'
    });
  });
  data.sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
}

/**
 * First guess at whether a migrated item is testable, from its category.
 *
 * A guess, not an answer — checkConfiguration counts what is still unset and
 * the Inventory tab has a dropdown. Getting it wrong is cheap in one direction
 * (a consumable sent to the bench wastes a tech's minute) and not in the other
 * (a used battery going straight back on the shelf), so anything powered or
 * with a battery in it defaults to testable.
 */
function guessItemClass(category, name) {
  var hay = String(category || '') + ' ' + String(name || '');
  return /batter|ups|power|adapter|adaptor|charger|lamp|projector|microphone|mic\b/i.test(hay)
    ? 'testable'
    : 'consumable';
}

/**
 * Step 2 of the install. Tells you exactly what still needs configuring
 * instead of failing mysteriously later.
 */
function checkConfiguration() {
  clearAllCaches();
  var problems = [];
  var warnings = [];
  var props = PropertiesService.getScriptProperties();
  var ss = SpreadsheetApp.getActive();

  if (!props.getProperty('setupCompleted')) {
    problems.push('Setup has not been run. Use IT Hallway -> 1. Run setup.');
  }
  [CONFIG.SHEETS.CONFIG, CONFIG.SHEETS.ROLES, CONFIG.SHEETS.DEPARTMENTS].forEach(function (name) {
    if (!ss.getSheetByName(name)) problems.push('The ' + name + ' tab is missing. Re-run Setup.');
  });

  if (CONFIG.BOOTSTRAP_ADMINS.indexOf('you@yourcollege.edu') !== -1) {
    problems.push('Config.gs: BOOTSTRAP_ADMINS still has the placeholder address. Put your real email there — it is your lockout insurance.');
  }

  var domains = settingList('access.allowedDomains');
  if (!domains.length) {
    warnings.push('Config tab: no allowed domains set, so any account the deployment lets through can sign in.');
  } else if (domains.indexOf('yourcollege.edu') !== -1) {
    problems.push('Config tab: "Which email domains may use the app?" still says yourcollege.edu.');
  }

  if (setting('access.institutionName') === 'your college') {
    warnings.push('Config tab: "What is your institution called?" is still the placeholder. '
      + 'People who land on the app with the wrong Google account will see it.');
  }
  if (setting('access.autoEnroll') && setting('access.autoEnrollRole') !== 'viewer') {
    warnings.push('Config tab: new people are enrolled automatically as "'
      + setting('access.autoEnrollRole') + '", so anyone on your domain who opens the link can '
      + 'change stock without being opted in. Set the starting role to viewer unless that is deliberate.');
  }

  var depts = listDepartments();
  var unconfigured = depts.filter(function (d) { return !props.getProperty(d.webhookKey); });
  if (unconfigured.length === depts.length) {
    warnings.push('No chat webhook saved for any department. Alerts will only show in the app until you add one (your name -> Notification settings).');
  } else if (unconfigured.length) {
    warnings.push('No chat webhook for: ' + unconfigured.map(function (d) { return d.label; }).join(', '));
  }

  var folderId = setting('photo.folderId');
  if (!folderId) {
    warnings.push('Config tab: no photo folder set, so direct upload is off. Pasting image links still works.');
  } else {
    try {
      DriveApp.getFolderById(folderId);
    } catch (e) {
      problems.push('Config tab: the photo folder ID is set but that folder cannot be opened. Check the ID and its sharing.');
    }
  }

  var admins = 0;
  var userData = readSheet(CONFIG.SHEETS.USERS);
  userData.rows.forEach(function (row) {
    if (String(cell(row, userData.col, 'Role')).trim().toLowerCase() === 'admin') admins++;
  });
  if (admins < 2) {
    warnings.push('Only ' + admins + ' admin on the Users tab. Consider a second one so a single departure does not strand the system.');
  }

  var invData = readSheet(CONFIG.SHEETS.INVENTORY);
  var unclassed = invData.rows.filter(function (row) {
    if (!cell(row, invData.col, 'Item ID')) return false;
    return !String(cell(row, invData.col, 'Item Class') || '').trim();
  }).length;
  if (unclassed) {
    warnings.push(unclassed + ' item(s) have no Item Class set, so they are treated as consumables. '
      + 'Anything that should go to the test bench when it comes back — UPS units, batteries, '
      + 'adapters — needs to say "testable" on the Inventory tab, or staff will be able to put a '
      + 'used one straight back on the shelf.');
  }

  /**
   * Does Qty In Testing still match the open bench queue?
   *
   * Testing.gs already has an error message admitting these can drift apart
   * ("the testing count for this item is out of step with the queue"), and until
   * 3.2 nothing ever checked. It is the one number in the system that can rot
   * silently: it is not visible on a shelf, so nobody eyeballs it the way they
   * would a count of boxes, and every unit stuck in it is a unit the forecast
   * believes is unavailable.
   */
  var queueSheet = ss.getSheetByName(CONFIG.SHEETS.TESTING);
  if (queueSheet && invData.rows.length) {
    var queueData = readSheet(CONFIG.SHEETS.TESTING);
    var pendingByItem = {};
    queueData.rows.forEach(function (row) {
      var state = CONFIG.TESTING_STATUS[cell(row, queueData.col, 'Status')];
      if (!state || !state.open) return;
      var id = cell(row, queueData.col, 'Item ID');
      pendingByItem[id] = (pendingByItem[id] || 0) + (Number(cell(row, queueData.col, 'Qty Pending')) || 0);
    });

    var drifted = [];
    invData.rows.forEach(function (row) {
      var id = cell(row, invData.col, 'Item ID');
      if (!id) return;
      var bucket = Number(cell(row, invData.col, 'Qty In Testing')) || 0;
      var queued = pendingByItem[id] || 0;
      if (bucket !== queued) {
        drifted.push(cell(row, invData.col, 'Item Name') + ' (bucket ' + bucket + ', queue ' + queued + ')');
      }
    });

    if (drifted.length) {
      warnings.push(drifted.length + ' item(s) whose Qty In Testing does not match the open bench '
        + 'queue: ' + drifted.slice(0, 6).join('; ')
        + (drifted.length > 6 ? ' and ' + (drifted.length - 6) + ' more' : '')
        + '. Units stuck in that bucket are counted as unavailable forever. Resolve or cancel the '
        + 'stale batches, then run a stock correction on the item.');
    }
  }

  var txnSheet = ss.getSheetByName(CONFIG.SHEETS.TXN);
  if (txnSheet) {
    var logRows = Math.max(0, txnSheet.getLastRow() - 1);
    var scan = setting('tech.txnScanRows');
    if (logRows > scan * 0.8) {
      warnings.push('The transaction log holds ' + logRows + ' rows and the usage report only reads '
        + 'the newest ' + scan + '. Raise "How many recent log rows should the usage report read?" '
        + 'on the Config tab, or the burn-rate figures will start missing older movements.');
    }
  }

  if (setting('report.recentWindowDays') > setting('report.usageWindowDays')) {
    warnings.push('Config tab: the "recently" window is longer than the main usage window, so the '
      + 'trend indicator has nothing shorter to compare against and is capped back down. '
      + 'Set it below "How many days of history should usage rates be based on?".');
  }

  var triggers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  if (triggers.indexOf('dailyCheck') === -1) warnings.push('No daily check scheduled. Run installTriggers().');
  if (triggers.indexOf('weeklyReport') === -1) warnings.push('No weekly report scheduled. Run installTriggers().');

  var message = '';
  message += problems.length ? 'MUST FIX:\n- ' + problems.join('\n- ') + '\n\n' : 'No blocking problems.\n\n';
  message += warnings.length ? 'WORTH KNOWING:\n- ' + warnings.join('\n- ') : 'Nothing else outstanding.';

  try {
    SpreadsheetApp.getUi().alert('IT Hallway configuration', message, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {
    Logger.log(message);
  }
  return { problems: problems, warnings: warnings };
}

/**
 * Move data over from a 2.1 spreadsheet.
 *
 * What changes:
 *   Quantity            → Qty On Shelf
 *   Status/Due Date/Checked Out To → dropped (see README: loans were removed)
 *   Items with Status "In Testing" get their quantity moved to Qty In Testing
 *   Old transactions are copied across with best-effort action mapping
 *
 * Run this ONCE, on a copy of your spreadsheet, before going live.
 */
function migrateFrom21() {
  var ss = SpreadsheetApp.getActive();
  runSetup();

  var legacy = ss.getSheetByName('Inventory');
  if (!legacy) return 'Nothing to migrate.';

  var values = legacy.getDataRange().getValues();
  var headers = values[0].map(function (h) { return String(h).trim(); });
  if (headers.indexOf('Quantity') === -1) {
    return 'This already looks like a 3.0 sheet — no migration needed.';
  }

  var col = {};
  headers.forEach(function (h, i) { col[h] = i; });
  var migrated = 0;

  values.slice(1).forEach(function (row) {
    if (!row[col['Item ID']]) return;
    var qty = Number(row[col['Quantity']]) || 0;
    var status = String(row[col['Status']] || '').trim();
    var inTesting = status === 'In Testing' ? qty : 0;
    var onShelf = status === 'In Testing' ? 0 : qty;

    appendRecord(CONFIG.SHEETS.INVENTORY, {
      'Item ID': row[col['Item ID']],
      'Department': defaultDepartment(),
      'Item Name': row[col['Item Name']],
      'Category': row[col['Category']],
      'Item Class': guessItemClass(row[col['Category']], row[col['Item Name']]),
      'Description': row[col['Description']],
      'Location': row[col['Location']],
      'Qty On Shelf': onShelf,
      'Qty In Testing': inTesting,
      'Min Threshold': Number(row[col['Min Threshold']]) || 0,
      'Reorder To': Number(row[col['Max Threshold']]) || 0,
      'Image URL': row[col['Image URL']] || '',
      'Active': status !== 'Disposed',
      'Notes': row[col['Notes']] || '',
      'Last Updated': formatDate(now()),
      'Updated By': 'migration'
    });
    migrated++;
  });

  var message = 'Migrated ' + migrated + ' items.\n\n' +
    'Old columns kept for reference in the original sheet. Check quantities, ' +
    'set Department on the Media Services rows, then delete the legacy sheet.';
  try {
    SpreadsheetApp.getUi().alert('Migration finished', message, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {
    Logger.log(message);
  }
  return message;
}
