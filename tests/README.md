# Tests

Node, no dependencies, no spreadsheet.

```
node run.js
```

`stubs.js` fakes the Google Apps Script services, Sheets, Cache, Properties,
Lock, UrlFetch, well enough to run the project's real `.gs` files unmodified.
`world.js` loads them and builds a workbook per test from plain objects.

Two of the stubs exist to test things that are otherwise invisible:

- **`LockService`** tracks nesting depth, so a test can assert the script lock is
  never taken twice at once.
- **`UrlFetchApp`** records whether the lock was held at the moment of each
  outbound call, so a test can assert no webhook ever fires while somebody at a
  shelf is waiting on that lock.

`requests.test.js` counts how many times each tab is read per request, which is
how the performance claims in UPGRADE.md are checked rather than assumed.

Set `GS_DIR` to point at a different copy of the project.
