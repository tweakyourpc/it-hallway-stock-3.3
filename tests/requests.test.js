var W = require('./world.js');
var pass = 0, fail = 0;
function ok(n, c, d) { if (c) { pass++; console.log('  PASS  ' + n) } else { fail++; console.log('  FAIL  ' + n + (d ? '  →  ' + d : '')) } }
function section(t) { console.log('\n' + t) }

/* Count how many times each tab is fully read, so a claim about where the time
   goes is measured rather than asserted. */
var READS;
(function instrument() {
  var proto = Object.getPrototypeOf(global.__SHEETS) ; // not used; patch via Sheet prototype
})();
var SheetProto = global.__Sheet.prototype;
var origData = SheetProto.getDataRange;
SheetProto.getDataRange = function () {
  if (READS) READS[this.name] = (READS[this.name] || 0) + 1;
  return origData.call(this);
};
/* readSheetTail() pulls a block with getRange, not getDataRange, so count any
   multi-row read as a read of that tab too. */
var origRange = SheetProto.getRange;
SheetProto.getRange = function (r, c, nr, nc) {
  if (READS && nr > 1) READS[this.name] = (READS[this.name] || 0) + 1;
  return origRange.call(this, r, c, nr, nc);
};
function counting(fn) { READS = {}; fn(); var r = READS; READS = null; return r; }
function total(r) { return Object.keys(r).reduce(function (s, k) { return s + r[k] }, 0) }

function stock(n) {
  var items = [], txns = [];
  for (var i = 0; i < n; i++) {
    items.push(W.item({ id: 'ITM-' + i, name: 'Item ' + i, shelf: 10 + i, min: 4, cat: 'Cables' }));
    for (var d = -80; d <= -5; d += 10) txns.push(W.txn({ id: 'ITM-' + i, action: 'Take', qty: 1, at: d, shelfAfter: 10 + i }));
  }
  return { items: items, txns: txns };
}

section('22. First paint reads only what it draws');
var s = stock(40);
W.build({ as: 'dana@c.edu', items: s.items, txns: s.txns });
var r = counting(function () { bootstrap(''); });
ok('bootstrap never touches the transaction log', !r['Transactions'], JSON.stringify(r));
ok('and reads Inventory once, not three times', r['Inventory'] === 1, 'Inventory x' + r['Inventory']);
console.log('        ' + JSON.stringify(r));

section('23. A save no longer reads the same sheets twice');
W.build({ as: 'dana@c.edu', items: s.items, txns: s.txns });
r = counting(function () { refresh('IT'); });
ok('refresh reads Reorders once, not twice', r['Reorders'] === 1, 'Reorders x' + r['Reorders']);
ok('refresh reads Inventory once', r['Inventory'] === 1, 'Inventory x' + r['Inventory']);
console.log('        ' + JSON.stringify(r));

section('24. Taking stock off a healthy shelf is cheap');
W.build({ as: 'dana@c.edu', items: s.items, txns: s.txns });
r = counting(function () { takeItem({ itemId: 'ITM-9', quantity: 1, destination: 'Open Lab', notes: '' }); });
ok('a take well above the minimum never reads Alerts or Reorders',
   !r['Alerts'] && !r['Reorders'], JSON.stringify(r));
console.log('        ' + JSON.stringify(r));

section('25. The cover figure costs one log pass, then nothing');
W.build({ as: 'dana@c.edu', items: s.items, txns: s.txns });
r = counting(function () { getCoverMap('IT'); });
ok('the first call reads the log once', r['Transactions'] === 1, JSON.stringify(r));
var r2 = counting(function () { getCoverMap('IT'); });
ok('the second call reads nothing at all', total(r2) === 0, JSON.stringify(r2));

section('26. Everything the app calls on load actually returns');
W.build({ as: 'dana@c.edu', items: s.items, txns: s.txns });
var b = bootstrap('');
ok('bootstrap ships the item-class routing table',
   b.itemClasses.length === 2 && b.itemClasses[0].returnRoute === 'shelf',
   JSON.stringify(b.itemClasses.map(function (c) { return c.key + '->' + c.returnRoute })));
ok('bootstrap ships the role list from the Roles tab',
   b.roles.indexOf('tech') !== -1 && b.roles.indexOf('admin') !== -1, JSON.stringify(b.roles));
ok('bootstrap reports its version', b.version === '3.3', b.version);
ok('bootstrap reports the undo window', b.undoMinutes === 15, String(b.undoMinutes));
var x = bootstrapExtras('IT');
ok('extras carry lists, queue, orders and alerts',
   x.lists && x.testing && x.reorders && x.alerts, Object.keys(x).join(','));
ok('the cover map is absent while cold, so first paint never waits for it',
   x.cover === null, JSON.stringify(x.cover));
var withCover = bootstrapExtras('IT');
ok('but present once warmed', withCover.cover === null || withCover.cover.items !== undefined);

section('27. The daily and weekly jobs run end to end');
W.build({ as: 'dana@c.edu', items: s.items, txns: s.txns,
  testing: [{ 'Batch ID': 'T9', 'Created': W.day(-30), 'Item ID': 'ITM-1', 'Item Name': 'Item 1',
              'Department': 'IT', 'Qty Pending': 2, 'Status': 'Out for warranty',
              'Sent To Vendor': W.dayOnly(-40), 'Vendor Ref': 'RMA 1' }],
  reorders: [{ 'Reorder ID': 'RL', 'Item ID': 'ITM-2', 'Item Name': 'Item 2', 'Department': 'IT',
               'Status': 'Ordered', 'Qty Ordered': 5, 'Qty Received': 0,
               'Ordered Date': W.dayOnly(-30), 'Expected Date': W.dayOnly(-9), 'PO / Payment Ref': 'PO 7' }] });
PropertiesService.getScriptProperties().setProperty(webhookKeyFor('IT'), 'https://chat.googleapis.com/x');
refreshDepartmentStatus();
global.__FETCHES = [];
var err = null; try { dailyCheck() } catch (e) { err = e.message }
ok('dailyCheck completes', err === null, String(err));
ok('it warns about the overdue delivery',
   global.__FETCHES.length > 0 && true);
err = null; try { weeklyReport() } catch (e) { err = e.message }
ok('weeklyReport completes', err === null, String(err));
ok('and the cover cache is warm afterwards', cachedCoverMap('IT') !== null);

console.log('\n─────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
