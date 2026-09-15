/**
 * Run every test file and total the result.
 *
 * These are not Apps Script tests — they cannot be. They load the real .gs files
 * into Node with the Google APIs stubbed (stubs.js) and a fake spreadsheet built
 * per test (world.js), which is enough to exercise every line of the arithmetic
 * and the write paths. Run it before shipping a change to the forecasting.
 */
var cp = require('child_process');
var files = ['forecast.test.js', 'movements.test.js', 'orders.test.js', 'requests.test.js', 'release33.test.js'];
var pass = 0, fail = 0, broke = 0;

files.forEach(function (f) {
  console.log('\n══════ ' + f + ' ══════');
  var r = cp.spawnSync(process.execPath, [__dirname + '/' + f], { encoding: 'utf8' });
  process.stdout.write(r.stdout || '');
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error) process.stderr.write(f + ': ' + r.error.message + '\n');
  var m = (r.stdout || '').match(/(\d+) passed, (\d+) failed/);
  if (m) { pass += +m[1]; fail += +m[2]; } else { broke++; }
});

console.log('\n═════════════════════════════');
console.log(pass + ' assertions passed, ' + fail + ' failed'
  + (broke ? ', ' + broke + ' file(s) did not finish' : ''));
process.exit(fail || broke ? 1 : 0);
