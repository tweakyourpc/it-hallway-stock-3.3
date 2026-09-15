/**
 * Settings.gs — configuration lives on the Config tab of the spreadsheet.
 *
 * HOW THIS WORKS
 * The *schema* below defines what settings exist, what type each one is, what
 * it defaults to, and the guidance text. The *values* live on the Config sheet,
 * where an admin can change them with a dropdown and read a plain-language
 * explanation of what each one does. Running Setup builds or repairs that tab
 * from this schema without touching values anyone has already set.
 *
 * WHY THE SHEET
 * The spreadsheet is shared with admins only — staff never touch it, they use
 * the web app. That makes the Config tab a naturally gated place to keep
 * settings, and it means changing behaviour doesn't need a code edit or a
 * redeploy the way editing Config.gs does.
 *
 * WHAT DELIBERATELY STAYS IN CODE
 *   BOOTSTRAP_ADMINS   — the anchor that stops a config change locking you out
 *   Sheet names/headers — needed to find the Config sheet in the first place
 *   Webhook URLs       — credentials, kept in Script Properties, never in a cell
 */

/**
 * @return {Array} the settings schema.
 * Types: 'boolean' | 'number' | 'text' | 'list' | 'role' | 'department'
 */
function settingsSchema() {
  return [
    // ── Identity and access ────────────────────────────────────
    { group: 'Access', key: 'access.allowedDomains', type: 'text',
      label: 'Which email domains may use the app?',
      def: 'yourcollege.edu',
      help: 'Comma separated, no @ sign. Anyone signing in from another domain is refused. '
          + 'Set this to your college domain before you share the app link. '
          + 'Leaving it blank allows any account the deployment lets through, which is not recommended.' },

    { group: 'Access', key: 'access.autoEnroll', type: 'boolean', def: true,
      label: 'Add new people automatically the first time they open the app?',
      help: 'Yes = anyone on an allowed domain gets an account with the starting role below, so you '
          + 'do not have to add 25 people by hand. No = you add each person on the Users tab first, '
          + 'and everyone else gets a "not set up yet" message.' },

    { group: 'Access', key: 'access.autoEnrollRole', type: 'role', def: 'viewer',
      label: 'What role should new people start with?',
      help: 'Only applies when automatic enrolment is on. "viewer" is the safe answer and the '
          + 'default: they can look at stock but cannot take, return, order or change anything. '
          + 'That way, if the link is forwarded to someone it should not have been, the worst they '
          + 'can do is read. Promote real team members to staff or tech from Manage people in the '
          + 'app. Only choose staff here if you would rather everyone on your domain could take '
          + 'stock without being opted in first.' },

    { group: 'Access', key: 'access.roleCacheSeconds', type: 'number', def: 300, min: 0, max: 3600,
      label: 'How long should the app remember someone\'s role?',
      help: 'Seconds. Higher is faster; lower means a role change takes effect sooner. '
          + '300 (five minutes) suits most teams. Set to 0 while you are testing permissions.' },

    { group: 'Access', key: 'access.institutionName', type: 'text', def: 'your college',
      label: 'What is your institution called?',
      help: 'Shown on the sign-in page and in access messages, e.g. "Ringling College". '
          + 'Someone who lands on the app with the wrong Google account sees this, so make it '
          + 'something they will recognise.' },

    { group: 'Access', key: 'access.supportContact', type: 'text', def: '',
      label: 'Who should someone contact if they cannot get in?',
      help: 'Optional. An email address or extension shown on the sign-in page, e.g. '
          + '"helpdesk@yourcollege.edu or x4400". Leave blank to show nothing.' },

    // ── Everyday use ───────────────────────────────────────────
    { group: 'Everyday use', key: 'app.orgName', type: 'text', def: 'IT Hallway',
      label: 'What should the app be called?',
      help: 'Shown under the title on every screen. Useful if Media Services wants it to read '
          + 'something other than IT Hallway.' },

    { group: 'Everyday use', key: 'app.defaultDepartment', type: 'department', def: 'IT',
      label: 'Which department should the app open on?',
      help: 'The view people land on before they switch tabs. Individuals can be given a different '
          + 'home department on the Users tab, which overrides this.' },

    { group: 'Everyday use', key: 'take.requireDestination', type: 'boolean', def: false,
      label: 'Must people say where stock is going when they take it?',
      help: 'No = fastest possible checkout, but some rows will have a blank destination and your '
          + '"where did it go" report gets patchy. Yes = one extra tap, and the usage report is '
          + 'complete. Start with No and switch to Yes if the data turns out to be too thin.' },

    { group: 'Everyday use', key: 'take.maxQtyPerAction', type: 'number', def: 500, min: 1, max: 100000,
      label: 'What is the largest quantity one action may move?',
      help: 'A fat-finger guard. If someone types 5000 instead of 5 they get an error instead of '
          + 'wrecking your counts. Set it a comfortable margin above your biggest realistic single '
          + 'movement, e.g. a full pallet of paper.' },

    { group: 'Everyday use', key: 'app.undoMinutes', type: 'number', def: 15, min: 1, max: 240,
      label: 'For how many minutes may someone undo their own movement?',
      help: 'The app offers an Undo straight after a take or a return. It only ever reverses that '
          + 'person\'s own movement, and only one that can be cleanly reversed — never a disposal '
          + 'or anything involving money. After this many minutes it needs a manager. Wrong taps '
          + 'happen at a shelf; the alternative to undo is an entry nobody corrects, which quietly '
          + 'poisons the burn rate.' },

    { group: 'Everyday use', key: 'app.historyLimit', type: 'number', def: 60, min: 10, max: 500,
      label: 'How many recent transactions should the app load?',
      help: 'Only affects what the app displays, never what is stored. The full history always stays '
          + 'on the Transactions tab. Lower this if the app feels slow.' },

    // ── The test bench ─────────────────────────────────────────
    { group: 'Test bench', key: 'bench.disposalRequiresReason', type: 'boolean', def: true,
      label: 'Must a tech give a reason when disposing of something?',
      help: 'Yes is strongly recommended — the reason is what makes your disposal log useful at '
          + 'budget time and for e-waste records. Reasons come from the Disposal Reasons column on '
          + 'the Lists tab, which you can edit freely.' },

    { group: 'Test bench', key: 'bench.staleAfterDays', type: 'number', def: 7, min: 1, max: 90,
      label: 'After how many days should a bench backlog be chased?',
      help: 'Days. Anything still waiting to be tested after this long gets mentioned in the daily '
          + 'chat message. Set it to roughly how long you think a fair turnaround is.' },

    // ── Ordering ───────────────────────────────────────────────
    { group: 'Test bench', key: 'bench.vendorChaseAfterDays', type: 'number', def: 21, min: 3, max: 365,
      label: 'After how many days should a batch away at a vendor be chased?',
      help: 'A batch sent out on warranty stops appearing in the daily bench backlog, which is '
          + 'right — nobody can act on it. But its units are still counted as unavailable stock, so '
          + 'if the vendor goes quiet it needs to resurface eventually. This is that eventually. '
          + 'Chased weekly, not daily.' },

    { group: 'Ordering', key: 'reorder.coverDays', type: 'number', def: 30, min: 0, max: 365,
      label: 'How many days of demand should a suggested order quantity cover?',
      help: 'Only used where an item has a measured usage rate. The suggestion becomes: enough to '
          + 'cover the delivery time, plus the spare-cover margin, plus this many days of actual '
          + 'use — or the plain "top up to" figure, whichever is larger. Set it to 0 to go back to '
          + 'topping up and nothing more.' },

    { group: 'Ordering', key: 'reorder.autoRaiseOnLowStock', type: 'boolean', def: true,
      label: 'Should hitting the minimum open a reorder request automatically?',
      help: 'Yes = the moment stock drops to its minimum, a line appears on the Orders tab for the '
          + 'ordering manager, so nothing depends on someone remembering. No = requests only appear '
          + 'when a person flags an item by hand.' },

    { group: 'Ordering', key: 'reorder.requiresApproval', type: 'boolean', def: false,
      label: 'Must a manager approve a request before it can be ordered?',
      help: 'No = requests go straight to the ordering manager as "Needed". Yes = they start as '
          + '"Pending approval" and a manager has to approve or decline first. Turn this on if you '
          + 'want a spend check before anything reaches the person with the p-card.' },

    // ── Notifications ──────────────────────────────────────────
    { group: 'Notifications', key: 'alerts.lowStockCooldownHours', type: 'number', def: 24, min: 0, max: 720,
      label: 'Minimum gap between repeat low-stock alerts for the same item?',
      help: 'Hours. This is the single most important setting for keeping your chat space usable. '
          + 'At 24, an item that sits below its minimum all week generates one message a day, not '
          + 'one per person who takes something. Set 0 only if you want an alert every time.' },

    { group: 'Notifications', key: 'alerts.nagIntervalHours', type: 'number', def: 48, min: 0, max: 720,
      label: 'How often should unacknowledged alerts be chased?',
      help: 'Hours. A reminder goes out for anything still unresolved after this long. '
          + 'Set to 0 to switch reminders off entirely.' },

    { group: 'Notifications', key: 'alerts.notifyEveryTransaction', type: 'boolean', def: false,
      label: 'Post a chat message for every single action?',
      help: 'Almost always No. With 25 people this produces dozens of messages a day, everyone mutes '
          + 'the space, and then nobody sees the reorder alerts that actually matter. Turn it on only '
          + 'for a short period if you are auditing who is taking what.' },

    { group: 'Notifications', key: 'alerts.emailFallback', type: 'text', def: '',
      label: 'Who should be emailed if chat delivery fails?',
      help: 'Comma separated addresses. Only used when the webhook is missing or returns an error, so '
          + 'a broken webhook does not silently swallow your alerts. Leave blank to skip email.' },

    { group: 'Notifications', key: 'schedule.dailyCheckHour', type: 'number', def: 8, min: 0, max: 23,
      label: 'What hour should the daily check run?',
      help: '24-hour clock in the spreadsheet\'s timezone. This is the job that raises low-stock '
          + 'alerts and chases bench backlogs. Pick a time shortly before your team starts. '
          + 'Re-run installTriggers() after changing this.' },

    { group: 'Notifications', key: 'schedule.weeklyReportDay', type: 'list', def: 'Monday',
      options: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
      label: 'Which day should the weekly report go out?',
      help: 'The summary of usage rates, what is running out and where things went. '
          + 'Re-run installTriggers() after changing this.' },

    { group: 'Notifications', key: 'schedule.weeklyReportHour', type: 'number', def: 9, min: 0, max: 23,
      label: 'What hour should the weekly report go out?',
      help: '24-hour clock. Re-run installTriggers() after changing this.' },

    // ── Reporting ──────────────────────────────────────────────
    { group: 'Reporting', key: 'report.usageWindowDays', type: 'number', def: 90, min: 7, max: 730,
      label: 'How far back should usage rates look?',
      help: 'Days. This drives the "units per week" and "days left" figures. 90 smooths out a quiet '
          + 'fortnight. Shorten it to 30 if your consumption changes sharply between terms, so the '
          + 'numbers react faster.' },

    { group: 'Reporting', key: 'report.minEventsForRate', type: 'number', def: 3, min: 1, max: 50,
      label: 'How many separate takes before a usage rate is shown?',
      help: 'Below this the app says it does not have enough history instead of printing a number. '
          + 'A rate worked out from one or two movements is not a rate, and a confident-looking '
          + 'figure people cannot rely on is worse than a blank — it teaches them to distrust all '
          + 'of them. 3 is a sensible floor; raise it if your stock moves in bursts.' },

    { group: 'Reporting', key: 'report.recentWindowDays', type: 'number', def: 30, min: 7, max: 365,
      label: 'How recent is "recently", for spotting a change in pace?',
      help: 'A second, shorter window that runs alongside the main one. The long window has enough '
          + 'movements to make a rate trustworthy; this one is short enough to notice that term has '
          + 'started. It never replaces the headline figure — it only says whether things are '
          + 'picking up, steady or slowing down. Capped at the main window length.' },

    { group: 'Reporting', key: 'report.assumedLeadTimeDays', type: 'number', def: 10, min: 1, max: 120,
      label: 'How long does an order take, before you have any delivered orders to measure?',
      help: 'Days. Once orders have been marked ordered AND received, the app measures the real gap '
          + 'per item and stops using this. It is only the starting assumption.' },

    { group: 'Reporting', key: 'report.reorderBufferDays', type: 'number', def: 7, min: 0, max: 90,
      label: 'How many days of spare cover should a suggested minimum include?',
      help: 'A minimum has to last until a replacement order lands, plus a margin for a slow week. '
          + 'The app suggests: daily usage x (measured delivery time + this). It only ever suggests '
          + '— nothing changes a threshold without someone agreeing to it.' },

    // ── Photos ─────────────────────────────────────────────────
    { group: 'Photos', key: 'photo.folderId', type: 'text', def: '',
      label: 'Which Drive folder should item photos go into?',
      help: 'Paste the folder ID — the long string in the folder URL after /folders/. Share that '
          + 'folder with your domain as Viewer first. Leave blank to switch off direct upload; '
          + 'pasting an image link still works either way.' },

    { group: 'Photos', key: 'photo.maxMegabytes', type: 'number', def: 4, min: 1, max: 25,
      label: 'Largest photo someone may upload?',
      help: 'Megabytes. Phone cameras produce 2–5 MB files. Anything larger is rejected before it '
          + 'reaches Drive, which keeps the folder tidy and uploads quick over campus wifi.' },

    // ── Technical ──────────────────────────────────────────────
    { group: 'Technical', key: 'tech.lockTimeoutSeconds', type: 'number', def: 12, min: 2, max: 60,
      label: 'How long should a save wait for its turn?',
      help: 'Seconds. Only one write happens at a time so two people cannot overwrite each other. '
          + 'If a save waits longer than this the person is asked to try again. 12 is plenty for a '
          + 'team this size — raise it only if you see timeout errors.' },

    { group: 'Technical', key: 'tech.itemCacheSeconds', type: 'number', def: 45, min: 0, max: 600,
      label: 'How long may the app reuse a cached stock list?',
      help: 'Seconds. Higher feels faster but means a colleague\'s change can take a moment to show '
          + 'up. Any write clears the cache immediately, so this mostly affects idle browsing. '
          + 'Set to 0 to switch caching off entirely.' },

    { group: 'Technical', key: 'tech.coverCacheSeconds', type: 'number', def: 900, min: 0, max: 3600,
      label: 'How long may the app reuse a calculated usage rate?',
      help: 'The weeks-of-cover figure on each shelf tag costs one pass over the transaction log, '
          + 'so it is worked out once and shared. It is refreshed every morning by the daily check '
          + 'and whenever it expires. A forecast is not a stock count — fifteen minutes stale makes '
          + 'no difference to it. Set to 0 to recalculate every time, which is slower for everyone.' },

    { group: 'Technical', key: 'tech.txnScanRows', type: 'number', def: 5000, min: 500, max: 50000,
      label: 'How many recent log rows should the usage report read?',
      help: 'The transaction log grows forever, and reading all of it to work out the last 90 days '
          + 'gets slower every week. The report reads this many of the newest rows instead. It '
          + 'needs to comfortably exceed the number of movements in your usage window — at 40 a '
          + 'day over 90 days that is 3,600, so 5,000 leaves room. If the report says its view was '
          + 'cut short, raise this.' }
  ];
}

// ─────────────────────────────────────────────────────────────
// Reading settings
// ─────────────────────────────────────────────────────────────

var __settingsMemo = null; // per-execution memo

/** Typed value for one setting, falling back to the schema default. */
function setting(key) {
  var all = allSettings();
  return all[key];
}

/** Every setting as { key: typedValue }. Reads the sheet once per execution. */
function allSettings() {
  if (__settingsMemo) return __settingsMemo;

  var schema = settingsSchema();
  var values = {};
  schema.forEach(function (s) { values[s.key] = s.def; });

  var sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEETS.CONFIG);
  if (sheet) {
    var data = sheet.getDataRange().getValues();
    var raw = {};
    data.forEach(function (row) {
      var key = String(row[0] || '').trim();
      if (key && key.indexOf('.') !== -1) raw[key] = row[2];
    });
    schema.forEach(function (s) {
      if (raw[s.key] !== undefined && raw[s.key] !== '') {
        try {
          values[s.key] = coerceSetting(s, raw[s.key]);
        } catch (e) {
          Logger.log('Bad value for %s, using default: %s', s.key, e.message);
        }
      }
    });
  }

  __settingsMemo = values;
  return values;
}

function coerceSetting(schemaEntry, raw) {
  var v = raw;
  switch (schemaEntry.type) {
    case 'boolean':
      if (typeof v === 'boolean') return v;
      var s = String(v).trim().toLowerCase();
      return s === 'yes' || s === 'true' || s === 'y' || s === '1';
    case 'number':
      var n = Number(v);
      if (!isFinite(n)) throw new Error('not a number');
      if (schemaEntry.min !== undefined && n < schemaEntry.min) n = schemaEntry.min;
      if (schemaEntry.max !== undefined && n > schemaEntry.max) n = schemaEntry.max;
      return n;
    default:
      return String(v).trim();
  }
}

/** Settings as comma-separated list, e.g. allowed domains. */
function settingList(key) {
  return String(setting(key) || '')
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
}

function clearSettingsCache() {
  __settingsMemo = null;
}

/**
 * Change a setting from the app. Admin only, and validated against the schema
 * so a bad value can never reach the sheet.
 */
function updateSetting(key, value) {
  requirePerm('settings.manage');

  var entry = null;
  settingsSchema().forEach(function (s) { if (s.key === key) entry = s; });
  if (!entry) throw new Error('There is no setting called ' + key + '.');

  var coerced = coerceSetting(entry, value);
  var allowed = optionsFor(entry);
  if (allowed && entry.type !== 'boolean' && allowed.indexOf(String(coerced)) === -1) {
    throw new Error('Choose one of: ' + allowed.join(', '));
  }

  return withLock(function () {
    var sheet = mustGetSheet(CONFIG.SHEETS.CONFIG);
    var data = sheet.getDataRange().getValues();
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][0]).trim() === key) {
        sheet.getRange(i + 1, 3).setValue(
          entry.type === 'boolean' ? (coerced ? 'Yes' : 'No') : coerced
        );
        clearSettingsCache();
        return { key: key, value: coerced };
      }
    }
    throw new Error('That setting is not on the Config tab. Re-run Setup.');
  });
}

/** Read-only view for the app's settings screen. */
function getConfigForApp() {
  requirePerm('settings.manage');
  var values = allSettings();
  return settingsSchema().map(function (s) {
    return {
      key: s.key, group: s.group, label: s.label, help: s.help,
      type: s.type, value: values[s.key], def: s.def,
      options: s.type === 'list' ? s.options
             : s.type === 'role' ? roleNames()
             : s.type === 'department' ? listDepartments().map(function (d) { return d.id; })
             : null
    };
  });
}

// ─────────────────────────────────────────────────────────────
// Building the Config tab
// ─────────────────────────────────────────────────────────────

/** The permitted values for a setting, or null if it's free text. */
function optionsFor(s) {
  if (s.type === 'boolean') return ['Yes', 'No'];
  if (s.type === 'list') return s.options;
  if (s.type === 'role') return roleNames();
  if (s.type === 'department') return departmentIds();
  return null;
}

/**
 * Coerce a value into something that will satisfy its own validation rule.
 *
 * This matters more than it looks. Sheets refuses to apply a rejecting
 * validation rule to a cell that already violates it, and reports the refusal
 * by throwing the rule's help text as an error — which aborts Setup halfway
 * with a baffling message. Anything can end up in a cell: a real boolean FALSE
 * rather than the string "No", a value with a trailing space, a role that was
 * renamed on the Roles tab, a department that was deactivated, or just a typo.
 * Every one of those now falls back to the default instead of stopping Setup.
 */
function normaliseForSheet(s, raw, options) {
  if (s.type === 'boolean') {
    if (raw === true) return 'Yes';
    if (raw === false) return 'No';
    var t = String(raw).trim().toLowerCase();
    if (t === 'yes' || t === 'true' || t === 'y' || t === '1') return 'Yes';
    if (t === 'no' || t === 'false' || t === 'n' || t === '0') return 'No';
    return s.def ? 'Yes' : 'No';
  }

  if (s.type === 'number') {
    var n = Number(raw);
    if (!isFinite(n) || String(raw).trim() === '') return s.def;
    n = Math.round(n);
    if (s.min !== undefined && n < s.min) return s.min;
    if (s.max !== undefined && n > s.max) return s.max;
    return n;
  }

  if (options && options.length) {
    var v = String(raw).trim();
    return options.indexOf(v) !== -1 ? v : s.def;
  }

  return String(raw === undefined || raw === null ? '' : raw).trim();
}

/**
 * Short, corrective text for the validation popup. This only ever appears when
 * someone types an invalid value, so it should say what's allowed, not explain
 * the feature — the full guidance lives in column E and in the cell's hover
 * note. Sheets also caps this field, and an essay in an error popup is poor
 * UX regardless.
 */
function validationHelp(s, options) {
  var text;
  if (options && options.length) {
    text = s.label + ' Choose one of: ' + options.join(', ') + '.';
  } else if (s.type === 'number') {
    text = s.label + ' Enter a whole number between ' + s.min + ' and ' + s.max + '.';
  } else {
    text = s.label;
  }
  return text.length > 250 ? text.slice(0, 247) + '...' : text;
}

/**
 * Creates or repairs the Config tab. Existing values are preserved; only
 * missing rows are added and the guidance text is refreshed. Safe to re-run
 * after an upgrade that introduces new settings.
 */
function buildConfigSheet() {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(CONFIG.SHEETS.CONFIG) || ss.insertSheet(CONFIG.SHEETS.CONFIG);

  // Remember what is already set before we redraw.
  var existing = {};
  if (sheet.getLastRow() > 0) {
    sheet.getDataRange().getValues().forEach(function (row) {
      var key = String(row[0] || '').trim();
      if (key && key.indexOf('.') !== -1 && row[2] !== '') existing[key] = row[2];
    });
  }

  wipeSheet(sheet);
  var schema = settingsSchema();
  var rows = [['Key', 'Setting', 'Value', 'Default', 'What this controls']];
  var meta = [null]; // parallel array: schema entry or null for headings

  var lastGroup = '';
  schema.forEach(function (s) {
    if (s.group !== lastGroup) {
      rows.push(['', s.group.toUpperCase(), '', '', '']);
      meta.push('group');
      lastGroup = s.group;
    }
    var opts = optionsFor(s);
    var current = normaliseForSheet(
      s, existing[s.key] !== undefined ? existing[s.key] : s.def, opts
    );
    rows.push([
      s.key,
      s.label,
      current,
      normaliseForSheet(s, s.def, opts),
      s.help
    ]);
    meta.push(s);
  });

  sheet.getRange(1, 1, rows.length, 5).setValues(rows);

  // ── Formatting ──
  sheet.getRange(1, 1, 1, 5)
    .setFontWeight('bold').setBackground('#16202b').setFontColor('#ffffff');
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(2);

  sheet.setColumnWidth(1, 190);   // Key
  sheet.setColumnWidth(2, 330);   // Setting (the question)
  sheet.setColumnWidth(3, 130);   // Value  ← the only editable column
  sheet.setColumnWidth(4, 90);    // Default
  sheet.setColumnWidth(5, 560);   // Guidance

  sheet.getRange(2, 1, rows.length - 1, 5).setVerticalAlignment('top');
  sheet.getRange(1, 5, rows.length, 1).setWrap(true);
  sheet.getRange(1, 2, rows.length, 1).setWrap(true);

  // Key column is machine-readable plumbing — mute it.
  sheet.getRange(2, 1, rows.length - 1, 1)
    .setFontFamily('Courier New').setFontSize(9).setFontColor('#93a1ae');
  sheet.getRange(2, 4, rows.length - 1, 1).setFontColor('#93a1ae').setHorizontalAlignment('center');
  sheet.getRange(2, 5, rows.length - 1, 1).setFontSize(10).setFontColor('#3d4e60');

  // The editable column stands out.
  sheet.getRange(2, 3, rows.length - 1, 1)
    .setBackground('#fffaeb').setFontWeight('bold').setHorizontalAlignment('center');

  // ── Per-row treatment: dropdowns, notes, group headings ──
  meta.forEach(function (s, i) {
    if (!s) return;
    var rowNum = i + 1;

    if (s === 'group') {
      sheet.getRange(rowNum, 1, 1, 5)
        .setBackground('#e9edf1').setFontWeight('bold').setFontSize(10);
      sheet.getRange(rowNum, 3).setBackground('#e9edf1');
      sheet.setRowHeight(rowNum, 26);
      return;
    }

    var valueCell = sheet.getRange(rowNum, 3);
    var options = optionsFor(s);

    if (options && options.length) {
      setValidationSafely(valueCell,
        SpreadsheetApp.newDataValidation()
          .requireValueInList(options, true)
          .setAllowInvalid(false)
          .setHelpText(validationHelp(s, options))
          .build(), s.key);
    } else if (s.type === 'number') {
      setValidationSafely(valueCell,
        SpreadsheetApp.newDataValidation()
          .requireNumberBetween(
            s.min === undefined ? -1e9 : s.min,
            s.max === undefined ? 1e9 : s.max
          )
          .setAllowInvalid(false)
          .setHelpText(validationHelp(s, options))
          .build(), s.key);
    }

    // The hover tooltip.
    valueCell.setNote(
      s.label + '\n\n' + s.help
      + '\n\nDefault: ' + (s.type === 'boolean' ? (s.def ? 'Yes' : 'No') : s.def)
      + (options ? '\nOptions: ' + options.join(', ') : '')
      + (s.type === 'number' && s.min !== undefined ? '\nAllowed range: ' + s.min + '–' + s.max : '')
    );
  });

  // Guardrail: warn if someone edits anything other than the Value column.
  try {
    sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function (p) { p.remove(); });
    var protection = sheet.protect()
      .setDescription('Only the Value column should be edited. Everything else is rebuilt by Setup.')
      .setWarningOnly(true);
    protection.setUnprotectedRanges([sheet.getRange(2, 3, rows.length - 1, 1)]);
  } catch (e) {
    Logger.log('Could not protect Config sheet: %s', e.message);
  }

  clearSettingsCache();
  return sheet;
}
