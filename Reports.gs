/**
 * Reports.gs — "how fast are we going through this, and where is it going?"
 *
 * Usage rate comes from Take transactions over the window set on the Config tab, which
 * also gives a rough days-of-stock-left figure. That's the number worth putting
 * in front of a manager: "about 11 days of paper left" lands harder than
 * "14 reams in stock".
 *
 * NOTE ON THE TWO LAYERS: scheduled triggers run as the project owner with no
 * active user, so getCurrentUser() can't apply. Each report therefore has a
 * compute* function with no identity check (only ever called internally) and a
 * thin public wrapper that authenticates first. Same logic, one copy.
 */

// ─────────────────────────────────────────────────────────────
// Public (authenticated) entry points
// ─────────────────────────────────────────────────────────────

function getUsageStats(departmentId) {
  getCurrentUser();
  return computeUsage(departmentId);
}

function getSummary(departmentId) {
  getCurrentUser();
  return computeSummary(departmentId);
}

// ─────────────────────────────────────────────────────────────
// Computation (no identity check — internal use only)
// ─────────────────────────────────────────────────────────────

/**
 * All active items, optionally filtered to one department.
 *
 * `preloaded` lets a caller that has already read the Inventory sheet hand it
 * over instead of paying for a second read. bootstrap() used to read it three
 * times in one request.
 */
function computeItems(departmentId, preloaded) {
  var dept = cleanText(departmentId, 20);

  if (!preloaded) {
    var hit = cachedItems(dept);
    if (hit) return hit;
  }

  var data = preloaded || readSheet(CONFIG.SHEETS.INVENTORY);

  var items = data.rows
    .filter(function (row) {
      if (!cell(row, data.col, 'Item ID')) return false;
      var active = String(cell(row, data.col, 'Active')).trim();
      if (active && !boolFrom(active)) return false;
      if (dept && cleanText(cell(row, data.col, 'Department'), 20) !== dept) return false;
      return true;
    })
    .map(function (row) { return itemFromRow(row, data.col); })
    .sort(function (a, b) { return a.name.localeCompare(b.name); });

  cacheItems(dept, items);
  return items;
}

function computeSummary(departmentId, preloadedItems, preloadedReorders) {
  var items = preloadedItems || computeItems(departmentId);
  var low = 0, out = 0, testing = 0;

  items.forEach(function (i) {
    if (i.state === 'out') out++;
    else if (i.state === 'low') low++;
    testing += i.testing;
  });

  var reorders = preloadedReorders || readSheet(CONFIG.SHEETS.REORDER);
  var open = openReorderStatuses();
  var openCount = reorders.rows.filter(function (row) {
    if (open.indexOf(cell(row, reorders.col, 'Status')) === -1) return false;
    return !departmentId || cell(row, reorders.col, 'Department') === departmentId;
  }).length;

  return {
    total: items.length,
    ok: items.length - low - out,
    low: low,
    out: out,
    unitsInTesting: testing,
    openReorders: openCount
  };
}

// ─────────────────────────────────────────────────────────────
// Burn rate
// ─────────────────────────────────────────────────────────────

/**
 * One pass over the transaction log, producing everything the forecast needs.
 *
 * Split out of computeUsage() in 3.2 so the Usage tab and the cover figure on
 * the shelf tag are built from the same arithmetic rather than two copies of
 * it, and so the pass happens once instead of twice.
 *
 * THE FOUR THINGS THIS GETS RIGHT THAT A NAIVE VERSION DOES NOT:
 *
 * 1. NET, NOT GROSS. A UPS battery that goes out, comes back, passes testing
 *    and returns to the shelf was never consumed. Counting every Take as
 *    consumption overstates the burn rate for anything that cycles through the
 *    bench — in testing, by roughly threefold — and tells you to reorder
 *    things you already have. So returns to the shelf, from the bench or put
 *    back unused, are subtracted.
 *
 * 2. DAYS IN STOCK, NOT DAYS IN THE WINDOW. Dividing by the window length
 *    assumes the item was there to be taken the whole time. If it ran out on
 *    day 33 of a 90-day window, the 57 days of zero takes were zero supply,
 *    not zero demand — and dividing by 90 reports about a third of the real
 *    rate for exactly the item that just ran out on you. The denominator here
 *    is the time the item both existed and had stock on the shelf.
 *
 * 3. IT SAYS WHEN IT DOES NOT KNOW. A rate from two observations is not a
 *    rate. Below `report.minEventsForRate` events the number is withheld
 *    rather than rounded, and every row carries the evidence it was built
 *    from so a thin one is visible as thin.
 *
 * 4. TWO WINDOWS, NOT ONE. A single window has to serve both recency and
 *    sample size and cannot do both: long enough to have seen three movements
 *    of anything, short enough to notice that term has started. So the long
 *    window sets the headline rate and a second, shorter one runs alongside it
 *    purely to say which direction things are moving. No seasonal model, two
 *    numbers.
 *
 * Units currently on the bench count as consumed until they come back. That is
 * deliberate and self-correcting: it errs towards ordering slightly early.
 */
function movementStats(departmentId) {
  var windowDays = setting('report.usageWindowDays');
  var recentDays = Math.min(setting('report.recentWindowDays'), windowDays);

  var nowMs = now().getTime();
  var cutoffMs = nowMs - windowDays * 86400000;
  var recentCutoffMs = nowMs - recentDays * 86400000;

  var txns = readSheetTail(CONFIG.SHEETS.TXN, setting('tech.txnScanRows'));
  var stats = {};
  var destinations = {};
  var tailStartMs = null;

  function statsFor(id) {
    if (!stats[id]) {
      stats[id] = {
        taken: 0, returned: 0, disposed: 0, events: 0,
        takenRecent: 0, returnedRecent: 0, eventsRecent: 0,
        takenOnRecord: 0,
        firstEverMs: null, lastTs: null, lastShelf: null,
        zeroMs: 0, zeroMsRecent: 0
      };
    }
    return stats[id];
  }

  /**
   * Bank a stretch during which the shelf was empty.
   *
   * Every bound is clamped into the window it belongs to. Before 3.2 this was
   * one unclamped subtraction, so a stretch that began AND ended before the
   * window opened produced a negative number, and that negative quietly
   * cancelled out genuine in-window outages — inflating the denominator,
   * understating the rate, and suppressing the "ran out during this period"
   * warning on exactly the items it was written for.
   */
  function bankZeroStretch(s, fromMs, toMs) {
    var to = Math.min(toMs, nowMs);
    var from = Math.max(fromMs, cutoffMs);
    if (to > from) s.zeroMs += to - from;

    var recentFrom = Math.max(fromMs, recentCutoffMs);
    if (to > recentFrom) s.zeroMsRecent += to - recentFrom;
  }

  // The log is appended in time order, so a single forward pass is enough.
  txns.rows.forEach(function (row) {
    var itemId = cell(row, txns.col, 'Item ID');
    if (!itemId) return;

    var when = new Date(cell(row, txns.col, 'Timestamp'));
    if (isNaN(when.getTime())) return;
    var ms = when.getTime();
    if (tailStartMs === null || ms < tailStartMs) tailStartMs = ms;

    if (departmentId && cell(row, txns.col, 'Department') !== departmentId) return;

    var s = statsFor(itemId);
    if (s.firstEverMs === null || ms < s.firstEverMs) s.firstEverMs = ms;

    var voided = boolFrom(cell(row, txns.col, 'Voided'));
    var action = cell(row, txns.col, 'Action');
    var rule = CONFIG.ACTIONS[action];
    var qty = Math.abs(Number(cell(row, txns.col, 'Quantity')) || 0);
    var snapshot = cell(row, txns.col, 'Shelf After');
    var shelfAfter = String(snapshot).trim() === '' ? NaN : Number(snapshot);

    // Out-of-stock stretches are measured from every row, voided or not, and
    // from before the window too — the shelf was empty regardless of whether
    // the paperwork was later corrected.
    if (!isNaN(shelfAfter)) {
      if (s.lastShelf === 0 && s.lastTs !== null && ms > s.lastTs) {
        bankZeroStretch(s, s.lastTs, ms);
      }
      s.lastTs = ms;
      s.lastShelf = shelfAfter;
    }

    if (voided || !rule) return;

    // Counted over the whole scanned log, not the window: the only honest
    // answer for something taken twice a year is an annual count, not a daily
    // rate withheld as unreliable.
    if (rule.consumes) s.takenOnRecord += qty;

    if (ms < cutoffMs) return;
    var inRecent = ms >= recentCutoffMs;

    if (rule.returnsToShelf) {
      s.returned += qty;
      if (inRecent) s.returnedRecent += qty;
    } else if (rule.consumes) {
      s.taken += qty;
      s.events++;
      if (inRecent) { s.takenRecent += qty; s.eventsRecent++; }
      var dest = cleanText(cell(row, txns.col, 'Destination'), 120) || 'Not recorded';
      destinations[dest] = (destinations[dest] || 0) + qty;
    }

    // Scrap off the shelf is consumption as well as disposal, so it lands in
    // both tallies. Scrap off the bench is only ever a disposal. Folding this
    // in here replaced a second full pass over the same rows.
    if (rule.disposes) s.disposed += qty;
  });

  return {
    stats: stats,
    statsFor: statsFor,
    destinations: destinations,
    truncated: txns.truncated,
    windowDays: windowDays,
    recentDays: recentDays,
    nowMs: nowMs,
    cutoffMs: cutoffMs,
    recentCutoffMs: recentCutoffMs,
    tailStartMs: tailStartMs === null ? cutoffMs : tailStartMs
  };
}

/**
 * How fast stock is actually being used up, and how long what's left will last.
 */
function computeUsage(departmentId, preloadedItems) {
  var m = movementStats(departmentId);
  var minEvents = setting('report.minEventsForRate');
  var bufferDays = setting('report.reorderBufferDays');
  // One read of the Reorders sheet, used twice. inboundByItem and leadTimeByItem
  // each read it for themselves, which meant every usage report read the same
  // sheet twice in the same pass.
  var reorderData = readSheet(CONFIG.SHEETS.REORDER);
  var inbound = inboundByItem(departmentId, reorderData);
  var leadTimes = leadTimeByItem(departmentId, reorderData);

  var recordDays = Math.max(1, (m.nowMs - m.tailStartMs) / 86400000);

  var rows = computeItems(departmentId, preloadedItems).map(function (item) {
    var s = m.stats[item.id] || m.statsFor(item.id);

    // Still empty right now? Keep counting the stretch up to this moment.
    var zeroMs = s.zeroMs;
    var zeroMsRecent = s.zeroMsRecent;
    if (s.lastShelf === 0 && s.lastTs !== null) {
      zeroMs += m.nowMs - Math.max(s.lastTs, m.cutoffMs);
      zeroMsRecent += m.nowMs - Math.max(s.lastTs, m.recentCutoffMs);
    }

    /**
     * When did this item start being observable?
     *
     * An item whose first movement is later than the oldest row we read really
     * did appear part-way through, so its denominator is shorter. An item whose
     * first movement IS the oldest row we read may simply be older than the
     * tail — and if the log was truncated we cannot tell, so we assume the full
     * window rather than crediting it with a suspiciously high rate.
     */
    function startFrom(cutoff) {
      var appearedInsideTail = s.firstEverMs !== null && s.firstEverMs > m.tailStartMs;
      return (appearedInsideTail && s.firstEverMs > cutoff) ? s.firstEverMs : cutoff;
    }

    var inStockDays = Math.max(1, (m.nowMs - startFrom(m.cutoffMs) - Math.max(0, zeroMs)) / 86400000);
    var recentStockDays = Math.max(1, (m.nowMs - startFrom(m.recentCutoffMs) - Math.max(0, zeroMsRecent)) / 86400000);

    var net = Math.max(0, s.taken - s.returned);
    var perDay = net / inStockDays;
    var perWeek = perDay * 7;

    var recentPerDay = Math.max(0, s.takenRecent - s.returnedRecent) / recentStockDays;

    var reliable = s.events >= minEvents && perDay > 0;
    var withheld = null;
    if (!reliable) {
      withheld = s.takenOnRecord > 0
        ? s.takenOnRecord + ' taken over the ' + Math.round(recordDays) + ' days on record'
        : (perDay === 0 ? 'nothing used yet'
                        : 'only ' + s.events + ' of the ' + minEvents + ' movements needed');
    }

    // More came back than went out. Physically impossible over a long enough
    // window, so it means a return was logged against the wrong item or with a
    // fat-fingered quantity — and because net clamps at zero, the effect is
    // that the item silently reports "nothing used yet" and drops out of the
    // forecast with no visible cause. Say so instead.
    var overReturned = s.returned > s.taken;

    var onOrder = inbound[item.id] || { qty: 0, due: '', overdue: 0 };
    var daysLeft = reliable ? item.shelf / perDay : null;
    var daysLeftWithOrder = reliable ? (item.shelf + onOrder.qty) / perDay : null;

    var leadTime = leadTimes[item.id] || leadTimes['_default'];
    var suggestedMin = reliable ? Math.ceil(perDay * (leadTime.days + bufferDays)) : null;

    return {
      id: item.id,
      name: item.name,
      category: item.category,
      itemClass: item.itemClass,
      shelf: item.shelf,
      testing: item.testing,
      min: item.min,
      taken: s.taken,
      returned: s.returned,
      disposed: s.disposed,
      events: s.events,
      takenOnRecord: s.takenOnRecord,
      observedDays: Math.round(inStockDays),
      ranOut: zeroMs > 0,
      reliable: reliable,
      perDay: reliable ? perDay : null,
      withheld: withheld,
      overReturned: overReturned,
      perWeek: reliable ? Math.round(perWeek * 10) / 10 : null,
      // The shorter window, and which way it points. Only shown where both
      // windows have something to say, so a single recent movement cannot
      // announce a trend on its own.
      recentPerWeek: reliable ? Math.round(recentPerDay * 7 * 10) / 10 : null,
      trend: trendLabel(perDay, recentPerDay, s.eventsRecent),
      // Gross movement, for the "moving fastest" panel. That panel is about
      // how busy a shelf slot is, not how fast stock is being used up, so a
      // UPS that goes out and comes back all week belongs high on it.
      grossPerWeek: Math.round((s.taken / Math.max(1, inStockDays) * 7) * 10) / 10,
      daysLeft: reliable ? Math.round(daysLeft) : null,
      // What the sort actually cares about: when the shelf runs dry given what
      // is already on its way. Something with five days of cover and forty
      // arriving tomorrow is not the emergency.
      effectiveDaysLeft: reliable ? Math.round(daysLeftWithOrder) : null,
      cover: coverLabel(daysLeft),
      coverWithOrder: onOrder.qty ? coverLabel(daysLeftWithOrder) : null,
      onOrder: onOrder.qty,
      onOrderDue: onOrder.due,
      onOrderOverdue: onOrder.overdue,
      leadTimeDays: leadTime.days,
      leadTimeSource: leadTime.source,
      leadTimeWorst: leadTime.worst,
      suggestedMin: suggestedMin,
      state: item.state
    };
  });

  // Anything whose minimum would not survive its own reorder lead time. This is
  // the panic-order early warning: not "you are low now" but "by the time an
  // order arrives you will have been out for days".
  var thresholdAdvice = rows.filter(function (r) {
    return r.reliable && r.suggestedMin !== null && r.suggestedMin > r.min;
  }).sort(function (a, b) { return (b.suggestedMin - b.min) - (a.suggestedMin - a.min); })
    .slice(0, 10);

  /**
   * What is about to run out.
   *
   * Two changes from 3.1. Anything at or below its minimum RIGHT NOW is in this
   * list whether or not a rate could be measured — an empty shelf is a fact and
   * does not need three movements to qualify. And the order is by cover
   * including stock already on its way, because that is the question the list
   * is answering.
   */
  var running = rows.filter(function (r) {
    if (r.state === 'out' || r.state === 'low') return true;
    return r.reliable && r.daysLeft <= 90;
  }).sort(function (a, b) {
    var stateRank = { out: 0, low: 1, ok: 2 };
    if (stateRank[a.state] !== stateRank[b.state]) return stateRank[a.state] - stateRank[b.state];
    var av = a.effectiveDaysLeft === null ? 9999 : a.effectiveDaysLeft;
    var bv = b.effectiveDaysLeft === null ? 9999 : b.effectiveDaysLeft;
    return av - bv;
  });

  return {
    windowDays: m.windowDays,
    recentDays: m.recentDays,
    recordDays: Math.round(recordDays),
    minEvents: minEvents,
    truncated: m.truncated,
    items: rows.slice().sort(function (a, b) { return b.taken - a.taken; }),
    topDestinations: Object.keys(m.destinations)
      .map(function (k) { return { destination: k, units: m.destinations[k] }; })
      .sort(function (a, b) { return b.units - a.units; })
      .slice(0, 10),
    movers: rows.filter(function (r) { return r.taken > 0; })
      .sort(function (a, b) { return b.taken - a.taken; })
      .slice(0, 8),
    running: running,
    thresholdAdvice: thresholdAdvice,
    // Orders that have quietly stopped arriving. The forecast counts them as
    // inbound supply, so cover stays optimistic until somebody chases them.
    overdueOrders: rows.filter(function (r) { return r.onOrderOverdue > 0; })
      .sort(function (a, b) { return b.onOrderOverdue - a.onOrderOverdue; }),
    dataQuality: rows.filter(function (r) { return r.overReturned; })
      .sort(function (a, b) { return (b.returned - b.taken) - (a.returned - a.taken); }),
    // Items that move but cannot support a rate. Ranked by what is on record
    // rather than by the window, so the twice-a-year projector lamp shows its
    // annual count instead of a blank.
    unknown: rows.filter(function (r) { return !r.reliable && r.takenOnRecord > 0; })
      .sort(function (a, b) { return b.takenOnRecord - a.takenOnRecord; })
      .slice(0, 10)
  };
}

/**
 * Which way the rate is moving, or null.
 *
 * Deliberately three buckets and no percentage. The difference between the two
 * windows is noisy at these sample sizes, so a number would imply a precision
 * that is not there; "picking up" is all anyone acts on. Needs at least two
 * movements inside the short window before it will say anything at all.
 */
function trendLabel(perDay, recentPerDay, recentEvents) {
  if (recentEvents < 2 || perDay <= 0) return null;
  var ratio = recentPerDay / perDay;
  if (ratio >= 1.4) return 'picking up';
  if (ratio <= 0.6) return 'slowing down';
  return 'steady';
}

/**
 * Days of cover, at a precision the estimate can actually support.
 *
 * Nobody schedules anything off the difference between 74 and 78 days, and
 * showing "823 days left" for something taken twice a year invites a laugh at
 * the whole report's expense. Exact days only where it is about to matter.
 */
function coverLabel(days) {
  if (days === null || days === undefined || !isFinite(days)) return null;
  if (days > 90) return '90+ days';
  if (days < 21) {
    var d = Math.round(days);
    return d + (d === 1 ? ' day' : ' days');
  }
  return 'about ' + Math.round(days / 7) + ' weeks';
}

// ─────────────────────────────────────────────────────────────
// The cover figure on the shelf tag
// ─────────────────────────────────────────────────────────────

/**
 * Weeks of cover, per item, small enough to cache.
 *
 * The whole point of this system is that a shelf tag says "14 · about 3 weeks"
 * rather than "14". But cover costs a pass over the transaction log, and
 * bootstrap() deliberately does not read that log — first paint is one
 * Inventory read and that is why the stock list appears quickly.
 *
 * So this is a third phase: the app paints, fills in its tab counts, and then
 * asks for this. It is cached for tech.coverCacheSeconds, warmed every morning
 * by dailyCheck and again by the weekly report, and derived from the same
 * computeUsage() rows as the Usage tab, so the two can never disagree.
 */
function coverCacheKey(departmentId) {
  return 'cover:v2:' + (departmentId || '_all');
}

function getCoverMap(departmentId) {
  getCurrentUser();
  return computeCoverMap(cleanText(departmentId, 20));
}

function computeCoverMap(departmentId) {
  var warm = cachedCoverMap(departmentId);
  if (warm) return warm;
  return coverMapFrom(computeUsage(departmentId), departmentId);
}

/**
 * Build and cache the slim map from usage figures the caller already has.
 *
 * The weekly report computes computeUsage() for every department anyway, so it
 * hands the result straight to this rather than paying for a second identical
 * pass over the transaction log just to warm the cache.
 */
function coverMapFrom(stats, departmentId) {
  var map = {};
  stats.items.forEach(function (r) {
    map[r.id] = {
      cover: r.cover,
      daysLeft: r.daysLeft,
      perDay: r.perDay,
      perWeek: r.perWeek,
      trend: r.trend,
      leadTimeDays: r.leadTimeDays,
      leadTimeSource: r.leadTimeSource,
      reliable: r.reliable,
      evidence: r.overReturned ? 'Returns exceed issues in this period; review the movements.'
        : (r.reliable ? r.events + ' movements over ' + r.observedDays + ' days with stock available'
          : (r.withheld === 'nothing used yet' ? 'No net consumption recorded in this period' : r.withheld)),
      truncated: stats.truncated,
      ranOut: r.ranOut
    };
  });

  var payload = { built: formatDate(now()), items: map };
  var ttl = setting('tech.coverCacheSeconds');
  if (ttl) {
    try {
      var json = JSON.stringify(payload);
      if (json.length <= 90000) {
        CacheService.getScriptCache().put(coverCacheKey(departmentId), json, ttl);
        // Suggestions may reuse a recent measured rate after shelf-dependent
        // cover is invalidated. No log scan is added to a movement's write path.
        CacheService.getScriptCache().put('rates:v1:' + (departmentId || '_all'), json, ttl);
      }
    } catch (e) { /* cache is best-effort */ }
  }
  return payload;
}

function cachedCoverMap(departmentId) {
  if (!setting('tech.coverCacheSeconds')) return null;
  try {
    var raw = CacheService.getScriptCache().get(coverCacheKey(departmentId));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

/**
 * One item's measured rate, but only if the map is already warm.
 *
 * Used by suggestedOrderQty(), which must never turn "flag this for reorder"
 * into a pass over the transaction log while holding the script lock.
 */
function cachedCoverFor(departmentId, itemId) {
  var map = cachedCoverMap(departmentId);
  if (map && map.items && map.items[itemId]) return map.items[itemId];

  // The all-departments map, if that is the one that happens to be warm.
  var all = departmentId ? cachedCoverMap('') : null;
  if (all && all.items && all.items[itemId]) return all.items[itemId];
  try {
    if (!setting('tech.coverCacheSeconds')) return null;
    var raw = CacheService.getScriptCache().get('rates:v1:' + (departmentId || '_all'));
    var rates = raw ? JSON.parse(raw) : null;
    return rates && rates.items[itemId] || null;
  } catch (e) { return null; }
}

function clearCoverCache() {
  try {
    var keys = [coverCacheKey('')];
    listDepartments().forEach(function (d) { keys.push(coverCacheKey(d.id)); });
    CacheService.getScriptCache().removeAll(keys);
  } catch (e) { /* cache is best-effort */ }
}

/** Units already ordered and not yet delivered, by item. */
function inboundByItem(departmentId, preloaded) {
  var data = preloaded || readSheet(CONFIG.SHEETS.REORDER);
  var out = {};
  data.rows.forEach(function (row) {
    var status = cell(row, data.col, 'Status');
    if (status !== 'Ordered' && status !== 'Partially Received') return;
    if (departmentId && cell(row, data.col, 'Department') !== departmentId) return;

    var itemId = cell(row, data.col, 'Item ID');
    var outstanding = (Number(cell(row, data.col, 'Qty Ordered')) || 0)
      - (Number(cell(row, data.col, 'Qty Received')) || 0);
    if (outstanding <= 0) return;

    if (!out[itemId]) out[itemId] = { qty: 0, due: '', overdue: 0 };
    out[itemId].qty += outstanding;
    var due = formatDay(cell(row, data.col, 'Expected Date'));
    if (due && (!out[itemId].due || due < out[itemId].due)) out[itemId].due = due;

    var late = overdueDaysFor(status, cell(row, data.col, 'Expected Date'));
    if (late > out[itemId].overdue) out[itemId].overdue = late;
  });
  return out;
}

/**
 * How long orders actually take, from the orders already placed.
 *
 * Ordered Date and Received Date have been recorded all along and never read.
 * They are the missing half of a sensible minimum threshold: a minimum only
 * works if it covers the time it takes to restock.
 */
function leadTimeByItem(departmentId, preloaded) {
  var data = preloaded || readSheet(CONFIG.SHEETS.REORDER);
  var perItem = {};
  var all = [];

  data.rows.forEach(function (row) {
    if (departmentId && cell(row, data.col, 'Department') !== departmentId) return;
    var ordered = new Date(cell(row, data.col, 'Ordered Date'));
    var received = new Date(cell(row, data.col, 'Received Date'));
    if (isNaN(ordered.getTime()) || isNaN(received.getTime())) return;

    var days = Math.round((received.getTime() - ordered.getTime()) / 86400000);
    if (days < 0 || days > 365) return; // a typo, not a lead time

    var itemId = cell(row, data.col, 'Item ID');
    (perItem[itemId] = perItem[itemId] || []).push(days);
    all.push(days);
  });

  /**
   * The median, not the mean.
   *
   * A safety threshold built on the mean delivery time is short roughly half
   * the time, which defeats the point of having one. And a single 60-day
   * backorder drags a mean up permanently with no way to exclude it, so one bad
   * experience quietly inflates every suggestion afterwards. The median ignores
   * the outlier; `worst` still reports it, so the outlier is visible rather
   * than averaged in.
   */
  function median(list) {
    var sorted = list.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[mid]
      : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }

  function summarise(list, source) {
    return {
      days: median(list),
      worst: Math.max.apply(null, list),
      source: source
    };
  }

  var out = {};
  Object.keys(perItem).forEach(function (id) {
    out[id] = summarise(perItem[id],
      'typical of ' + perItem[id].length + ' past order' + (perItem[id].length === 1 ? '' : 's'));
  });
  out['_default'] = all.length
    ? summarise(all, 'typical across all orders')
    : { days: setting('report.assumedLeadTimeDays'), worst: setting('report.assumedLeadTimeDays'),
        source: 'assumed — no delivered orders yet' };

  return out;
}

/**
 * Open testing batches, split by where they physically are.
 *
 * `onBench` feeds the daily backlog nudge. `atVendor` is new in 3.2 and feeds a
 * slower chase: 3.1 correctly stopped nagging a tech every morning about a
 * batch sitting with APC, and then nothing chased it at all, so the units stayed
 * in Qty In Testing until somebody happened to remember. Aged from the date it
 * was sent, not the date it arrived on the bench.
 */
function computeTestingBacklog(departmentId) {
  var data = readSheet(CONFIG.SHEETS.TESTING);
  var onBench = [];
  var atVendor = [];

  data.rows.forEach(function (row) {
    var state = CONFIG.TESTING_STATUS[cell(row, data.col, 'Status')];
    if (!state || !state.open) return;
    if ((Number(cell(row, data.col, 'Qty Pending')) || 0) <= 0) return;
    if (departmentId && cell(row, data.col, 'Department') !== departmentId) return;

    var batch = {
      batchId: cell(row, data.col, 'Batch ID'),
      itemName: cell(row, data.col, 'Item Name'),
      pending: Number(cell(row, data.col, 'Qty Pending')) || 0,
      ageDays: daysSince(cell(row, data.col, 'Created')),
      vendorRef: cell(row, data.col, 'Vendor Ref'),
      sentToVendor: formatDay(cell(row, data.col, 'Sent To Vendor')),
      awayDays: daysSince(cell(row, data.col, 'Sent To Vendor'))
    };

    if (state.atVendor) atVendor.push(batch);
    else if (state.onBench) onBench.push(batch);
  });

  return { onBench: onBench, atVendor: atVendor };
}

// ─────────────────────────────────────────────────────────────
// Dashboard sheet
// ─────────────────────────────────────────────────────────────

/**
 * Writes the Dashboard sheet. Menu item and weekly trigger both land here.
 *
 * `precomputed` lets weeklyReport hand over figures it has already worked out
 * rather than making this recompute them from the transaction log.
 */
function buildDashboard(precomputed) {
  var sheet = mustGetSheet(CONFIG.SHEETS.DASHBOARD);
  sheet.clear();

  var out = [['IT Hallway — snapshot', formatDate(now())], []];

  listDepartments().forEach(function (dept) {
    var ready = precomputed && precomputed[dept.id];
    var s = ready ? ready.summary : computeSummary(dept.id);
    var stats = ready ? ready.stats : computeUsage(dept.id);

    out.push([dept.label, '']);
    out.push(['Items tracked', s.total]);
    out.push(['At or below minimum', s.low]);
    out.push(['Out of stock', s.out]);
    out.push(['Units waiting on the test bench', s.unitsInTesting]);
    out.push(['Open reorders', s.openReorders]);
    out.push([]);

    if (stats.running.length) {
      out.push(['Running out soonest', 'Cover left at current rate']);
      stats.running.slice(0, 8).forEach(function (r) {
        out.push(['  ' + r.name + (r.ranOut ? ' (ran out during this period)' : ''),
          (r.cover || (r.state === 'out' ? 'empty now' : 'at or below minimum'))
          + (r.onOrder ? ' — ' + r.coverWithOrder + ' with ' + r.onOrder + ' on order' : '')]);
      });
      out.push([]);
    }

    if (stats.overdueOrders.length) {
      out.push(['Ordered but overdue', 'Days late']);
      stats.overdueOrders.slice(0, 8).forEach(function (r) {
        out.push(['  ' + r.name + ' (' + r.onOrder + ' outstanding)', r.onOrderOverdue]);
      });
      out.push([]);
    }

    if (stats.thresholdAdvice.length) {
      out.push(['Minimum will not cover a delivery', 'Set to / suggested']);
      stats.thresholdAdvice.slice(0, 8).forEach(function (r) {
        out.push(['  ' + r.name + ' (' + r.leadTimeDays + ' day delivery)', r.min + ' / ' + r.suggestedMin]);
      });
      out.push([]);
    }

    if (stats.movers.length) {
      out.push(['Moving fastest', 'Units per week']);
      stats.movers.slice(0, 8).forEach(function (r) {
        out.push(['  ' + r.name, r.grossPerWeek + (r.trend && r.trend !== 'steady' ? ' (' + r.trend + ')' : '')]);
      });
      out.push([]);
    }

    if (stats.unknown.length) {
      out.push(['Moving, but not enough history for a rate', 'What is on record']);
      stats.unknown.slice(0, 8).forEach(function (r) { out.push(['  ' + r.name, r.withheld]); });
      out.push([]);
    }

    if (stats.dataQuality.length) {
      out.push(['More returned than taken — check these', 'Out / back']);
      stats.dataQuality.slice(0, 8).forEach(function (r) {
        out.push(['  ' + r.name, r.taken + ' / ' + r.returned]);
      });
      out.push([]);
    }

    if (stats.topDestinations.length) {
      out.push(['Where it went (last ' + stats.windowDays + ' days)', 'Units']);
      stats.topDestinations.forEach(function (d) { out.push(['  ' + d.destination, d.units]); });
      out.push([]);
    }
  });

  var padded = out.map(function (r) {
    while (r.length < 2) r.push('');
    return r.slice(0, 2);
  });

  sheet.getRange(1, 1, padded.length, 2).setValues(padded);
  sheet.getRange(1, 1, 1, 2).setFontWeight('bold').setFontSize(13);
  sheet.setColumnWidth(1, 340);
  sheet.setColumnWidth(2, 220);
  return 'Dashboard updated.';
}
