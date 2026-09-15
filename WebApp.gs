/**
 * WebApp.gs — the web app entry point, the one bootstrap call the frontend
 * makes on load, photo upload, and the scheduled triggers.
 */

/**
 * Web app entry point.
 *
 * Anyone who isn't a recognised, signed-in domain user gets a neutral sign-in
 * page rather than a Google error screen. This matters most on phones: if
 * someone's default Google profile is a personal Gmail, Google's own "you need
 * access" screen is confusing and switching accounts from it is not obvious.
 * Here we can say plainly what's wrong and hand them a button that fixes it.
 *
 * The page reveals nothing — no stock, no counts, no names. Every piece of data
 * arrives through bootstrap(), which authenticates independently.
 */
function doGet(e) {
  var id = identify();

  if (id.status === 'ok') {
    return HtmlService.createTemplateFromFile('WebForm')
      .evaluate()
      .setTitle(setting('app.orgName'))
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
  }
  return renderSignInPage(id);
}

function renderSignInPage(id) {
  var institution = institutionName();
  var t = HtmlService.createTemplateFromFile('Welcome');

  t.title = institution + ' · staff sign-in';
  t.institution = institution;
  t.supportContact = setting('access.supportContact');
  t.signInUrl = domainSignInUrl();
  t.chooserUrl = accountChooserUrl();
  t.showSwitch = true;

  if (id.status === 'foreign') {
    t.heading = 'Wrong Google account';
    t.message = 'You are signed in as ' + id.email + ', which is not a ' + institution
      + ' account. Switch to your ' + institution + ' account to continue.';
  } else if (id.status === 'unenrolled') {
    t.heading = 'You are signed in';
    t.message = id.email + ' does not have access to this tool yet. Ask an administrator '
      + 'to add you, then reload this page.';
    t.showSwitch = false;
  } else if (id.status === 'inactive') {
    t.heading = 'Access turned off';
    t.message = 'Access for ' + id.email + ' has been switched off. Contact an administrator '
      + 'if you think that is a mistake.';
    t.showSwitch = false;
  } else {
    t.heading = 'Sign in to continue';
    t.message = 'This is an internal tool for ' + institution
      + ' staff. Sign in with your ' + institution
      + ' account to continue. Personal Google accounts cannot be used.';
  }

  return t.evaluate()
    .setTitle(t.title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/**
 * The domain-scoped form of the web app URL. Sending someone to
 * script.google.com/a/macros/<domain>/... tells Google which account to use,
 * so a phone with several profiles lands on the right one instead of guessing.
 */
function domainSignInUrl() {
  var url = deployedUrl();
  var domains = settingList('access.allowedDomains');
  if (!url || !domains.length) return url || '';
  return url.replace('script.google.com/macros/', 'script.google.com/a/macros/' + domains[0] + '/');
}

/** Google's account picker, returning here afterwards. */
function accountChooserUrl() {
  var target = domainSignInUrl() || deployedUrl();
  if (!target) return '';
  return 'https://accounts.google.com/AccountChooser?continue=' + encodeURIComponent(target);
}

function deployedUrl() {
  try {
    return ScriptApp.getService().getUrl() || '';
  } catch (e) {
    return '';
  }
}

/**
 * First paint. Everything the stock list needs and nothing else.
 *
 * WHY THIS IS SPLIT IN TWO: the old single bootstrap read fourteen whole
 * sheets before the screen could draw anything — the Lists tab five separate
 * times for five columns, the Inventory tab three times, Reorders twice. Most
 * of that is for screens the person has not opened yet. The destinations list
 * is not needed until a sheet slides up; the bench queue is not needed until
 * the Bench tab is tapped; the reorder list only feeds a number on a tab.
 *
 * So this returns the user, the items and the summary, and the app paints.
 * bootstrapExtras() fetches the rest a moment later and fills in the tab
 * counts. Same total work, but the shelf list is on screen for most of it.
 */
function bootstrap(departmentId) {
  var user = getCurrentUser();
  var dept = cleanText(departmentId, 20) || user.department || defaultDepartment();

  var inventory = readSheet(CONFIG.SHEETS.INVENTORY);
  var reorders = readSheet(CONFIG.SHEETS.REORDER);
  var items = computeItems(dept, inventory);

  return {
    user: {
      email: user.email,
      name: user.name,
      role: user.role,
      permissions: user.permissions,
      department: dept
    },
    orgName: setting('app.orgName'),
    departments: listDepartments().map(function (d) { return { id: d.id, label: d.label }; }),
    items: items,
    summary: computeSummary(dept, items, reorders),
    version: CONFIG.VERSION,
    // The routing rules themselves, not just the class names. The front end
    // decides which return buttons to show from this, so a class added to
    // CONFIG.ITEM_CLASSES works in the app without touching WebForm.html.
    itemClasses: itemClassOptions(),
    // Roles.gs supports adding a role by adding a column to the Roles tab. The
    // Manage People screen used to hardcode the list, so a new role was
    // invisible in the only place you could assign it.
    roles: roleNames(),
    photoUploadEnabled: !!setting('photo.folderId') && can(user, 'photo.upload'),
    requireDestination: setting('take.requireDestination'),
    startingRole: setting('access.autoEnrollRole'),
    approvalRequired: setting('reorder.requiresApproval'),
    disposalRequiresReason: setting('bench.disposalRequiresReason'),
    undoMinutes: setting('app.undoMinutes'),
    benchStaleAfterDays: setting('bench.staleAfterDays')
  };
}

/**
 * The rest, fetched after the stock list is already on screen: dropdown
 * options, the bench queue, open orders, open alerts.
 *
 * `cover` is handed over only if the usage rates happen to be cached already.
 * Calculating them costs a pass over the transaction log, which is the one thing
 * this two-phase split exists to keep off the critical path — so when it is
 * cold the app asks for it separately, last of all, and the tags fill in a
 * moment later. See getCoverMap().
 */
function bootstrapExtras(departmentId) {
  var user = getCurrentUser();
  var dept = cleanText(departmentId, 20) || user.department || defaultDepartment();
  var batches = getTestingQueue(dept);

  return {
    lists: getLists(),
    testing: can(user, 'testing.resolve') ? batches : [],
    unavailable: testingTotals(batches),
    reorders: getReorders(dept, false),
    alerts: getActiveAlerts(dept),
    cover: cachedCoverMap(dept)
  };
}

/**
 * Lighter refresh after an action — just the things that change.
 *
 * The app patches the single changed item in place first and calls this in the
 * background, so nobody is watching a spinner while it runs.
 */
function refresh(departmentId) {
  var user = getCurrentUser();
  var dept = cleanText(departmentId, 20) || defaultDepartment();

  var inventory = readSheet(CONFIG.SHEETS.INVENTORY);
  var reorders = readSheet(CONFIG.SHEETS.REORDER);
  var items = computeItems(dept, inventory);
  var batches = getTestingQueue(dept);

  return {
    items: items,
    summary: computeSummary(dept, items, reorders),
    testing: can(user, 'testing.resolve') ? batches : [],
    unavailable: testingTotals(batches),
    // The Reorders sheet is already in memory from the read above — this used to
    // call getReorders(), which read the whole sheet a second time in the same
    // request, on every single save.
    reorders: reordersFrom(reorders, dept, false),
    alerts: getActiveAlerts(dept, inventory)
  };
}

/**
 * Photo upload straight from the phone camera. Saves into the configured Drive
 * folder and returns a thumbnail URL — no more copy-pasting share links.
 *
 * The file inherits the folder's sharing, so share that folder with your domain
 * as Viewer and nothing is exposed to the open internet.
 */
function uploadPhoto(payload) {
  requirePerm('photo.upload');

  var folderId = setting('photo.folderId');
  if (!folderId) {
    throw new Error('Photo upload is off. An admin can switch it on by putting a Drive folder ID in the Config tab.');
  }
  if (CONFIG.PHOTO_ALLOWED_TYPES.indexOf(payload.mimeType) === -1) {
    throw new Error('Photos must be JPEG, PNG, WebP or HEIC.');
  }

  var bytes = Utilities.base64Decode(payload.data);
  var maxBytes = setting('photo.maxMegabytes') * 1048576;
  if (bytes.length > maxBytes) {
    throw new Error('That photo is too large. Keep it under ' + setting('photo.maxMegabytes') + ' MB.');
  }

  var safeName = cleanText(payload.filename, 80).replace(/[^\w.\- ]/g, '_') || 'item-photo';
  var blob = Utilities.newBlob(bytes, payload.mimeType, Date.now() + '-' + safeName);
  var file = DriveApp.getFolderById(folderId).createFile(blob);

  return {
    url: 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w600',
    fileId: file.getId()
  };
}

// ─────────────────────────────────────────────────────────────
// Triggers
// ─────────────────────────────────────────────────────────────

/** Run once from the editor to install the schedule. Safe to re-run. */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'dailyCheck' || fn === 'weeklyReport') ScriptApp.deleteTrigger(t);
  });

  var dailyHour = setting('schedule.dailyCheckHour');
  var weeklyHour = setting('schedule.weeklyReportHour');
  var dayName = setting('schedule.weeklyReportDay');
  var weekDay = ScriptApp.WeekDay[String(dayName).toUpperCase()] || ScriptApp.WeekDay.MONDAY;

  ScriptApp.newTrigger('dailyCheck').timeBased().atHour(dailyHour).everyDays(1).create();
  ScriptApp.newTrigger('weeklyReport').timeBased().onWeekDay(weekDay).atHour(weeklyHour).create();

  return 'Daily check at ' + dailyHour + ':00 and weekly report ' + dayName
    + ' at ' + weeklyHour + ':00 are installed. Re-run this after changing those settings on the Config tab.';
}

/**
 * Runs every morning. Raises low-stock alerts (respecting the cooldown),
 * flags anything sitting on the test bench too long, and reminds about
 * unacknowledged alerts.
 */
function dailyCheck() {
  clearAllCaches();
  var chaseVendors = new Date().getDay() === 1; // vendors get chased weekly, on Mondays

  listDepartments().forEach(function (dept) {
    var items = computeItems(dept.id);
    var low = items.filter(function (i) { return i.shelf <= i.min; });

    low.forEach(function (item) {
      maybeRaiseLowStock(item, null);
    });

    var backlog = computeTestingBacklog(dept.id);

    var stale = backlog.onBench
      .filter(function (b) { return b.ageDays >= setting('bench.staleAfterDays'); });
    if (stale.length) {
      chatText(dept.id, '*Test bench backlog — ' + dept.label + '*\n'
        + stale.length + ' batch(es) waiting ' + setting('bench.staleAfterDays') + ' days or more:\n'
        + stale.slice(0, 8).map(function (b) {
          return '• ' + b.pending + ' × ' + b.itemName + ' (' + b.ageDays + ' days)';
        }).join('\n'));
    }

    // Batches away on warranty are deliberately absent from the message above —
    // nobody on the bench can act on them. But their units are still counted as
    // unavailable stock, so a vendor going quiet has to resurface eventually.
    // Weekly, so it stays readable.
    if (chaseVendors) {
      var away = backlog.atVendor
        .filter(function (b) { return b.awayDays >= setting('bench.vendorChaseAfterDays'); });
      if (away.length) {
        chatText(dept.id, '*Still with a vendor — ' + dept.label + '*\n'
          + away.slice(0, 8).map(function (b) {
            return '• ' + b.pending + ' × ' + b.itemName + ' — ' + b.awayDays + ' days, ref '
              + (b.vendorRef || 'not recorded');
          }).join('\n')
          + '\nChase them or write them off, or they stay out of stock on paper forever.');
      }
    }

    // Deliveries that have stopped arriving. The forecast still counts these as
    // stock on the way, so cover reads optimistically until somebody chases.
    var late = getReorders(dept.id, false).filter(function (o) { return o.overdueDays > 0; });
    if (late.length) {
      chatText(dept.id, '*Orders past their expected date — ' + dept.label + '*\n'
        + late.slice(0, 8).map(function (o) {
          return '• ' + o.itemName + ' — ' + o.outstanding + ' outstanding, '
            + o.overdueDays + ' day(s) late (' + (o.poRef || 'no ref') + ')';
        }).join('\n'));
    }

    // Warm the usage rates while nobody is waiting, so the first person to open
    // the app this morning gets cover figures on their shelf tags immediately.
    try {
      computeCoverMap(dept.id);
    } catch (e) {
      Logger.log('Could not warm the cover map for %s: %s', dept.id, e.message);
    }
  });

  nagUnacknowledged();
}

function nagUnacknowledged() {
  var nagHours = setting('alerts.nagIntervalHours');
  if (!nagHours) return;

  var alerts = readSheet(CONFIG.SHEETS.ALERTS);
  var intervalMs = nagHours * 3600000;
  var inventory = readSheet(CONFIG.SHEETS.INVENTORY);

  alerts.rows.forEach(function (row, i) {
    if (cell(row, alerts.col, 'Status') !== 'Active') return;

    var lastNotified = new Date(cell(row, alerts.col, 'Last Notified') || cell(row, alerts.col, 'Timestamp'));
    if (isNaN(lastNotified.getTime()) || (now() - lastNotified) < intervalMs) return;

    var itemId = cell(row, alerts.col, 'Item ID');
    var j = findRow(inventory.rows, inventory.col['Item ID'], itemId);
    var dept = j === -1 ? defaultDepartment() : cell(inventory.rows[j], inventory.col, 'Department');

    var age = Math.round((now() - new Date(cell(row, alerts.col, 'Timestamp'))) / 3600000);
    chatText(dept, 'Still open after ' + age + 'h: ' + cell(row, alerts.col, 'Message'));

    row[alerts.col['Last Notified']] = formatDate(now());
    writeRow(alerts.sheet, i, row);
  });
}

function weeklyReport() {
  clearAllCaches();

  // computeUsage is the expensive one. It used to run twice per department —
  // once here and once inside buildDashboard — so a two-department site paid
  // for four full passes over the transaction log to send one message.
  var byDept = {};
  listDepartments().forEach(function (dept) {
    var items = computeItems(dept.id);
    var stats = computeUsage(dept.id, null);
    byDept[dept.id] = { summary: computeSummary(dept.id, items), stats: stats };
    // Cache the cover figures off the pass we have just paid for, so Monday
    // morning's first shelf tag already has its weeks-of-supply on it.
    coverMapFrom(stats, dept.id);
  });
  buildDashboard(byDept);

  listDepartments().forEach(function (dept) {
    var summary = byDept[dept.id].summary;
    var stats = byDept[dept.id].stats;

    var text = '*Weekly stock report — ' + dept.label + '*\n'
      + summary.total + ' items • ' + summary.low + ' low • ' + summary.out + ' out\n'
      + summary.unitsInTesting + ' units on the test bench • '
      + summary.openReorders + ' open reorder(s)';

    if (stats.running.length) {
      text += '\n\n*Running out soonest*\n' + stats.running.slice(0, 5).map(function (r) {
        return '• ' + r.name + ' — '
          + (r.cover || (r.state === 'out' ? 'empty now' : 'at or below minimum'))
          + (r.onOrder ? ' (' + r.coverWithOrder + ' once ' + r.onOrder + ' on order arrive)' : '');
      }).join('\n');
    }

    if (stats.thresholdAdvice.length) {
      text += '\n\n*Minimums that will not cover a delivery*\n'
        + stats.thresholdAdvice.slice(0, 5).map(function (r) {
          return '• ' + r.name + ' — set to ' + r.min + ', suggest ' + r.suggestedMin
            + ' (' + r.perWeek + '/week, ' + r.leadTimeDays + ' day delivery)';
        }).join('\n');
    }

    if (stats.movers.length) {
      text += '\n\n*Moving fastest*\n' + stats.movers.slice(0, 5).map(function (r) {
        return '• ' + r.name + ' — ' + r.grossPerWeek + '/week'
          + (r.trend && r.trend !== 'steady' ? ' (' + r.trend + ')' : '');
      }).join('\n');
    }

    if (stats.overdueOrders.length) {
      text += '\n\n*Ordered but overdue*\n' + stats.overdueOrders.slice(0, 5).map(function (r) {
        return '• ' + r.name + ' — ' + r.onOrder + ' outstanding, ' + r.onOrderOverdue + ' day(s) late';
      }).join('\n');
    }

    if (stats.dataQuality.length) {
      text += '\n\n*More returned than taken — worth a look*\n'
        + stats.dataQuality.slice(0, 5).map(function (r) {
          return '• ' + r.name + ' — ' + r.taken + ' out, ' + r.returned + ' back';
        }).join('\n')
        + '\nA return logged against the wrong item hides that item from the forecast.';
    }

    var sent = chatText(dept.id, text);
    if (!sent) emailFallback('Weekly report — ' + dept.label, text.replace(/\*/g, ''));
  });
}
