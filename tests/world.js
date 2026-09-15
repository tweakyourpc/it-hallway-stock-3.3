require('./stubs.js');
var fs = require('fs');
var vm = require('vm');
// The Apps Script project itself: the folder above this one, unless GS_DIR says
// otherwise. Nothing here touches a real spreadsheet.
var path = require('path');
var DIR = process.env.GS_DIR || path.join(__dirname, '..') + path.sep;

// Load every .gs into the shared global scope, exactly as Apps Script does.
['Code.gs','Utils.gs','Settings.gs','Roles.gs','Departments.gs','Auth.gs',
 'Inventory.gs','Testing.gs','Reorder.gs','Reports.gs','Notify.gs','Setup.gs','WebApp.gs']
  .forEach(function (f) {
    vm.runInThisContext(fs.readFileSync(DIR + f, 'utf8'), { filename: f });
  });

var DAY = 86400000;
function day(offset) { // a timestamp `offset` days from now, as the sheet stores it
  var d = new Date(Date.now() + offset * DAY);
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd HH:mm:ss');
}
function dayOnly(offset) {
  return Utilities.formatDate(new Date(Date.now() + offset * DAY), 'UTC', 'yyyy-MM-dd');
}

function sheet(name, headers, rows) {
  global.__SHEETS[name] = new global.__Sheet(name, [headers].concat(rows || []));
}

/** A workbook with the standard tabs and whatever rows a test wants. */
function build(opts) {
  var o = opts || {};
  global.__SHEETS = {};
  global.__FETCHES = []; global.__MAILS = [];
  global.__LOCK_DEPTH = 0; global.__MAX_LOCK_DEPTH = 0;
  clearAllCaches();

  Object.keys(CONFIG.HEADERS).forEach(function (n) { sheet(n, CONFIG.HEADERS[n], []); });
  sheet('Dashboard', ['', ''], []);
  var baseSettings = { 'access.allowedDomains': 'c.edu', 'access.institutionName': 'Test College' };
  sheet('Config', ['Key', 'Question', 'Value'],
    settingsSchema().map(function (s) {
      var v = (o.settings && o.settings[s.key] !== undefined) ? o.settings[s.key]
            : (baseSettings[s.key] !== undefined ? baseSettings[s.key] : s.def);
      return [s.key, s.label, typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v];
    }));
  sheet('Roles', ['Permission', 'What it allows', 'viewer', 'staff', 'tech', 'manager', 'admin'],
    permissionCatalog().map(function (p) {
      var g = defaultRoleMatrix().grants[p.key] || [];
      return [p.key, p.desc].concat(['viewer','staff','tech','manager','admin']
        .map(function (r) { return g.indexOf(r) !== -1 || r === 'admin' ? 'Yes' : 'No'; }));
    }));
  sheet('Departments', CONFIG.HEADERS['Departments'], [['IT','IT / Helpdesk','Yes','',''],
                                                       ['AV','Media Services','Yes','','']]);
  sheet('Users', CONFIG.HEADERS['Users'], (o.users || [
    ['dana@c.edu','Dana','staff','IT',true,day(-60)],
    ['tech@c.edu','Tariq','tech','IT',true,day(-60)],
    ['boss@c.edu','Mo','manager','IT',true,day(-60)]
  ]));

  (o.items || []).forEach(function (i) { global.__SHEETS['Inventory'].appendRow(buildRow(CONFIG.HEADERS['Inventory'], i)); });
  (o.txns || []).forEach(function (t) { global.__SHEETS['Transactions'].appendRow(buildRow(CONFIG.HEADERS['Transactions'], t)); });
  (o.reorders || []).forEach(function (r) { global.__SHEETS['Reorders'].appendRow(buildRow(CONFIG.HEADERS['Reorders'], r)); });
  (o.testing || []).forEach(function (r) { global.__SHEETS['Testing Queue'].appendRow(buildRow(CONFIG.HEADERS['Testing Queue'], r)); });

  global.__EMAIL = o.as || 'tech@c.edu';
  clearAllCaches();
}

function item(o) {
  return {
    'Item ID': o.id, 'Department': o.dept || 'IT', 'Item Name': o.name,
    'Category': o.cat || 'Misc', 'Item Class': o.cls || 'consumable',
    'Location': o.loc || 'Back Hallway A',
    'Qty On Shelf': o.shelf === undefined ? 10 : o.shelf,
    'Qty In Testing': o.testing || 0,
    'Min Threshold': o.min === undefined ? 4 : o.min,
    'Reorder To': o.reorderTo === undefined ? 20 : o.reorderTo,
    'Unit Cost': o.cost || '', 'Vendor': o.vendor || '', 'Active': true,
    'Last Updated': day(-1), 'Updated By': 'setup'
  };
}

var txnN = 0;
function txn(o) {
  txnN++;
  return {
    'Transaction ID': 'TXN-' + txnN, 'Timestamp': day(o.at),
    'Item ID': o.id, 'Item Name': o.name || o.id, 'Department': o.dept || 'IT',
    'Action': o.action, 'Quantity': o.qty,
    'Shelf After': o.shelfAfter === undefined ? '' : o.shelfAfter,
    'Testing After': o.testingAfter === undefined ? '' : o.testingAfter,
    'Destination': o.dest || '', 'User Email': o.by || 'dana@c.edu',
    'User Name': 'Dana', 'Notes': '', 'Reference': o.ref || '',
    'Voided': o.voided ? true : '', 'Void Note': ''
  };
}

module.exports = { build: build, item: item, txn: txn, day: day, dayOnly: dayOnly, sheet: sheet };
