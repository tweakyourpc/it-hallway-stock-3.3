# IT Hallway Stock 3.3

![IT Hallway Stock 3.3](docs/assets/it-hallway-stock-3.3-readme-hero.png)

IT Hallway Stock is a low-overhead Google Apps Script application for managing interchangeable IT supplies and replacement parts. It records stock movements and demand destinations while keeping shelf stock, testing work, warranty/RMA work, forecasting, and purchasing understandable at a glance.

## What 3.3 improves

- Faster take and return flows with remembered job context.
- Clear separation of available shelf stock, testing work, and vendor/RMA work.
- Partial batch resolution with explicit outcomes and an open remainder.
- Reorder suggestions that distinguish insufficient evidence, requested, ordered, and partially received.
- Safer correction flow with explicit reversal rules and preserved history.
- Mobile-first screens that remain useful at a shelf and at a manager's desk.

The product intentionally does not track serial numbers, asset custody, permanent assignments, or individual units after issue.

## Project contents

The `.gs` files are Google Apps Script server code and `WebForm.html` is the web app client. The `tests` directory contains synthetic-data unit and integration-style checks; it never writes to a live spreadsheet.

To use the project, create or open an Apps Script project, add the files, run the setup flow, and configure the spreadsheet and notification settings described in `UPGRADE.md`.

## Checks

Run the test files from this directory:

```sh
for f in tests/forecast.test.js tests/movements.test.js tests/orders.test.js tests/requests.test.js tests/release33.test.js; do node "$f"; done
```

The social-preview artwork is provided at `docs/assets/it-hallway-stock-3.3-social-preview.png` for the repository's GitHub social image setting.
