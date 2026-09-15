/**
 * Notify.gs — chat webhooks and email.
 *
 * Two things changed from 2.1:
 *  1. Webhook URLs are per-department Script Properties, so IT and Media
 *     Services can post to different spaces. They're never returned to the
 *     browser in full — the Settings screen only ever sees a masked preview.
 *  2. Low-stock alerts have a cooldown. The old version fired one on every
 *     single transaction and again on every daily check, which is how a chat
 *     space earns itself a permanent mute.
 *
 * AND ONE THING CHANGED IN 3.2: nothing in here is sent from inside the script
 * lock any more. Everything a write path wants to say goes through
 * queueNotice(); withLock() flushes the queue once the lock is released. See
 * the comment in withLock() for why that mattered.
 */

// ─────────────────────────────────────────────────────────────
// The outbound queue
// ─────────────────────────────────────────────────────────────

var __noticeQueue = [];

/**
 * Say something, later — after the lock is released.
 *
 * `subject` is optional. Give one and the message falls back to email if the
 * chat webhook is missing or fails; leave it off for chatter nobody needs a
 * second copy of.
 */
function queueNotice(departmentId, text, subject) {
  __noticeQueue.push({ dept: departmentId, text: text, subject: subject || '' });
}

/**
 * Send everything queued. Called by withLock(); safe to call when empty.
 *
 * One failed webhook must not swallow the rest of the queue, and must never
 * surface as an error to someone who has already successfully taken stock off a
 * shelf — the write is done and committed by the time we get here.
 */
function flushNotices() {
  if (!__noticeQueue.length) return;
  var queue = __noticeQueue;
  __noticeQueue = [];

  queue.forEach(function (n) {
    try {
      var sent = chatText(n.dept, n.text);
      if (!sent && n.subject) emailFallback(n.subject, n.text.replace(/\*/g, ''));
    } catch (e) {
      Logger.log('Notification dropped: %s', e.message);
    }
  });
}

function getWebhookUrl(departmentId) {
  return PropertiesService.getScriptProperties().getProperty(webhookKeyFor(departmentId)) || '';
}

function postToChat(departmentId, payload) {
  var url = getWebhookUrl(departmentId);
  if (!url) {
    Logger.log('No webhook for %s, skipping notification.', departmentId);
    return false;
  }
  try {
    var response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json; charset=UTF-8',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var code = response.getResponseCode();
    if (code >= 300) {
      Logger.log('Chat webhook returned %s: %s', code, response.getContentText().slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    Logger.log('Chat webhook failed: %s', e.message);
    return false;
  }
}

function chatText(departmentId, text) {
  return postToChat(departmentId, { text: text });
}

/** Email backup — actually implemented this time. 2.1 had the setting but no code. */
function emailFallback(subject, body) {
  var list = settingList('alerts.emailFallback');
  if (!list.length) return false;
  try {
    MailApp.sendEmail({ to: list.join(','), subject: '[IT Hallway] ' + subject, body: body });
    return true;
  } catch (e) {
    Logger.log('Email failed: %s', e.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// Alerts
// ─────────────────────────────────────────────────────────────

/**
 * Called after anything that reduces stock. Raises a low-stock alert at most
 * once per cooldown window per item, and opens a reorder request so the item
 * lands on the ordering manager's list rather than only in a chat message.
 */
function maybeRaiseLowStock(item, user) {
  if (item.shelf > item.min) return;

  var alerts = readSheet(CONFIG.SHEETS.ALERTS);
  var cooldownMs = setting('alerts.lowStockCooldownHours') * 3600000;

  for (var i = alerts.rows.length - 1; i >= 0; i--) {
    var row = alerts.rows[i];
    if (cell(row, alerts.col, 'Item ID') !== item.id) continue;
    if (cell(row, alerts.col, 'Type') !== 'Low Stock') continue;
    if (cell(row, alerts.col, 'Status') !== 'Active') break;
    var last = new Date(cell(row, alerts.col, 'Last Notified') || cell(row, alerts.col, 'Timestamp'));
    if (!isNaN(last.getTime()) && (now() - last) < cooldownMs) return; // still cooling down
    break;
  }

  var alertId = generateId('ALT');
  appendRecord(CONFIG.SHEETS.ALERTS, {
    'Alert ID': alertId,
    'Timestamp': formatDate(now()),
    'Type': 'Low Stock',
    'Item ID': item.id,
    'Message': item.name + ' is down to ' + item.shelf + ' (minimum ' + item.min + ')',
    'Status': 'Active',
    'Last Notified': formatDate(now())
  });

  var raised = null;
  if (setting('reorder.autoRaiseOnLowStock')) {
    try {
      raised = requestReorderSystem(item, user);
    } catch (e) {
      Logger.log('Could not auto-open reorder for %s: %s', item.id, e.message);
    }
  }

  notifyLowStock(item, raised);
}

/**
 * Opens a reorder request without a permission check — the system raised it,
 * not a person. Shares createReorderRow() with the human path so there is one
 * idea of what a new request row looks like.
 */
function requestReorderSystem(item, user) {
  if (findOpenReorder(item.id)) return null;
  return createReorderRow(item, suggestedOrderQty(item), 'Auto (low stock)',
    'Raised automatically when stock hit the minimum'
      + (user ? ' after ' + user.name + ' took stock.' : '.'));
}

function resolveLowStockAlert(itemId) {
  var alerts = readSheet(CONFIG.SHEETS.ALERTS);
  for (var i = 0; i < alerts.rows.length; i++) {
    var row = alerts.rows[i];
    if (cell(row, alerts.col, 'Item ID') === itemId
      && cell(row, alerts.col, 'Type') === 'Low Stock'
      && cell(row, alerts.col, 'Status') === 'Active') {
      row[alerts.col['Status']] = 'Resolved';
      row[alerts.col['Acknowledged At']] = formatDate(now());
      writeRow(alerts.sheet, i, row);
    }
  }
}

function acknowledgeAlert(alertId) {
  var user = requirePerm('reorder.request');
  return withLock(function () {
    var alerts = readSheet(CONFIG.SHEETS.ALERTS);
    var i = findRow(alerts.rows, alerts.col['Alert ID'], alertId);
    if (i === -1) throw new Error('No alert with that ID.');
    var row = alerts.rows[i];
    row[alerts.col['Status']] = 'Acknowledged';
    row[alerts.col['Acknowledged By']] = user.name;
    row[alerts.col['Acknowledged At']] = formatDate(now());
    writeRow(alerts.sheet, i, row);
    return { id: alertId, status: 'Acknowledged' };
  });
}

/**
 * Open alerts for one department.
 *
 * `preloadedInventory` is there because the Alerts tab records an item ID and not
 * a department, so working out which alerts belong to this view needs the
 * Inventory sheet — and refresh() has already read it. Without this, adding
 * alerts to the refresh payload would have cost a second full Inventory read on
 * every single save.
 */
function getActiveAlerts(departmentId, preloadedInventory) {
  getCurrentUser();
  var alerts = readSheet(CONFIG.SHEETS.ALERTS);
  var inventory = preloadedInventory || readSheet(CONFIG.SHEETS.INVENTORY);
  var items = {};
  inventory.rows.forEach(function (row) {
    items[cell(row, inventory.col, 'Item ID')] = cell(row, inventory.col, 'Department');
  });

  return alerts.rows
    .filter(function (row) {
      if (cell(row, alerts.col, 'Status') !== 'Active') return false;
      if (!departmentId) return true;
      return items[cell(row, alerts.col, 'Item ID')] === departmentId;
    })
    .map(function (row) {
      return {
        id: cell(row, alerts.col, 'Alert ID'),
        type: cell(row, alerts.col, 'Type'),
        itemId: cell(row, alerts.col, 'Item ID'),
        message: cell(row, alerts.col, 'Message'),
        timestamp: formatDate(cell(row, alerts.col, 'Timestamp')),
        ageDays: daysSince(cell(row, alerts.col, 'Timestamp'))
      };
    });
}

// ─────────────────────────────────────────────────────────────
// Message composition
// ─────────────────────────────────────────────────────────────

function notifyLowStock(item, raisedReorder) {
  var text = '*Running low — ' + item.name + '*\n'
    + 'On shelf: ' + item.shelf + '  •  Minimum: ' + item.min + '\n'
    + 'Location: ' + (item.location || 'not set') + '\n'
    + (raisedReorder
        ? 'A reorder request for ' + raisedReorder.qty + ' is waiting on the Reorders tab.'
        : 'Flag it for reorder in the app if you want one raised.');
  queueNotice(item.department, text, 'Low stock: ' + item.name);
}

function notifyReorderNeeded(item, qty, user) {
  queueNotice(item.department, '*Reorder requested — ' + item.name + '*\n'
    + 'Suggested quantity: ' + qty + '\n'
    + 'On shelf: ' + item.shelf + '  •  Requested by ' + user.name);
}

function notifyOrdered(order, user) {
  queueNotice(order.department, '*Ordered — ' + order.itemName + '*\n'
    + 'Qty ' + order.qty + ' from ' + order.vendor + '\n'
    + 'Ref: ' + order.poRef
    + (order.expected ? '\nExpected: ' + order.expected : '')
    + '\nPlaced by ' + user.name);
}

function notifyTransaction(t) {
  queueNotice(t.department, t.action + ': ' + t.quantity + ' × ' + t.itemName
    + ' by ' + t.user.name + (t.destination ? ' → ' + t.destination : ''));
}

// ─────────────────────────────────────────────────────────────
// Settings (admin only)
// ─────────────────────────────────────────────────────────────

/**
 * Webhook URLs are secrets, so this returns a masked preview only. The real
 * value never leaves the server. 2.1 handed the full URL to every client.
 */
function getSettings() {
  requirePerm('settings.manage');
  var props = PropertiesService.getScriptProperties();
  return {
    webhooks: listDepartments().map(function (d) {
      var value = props.getProperty(d.webhookKey) || '';
      return { id: d.id, label: d.label, configured: !!value, preview: maskSecret(value) };
    }),
    setupCompleted: props.getProperty('setupCompleted') || ''
  };
}

function maskSecret(value) {
  if (!value) return '';
  return value.slice(0, 28) + '…' + value.slice(-4);
}

/**
 * Only webhook URLs are saved here — they're credentials, so they live in
 * Script Properties rather than a spreadsheet cell. Every other setting is on
 * the Config tab and goes through updateSetting().
 */
function saveSettings(settings) {
  requirePerm('settings.manage');
  var props = PropertiesService.getScriptProperties();

  if (settings.webhooks) {
    Object.keys(settings.webhooks).forEach(function (deptId) {
      var url = cleanText(settings.webhooks[deptId], 800);
      if (url === '') return;                       // blank means "leave it alone"
      if (url === '__CLEAR__') {
        props.deleteProperty(webhookKeyFor(deptId));
        return;
      }
      if (!/^https:\/\/chat\.googleapis\.com\//.test(url)) {
        throw new Error('That does not look like a Google Chat webhook. It should start with https://chat.googleapis.com/');
      }
      props.setProperty(webhookKeyFor(deptId), url);
    });
    refreshDepartmentStatus();
  }
  return getSettings();
}

/** Send a test message so you find out the webhook is wrong now, not in a month. */
function testWebhook(departmentId) {
  var user = requirePerm('settings.manage');
  var ok = chatText(departmentId, 'Test message from IT Hallway, sent by ' + user.name + '. If you can read this, alerts are working.');
  if (!ok) throw new Error('Nothing was sent. Check the webhook URL in Settings.');
  return true;
}
