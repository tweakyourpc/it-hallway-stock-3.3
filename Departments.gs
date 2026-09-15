/**
 * Departments.gs — the Departments tab.
 *
 * Each department is its own filtered view of the same inventory, with its own
 * chat space for alerts. Adding "Library IT" is a matter of typing a row here
 * and re-running Setup, not editing code and redeploying.
 *
 * The webhook URL itself is NOT stored here. A webhook URL is a credential —
 * anyone holding it can post into your chat space — so it lives in Script
 * Properties and is set from the app's notification settings. This tab only
 * shows whether one has been configured.
 */

function buildDepartmentsSheet() {
  var ss = SpreadsheetApp.getActive();
  var name = CONFIG.SHEETS.DEPARTMENTS;
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  var headers = CONFIG.HEADERS[name];

  var isNew = sheet.getLastRow() < 2;
  applyHeaders(sheet, headers);

  if (isNew) {
    sheet.getRange(2, 1, 2, headers.length).setValues([
      ['IT', 'IT / Helpdesk', 'Yes', '', 'Batteries, cables, keyboards, paper'],
      ['AV', 'Media Services', 'Yes', '', 'A/V cables, microphones, projector lamps']
    ]);
  }

  setValidationSafely(sheet.getRange(2, 3, 200, 1),
    SpreadsheetApp.newDataValidation().requireValueInList(['Yes', 'No'], true)
      .setAllowInvalid(false)
      .setHelpText('Set to No to hide this department from the app without deleting its history.')
      .build(), 'Departments > Active');

  sheet.getRange(1, 1).setNote(
    'Short code used on every inventory row, e.g. IT or AV.\n\n'
    + 'Keep it short and do not change it once items are using it — existing rows reference it.'
  );
  sheet.getRange(1, 2).setNote('The name people see in the app\'s department switcher. Safe to rename any time.');
  sheet.getRange(1, 4).setNote(
    'Whether a Google Chat webhook has been saved for this department.\n\n'
    + 'Set the webhook itself in the app: your name → Notification settings. '
    + 'URLs are credentials and are never stored in the spreadsheet.'
  );

  sheet.setColumnWidth(1, 80);
  sheet.setColumnWidth(2, 200);
  sheet.setColumnWidth(3, 70);
  sheet.setColumnWidth(4, 150);
  sheet.setColumnWidth(5, 320);

  refreshDepartmentStatus();
  return sheet;
}

/** Writes the "Chat alerts" column so the tab reflects reality. */
function refreshDepartmentStatus() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEETS.DEPARTMENTS);
  if (!sheet || sheet.getLastRow() < 2) return;

  var data = readSheet(CONFIG.SHEETS.DEPARTMENTS);
  var props = PropertiesService.getScriptProperties();
  var statusCol = data.col['Chat alerts'];
  if (statusCol === undefined) return;

  data.rows.forEach(function (row, i) {
    var id = cleanText(cell(row, data.col, 'ID'), 20);
    if (!id) return;
    var configured = !!props.getProperty(webhookKeyFor(id));
    sheet.getRange(i + 2, statusCol + 1).setValue(configured ? 'Configured' : 'Not set up');
  });
}

function webhookKeyFor(departmentId) {
  return 'webhook.' + String(departmentId).trim();
}

var __deptMemo = null;

/** Active departments, in sheet order. Falls back to a single default. */
function listDepartments() {
  if (__deptMemo) return __deptMemo;

  var sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEETS.DEPARTMENTS);
  var out = [];

  if (sheet && sheet.getLastRow() > 1) {
    var data = readSheet(CONFIG.SHEETS.DEPARTMENTS);
    data.rows.forEach(function (row) {
      var id = cleanText(cell(row, data.col, 'ID'), 20);
      if (!id) return;
      var active = String(cell(row, data.col, 'Active')).trim();
      if (active && !boolFrom(active) && active.toLowerCase() !== 'yes') return;
      out.push({
        id: id,
        label: cleanText(cell(row, data.col, 'Department name'), 80) || id,
        webhookKey: webhookKeyFor(id)
      });
    });
  }

  if (!out.length) out = [{ id: 'IT', label: 'IT / Helpdesk', webhookKey: 'webhook.IT' }];
  __deptMemo = out;
  return out;
}

function departmentIds() {
  return listDepartments().map(function (d) { return d.id; });
}

function getDepartment(id) {
  var list = listDepartments();
  var found = null;
  list.forEach(function (d) { if (d.id === id) found = d; });
  return found || list[0];
}

/** The department the app opens on, validated against what actually exists. */
function defaultDepartment() {
  var want = setting('app.defaultDepartment');
  return departmentIds().indexOf(want) !== -1 ? want : listDepartments()[0].id;
}

function clearDepartmentCache() {
  __deptMemo = null;
}
