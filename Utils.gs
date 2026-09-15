/**
 * Utils.gs — shared helpers.
 *
 * The important one is readSheet(): it maps columns by HEADER NAME rather than
 * by position, so inserting or reordering a column in the spreadsheet can't
 * silently corrupt your data the way it could in the old version.
 */

/** Get a sheet that must already exist. Fails loudly instead of creating junk. */
function mustGetSheet(name) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sheet) {
    throw new Error('Sheet "' + name + '" is missing. Run Setup from the IT Hallway menu.');
  }
  return sheet;
}

/**
 * Read a whole sheet into { sheet, headers, col, rows }.
 * `col` maps header name → zero-based column index.
 * `rows` excludes the header row.
 */
function readSheet(name) {
  var sheet = mustGetSheet(name);
  var values = sheet.getDataRange().getValues();
  var headers = (values[0] || []).map(function (h) { return String(h).trim(); });
  var col = {};
  headers.forEach(function (h, i) { if (h) col[h] = i; });
  return { sheet: sheet, headers: headers, col: col, rows: values.slice(1) };
}

/**
 * Read only the LAST n data rows of a sheet, plus the header row.
 *
 * The Transactions sheet grows forever. Reading all of it to work out what
 * happened in the last 30 days gets slower every week and eventually walks
 * into the execution time limit. This reads the tail instead.
 *
 * Returns the same shape as readSheet(), plus `truncated`, which is true when
 * the sheet was longer than n — the caller then knows its view is partial and
 * can say so rather than quietly reporting on less data than it thinks.
 */
function readSheetTail(name, n) {
  var sheet = mustGetSheet(name);
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) {
    return { sheet: sheet, headers: [], col: {}, rows: [], truncated: false };
  }

  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  var col = {};
  headers.forEach(function (h, i) { if (h) col[h] = i; });

  var dataRows = lastRow - 1;
  var want = Math.max(0, Math.min(dataRows, n));
  var start = 1 + (dataRows - want);
  var rows = want ? sheet.getRange(start + 1, 1, want, lastCol).getValues() : [];

  return { sheet: sheet, headers: headers, col: col, rows: rows, truncated: want < dataRows };
}

/** Read a single cell from a row array using the header map. */
function cell(row, col, header) {
  var i = col[header];
  return i === undefined ? '' : row[i];
}

/** Build a sheet row array in the correct column order from a plain object. */
function buildRow(headers, obj) {
  return headers.map(function (h) {
    return obj[h] === undefined || obj[h] === null ? '' : obj[h];
  });
}

/**
 * Append a record using the sheet's OWN column order.
 *
 * Every append used to build its row from CONFIG.HEADERS, which is the order
 * the columns were FIRST created in — not necessarily the order they are in
 * now. applyHeaders adds a missing column at the far right rather than in the
 * middle, and the sheet is safe to reorder by hand because everything else
 * reads by header name. So the two orders drift apart, and then an append
 * writes every value one column out of place.
 *
 * Reading the header row costs one call on a write, which is rare. Silent
 * column-shifted data does not announce itself for weeks.
 */
function appendRecord(sheetName, obj) {
  var sheet = mustGetSheet(sheetName);
  var lastCol = Math.max(1, sheet.getLastColumn());
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function (h) { return String(h).trim(); });

  // A brand new sheet with no header row yet falls back to the definition.
  if (!headers.join('')) headers = CONFIG.HEADERS[sheetName] || [];

  sheet.appendRow(buildRow(headers, obj));
  return sheet;
}

/** Write one row back to the sheet. rowIndex is zero-based within data rows. */
function writeRow(sheet, rowIndex, values) {
  sheet.getRange(rowIndex + 2, 1, 1, values.length).setValues([values]);
}

/**
 * Run fn while holding the script lock. Anything that reads a quantity, adds to
 * it, and writes it back must go through here or concurrent users will
 * overwrite each other.
 */
function withLock(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(setting('tech.lockTimeoutSeconds') * 1000)) {
    throw new Error('Someone else is saving right now. Wait a second and try again.');
  }
  var result;
  try {
    result = fn();
  } finally {
    lock.releaseLock();
  }

  // Chat and email are network calls to services we do not control, and a slow
  // one used to be made while still holding this lock — so one unresponsive
  // webhook made the next person at the shelf wait out the whole lock timeout
  // and then read "someone else is saving right now". Anything inside the lock
  // that wants to tell somebody calls queueNotice(); it goes out here, after
  // the lock is gone and the caller's data is already safely written.
  flushNotices();
  return result;
}

/**
 * Never nest withLock().
 *
 * LockService hands back a lock owned by the execution, so an inner tryLock
 * succeeds — and then the inner finally releases the lock the outer block is
 * still inside, silently. If a locked function needs work another locked
 * function already does, factor the body out into a plain helper and call that
 * from both. createReorderRow() is the worked example.
 */

function generateId(prefix) {
  return prefix + '-' + Utilities.getUuid().split('-')[0].toUpperCase();
}

function now() {
  return new Date();
}

function formatDate(date) {
  if (!date) return '';
  return Utilities.formatDate(new Date(date), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

function formatDay(date) {
  if (!date) return '';
  return Utilities.formatDate(new Date(date), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/**
 * A quantity of things you can count on a shelf, or an error.
 *
 * The cap defaults to take.maxQtyPerAction, which is a sanity check on what one
 * person carries away in one go. Quantities that are not shelf movements — a
 * pallet of paper arriving against a purchase order — pass their own cap, so
 * receiving 1,000 reams no longer fails with a message about a take limit.
 */
var ORDER_QTY_CAP = 100000;

function toQty(value, opts) {
  var options = opts || {};
  var n = Math.floor(Number(value));
  if (!isFinite(n)) throw new Error('Quantity must be a number.');
  var min = options.min === undefined ? 1 : options.min;
  if (n < min) throw new Error('Quantity must be at least ' + min + '.');

  var cap = options.cap === undefined ? setting('take.maxQtyPerAction') : options.cap;
  if (n > cap) {
    throw new Error(
      options.cap === undefined
        ? 'Quantity looks wrong — ' + n + ' is above the ' + cap + ' limit set on the Config tab.'
        : 'Quantity looks wrong — ' + n + ' is more than this system will accept in one line.'
    );
  }
  return n;
}

/** Trim and cap free text so a stray paste can't blow up a cell. */
function cleanText(value, maxLength) {
  var s = String(value === undefined || value === null ? '' : value).trim();
  var max = maxLength || 500;
  return s.length > max ? s.slice(0, max) : s;
}

function requireText(value, fieldName, maxLength) {
  var s = cleanText(value, maxLength);
  if (!s) throw new Error(fieldName + ' is required.');
  return s;
}

/** Only allow a value that's in the approved list. */
function requireOneOf(value, allowed, fieldName) {
  var s = cleanText(value, 120);
  if (allowed.indexOf(s) === -1) {
    throw new Error(fieldName + ' must be one of: ' + allowed.join(', '));
  }
  return s;
}

/**
 * Accept only http(s) image links, and normalise Google Drive share links into
 * a form that actually renders as a thumbnail. Blocks javascript: and data:
 * URLs, which would otherwise end up in an <img src> on everyone's phone.
 */
function safeImageUrl(value) {
  var url = cleanText(value, 800);
  if (!url) return '';
  if (!/^https:\/\//i.test(url)) {
    throw new Error('Image links must start with https://');
  }
  var driveMatch = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=view&)?id=)([\w-]{20,})/);
  if (driveMatch) {
    return 'https://drive.google.com/thumbnail?id=' + driveMatch[1] + '&sz=w600';
  }
  return url;
}

/** Find the zero-based data-row index whose column equals id. -1 if absent. */
function findRow(rows, colIndex, id) {
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][colIndex]) === String(id)) return i;
  }
  return -1;
}

function boolFrom(value) {
  var s = String(value).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === 'y' || s === '1';
}

/**
 * Every column of the Lists sheet, in ONE read.
 *
 * This used to be five separate getList() calls from bootstrap, each of which
 * read the whole sheet again to pull one column out of it.
 *
 * Keys are camelCased from the header, so adding a column to the Lists tab
 * makes it available to the app without editing this function or WebApp.gs.
 */
function getLists() {
  var data = readSheet(CONFIG.SHEETS.LISTS);
  var out = {};

  data.headers.forEach(function (header, idx) {
    if (!header) return;
    var seen = {};
    var values = [];
    data.rows.forEach(function (row) {
      var v = cleanText(row[idx], 120);
      if (v && !seen[v]) { seen[v] = true; values.push(v); }
    });
    out[listKey(header)] = values;
  });

  return out;
}

/** 'Disposal Reasons' -> 'disposalReasons' */
function listKey(header) {
  var parts = String(header).trim().split(/\s+/);
  return parts.map(function (p, i) {
    p = p.replace(/[^A-Za-z0-9]/g, '');
    if (!p) return '';
    return i === 0
      ? p.charAt(0).toLowerCase() + p.slice(1)
      : p.charAt(0).toUpperCase() + p.slice(1);
  }).join('');
}

/** Read a single column of the Lists sheet. Kept for callers that want just one. */
function getList(columnName) {
  return getLists()[listKey(columnName)] || [];
}

/** Whole days between a timestamp and now. Returns 0 for anything unreadable. */
function daysSince(value) {
  if (!value) return 0;
  var then = new Date(value);
  if (isNaN(then.getTime())) return 0;
  return Math.floor((now() - then) / 86400000);
}

/**
 * Wipe a sheet completely — content, formatting, notes AND validation rules.
 *
 * sheet.clear() removes content and formatting but NOT data validation rules.
 * The clue is in the API: there is no Sheet.clearDataValidations(), only a
 * Range one. Stale rules are genuinely dangerous on a rebuild. If the layout
 * shifts — because a setting was added or removed — a rule that used to guard
 * one row ends up guarding a different one, and the first value that violates
 * it aborts the whole rebuild. Worse, the error message is the OLD rule's help
 * text, so it points at the wrong setting entirely.
 */
function wipeSheet(sheet) {
  var everything = sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns());
  try { everything.clearDataValidations(); } catch (e) { Logger.log('clearDataValidations: %s', e.message); }
  try { everything.clearNote(); } catch (e) { Logger.log('clearNote: %s', e.message); }
  sheet.clear();
}

/**
 * Apply a validation rule without ever letting it abort the caller.
 *
 * Dropdowns are a convenience for whoever edits the sheet. Real enforcement
 * happens server-side in the code. So if a rule can't be applied — because a
 * cell somewhere in the range holds an unexpected value — log it and carry on
 * rather than stopping Setup halfway and leaving the workbook half-built.
 */
function setValidationSafely(range, rule, label) {
  try {
    range.clearDataValidations();
    range.setDataValidation(rule);
    return true;
  } catch (e) {
    Logger.log('Could not apply the dropdown for %s: %s', label || 'a range', e.message);
    return false;
  }
}

/**
 * Drop every in-memory cache. Called at the start of each scheduled run so a
 * trigger always sees the current Config, Roles and Departments tabs rather
 * than whatever was cached when the execution started.
 */
function clearAllCaches() {
  clearSettingsCache();
  clearRoleCache();
  clearDepartmentCache();
  clearItemCache();
  clearCoverCache();
  try {
    CacheService.getScriptCache().removeAll(['rates:v1:_all'].concat(listDepartments().map(function (d) { return 'rates:v1:' + d.id; })));
  } catch (e) { /* best-effort cache */ }
}

/**
 * The item cache.
 *
 * This is what the "How long may the app reuse a cached stock list?" setting
 * has always claimed to control. Before, the setting existed, the invalidation
 * existed, and the cache itself did not — so every screen re-read the whole
 * Inventory sheet and the setting was a promise the code never kept.
 *
 * Cached per department, because that is how it is read. Any write clears
 * every department's entry rather than reasoning about which one moved: a
 * stale count on a shelf tag is worse than one extra read.
 */
function itemCacheKey(departmentId) {
  return 'items:v2:' + (departmentId || '_all');
}

function cachedItems(departmentId) {
  var ttl = setting('tech.itemCacheSeconds');
  if (!ttl) return null;
  try {
    var raw = CacheService.getScriptCache().get(itemCacheKey(departmentId));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function cacheItems(departmentId, items) {
  var ttl = setting('tech.itemCacheSeconds');
  if (!ttl) return;
  try {
    var json = JSON.stringify(items);
    // CacheService rejects values over 100KB. A big inventory just goes uncached
    // rather than throwing on every single page load.
    if (json.length > 90000) return;
    CacheService.getScriptCache().put(itemCacheKey(departmentId), json, ttl);
  } catch (e) { /* cache is best-effort */ }
}

function clearItemCache() {
  clearCoverCache();
  try {
    var keys = [itemCacheKey('')];
    listDepartments().forEach(function (d) { keys.push(itemCacheKey(d.id)); });
    CacheService.getScriptCache().removeAll(keys);
  } catch (e) { /* cache is best-effort */ }
}
