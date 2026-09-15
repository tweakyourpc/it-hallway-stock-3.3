var W = require('./world.js');
var fs = require('fs'), vm = require('vm');
var pass = 0, fail = 0;
function ok(name, condition) { if (condition) {pass++; console.log('  PASS  '+name)} else {fail++; console.log('  FAIL  '+name)} }
function throws(fn, pattern) {try {fn(); return false} catch(e) {return pattern.test(e.message)} }

new vm.Script(fs.readFileSync(require('path').join(__dirname,'../WebForm.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1]);
ok('client JavaScript parses',true);

function measured() {
  return { items:[W.item({id:'X',name:'Synthetic cable',shelf:20,min:1})],txns:[
    W.txn({id:'X',at:-95,action:'Create',qty:38,shelfAfter:38}),
    W.txn({id:'X',at:-60,action:'Take',qty:6,shelfAfter:32}),
    W.txn({id:'X',at:-30,action:'Take',qty:6,shelfAfter:26}),
    W.txn({id:'X',at:-5,action:'Take',qty:6,shelfAfter:20})] };
}
W.build(measured());
var before=computeUsage('IT').items[0];
global.__SHEETS.Transactions.appendRow(buildRow(CONFIG.HEADERS.Transactions,W.txn({id:'X',at:-1,action:'Send to Vendor',qty:2})));
var after=computeUsage('IT').items[0];
ok('blank vendor snapshot does not create a stockout',!after.ranOut&&after.observedDays===before.observedDays&&after.perDay===before.perDay);
getCoverMap('IT');
takeItem({itemId:'X',quantity:19,destination:'Science Lab 204'});
ok('a take invalidates quantity-dependent cover',cachedCoverMap('IT')===null);
ok('a recent measured rate is still available to a reorder suggestion',cachedCoverFor('IT','X').reliable);
var fresh=getCoverMap('IT');
ok('fresh cover reflects the remaining shelf quantity',fresh.items.X.daysLeft<10&&fresh.items.X.cover===computeUsage('IT').items[0].cover);
putBackOnShelf({itemId:'X',quantity:3});
ok('a return also invalidates cover',cachedCoverMap('IT')===null);

W.build({items:[W.item({id:'EMPTY',name:'Empty',shelf:0}),W.item({id:'NEW',name:'New',shelf:2})]});
var map=getCoverMap('IT');
ok('no evidence is explicit without inventing a rate',map.items.NEW.reliable===false&&map.items.NEW.cover===null&&!!map.items.NEW.evidence);
ok('an empty shelf does not require a forecast',computeUsage('IT').running.some(function(i){return i.id==='EMPTY'}));

W.build({as:'boss@c.edu',items:[W.item({id:'BAT',name:'Synthetic battery',shelf:4,cls:'testable'})]});
var first=returnForTesting({itemId:'BAT',quantity:6});
resolveTestingBatch({batchId:first.batchId,toShelf:2,toDispose:0});
returnForTesting({itemId:'BAT',quantity:5});
var original=getTransactions('IT',60,'BAT').find(function(t){return t.action==='Return to Testing'&&t.quantity===6});
ok('a processed batch cannot borrow other testing units for reversal',throws(function(){voidTransaction(original.id,'wrong return')},/batch has already changed/));
ok('refused reversal leaves both balances and history intact',getItem('BAT').testing===9&&getTestingQueue('IT').reduce(function(n,b){return n+b.pending},0)===9&&!getTransactions('IT',60,'BAT').find(function(t){return t.id===original.id}).voided);

W.build({as:'boss@c.edu',items:[W.item({id:'BAT',name:'Synthetic battery',shelf:4,cls:'testable'})]});
var untouched=returnForTesting({itemId:'BAT',quantity:2});
undoLastAction('mistyped');
ok('an untouched testing return still reverses',getItem('BAT').testing===0&&getTestingQueue('IT').length===0);
var vendor=returnForTesting({itemId:'BAT',quantity:2});
sendBatchToVendor({batchId:vendor.batchId,vendorRef:'Synthetic RMA'});
var ret=getTransactions('IT',60,'BAT').find(function(t){return t.action==='Return to Testing'&&!t.voided});
ok('a vendor batch cannot be reversed as an untouched return',throws(function(){voidTransaction(ret.id,'mistyped')},/batch has already changed/));
returnBatchFromVendor(vendor.batchId,'back');
ok('returning from vendor does not erase batch progress',throws(function(){voidTransaction(ret.id,'mistyped')},/batch has already changed/));

W.build({as:'boss@c.edu',items:[W.item({id:'BAT',name:'Battery',shelf:4,testing:8})],testing:[
  {'Batch ID':'B1','Item ID':'BAT','Item Name':'Battery','Department':'IT','Qty Pending':6,'Status':'Pending','Created':W.day(-10)},
  {'Batch ID':'B2','Item ID':'BAT','Item Name':'Battery','Department':'IT','Qty Pending':2,'Status':'Out for warranty','Created':W.day(-20),'Sent To Vendor':W.dayOnly(-15)}]});
var extras=bootstrapExtras('IT');
ok('available, bench and vendor quantities are distinct',getItem('BAT').shelf===4&&extras.unavailable.BAT.bench===6&&extras.unavailable.BAT.vendor===2);
resolveTestingBatch({batchId:'B1',toShelf:2,toIssue:1,toDispose:1,destination:'Library Lab',disposalReason:'Failed testing',notes:'test'});
var q=getTestingQueue('IT').find(function(b){return b.batchId==='B1'});
ok('mixed results preserve remainder and prior result context',q.pending===2&&/2 to shelf/.test(q.resolutionNote)&&getItem('BAT').shelf===6&&getItem('BAT').testing===4);

W.build({as:'boss@c.edu',items:[W.item({id:'C',name:'Cable',shelf:4})]});
var r=requestReorder({itemId:'C',quantity:10});
var duplicate=requestReorder({itemId:'C',quantity:6});
ok('repeat request reports the actual retained quantity',!duplicate.created&&duplicate.qty===10&&getReorders('IT',false).length===1);
markOrdered({reorderId:r.id,vendor:'Local',poRef:'Synthetic PO',qtyOrdered:40});
receiveOrder({reorderId:r.id,qtyReceived:10});
var receipt=receiveOrder({reorderId:r.id,qtyReceived:5});
ok('partial receipt updates the shelf and cumulative receipt independently',receipt.item.shelf===19&&receipt.received===15&&receipt.status==='Partially Received'&&getReorders('IT',false)[0].outstanding===25);
receiveOrder({reorderId:r.id,qtyReceived:25});
var closed=getReorders('IT',true)[0];
ok('completed orders retain receipt date and are available in history',getReorders('IT',false).length===0&&closed.status==='Received'&&!!closed.receivedDate);
ok('a completed receipt cannot be applied again',throws(function(){receiveOrder({reorderId:r.id,qtyReceived:25})},/Check the count/));

console.log('\n'+pass+' passed, '+fail+' failed');process.exit(fail?1:0);
