/**
 * Config.gs — the small amount that has to live in code.
 *
 * Almost everything you would want to change is on the **Config**, **Roles**
 * and **Departments** tabs of the spreadsheet, where each setting has a
 * dropdown and a plain-language explanation. Those tabs are the place to look
 * first. This file holds only the three kinds of thing that can't sensibly
 * live there:
 *
 *   1. BOOTSTRAP_ADMINS — the anchor that keeps you from being locked out.
 *      If this were a cell, a bad edit to that cell could strand everyone
 *      outside the system with no way back in.
 *
 *   2. Sheet and column names — the code needs these to find the Config tab
 *      in the first place, so they can't be read from it.
 *
 *   3. Starting data used once, when a blank spreadsheet is first set up.
 *
 * There is exactly one line below you must edit before going live.
 */

const CONFIG = {

  /** Bumped when the code changes. Shown in the app so you can tell what is deployed. */
  VERSION: '3.3',

  /**
   * ── THE ONE LINE YOU MUST EDIT ──
   * Anyone listed here is treated as an admin no matter what the Users tab or
   * the Roles tab says. Put your real address here, and ideally a colleague's
   * too, so a single departure doesn't leave the system unadministered.
   */
  BOOTSTRAP_ADMINS: ['tchris@c.ringling.edu'],

  /**
   * MIME types accepted for photo upload. In code rather than the sheet
   * because it's a security whitelist, not a preference — widening it is a
   * decision that deserves a code review, not a dropdown.
   */
  PHOTO_ALLOWED_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'],

  // ---------------------------------------------------------------
  // Structure — the shape of the spreadsheet
  // ---------------------------------------------------------------

  SHEETS: {
    INVENTORY:   'Inventory',
    TXN:         'Transactions',
    TESTING:     'Testing Queue',
    REORDER:     'Reorders',
    USERS:       'Users',
    ALERTS:      'Alerts',
    LISTS:       'Lists',
    CONFIG:      'Config',
    ROLES:       'Roles',
    DEPARTMENTS: 'Departments',
    DASHBOARD:   'Dashboard'
  },

  /**
   * Columns are read by header NAME, not position, so you can reorder or
   * insert columns freely. Renaming a header orphans that field — put it back
   * or re-run Setup.
   */
  HEADERS: {
    'Inventory': [
      'Item ID', 'Department', 'Item Name', 'Category', 'Item Class', 'Description',
      'Location', 'Qty On Shelf', 'Qty In Testing', 'Min Threshold',
      'Reorder To', 'Unit Cost', 'Vendor', 'Vendor SKU', 'Image URL',
      'Active', 'Notes', 'Last Updated', 'Updated By'
    ],
    'Transactions': [
      'Transaction ID', 'Timestamp', 'Item ID', 'Item Name', 'Department',
      'Action', 'Quantity', 'Shelf After', 'Testing After', 'Destination',
      'User Email', 'User Name', 'Notes', 'Reference', 'Voided', 'Void Note'
    ],
    'Testing Queue': [
      'Batch ID', 'Created', 'Item ID', 'Item Name', 'Department',
      'Qty Pending', 'Came From', 'Returned By', 'Notes',
      'Status', 'Resolved By', 'Resolved At', 'Resolution Note',
      'Sent To Vendor', 'Vendor Ref'
    ],
    'Reorders': [
      'Reorder ID', 'Created', 'Item ID', 'Item Name', 'Department',
      'Qty Requested', 'Requested By', 'Status', 'Approved By', 'Approved At',
      'Vendor', 'PO / Payment Ref', 'Unit Cost', 'Qty Ordered', 'Ordered By',
      'Ordered Date', 'Expected Date', 'Qty Received', 'Received By',
      'Received Date', 'Notes'
    ],
    'Users': ['Email', 'Name', 'Role', 'Home Department', 'Active', 'Added'],
    'Alerts': [
      'Alert ID', 'Timestamp', 'Type', 'Item ID', 'Message',
      'Status', 'Acknowledged By', 'Acknowledged At', 'Last Notified'
    ],
    'Lists': ['Categories', 'Locations', 'Destinations', 'Vendors', 'Disposal Reasons'],
    'Departments': ['ID', 'Department name', 'Active', 'Chat alerts', 'Notes']
  },

  /**
   * Every kind of movement, in one table.
   *
   * WHY THIS IS IN CODE AND NOT ON A TAB: these strings are written into the
   * Action column of the transaction log and then read back by the reports. A
   * dropdown that let someone invent a new one would produce rows no report
   * knows how to count.
   *
   *   shelf / testing  which bucket the quantity moves, and which way
   *   consumes         this is real demand — it counts in the burn-rate
   *                    numerator. A Take does; so does issuing a tested unit
   *                    straight out from the bench, because the shelf never
   *                    saw it but a lab did
   *   returnsToShelf   the units came back unused or passed testing, so they
   *                    did NOT get consumed — subtracted from the numerator
   *   disposes         scrap, tallied separately. Off the shelf it is also
   *                    consumption; off the bench it is not
   *   reversible       may be undone with Void or the app's Undo. Anything
   *                    touching money or disposal is corrected with an Adjust
   *
   * Anything with none of consumes / returnsToShelf / disposes set moves stock
   * without saying anything about demand — a Receive or a correction.
   *
   * ADDING ONE: add a row here, then check the four places that read this
   * table — applyMovement(), movementStats(), reverseTransaction() and the
   * Action column's validation in Setup.
   */
  ACTIONS: {
    'Take':               { shelf: -1, testing:  0, consumes: true,  returnsToShelf: false, disposes: false, reversible: true  },
    'Put Back':           { shelf: +1, testing:  0, consumes: false, returnsToShelf: true,  disposes: false, reversible: true  },
    'Return to Testing':  { shelf:  0, testing: +1, consumes: false, returnsToShelf: false, disposes: false, reversible: true  },
    'Return to Shelf':    { shelf: +1, testing: -1, consumes: false, returnsToShelf: true,  disposes: false, reversible: false },
    'Issued from Bench':  { shelf:  0, testing: -1, consumes: true,  returnsToShelf: false, disposes: false, reversible: false },
    'Dispose':            { shelf:  0, testing: -1, consumes: false, returnsToShelf: false, disposes: true,  reversible: false },
    'Dispose from Shelf': { shelf: -1, testing:  0, consumes: true,  returnsToShelf: false, disposes: true,  reversible: false },
    'Send to Vendor':     { shelf:  0, testing:  0, consumes: false, returnsToShelf: false, disposes: false, reversible: false },
    'Receive':            { shelf: +1, testing:  0, consumes: false, returnsToShelf: false, disposes: false, reversible: false },
    'Adjust':             { shelf:  0, testing:  0, consumes: false, returnsToShelf: false, disposes: false, reversible: false },
    'Create':             { shelf:  0, testing:  0, consumes: false, returnsToShelf: false, disposes: false, reversible: false }
  },

  /**
   * What an item does when it comes back, in one table.
   *
   * Same reasoning as ACTIONS. This used to be a ternary in itemClassOf() plus
   * a branch in putBackOnShelf() plus two functions in the front end, so a
   * third class meant editing five places in two languages. Now it is a row,
   * and the front end reads the same table because bootstrap ships it.
   *
   *   label                 what the person picking it sees
   *   returnRoute           where a used one goes by default: shelf or bench
   *   staffMayReturnToShelf may someone without testing.resolve put a used one
   *                         straight back? Only ever true where no judgement
   *                         is involved
   *   blurb                 the one-line explanation under the picker
   */
  ITEM_CLASSES: {
    'consumable': {
      label: 'Consumable — put straight back on the shelf',
      returnRoute: 'shelf',
      staffMayReturnToShelf: true,
      blurb: 'Paper, toner, patch cables. Anything carried back was never opened.'
    },
    'testable': {
      label: 'Testable — goes to the bench for a tech to check',
      returnRoute: 'bench',
      staffMayReturnToShelf: false,
      blurb: 'UPS units, batteries, adapters. A used one is not stock again until someone has looked at it.'
    }
  },

  /** Blank Item Class means this. Most of the shelf is consumable. */
  DEFAULT_ITEM_CLASS: 'consumable',

  /**
   * What a reorder line may become next. Previously each function carried its
   * own idea of this, so adding a status meant editing three files.
   */
  REORDER_FLOW: {
    'Pending approval':   ['Needed', 'Declined', 'Cancelled'],
    'Needed':             ['Ordered', 'Cancelled'],
    'Ordered':            ['Partially Received', 'Received', 'Cancelled'],
    'Partially Received': ['Partially Received', 'Received', 'Cancelled'],
    'Received':           [],
    'Declined':           [],
    'Cancelled':          []
  },

  /**
   * Testing batch statuses, in one table.
   *
   * TESTING_OPEN used to be the only one of these in code; 'Resolved',
   * 'Cancelled' and 'Out for warranty' were inline strings across Testing.gs
   * and Reports.gs, so adding a state meant grepping for quoted words.
   *
   *   open       the batch still has units nobody has decided about
   *   onBench    physically here, so it belongs in the daily backlog nudge
   *   atVendor   away on an RMA, chased on its own slower schedule
   */
  TESTING_STATUS: {
    'Pending':          { open: true,  onBench: true,  atVendor: false },
    'Out for warranty': { open: true,  onBench: false, atVendor: true  },
    'Resolved':         { open: false, onBench: false, atVendor: false },
    'Cancelled':        { open: false, onBench: false, atVendor: false }
  },

  // ---------------------------------------------------------------
  // First-run seed data — used once, on a blank spreadsheet
  // ---------------------------------------------------------------

  /** Populates an empty Lists tab. After setup, edit the TAB, not this. */
  SEED_LISTS: {
    'Categories': [
      'Battery Backup', 'Batteries', 'Cables', 'Keyboards & Mice',
      'Paper & Toner', 'Adapters', 'Power', 'A/V Cables', 'Microphones',
      'Projector Lamps', 'Misc'
    ],
    'Locations': [
      'Back Hallway A', 'Back Hallway B', 'Back Hallway C',
      'Storage Room', 'A/V Cage'
    ],
    'Destinations': [
      'Library Lab', 'Science Lab 204', 'Business Lab', 'Open Lab',
      'Front Office', 'Classroom', 'Auditorium', 'Helpdesk Bench', 'Other'
    ],
    'Vendors': ['CDW-G', 'Amazon Business', 'B&H', 'Dell', 'Local'],
    'Disposal Reasons': [
      'Failed testing', 'Swollen / leaking battery', 'Physical damage',
      'End of life', 'Obsolete', 'Missing parts'
    ]
  },

  /** Sample rows so the app isn't empty on day one. Delete once you're live. */
  SEED_ITEMS: [
    { dept: 'IT', name: 'APC Back-UPS 600VA',  cat: 'Battery Backup', cls: 'testable',   loc: 'Back Hallway A', qty: 6,  min: 3, reorderTo: 12 },
    { dept: 'IT', name: 'APC RBC17 Battery',   cat: 'Batteries',      cls: 'testable',   loc: 'Back Hallway A', qty: 4,  min: 2, reorderTo: 10 },
    { dept: 'IT', name: 'USB-C to USB-A 1m',   cat: 'Cables',         cls: 'consumable', loc: 'Back Hallway B', qty: 22, min: 8, reorderTo: 40 },
    { dept: 'IT', name: 'Letter Paper (ream)', cat: 'Paper & Toner',  cls: 'consumable', loc: 'Storage Room',   qty: 14, min: 6, reorderTo: 40 },
    { dept: 'AV', name: 'XLR Cable 25ft',      cat: 'A/V Cables',     cls: 'consumable', loc: 'A/V Cage',       qty: 9,  min: 4, reorderTo: 16 }
  ]
};
