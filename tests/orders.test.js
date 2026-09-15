var W = require('./world.js');
var pass = 0, fail = 0;
function ok(n, c, d) { if (c) { pass++; console.log('  PASS  ' + n) } else { fail++; console.log('  FAIL  ' + n + (d ? '  →  ' + d : '')) } }
function section(t) { console.log('\n' + t) }
function threw(fn) { try { fn(); return null } catch (e) { return e.message } }

section('15. The reorder flow table is the only gatekeeper');
W.build({ as: 'boss@c.edu', settings: { 'reorder.requiresApproval': true },
  items: [W.item({ id: 'ITM-R', name: 'Toner', shelf: 2, min: 5 })] });
requestReorder({ itemId: 'ITM-R', notes: '' });
var r = getReorders('IT', false)[0];
ok('approval on means it starts pending', r.status === 'Pending approval', r.status);
var msg = threw(function () {
  markOrdered({ reorderId: r.id, vendor: 'CDW-G', poRef: 'PO 1', qtyOrdered: 10, unitCost: 1, expectedDate: '' });
});
ok('it cannot be ordered before approval', !!msg, String(msg));
ok('and the refusal now lists what IS legal from here (the table talking)',
   /can only be: Needed, Declined, Cancelled/.test(msg), msg);

approveReorder(r.id, true, 'go ahead');
markOrdered({ reorderId: r.id, vendor: 'CDW-G', poRef: 'PO 1', qtyOrdered: 10, unitCost: 1, expectedDate: W.dayOnly(5) });
receiveOrder({ reorderId: r.id, qtyReceived: 4, notes: 'part one' });
var r2 = getReorders('IT', true).filter(function (x) { return x.id === r.id })[0];
ok('a short delivery stays open', r2.status === 'Partially Received', r2.status);
ok('the shelf went up by what arrived', getItem('ITM-R').shelf === 6, String(getItem('ITM-R').shelf));
receiveOrder({ reorderId: r.id, qtyReceived: 6, notes: 'the rest' });
r2 = getReorders('IT', true).filter(function (x) { return x.id === r.id })[0];
ok('the rest closes it', r2.status === 'Received', r2.status);
ok('receiving more than ordered is refused',
   /Check the count/.test(threw(function () { receiveOrder({ reorderId: r.id, qtyReceived: 1, notes: '' }) })),
   threw(function () { receiveOrder({ reorderId: r.id, qtyReceived: 1, notes: '' }) }));

section('16. A pallet can be received without hitting the take limit');
W.build({ as: 'boss@c.edu', settings: { 'take.maxQtyPerAction': 20 },
  items: [W.item({ id: 'ITM-PA', name: 'Letter Paper', shelf: 2, min: 5 })] });
requestReorder({ itemId: 'ITM-PA', notes: '' });
var pid = getReorders('IT', false)[0].id;
markOrdered({ reorderId: pid, vendor: 'Local', poRef: 'PO 2', qtyOrdered: 1000, unitCost: 3, expectedDate: '' });
receiveOrder({ reorderId: pid, qtyReceived: 1000, notes: '' });
ok('1000 reams arrive against a take limit of 20', getItem('ITM-PA').shelf === 1002,
   String(getItem('ITM-PA').shelf));
ok('but one person still cannot carry off 30 at once',
   /above the 20 limit/.test(threw(function () { takeItem({ itemId: 'ITM-PA', quantity: 30, destination: 'Open Lab', notes: '' }) })),
   threw(function () { takeItem({ itemId: 'ITM-PA', quantity: 30, destination: 'Open Lab', notes: '' }) }));

section('17. Suggested order quantity uses the measured rate when it has one');
var txns = [];
for (var d = -84; d <= -7; d += 7) txns.push(W.txn({ id: 'ITM-S', action: 'Take', qty: 7, at: d, shelfAfter: 30 }));
W.build({ as: 'boss@c.edu',
  items: [W.item({ id: 'ITM-S', name: 'Fast Cable', shelf: 4, min: 5, reorderTo: 10 })],
  txns: txns,
  reorders: [{ 'Reorder ID': 'RX', 'Item ID': 'ITM-S', 'Department': 'IT', 'Status': 'Received',
               'Ordered Date': W.dayOnly(-40), 'Received Date': W.dayOnly(-30),
               'Qty Ordered': 10, 'Qty Received': 10 }] });
var cold = suggestedOrderQty(getItem('ITM-S'));
ok('with no rates cached it falls back to topping up', cold === 6, 'cold=' + cold);
computeCoverMap('IT');                       // warm the cache, as the daily check does
var warm = suggestedOrderQty(getItem('ITM-S'));
ok('once the rate is known it asks for enough to actually cover the gap', warm > cold,
   'warm=' + warm + ' vs cold=' + cold);
console.log('        top-up would order ' + cold + '; the measured rate asks for ' + warm);

section('18. Cover map matches the Usage tab, and is shared not recomputed');
W.build({ items: [W.item({ id: 'ITM-M', name: 'Measured', shelf: 20, min: 5 })],
  txns: (function () { var t = []; for (var d = -84; d <= -7; d += 7) t.push(W.txn({ id: 'ITM-M', action: 'Take', qty: 2, at: d, shelfAfter: 20 })); return t })() });
var usage = computeUsage('IT').items[0];
var map = computeCoverMap('IT');
ok('the tag figure is the same object as the report figure',
   map.items['ITM-M'].cover === usage.cover, map.items['ITM-M'].cover + ' vs ' + usage.cover);
ok('a second call is served from the cache, not recalculated',
   cachedCoverMap('IT') !== null);
ok('an unreliable item is simply absent rather than shown as zero',
   Object.keys(map.items).length === 1);

section('19. Health check catches a testing bucket that has drifted');
W.build({ items: [W.item({ id: 'ITM-G', name: 'Ghost Units', shelf: 5, testing: 4 })],
  testing: [{ 'Batch ID': 'TST-1', 'Created': W.day(-40), 'Item ID': 'ITM-G',
              'Item Name': 'Ghost Units', 'Department': 'IT', 'Qty Pending': 1, 'Status': 'Pending' }] });
PropertiesService.getScriptProperties().setProperty('setupCompleted', W.day(-1));
var check = checkConfiguration();
ok('the drift is reported with both numbers',
   check.warnings.some(function (w) { return /Qty In Testing does not match/.test(w) && /bucket 4, queue 1/.test(w) }),
   JSON.stringify(check.warnings.filter(function (w) { return /Testing/.test(w) })));

section('19b. Retiring an item records why');
W.build({ as: 'boss@c.edu', items: [W.item({ id: 'ITM-Z', name: 'Old Cable', shelf: 3, min: 1 })] });
archiveItem('ITM-Z', 'discontinued, replaced by the 1.5m version');
var inv = readSheet('Inventory');
var zrow = inv.rows[findRow(inv.rows, inv.col['Item ID'], 'ITM-Z')];
ok('it leaves the stock list', computeItems('IT').length === 0, String(computeItems('IT').length));
ok('the reason is kept on the row, not discarded',
   /Retired by Mo: discontinued/.test(String(cell(zrow, inv.col, 'Notes'))),
   String(cell(zrow, inv.col, 'Notes')));
ok('and the row itself survives for its history', !!cell(zrow, inv.col, 'Item ID'));

section('20. Setup is safe to re-run on a live sheet');
W.build({ items: [W.item({ id: 'ITM-K', name: 'Keeper', shelf: 7, min: 2 })] });
runSetup();
ok('existing stock survives a re-run', getItem('ITM-K').shelf === 7, String(getItem('ITM-K').shelf));
ok('the new permission row appears on the Roles tab',
   permissionsFor('staff').indexOf('txn.undoOwn') !== -1,
   JSON.stringify(permissionsFor('staff')));
ok('a viewer still cannot undo anything', permissionsFor('viewer').indexOf('txn.undoOwn') === -1);
ok('the dashboard builds without throwing', typeof buildDashboard() === 'string');

section('21. Bench backlog splits bench from vendor');
W.build({ testing: [
  { 'Batch ID': 'T1', 'Created': W.day(-10), 'Item ID': 'I1', 'Item Name': 'On Bench',
    'Department': 'IT', 'Qty Pending': 2, 'Status': 'Pending' },
  { 'Batch ID': 'T2', 'Created': W.day(-60), 'Item ID': 'I2', 'Item Name': 'At Vendor',
    'Department': 'IT', 'Qty Pending': 3, 'Status': 'Out for warranty',
    'Sent To Vendor': W.dayOnly(-45), 'Vendor Ref': 'RMA 88213' }] });
var backlog = computeTestingBacklog('IT');
ok('the warranty batch is not in the daily bench nudge',
   backlog.onBench.length === 1 && backlog.onBench[0].itemName === 'On Bench',
   JSON.stringify(backlog.onBench.map(function (b) { return b.itemName })));
ok('it is in the vendor chase list, aged from the day it left',
   backlog.atVendor.length === 1 && backlog.atVendor[0].awayDays === 45,
   JSON.stringify(backlog.atVendor.map(function (b) { return b.awayDays })));

console.log('\n─────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
