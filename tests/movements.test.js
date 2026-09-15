var W = require('./world.js');
var pass = 0, fail = 0;
function ok(n, c, d) { if (c) { pass++; console.log('  PASS  ' + n) } else { fail++; console.log('  FAIL  ' + n + (d ? '  →  ' + d : '')) } }
function section(t) { console.log('\n' + t) }
function threw(fn) { try { fn(); return null } catch (e) { return e.message } }
function shelfOf(id) { return getItem(id).shelf }
function testingOf(id) { return getItem(id).testing }

// ───────────────────────────────────────────────────────────────
section('8. Undo a mistaken take');
W.build({ as: 'dana@c.edu', items: [W.item({ id: 'ITM-A', name: 'USB-C Cable', shelf: 20, min: 5 })] });
takeItem({ itemId: 'ITM-A', quantity: 3, destination: 'Open Lab', notes: '' });
ok('the take moved stock', shelfOf('ITM-A') === 17, String(shelfOf('ITM-A')));
var undone = undoLastAction('mistyped');
ok('undo puts it straight back', shelfOf('ITM-A') === 20, String(shelfOf('ITM-A')));
ok('undo reports what it reversed', undone.action === 'Take' && undone.quantity === 3, JSON.stringify(undone.action));
var log = getTransactions('IT', 20, 'ITM-A');
ok('the original row is kept and marked, not deleted', log.length === 1 && log[0].voided === true,
   log.length + ' rows');
ok('and it cannot be undone twice', /already undone/.test(threw(function () { undoLastAction('again') })),
   threw(function () { undoLastAction('again') }));

// The dangerous version of "undo twice": a correct movement, then a mistake,
// then two taps on Undo. The second tap must not quietly reverse the good one.
W.build({ as: 'dana@c.edu', items: [
  W.item({ id: 'ITM-GOOD', name: 'Correct Take', shelf: 20, min: 2 }),
  W.item({ id: 'ITM-OOPS', name: 'Wrong Item', shelf: 20, min: 2 })] });
takeItem({ itemId: 'ITM-GOOD', quantity: 5, destination: 'Open Lab', notes: '' });
takeItem({ itemId: 'ITM-OOPS', quantity: 1, destination: 'Open Lab', notes: '' });
undoLastAction('wrong item');
ok('the mistake is reversed', shelfOf('ITM-OOPS') === 20, String(shelfOf('ITM-OOPS')));
var second = threw(function () { undoLastAction('double tap') });
ok('a second tap on Undo refuses rather than reversing the earlier correct take',
   /already undone/.test(second), String(second));
ok('the correct take is untouched', shelfOf('ITM-GOOD') === 15, String(shelfOf('ITM-GOOD')));

section('9. Undo is scoped to your own movement, and to the window');
W.build({ as: 'dana@c.edu', items: [W.item({ id: 'ITM-B', name: 'Patch Cable', shelf: 10, min: 2 })] });
takeItem({ itemId: 'ITM-B', quantity: 2, destination: 'Open Lab', notes: '' });
global.__EMAIL = 'tech@c.edu'; clearAllCaches();
ok('somebody else cannot undo it as "their last action"',
   /left to undo/.test(threw(function () { undoLastAction('nope') })),
   threw(function () { undoLastAction('nope') }));
ok('but a tech without txn.void cannot reverse it by ID either',
   /only undo your own/.test(threw(function () { voidTransaction(getTransactions('IT',5,'ITM-B')[0].id, 'reason') })),
   threw(function () { voidTransaction(getTransactions('IT',5,'ITM-B')[0].id, 'r') }));
global.__EMAIL = 'boss@c.edu'; clearAllCaches();
voidTransaction(getTransactions('IT', 5, 'ITM-B')[0].id, 'wrong item');
ok('a manager with txn.void can, with no time limit', shelfOf('ITM-B') === 10, String(shelfOf('ITM-B')));

section('10. A disposal can never be undone');
W.build({ as: 'tech@c.edu', items: [W.item({ id: 'ITM-C', name: 'Swollen Battery', shelf: 5, min: 1 })] });
disposeFromShelf({ itemId: 'ITM-C', quantity: 1, disposalReason: 'Swollen / leaking battery', notes: '' });
ok('disposal moved stock', shelfOf('ITM-C') === 4, String(shelfOf('ITM-C')));
ok('and undo refuses it by name',
   /cannot be undone|involved money or disposal/.test(threw(function () { undoLastAction('oops') })),
   threw(function () { undoLastAction('oops') }));

// ───────────────────────────────────────────────────────────────
section('11. The bench, three ways out of one batch');
W.build({ as: 'dana@c.edu',
  items: [W.item({ id: 'ITM-U', name: 'APC Back-UPS', cls: 'testable', shelf: 6, min: 3 })] });
var sent = returnForTesting({ itemId: 'ITM-U', quantity: 6, cameFrom: 'Science Lab 204', notes: 'all beeping' });
ok('used units land on the bench, not the shelf',
   shelfOf('ITM-U') === 6 && testingOf('ITM-U') === 6, shelfOf('ITM-U') + '/' + testingOf('ITM-U'));
ok('a consumable-only staff member cannot shortcut a testable to the shelf',
   /test bench/.test(threw(function () { putBackOnShelf({ itemId: 'ITM-U', quantity: 1, cameFrom: '', notes: '' }) })),
   threw(function () { putBackOnShelf({ itemId: 'ITM-U', quantity: 1, cameFrom: '', notes: '' }) }));

global.__EMAIL = 'tech@c.edu'; clearAllCaches();
var res = resolveTestingBatch({ batchId: sent.batchId, toShelf: 2, toIssue: 3, toDispose: 1,
  destination: 'Library Lab', disposalReason: 'Failed testing', notes: 'one swelled' });
ok('two go back on the shelf', shelfOf('ITM-U') === 8, String(shelfOf('ITM-U')));
ok('three go straight out and never touch the shelf', testingOf('ITM-U') === 0, String(testingOf('ITM-U')));
ok('the batch closes', res.remaining === 0, String(res.remaining));
var all = getTransactions('IT', 30, 'ITM-U');
var issued = all.filter(function (t) { return t.action === 'Issued from Bench'; })[0];
ok('the issue is one movement with a destination',
   issued && issued.quantity === 3 && issued.destination === 'Library Lab',
   JSON.stringify(issued && [issued.quantity, issued.destination]));

section('12. Issuing from the bench counts as demand; restocking does not');
var u = computeUsage('IT');
var ups = u.items.filter(function (r) { return r.id === 'ITM-U'; })[0];
ok('the 3 issued units are counted as consumption', ups.taken === 3, 'taken=' + ups.taken);
ok('the 2 restocked units are counted as a return', ups.returned === 2, 'returned=' + ups.returned);
ok('the scrapped unit is tallied as a disposal', ups.disposed === 1, 'disposed=' + ups.disposed);

// ───────────────────────────────────────────────────────────────
section('13. Nested locks and webhooks under lock');
W.build({ as: 'tech@c.edu',
  items: [W.item({ id: 'ITM-D', name: 'Dying UPS', cls: 'testable', shelf: 1, min: 4, testing: 0 })] });
PropertiesService.getScriptProperties().setProperty(webhookKeyFor('IT'), 'https://chat.googleapis.com/x');
refreshDepartmentStatus();
var batch = returnForTesting({ itemId: 'ITM-D', quantity: 4, cameFrom: 'Open Lab', notes: '' });
global.__MAX_LOCK_DEPTH = 0; global.__FETCHES = [];
// Scrapping the lot AND asking for replacements is the path that used to nest locks.
resolveTestingBatch({ batchId: batch.batchId, toShelf: 0, toIssue: 0, toDispose: 4,
  disposalReason: 'Failed testing', notes: '', reorderDisposed: true });
ok('the script lock is never taken twice at once', global.__MAX_LOCK_DEPTH === 1,
   'max depth ' + global.__MAX_LOCK_DEPTH);
ok('a replacement reorder was raised', getReorders('IT', false).length >= 1,
   String(getReorders('IT', false).length));
ok('a chat webhook did fire', global.__FETCHES.length >= 1, String(global.__FETCHES.length));
ok('and no webhook fired while the lock was held',
   global.__FETCHES.every(function (f) { return !f.lockHeld; }),
   JSON.stringify(global.__FETCHES.map(function (f) { return f.lockHeld })));

section('14. Every notification path, checked for the same thing');
W.build({ as: 'boss@c.edu', items: [W.item({ id: 'ITM-N', name: 'Low Thing', shelf: 3, min: 5 })] });
PropertiesService.getScriptProperties().setProperty(webhookKeyFor('IT'), 'https://chat.googleapis.com/x');
refreshDepartmentStatus();
global.__FETCHES = [];
takeItem({ itemId: 'ITM-N', quantity: 1, destination: 'Open Lab', notes: '' });   // low stock alert
requestReorder({ itemId: 'ITM-N', notes: 'more please' });
var rid = getReorders('IT', false)[0].id;
markOrdered({ reorderId: rid, vendor: 'CDW-G', poRef: 'PO 44821', qtyOrdered: 20, unitCost: 4, expectedDate: W.dayOnly(7) });
// Two, not three: the take crosses the minimum and raises a low-stock notice
// AND an automatic reorder, so the manual flag that follows is absorbed into the
// request that already exists and correctly stays quiet.
ok('the low-stock notice and the order confirmation both went out',
   global.__FETCHES.length === 2, String(global.__FETCHES.length));
ok('the redundant reorder request stayed quiet',
   getReorders('IT', false).length === 1, String(getReorders('IT', false).length));
ok('none of them held the lock while doing it',
   global.__FETCHES.every(function (f) { return !f.lockHeld; }),
   JSON.stringify(global.__FETCHES.map(function (f) { return f.lockHeld })));

console.log('\n─────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
