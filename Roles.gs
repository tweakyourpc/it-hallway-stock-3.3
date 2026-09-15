/**
 * Roles.gs — the Roles tab.
 *
 * A grid: one row per permission, one column per role, Yes/No in each cell.
 * It's the whole authorisation model on one screen, which is a lot easier to
 * audit than a nested object in a code file — you can look at it and answer
 * "can a student worker do X?" in two seconds.
 *
 * Adding a role means adding a column. Removing a permission from every role
 * means a column of No. The catalogue of permissions itself lives in code,
 * because those strings are what the code actually checks.
 *
 * Admin is a special case: it is forced to Yes for everything by the reader,
 * so no edit here can lock every admin out of their own system.
 */

/** The vocabulary. Each entry becomes a row on the Roles tab. */
function permissionCatalog() {
  return [
    { key: 'item.view',        desc: 'See the stock list and item details' },
    { key: 'report.view',      desc: 'See usage rates and the reports tab' },
    { key: 'item.take',        desc: 'Take units off the shelf' },
    { key: 'item.return',      desc: 'Send used units to the test bench' },
    { key: 'reorder.request',  desc: 'Flag an item as needing reordering' },
    { key: 'item.create',      desc: 'Add a new item to the inventory' },
    { key: 'item.edit',        desc: 'Change an item\'s name, thresholds, vendor or photo' },
    { key: 'item.adjust',      desc: 'Correct a shelf count by hand (always logged with a reason)' },
    { key: 'testing.resolve',  desc: 'Decide whether bench units go back on the shelf or get disposed' },
    { key: 'photo.upload',     desc: 'Upload item photos from a phone' },
    { key: 'reorder.receive',  desc: 'Record a delivery and add it to the shelf' },
    { key: 'reorder.approve',  desc: 'Approve or decline a reorder request (when approval is required)' },
    { key: 'reorder.order',    desc: 'Record vendor, PO or p-card details against a request' },
    { key: 'txn.undoOwn',      desc: 'Undo their OWN take or return, for a few minutes afterwards' },
    { key: 'txn.void',         desc: 'Reverse anyone\'s mistaken transaction, with no time limit' },
    { key: 'item.archive',     desc: 'Retire an item from the list, keeping its history' },
    { key: 'settings.manage',  desc: 'Change settings and chat webhooks' },
    { key: 'users.manage',     desc: 'Add people and change their roles' }
  ];
}

/** Starting grid, used only when the Roles tab is first created. */
function defaultRoleMatrix() {
  return {
    roles: ['viewer', 'staff', 'tech', 'manager', 'admin'],
    grants: {
      'item.view':       ['viewer', 'staff', 'tech', 'manager', 'admin'],
      'report.view':     ['viewer', 'staff', 'tech', 'manager', 'admin'],
      'item.take':       ['staff', 'tech', 'manager', 'admin'],
      'item.return':     ['staff', 'tech', 'manager', 'admin'],
      'reorder.request': ['staff', 'tech', 'manager', 'admin'],
      'item.create':     ['tech', 'manager', 'admin'],
      'item.edit':       ['tech', 'manager', 'admin'],
      'item.adjust':     ['tech', 'manager', 'admin'],
      'testing.resolve': ['tech', 'manager', 'admin'],
      'photo.upload':    ['tech', 'manager', 'admin'],
      'reorder.receive': ['tech', 'manager', 'admin'],
      'reorder.approve': ['manager', 'admin'],
      'reorder.order':   ['manager', 'admin'],
      // Deliberately as wide as item.take: whoever can make the mistake can fix
      // it. It is narrow in every other direction — their own movement, only a
      // kind that reverses cleanly, and only for app.undoMinutes.
      'txn.undoOwn':     ['staff', 'tech', 'manager', 'admin'],
      'txn.void':        ['manager', 'admin'],
      'item.archive':    ['manager', 'admin'],
      'settings.manage': ['admin'],
      'users.manage':    ['admin']
    }
  };
}

function buildRolesSheet() {
  var ss = SpreadsheetApp.getActive();
  var name = CONFIG.SHEETS.ROLES;
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  var catalog = permissionCatalog();

  // Preserve whatever is already set.
  var existing = {};
  var roles = null;
  if (sheet.getLastRow() > 1) {
    var old = sheet.getDataRange().getValues();
    roles = old[0].slice(2).map(function (r) { return String(r).trim().toLowerCase(); }).filter(Boolean);
    old.slice(1).forEach(function (row) {
      var key = String(row[0] || '').trim();
      if (!key) return;
      existing[key] = {};
      roles.forEach(function (r, i) { existing[key][r] = String(row[i + 2] || '').trim(); });
    });
  }

  var matrix = defaultRoleMatrix();
  if (!roles || !roles.length) roles = matrix.roles;

  var rows = [['Permission', 'What it allows'].concat(roles)];
  catalog.forEach(function (p) {
    var line = [p.key, p.desc];
    roles.forEach(function (role) {
      var prior = existing[p.key] && existing[p.key][role];
      if (prior) { line.push(prior); return; }
      var granted = (matrix.grants[p.key] || []).indexOf(role) !== -1 || role === 'admin';
      line.push(granted ? 'Yes' : 'No');
    });
    rows.push(line);
  });

  wipeSheet(sheet);
  sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);

  sheet.getRange(1, 1, 1, rows[0].length)
    .setFontWeight('bold').setBackground('#16202b').setFontColor('#ffffff')
    .setHorizontalAlignment('center');
  sheet.getRange(1, 1, 1, 2).setHorizontalAlignment('left');
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(2);

  sheet.setColumnWidth(1, 175);
  sheet.setColumnWidth(2, 430);
  for (var c = 0; c < roles.length; c++) sheet.setColumnWidth(3 + c, 92);

  var grid = sheet.getRange(2, 3, rows.length - 1, roles.length);
  grid.setHorizontalAlignment('center');
  setValidationSafely(grid,
    SpreadsheetApp.newDataValidation().requireValueInList(['Yes', 'No'], true)
      .setAllowInvalid(false)
      .setHelpText('Yes grants this permission to this role. Admin is always treated as Yes.')
      .build(), 'the Roles grid');

  // Colour the grid so the shape of the model is readable at a glance.
  var rules = [
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Yes')
      .setBackground('#e8f3ed').setFontColor('#1f7a4d').setRanges([grid]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('No')
      .setBackground('#f6f8f9').setFontColor('#a8b4be').setRanges([grid]).build()
  ];
  sheet.setConditionalFormatRules(rules);

  sheet.getRange(1, 1).setNote(
    'These keys are what the code checks. Do not rename them.\n\n'
    + 'To add a role, type its name in the next empty column heading and fill the column '
    + 'with Yes/No, then re-run Setup so the Users tab dropdown picks it up.'
  );
  sheet.getRange(1, roles.indexOf('admin') + 3).setNote(
    'Admin is always granted everything, whatever this column says. '
    + 'That is deliberate — it stops a mis-click here locking every admin out.'
  );

  clearRoleCache();
  return sheet;
}

var __roleMemo = null;

function roleMatrix() {
  if (__roleMemo) return __roleMemo;

  var sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEETS.ROLES);
  var result = { roles: [], grants: {} };

  if (sheet && sheet.getLastRow() > 1) {
    var data = sheet.getDataRange().getValues();
    result.roles = data[0].slice(2)
      .map(function (r) { return String(r).trim().toLowerCase(); })
      .filter(Boolean);

    data.slice(1).forEach(function (row) {
      var key = String(row[0] || '').trim();
      if (!key || key.indexOf('.') === -1) return;
      result.roles.forEach(function (role, i) {
        var yes = String(row[i + 2] || '').trim().toLowerCase();
        if (yes === 'yes' || yes === 'true') {
          if (!result.grants[role]) result.grants[role] = [];
          result.grants[role].push(key);
        }
      });
    });
  }

  if (!result.roles.length) {
    var fallback = defaultRoleMatrix();
    result.roles = fallback.roles;
    result.grants = {};
    fallback.roles.forEach(function (role) {
      result.grants[role] = [];
      Object.keys(fallback.grants).forEach(function (perm) {
        if (fallback.grants[perm].indexOf(role) !== -1) result.grants[role].push(perm);
      });
    });
  }

  // Admin always holds everything, regardless of what the grid says.
  result.grants['admin'] = permissionCatalog().map(function (p) { return p.key; });
  if (result.roles.indexOf('admin') === -1) result.roles.push('admin');

  __roleMemo = result;
  return result;
}

function roleNames() {
  return roleMatrix().roles;
}

function permissionsFor(role) {
  var m = roleMatrix();
  return (m.grants[role] || []).slice();
}

function clearRoleCache() {
  __roleMemo = null;
}
