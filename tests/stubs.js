/* A fake Google Sheet, good enough to run the real IT Hallway code against. */
global.__SHEETS = {};

function Sheet(name, rows) {
  this.name = name;
  this.rows = rows;               // includes the header row
  this.validations = [];
}
Sheet.prototype.width = function () {
  return this.rows.reduce(function (w, r) { return Math.max(w, r.length); }, 0);
};
Sheet.prototype.pad = function () {
  var w = this.width();
  this.rows.forEach(function (r) { while (r.length < w) r.push(''); });
};
Sheet.prototype.getLastRow = function () { return this.rows.length; };
Sheet.prototype.getLastColumn = function () { return this.width(); };
Sheet.prototype.getMaxRows = function () { return this.rows.length + 100; };
Sheet.prototype.getMaxColumns = function () { return this.width() + 5; };
Sheet.prototype.appendRow = function (values) { this.rows.push(values.slice()); this.pad(); };
Sheet.prototype.clear = function () { this.rows = []; };
Sheet.prototype.setFrozenRows = function () { return this; };
Sheet.prototype.setFrozenColumns = function () { return this; };
Sheet.prototype.setColumnWidth = function () { return this; };
Sheet.prototype.setRowHeight = function () { return this; };
Sheet.prototype.autoResizeColumns = function () { return this; };
Sheet.prototype.setConditionalFormatRules = function () { return this; };
Sheet.prototype.getDataRange = function () {
  this.pad();
  return new Range(this, 1, 1, Math.max(1, this.rows.length), Math.max(1, this.width()));
};
Sheet.prototype.getRange = function (r, c, nr, nc) {
  return new Range(this, r, c, nr === undefined ? 1 : nr, nc === undefined ? 1 : nc);
};

function Range(sheet, r, c, nr, nc) {
  this.sheet = sheet; this.r = r; this.c = c; this.nr = nr; this.nc = nc;
}
Range.prototype.getValues = function () {
  var out = [];
  for (var i = 0; i < this.nr; i++) {
    var row = this.sheet.rows[this.r - 1 + i] || [];
    var line = [];
    for (var j = 0; j < this.nc; j++) line.push(row[this.c - 1 + j] === undefined ? '' : row[this.c - 1 + j]);
    out.push(line);
  }
  return out;
};
Range.prototype.setValues = function (values) {
  for (var i = 0; i < values.length; i++) {
    var ri = this.r - 1 + i;
    while (this.sheet.rows.length <= ri) this.sheet.rows.push([]);
    for (var j = 0; j < values[i].length; j++) this.sheet.rows[ri][this.c - 1 + j] = values[i][j];
  }
  this.sheet.pad();
  return this;
};
Range.prototype.setValue = function (v) { return this.setValues([[v]]); };
/* Every other Range method is cosmetic (fonts, borders, notes, validation) and
   chainable, so anything not defined above returns the range unchanged rather
   than needing a stub per method name. */
var realRange = Range.prototype;
function wrapRange(r) {
  return new Proxy(r, {
    get: function (target, prop) {
      if (prop in target || prop in realRange) return target[prop];
      if (typeof prop === 'string' && /^(set|clear|insert|remove|merge|copy|protect|sort|create)/.test(prop)) {
        return function () { return wrapRange(target); };
      }
      return target[prop];
    }
  });
}
var origGetRange = Sheet.prototype.getRange;
Sheet.prototype.getRange = function (r, c, nr, nc) { return wrapRange(origGetRange.call(this, r, c, nr, nc)); };
var origDataRange = Sheet.prototype.getDataRange;
Sheet.prototype.getDataRange = function () { return wrapRange(origDataRange.call(this)); };

global.SpreadsheetApp = {
  getActive: function () {
    return {
      getSheetByName: function (n) { return global.__SHEETS[n] || null; },
      insertSheet: function (n) { global.__SHEETS[n] = new Sheet(n, []); return global.__SHEETS[n]; },
      setActiveSheet: function () {}, moveActiveSheet: function () {}
    };
  },
  newDataValidation: function () {
    // Any require*/set* call chains; build() ends it.
    var b = new Proxy({}, {
      get: function (t, prop) {
        if (prop === 'build') return function () { return {}; };
        return function () { return b; };
      }
    });
    return b;
  },
  newConditionalFormatRule: function () {
    var b = { whenTextEqualTo: function(){return b}, setBackground: function(){return b},
              setFontColor: function(){return b}, setRanges: function(){return b},
              build: function(){return {}} };
    return b;
  },
  getUi: function () { throw new Error('no UI in tests'); }
};

var PROPS = {};
global.PropertiesService = {
  getScriptProperties: function () {
    return {
      getProperty: function (k) { return PROPS[k] === undefined ? null : PROPS[k]; },
      setProperty: function (k, v) { PROPS[k] = v; },
      deleteProperty: function (k) { delete PROPS[k]; }
    };
  }
};

var CACHE = {};
global.CacheService = {
  getScriptCache: function () {
    return {
      get: function (k) { return CACHE[k] === undefined ? null : CACHE[k]; },
      put: function (k, v) { CACHE[k] = v; },
      remove: function (k) { delete CACHE[k]; },
      removeAll: function (ks) { ks.forEach(function (k) { delete CACHE[k]; }); }
    };
  }
};

global.__LOCK_DEPTH = 0;
global.__MAX_LOCK_DEPTH = 0;
global.LockService = {
  getScriptLock: function () {
    return {
      tryLock: function () {
        global.__LOCK_DEPTH++;
        if (global.__LOCK_DEPTH > global.__MAX_LOCK_DEPTH) global.__MAX_LOCK_DEPTH = global.__LOCK_DEPTH;
        return true;
      },
      releaseLock: function () { global.__LOCK_DEPTH--; }
    };
  }
};

global.__FETCHES = [];
global.UrlFetchApp = {
  fetch: function (url, opts) {
    // Record whether the script lock was held at the moment of the network call.
    global.__FETCHES.push({ url: url, lockHeld: global.__LOCK_DEPTH > 0 });
    return { getResponseCode: function () { return 200; }, getContentText: function () { return 'ok'; } };
  }
};

global.__MAILS = [];
global.MailApp = { sendEmail: function (o) { global.__MAILS.push(o); } };

var uuidN = 0;
global.Utilities = {
  getUuid: function () { uuidN++; return ('0000000' + uuidN).slice(-8) + '-a-b-c-d'; },
  formatDate: function (d, tz, fmt) {
    var p = function (n) { return ('0' + n).slice(-2); };
    var s = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    if (fmt.indexOf('HH') !== -1) s += ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    return s;
  },
  base64Decode: function () { return []; },
  newBlob: function () { return {}; }
};

global.Session = {
  getScriptTimeZone: function () { return 'UTC'; },
  getActiveUser: function () { return { getEmail: function () { return global.__EMAIL; } }; }
};

global.ScriptApp = {
  getProjectTriggers: function () { return []; },
  getService: function () { return { getUrl: function () { return 'https://script.google.com/macros/s/X/exec'; } }; },
  WeekDay: { MONDAY: 1 }
};
global.DriveApp = { getFolderById: function () { return { createFile: function () { return { getId: function () { return 'f'; } }; } }; } };
global.HtmlService = { createTemplateFromFile: function () { throw new Error('no templates in tests'); } };
global.Logger = { log: function () {} };

global.__Sheet = Sheet;
