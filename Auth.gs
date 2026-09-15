/**
 * Auth.gs — who is this, and what are they allowed to do.
 *
 * WHY THIS MATTERS: google.script.run can call ANY global function in the
 * project. A student worker who opens the browser console can call
 * saveSettings() or archiveItem() directly, no matter what the UI shows them.
 * So every function that changes data calls requirePerm() as its first line.
 * Hiding a button is a convenience, not a control.
 */

/**
 * Work out who this is, WITHOUT throwing. Returns a status so doGet() can show
 * a friendly page instead of an error, and so the caller can tell the
 * difference between "signed in with the wrong account" and "not on the team".
 *
 *   ok         → { status:'ok', user }
 *   anonymous  → Google gave us no email at all. Either the person is signed in
 *                with a personal account (the common case on a phone with more
 *                than one profile), or the app was deployed with access set to
 *                "Anyone", which performs no authentication.
 *   foreign    → a real email, but not on an approved domain
 *   inactive   → on the Users tab but switched off
 *   unenrolled → allowed domain, not on the Users tab, automatic enrolment off
 */
function identify() {
  var email = '';
  try {
    email = String(Session.getActiveUser().getEmail() || '').toLowerCase().trim();
  } catch (e) {
    email = '';
  }

  if (!email) return { status: 'anonymous' };

  var domains = settingList('access.allowedDomains');
  if (domains.length) {
    var domain = email.split('@')[1] || '';
    if (domains.indexOf(domain) === -1) return { status: 'foreign', email: email };
  }

  var cache = CacheService.getScriptCache();
  var cached = cache.get('user:' + email);
  if (cached) {
    try { return { status: 'ok', user: JSON.parse(cached) }; } catch (e) { /* re-read */ }
  }

  var result;
  try {
    result = { status: 'ok', user: lookupUser(email) };
  } catch (e) {
    return { status: e.itHallwayStatus || 'unenrolled', email: email, message: e.message };
  }

  try {
    cache.put('user:' + email, JSON.stringify(result.user), setting('access.roleCacheSeconds'));
  } catch (e) { /* cache is best-effort */ }
  return result;
}

/**
 * The signed-in person, or an error. Every data function starts here.
 *
 * Identity comes from Google, not from anything the browser sends, so nobody
 * can claim to be someone else the way they could in version 2.1.
 */
function getCurrentUser() {
  var id = identify();
  if (id.status === 'ok') return id.user;

  if (id.status === 'anonymous') {
    throw new Error(
      'Could not identify your Google account. Sign in with your '
      + institutionName() + ' account — personal Google accounts cannot be used.'
    );
  }
  if (id.status === 'foreign') {
    throw new Error(
      id.email + ' is not a ' + institutionName() + ' account. '
      + 'Switch accounts and try again.'
    );
  }
  throw new Error(id.message || 'You do not have access to IT Hallway.');
}

/** What to call the institution on sign-in screens and error messages. */
function institutionName() {
  return setting('access.institutionName') || 'your organisation';
}

function lookupUser(email) {
  var isBootstrapAdmin = CONFIG.BOOTSTRAP_ADMINS
    .map(function (e) { return String(e).toLowerCase(); })
    .indexOf(email) !== -1;

  var data = readSheet(CONFIG.SHEETS.USERS);
  var rowIndex = findRow(data.rows, data.col['Email'], email);

  if (rowIndex === -1) {
    // Not on the roster yet.
    if (isBootstrapAdmin) {
      addUserRow(email, email.split('@')[0], 'admin', defaultDepartment());
      return userObject(email, email.split('@')[0], 'admin', defaultDepartment());
    }
    if (setting('access.autoEnroll')) {
      var name = email.split('@')[0].replace(/[._]/g, ' ');
      var startRole = setting('access.autoEnrollRole');
      addUserRow(email, name, startRole, defaultDepartment());
      return userObject(email, name, startRole, defaultDepartment());
    }
    var notEnrolled = new Error(
      'You are not set up in IT Hallway yet. Ask an admin to add ' + email + ' to the Users tab.'
    );
    notEnrolled.itHallwayStatus = 'unenrolled';
    throw notEnrolled;
  }

  var row = data.rows[rowIndex];
  var active = String(cell(row, data.col, 'Active')).trim();
  if (active && !boolFrom(active) && !isBootstrapAdmin) {
    var off = new Error('Your IT Hallway access has been turned off. Contact an admin.');
    off.itHallwayStatus = 'inactive';
    throw off;
  }

  var role = cleanText(cell(row, data.col, 'Role'), 20).toLowerCase();
  if (isBootstrapAdmin) role = 'admin';
  if (roleNames().indexOf(role) === -1) role = setting('access.autoEnrollRole');

  return userObject(
    email,
    cleanText(cell(row, data.col, 'Name'), 120) || email,
    role,
    cleanText(cell(row, data.col, 'Home Department'), 20) || defaultDepartment()
  );
}

function userObject(email, name, role, department) {
  return {
    email: email,
    name: name,
    role: role,
    department: department,
    permissions: permissionsFor(role)
  };
}

function addUserRow(email, name, role, department) {
  var sheet = mustGetSheet(CONFIG.SHEETS.USERS);
  var headers = CONFIG.HEADERS[CONFIG.SHEETS.USERS];
  sheet.appendRow(buildRow(headers, {
    'Email': email,
    'Name': name,
    'Role': role,
    'Home Department': department,
    'Active': true,
    'Added': formatDate(now())
  }));
}

/** Does this user hold the permission? */
function can(user, permission) {
  return user.permissions.indexOf(permission) !== -1;
}

/**
 * Gate for every function that writes data. Returns the user so callers can
 * attribute the change: `var user = requirePerm('item.take');`
 */
function requirePerm(permission) {
  var user = getCurrentUser();
  if (!can(user, permission)) {
    throw new Error(
      'Your role (' + user.role + ') can\'t do that. Ask a manager if you need access.'
    );
  }
  return user;
}

// ─────────────────────────────────────────────────────────────
// User administration (admin only)
// ─────────────────────────────────────────────────────────────

function listUsers() {
  requirePerm('users.manage');
  var data = readSheet(CONFIG.SHEETS.USERS);
  return data.rows
    .filter(function (row) { return cell(row, data.col, 'Email'); })
    .map(function (row) {
      return {
        email: cell(row, data.col, 'Email'),
        name: cell(row, data.col, 'Name'),
        role: cell(row, data.col, 'Role'),
        department: cell(row, data.col, 'Home Department'),
        active: boolFrom(cell(row, data.col, 'Active'))
      };
    });
}

function setUserRole(email, role, active) {
  var admin = requirePerm('users.manage');
  var target = cleanText(email, 200).toLowerCase();
  var newRole = requireOneOf(String(role).toLowerCase(), roleNames(), 'Role');

  if (target === admin.email && newRole !== 'admin') {
    throw new Error('You can\'t remove your own admin access. Ask another admin.');
  }

  return withLock(function () {
    var data = readSheet(CONFIG.SHEETS.USERS);
    var rowIndex = findRow(data.rows, data.col['Email'], target);
    if (rowIndex === -1) throw new Error('No user found for ' + target);

    var row = data.rows[rowIndex];
    row[data.col['Role']] = newRole;
    if (active !== undefined) row[data.col['Active']] = !!active;
    writeRow(data.sheet, rowIndex, row);

    CacheService.getScriptCache().remove('user:' + target);
    return { email: target, role: newRole };
  });
}

function inviteUser(email, name, role, department) {
  requirePerm('users.manage');
  var target = requireText(email, 'Email', 200).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target)) throw new Error('That doesn\'t look like an email address.');

  var data = readSheet(CONFIG.SHEETS.USERS);
  if (findRow(data.rows, data.col['Email'], target) !== -1) {
    throw new Error(target + ' is already on the roster.');
  }
  addUserRow(
    target,
    cleanText(name, 120) || target.split('@')[0],
    requireOneOf(String(role).toLowerCase(), roleNames(), 'Role'),
    cleanText(department, 20) || defaultDepartment()
  );
  return { email: target };
}
