# @northbound-run/sync-shopify

Sync a Shopify store into an [Open Mercato](https://openmercato.com) app — products, collections,
customers, orders and inventory — mapped onto Open Mercato's native catalog, customer and sales
entities. Import-only, read-only against Shopify, and safe to run on a schedule.

The package registers five independent Data Sync integrations under one shared Shopify connection.
Each can be enabled, scheduled and run on its own.

| Integration | Shopify → Open Mercato | Notes |
|---|---|---|
| **Products** | products, variants, prices | Per-product variant reconciliation; deletes handled on full sync |
| **Collections** | collections → product categories | Membership synced; smart-collection rules are not preserved |
| **Customers** | customers, addresses | Addresses reconciled per customer |
| **Orders** | orders, lines, discounts, payments, fulfillments | Totals reconciled to the cent; **limited to the last 60 days unless the app holds `read_all_orders`** |
| **Inventory** | daily stock snapshots + out-of-stock history | Owns one table; enables demand-planning corrections |

---

## Requirements

- An Open Mercato app on **`@open-mercato/core` 0.6.x** or later, with the **`integrations`** and
  **`data_sync`** modules enabled.
- **Node.js 24+** (native `fetch`, `AbortSignal.timeout`).
- **PostgreSQL** (the framework's database).
- A configured **credential encryption key** — Vault KMS or `TENANT_DATA_ENCRYPTION_FALLBACK_KEY`.
  Without one, storing the Shopify credentials fails outright (the framework encrypts them at rest).
- For **scheduled** and **background** syncs: `@open-mercato/queue` on its Redis/BullMQ strategy and
  `@open-mercato/scheduler`. Without them the sync still runs on demand, but not unattended.

---

## Install

```bash
yarn mercato module add @northbound-run/sync-shopify --allow-third-party
yarn db:migrate
```

`module add` registers the module in `src/modules.ts` and runs `mercato generate`. `db:migrate`
applies the single migration this package ships (the inventory snapshot table).

The `--allow-third-party` flag is required because the package is not under the `@open-mercato`
scope — it is a supply-chain opt-in, nothing more.

---

## Connect a Shopify store

This module authenticates with Shopify's **client credentials grant**: your app exchanges its own
client ID and secret for a short-lived access token, with no browser redirect and no user login. It
is the grant Shopify intends for a server-to-server integration against a store you control, which is
exactly the self-hosted case here.

> **Why no access token to paste?** Newer Shopify apps do not expose a permanent Admin API token in
> the UI — only a **client ID** and **client secret** (the value beginning `shpss_`). The module
> mints and refreshes a 24-hour token from those automatically; you never handle the token yourself.

### 1. Create the app

1. In the [Shopify Dev Dashboard](https://dev.shopify.com/dashboard), create an app.
2. Configure its **Admin API access scopes** (see below).
3. **Install the app on the store.** The client credentials grant only works for a store the app is
   installed in.
4. From the app's **Settings → API credentials**, copy the **Client ID** and **Client secret**.

### 2. Required scopes

Configure these on the app, then **release a new app version** — scope changes take effect only on
release, and an already-installed app must re-approve them.

| Scope | Enables |
|---|---|
| `read_products` | products, variants, prices — and collections |
| `read_customers` | customers and addresses |
| `read_orders` | orders (last 60 days — see below) |
| `read_inventory` | inventory levels and unit cost |
| `read_locations` | per-location inventory |
| `read_all_orders` | **optional** — order history beyond 60 days |

> **The 60-day order window.** Shopify's Order API returns only the last 60 days unless the app holds
> `read_all_orders`, which is a protected scope. Without it, the orders integration syncs a rolling
> 60-day window and **will not** delete older orders it can no longer see — it knows it is
> window-limited and reconciles only within that window. If you need full order history (for example
> for demand planning), request `read_all_orders` on the app.

### 3. Connect the store

The connection is resolved **env-first at runtime**: each field falls back to its
`OM_INTEGRATION_SHOPIFY_*` env var, with the stored credential (if any) taking precedence as a
per-tenant override. So a headless deployment just sets the [environment
variables](#environment-variables) — tenant bootstrap seeds the same values into the store, and the
connection works without touching the admin UI.

To connect (or override) in the admin instead, go to **Settings → Integrations → Shopify** and enter:

| Field | Value |
|---|---|
| **Shop domain** | `yourstore.myshopify.com` (the permanent domain, not a custom storefront domain) |
| **Client ID** | from the app's API credentials |
| **Client secret** | the `shpss_…` value |
| **Admin API version** | pinned to `2026-07` by default |

Then enable the integrations you want (Products, Collections, Customers, Orders, Inventory) and run or
schedule each.

### 4. Verify the connection

```bash
yarn mercato sync_shopify test-connection --tenant <id> --org <id>
```

This mints a token, calls the Admin API, and reports the granted scopes, the store, and the available
order-history window — the same code path a real sync uses, so a green result means a sync will
authenticate. It also warns if the store's canonical domain differs from the one you entered.

---

## How syncing works

Each integration supports three modes, all through Open Mercato's Data Sync engine (which owns run
records, cursors, progress and resumability):

- **Backfill** — the first run, via Shopify's Bulk Operations API (streamed, memory-bounded).
- **Delta** — scheduled incremental runs, via an `updated_at` cursor.
- **Reconcile** — on a full sync, records absent upstream are soft-deleted. This is the only
  deletion mechanism in v1, so **deletes are eventually consistent** within one full-sync interval.

### Scheduling

Register a schedule per integration through the Data Sync UI or the scheduler. Production scheduled
runs require `@open-mercato/queue` on its `async` (Redis/BullMQ) strategy — set
`AUTO_SPAWN_WORKERS=false` and run `yarn start:workers` separately. On the file-based `local` strategy
scheduled syncs are not reliable, and the framework refuses multi-instance production on it.

---

## Inventory and demand planning

The inventory integration is the one place this package owns a table
(`sync_shopify_inventory_snapshots`). It exists for a specific reason: **demand planning**.

A product's trailing sales are understated for any period it was out of stock, so a naive 90-day
average under-orders exactly the items that sell best. Correcting for that needs inventory *over
time*, which a current-state custom field cannot represent. So the integration appends one dated
snapshot per variant per location per day, and derives a per-SKU **out-of-stock ratio** over a window:

```
oos_ratio = days_out_of_stock / days_observed
effective_daily_demand = recorded_sales / (days_observed × (1 − oos_ratio))
```

Written back to the native variant as custom fields, so a downstream module (a purchasing /
PO-drafting tool, a report) reads current stock and the derived signal off a stable `cf:` seam and
never has to touch this connector's snapshot table:

| Field | Meaning |
|---|---|
| `cf:on_hand` | current on-hand, summed across the variant's locations |
| `cf:available` | current available (sellable), summed across locations |
| `cf:oos_ratio_90d` | out-of-stock ratio over the window (written only when there is enough history) |
| `cf:days_out_of_stock_90d` | days out of stock over the window |
| `cf:unit_cost` | Shopify's `unitCost` — unblocks margin/P&L |

> **The ratio is guarded.** History cannot be backfilled — it accrues forward only — so a fresh
> install has no valid ratio for ~90 days. Below a minimum of 14 observed days and 50% window
> coverage, the ratio is reported as **unknown** and no custom field is written (a `0` would read as
> "never out of stock" and feed straight into a purchase order). Treat a missing ratio as "not enough
> history yet", not "no stockouts".

### Pruning history

Snapshots are **never deleted automatically** — the history cannot be re-fetched from Shopify, so
deletion is always an explicit operator action:

```bash
# Dry run by default — reports what it would delete.
yarn mercato sync_shopify prune-inventory --tenant <id> --org <id>

# Actually delete rows older than the retention window (default 396 days):
yarn mercato sync_shopify prune-inventory --tenant <id> --org <id> --confirm
```

A 10,000-variant, 3-location store generates roughly 11M rows/year, so plan retention for a large
catalog; the validated single-location store generates ~77k/year.

---

## Limitations

Documented plainly, because they affect what the synced data can be trusted for:

- **Orders are limited to 60 days** without `read_all_orders` (above).
- **Deletes are eventually consistent** — detected on full-sync reconciliation, not in real time
  (webhooks are a future increment).
- **Smart-collection rules are not preserved.** Shopify computes their membership server-side; the
  resulting membership is synced as static assignments, but the rules themselves are not.
- **Inventory history is forward-only** and cannot be backfilled.
- **The demand signal is DTC only.** For a wholesale-heavy brand, Shopify orders understate true
  demand — the connector sees the direct-to-consumer slice, not total.
- **Order statuses** (`financialStatus`/`fulfillmentStatus`) are kept in order metadata; the native
  status columns are populated only once a status dictionary is configured.
- **Returns** are not modelled separately, so a returned unit still counts toward demand.

---

## CLI reference

```
yarn mercato sync_shopify test-connection   [--shop … --client-id … --client-secret …] [--tenant … --org …]
yarn mercato sync_shopify configure-from-env --tenant <id> --org <id>
yarn mercato sync_shopify prune-inventory    --tenant <id> --org <id> [--older-than-days N] [--confirm]
yarn mercato sync_shopify help
```

A standalone connection probe is also available before the module is installed anywhere:

```bash
yarn probe --shop yourstore.myshopify.com --client-id <id> --client-secret shpss_…
```

## Environment variables

All optional. The **connection** (`SHOP_DOMAIN` / `CLIENT_ID` / `CLIENT_SECRET` / `API_VERSION`) is
resolved **env-first at runtime** — a stored credential wins as a per-tenant override, otherwise the
env var is used — so a single-store deployment connects straight from configuration management
without touching the admin UI. Tenant bootstrap (`setup.ts`) also seeds these into the credential
store on tenant creation, and `configure-from-env` re-applies the same logic (plus enable/schedule)
later. Every step is **non-destructive** — existing credentials, operator-toggled integrations and
existing schedules are all left untouched, so a redeploy never clobbers an operator's choices.

| Variable | Purpose |
|---|---|
| `OM_INTEGRATION_SHOPIFY_SHOP_DOMAIN` | `yourstore.myshopify.com` |
| `OM_INTEGRATION_SHOPIFY_CLIENT_ID` | app client ID |
| `OM_INTEGRATION_SHOPIFY_CLIENT_SECRET` | app client secret (`shpss_…`) |
| `OM_INTEGRATION_SHOPIFY_API_VERSION` | optional; defaults to `2026-07` |
| `OM_INTEGRATION_SHOPIFY_ENABLE_ENTITIES` | optional; comma list of `products,collections,customers,orders,inventory` (or `all` / `none`). **Unset defaults to `all` when a shop domain is configured via env** |
| `OM_INTEGRATION_SHOPIFY_SYNC_CRON` | optional; cron (e.g. `0 * * * *`) to seed an incremental import schedule for each enabled **delta** sync (products, collections, customers, orders) — needs `@open-mercato/scheduler` |
| `OM_INTEGRATION_SHOPIFY_SYNC_CRON_INVENTORY` | optional; separate cron (e.g. `0 2 * * *`) for the daily inventory snapshot |
| `OM_INTEGRATION_SHOPIFY_SYNC_TIMEZONE` | optional; timezone for seeded schedules, defaults to `UTC` |
| `TENANT_DATA_ENCRYPTION_FALLBACK_KEY` | framework credential-encryption key (or configure Vault KMS) |

When the connection is configured via env (`OM_INTEGRATION_SHOPIFY_SHOP_DOMAIN` is set), a fresh
tenant **enables all five syncs by default** — the deployment already knows the credentials, so no
admin toggling is needed. Set `OM_INTEGRATION_SHOPIFY_ENABLE_ENTITIES=none` to opt out, or name a
subset. A plain install with no Shopify env enables nothing (integrations stay disabled until an
admin turns them on), so nothing is ever enabled without a connection behind it. The cron variables
only take effect for entities that end up enabled, and are silently skipped when the scheduler module
is absent.

**Inventory** is a snapshot job, not a delta sync: every run captures the current day (there is no
cursor), so give it its own daily cadence via `OM_INTEGRATION_SHOPIFY_SYNC_CRON_INVENTORY` rather than
the hourly delta cron — running it hourly just re-captures the same day. It also links snapshots to
catalog variants (and writes `unit_cost` / out-of-stock ratio) through the **Products** sync's
external-id mappings, so keep Products enabled and synced alongside it; before Products has run, a
snapshot is still recorded but its local variant link resolves on a later run.

---

## API version

Pinned to **`2026-07`** (current stable; supported `2026-07`, `2026-04`, `2026-01`). Do not pin
backwards to an older version to "play safe" — collections using the 2026-07 multi-source model are
silently filtered out of older-version query results, so an older pin loses data without any error.

---

## License

MIT © Northbound
