var W = require('./world.js');
var pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  →  ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

// ───────────────────────────────────────────────────────────────
section('1. Out-of-stock stretches (the 3.1 sign bug)');
// Paper: empty from day -40, restocked day -20 (both BEFORE the 90-day window),
// then genuinely empty from day -40+... use in-window: out day -12, back day -2.
W.build({
  items: [W.item({ id: 'ITM-P', name: 'Letter Paper', shelf: 8, min: 4 })],
  txns: [
    W.txn({ id: 'ITM-P', action: 'Take', qty: 2, at: -140, shelfAfter: 0 }),
    W.txn({ id: 'ITM-P', action: 'Receive', qty: 5, at: -120, shelfAfter: 5 }),
    W.txn({ id: 'ITM-P', action: 'Take', qty: 5, at: -12, shelfAfter: 0 }),
    W.txn({ id: 'ITM-P', action: 'Receive', qty: 8, at: -2, shelfAfter: 8 }),
    W.txn({ id: 'ITM-P', action: 'Take', qty: 4, at: -70, shelfAfter: 6 }),
    W.txn({ id: 'ITM-P', action: 'Take', qty: 4, at: -50, shelfAfter: 6 }),
    W.txn({ id: 'ITM-P', action: 'Take', qty: 4, at: -30, shelfAfter: 6 })
  ]
});
var u = computeUsage('IT');
var p = u.items.filter(function (r) { return r.id === 'ITM-P'; })[0];
ok('the in-window outage is counted, not cancelled by the pre-window one',
   p.ranOut === true, 'ranOut=' + p.ranOut);
ok('the denominator excludes the 10 days it was empty',
   p.observedDays >= 78 && p.observedDays <= 82, 'observedDays=' + p.observedDays);
ok('it produces a rate', p.reliable === true && p.perWeek > 0, JSON.stringify(p.perWeek));
console.log('        perWeek=' + p.perWeek + '  observedDays=' + p.observedDays + '  cover=' + p.cover);

// ───────────────────────────────────────────────────────────────
section('2. Net vs gross, and the over-return trap');
W.build({
  items: [W.item({ id: 'ITM-U', name: 'APC Back-UPS', cls: 'testable', shelf: 6, min: 3 }),
          W.item({ id: 'ITM-X', name: 'Mistyped Cable', shelf: 9, min: 2 })],
  txns: [
    W.txn({ id: 'ITM-U', action: 'Take', qty: 3, at: -40, shelfAfter: 7 }),
    W.txn({ id: 'ITM-U', action: 'Take', qty: 3, at: -25, shelfAfter: 4 }),
    W.txn({ id: 'ITM-U', action: 'Take', qty: 3, at: -10, shelfAfter: 6 }),
    W.txn({ id: 'ITM-U', action: 'Return to Shelf', qty: 6, at: -8, shelfAfter: 6 }),
    // one mistyped return, far more than ever went out
    W.txn({ id: 'ITM-X', action: 'Take', qty: 1, at: -30, shelfAfter: 9 }),
    W.txn({ id: 'ITM-X', action: 'Take', qty: 1, at: -20, shelfAfter: 8 }),
    W.txn({ id: 'ITM-X', action: 'Take', qty: 1, at: -10, shelfAfter: 7 }),
    W.txn({ id: 'ITM-X', action: 'Put Back', qty: 40, at: -5, shelfAfter: 9 })
  ]
});
u = computeUsage('IT');
var ups = u.items.filter(function (r) { return r.id === 'ITM-U'; })[0];
ok('returns to the shelf are subtracted from consumption',
   ups.taken === 9 && ups.returned === 6, ups.taken + '/' + ups.returned);
ok('gross movement is still reported separately', ups.grossPerWeek > ups.perWeek,
   ups.grossPerWeek + ' vs ' + ups.perWeek);
ok('an impossible over-return is surfaced, not silently swallowed',
   u.dataQuality.length === 1 && u.dataQuality[0].id === 'ITM-X',
   JSON.stringify(u.dataQuality.map(function(r){return r.id})));

// ───────────────────────────────────────────────────────────────
section('3. Out-of-stock items appear in the forecast without a rate');
W.build({
  items: [W.item({ id: 'ITM-E', name: 'Empty Shelf Thing', shelf: 0, min: 2 })],
  txns: [W.txn({ id: 'ITM-E', action: 'Take', qty: 2, at: -3, shelfAfter: 0 })]
});
u = computeUsage('IT');
ok('one movement is not enough for a rate',
   u.items[0].reliable === false, String(u.items[0].reliable));
ok('but the empty shelf is still top of "running out soonest"',
   u.running.length === 1 && u.running[0].id === 'ITM-E', JSON.stringify(u.running.length));

// ───────────────────────────────────────────────────────────────
section('4. Slow movers get a count instead of a blank');
W.build({
  items: [W.item({ id: 'ITM-L', name: 'Projector Lamp', shelf: 3, min: 1 })],
  txns: [W.txn({ id: 'ITM-L', action: 'Take', qty: 1, at: -200, shelfAfter: 4 }),
         W.txn({ id: 'ITM-L', action: 'Take', qty: 1, at: -100, shelfAfter: 3 })]
});
u = computeUsage('IT');
var lamp = u.items[0];
ok('no rate is invented for two movements in seven months', lamp.reliable === false);
ok('it reports what is on record instead',
   /2 taken over the \d+ days on record/.test(lamp.withheld), lamp.withheld);
ok('and it appears in the slow-mover list', u.unknown.length === 1);

// ───────────────────────────────────────────────────────────────
section('5. Trend from the second window');
function trendCase(recentTakes) {
  var txns = [];
  // steady background: one take every 6 days from day -85 to -35
  for (var d = -85; d <= -35; d += 6) txns.push(W.txn({ id: 'ITM-T', action: 'Take', qty: 1, at: d, shelfAfter: 40 }));
  for (var i = 0; i < recentTakes; i++) txns.push(W.txn({ id: 'ITM-T', action: 'Take', qty: 1, at: -20 + i, shelfAfter: 40 }));
  W.build({ items: [W.item({ id: 'ITM-T', name: 'Trending', shelf: 40, min: 5 })], txns: txns });
  return computeUsage('IT').items[0];
}
ok('a burst in the last 30 days reads as picking up', trendCase(18).trend === 'picking up', trendCase(18).trend);
// Deliberately silent rather than guessing: one recent movement is not a trend.
ok('a single recent movement claims no trend at all', trendCase(1).trend === null, String(trendCase(1).trend));
ok('two recent movements against a busy history reads as slowing down',
   trendCase(2).trend === 'slowing down', String(trendCase(2).trend));

// ───────────────────────────────────────────────────────────────
section('6. Lead time: median, and the worst case reported');
W.build({
  items: [W.item({ id: 'ITM-V', name: 'Vendor Item', shelf: 5, min: 3 })],
  txns: [W.txn({ id: 'ITM-V', action: 'Take', qty: 1, at: -30, shelfAfter: 7 }),
         W.txn({ id: 'ITM-V', action: 'Take', qty: 1, at: -20, shelfAfter: 6 }),
         W.txn({ id: 'ITM-V', action: 'Take', qty: 1, at: -10, shelfAfter: 5 })],
  reorders: [
    { 'Reorder ID': 'R1', 'Item ID': 'ITM-V', 'Department': 'IT', 'Status': 'Received',
      'Ordered Date': W.dayOnly(-70), 'Received Date': W.dayOnly(-64), 'Qty Ordered': 5, 'Qty Received': 5 },
    { 'Reorder ID': 'R2', 'Item ID': 'ITM-V', 'Department': 'IT', 'Status': 'Received',
      'Ordered Date': W.dayOnly(-60), 'Received Date': W.dayOnly(-53), 'Qty Ordered': 5, 'Qty Received': 5 },
    { 'Reorder ID': 'R3', 'Item ID': 'ITM-V', 'Department': 'IT', 'Status': 'Received',
      'Ordered Date': W.dayOnly(-50), 'Received Date': W.dayOnly(-44), 'Qty Ordered': 5, 'Qty Received': 5 },
    // one ugly backorder
    { 'Reorder ID': 'R4', 'Item ID': 'ITM-V', 'Department': 'IT', 'Status': 'Received',
      'Ordered Date': W.dayOnly(-120), 'Received Date': W.dayOnly(-60), 'Qty Ordered': 5, 'Qty Received': 5 }
  ]
});
var lt = leadTimeByItem('IT')['ITM-V'];
ok('the 60-day outlier does not drag the typical figure up', lt.days <= 8, 'days=' + lt.days);
ok('the outlier is still reported as the worst seen', lt.worst === 60, 'worst=' + lt.worst);
console.log('        median=' + lt.days + '  worst=' + lt.worst + '  source=' + lt.source);

// ───────────────────────────────────────────────────────────────
section('7. Overdue orders');
W.build({
  items: [W.item({ id: 'ITM-O', name: 'Late Item', shelf: 1, min: 3 })],
  txns: [W.txn({ id: 'ITM-O', action: 'Take', qty: 2, at: -30, shelfAfter: 3 }),
         W.txn({ id: 'ITM-O', action: 'Take', qty: 1, at: -20, shelfAfter: 2 }),
         W.txn({ id: 'ITM-O', action: 'Take', qty: 1, at: -10, shelfAfter: 1 })],
  reorders: [{ 'Reorder ID': 'R9', 'Item ID': 'ITM-O', 'Item Name': 'Late Item', 'Department': 'IT',
               'Status': 'Ordered', 'Qty Ordered': 20, 'Qty Received': 0,
               'Ordered Date': W.dayOnly(-40), 'Expected Date': W.dayOnly(-14), 'PO / Payment Ref': 'PO 1' }]
});
u = computeUsage('IT');
ok('an order 14 days past its date is flagged',
   u.overdueOrders.length === 1 && u.overdueOrders[0].onOrderOverdue === 14,
   JSON.stringify(u.overdueOrders.map(function(r){return r.onOrderOverdue})));
var list = getReorders('IT', false);
ok('and the orders list carries the same figure', list[0].overdueDays === 14, String(list[0].overdueDays));

console.log('\n─────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
