import { Migration } from '@mikro-orm/migrations';

/**
 * The connector's only migration — see `data/entities.ts` and plan §12.2 for why one table exists
 * at all. Written by hand rather than generated so the diff stays scoped to this module and cannot
 * pick up unrelated snapshot drift from core.
 */
export class Migration20260720120000_sync_shopify extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "sync_shopify_inventory_snapshots" (
      "id" uuid not null default gen_random_uuid(),
      "snapshot_date" text not null,
      "captured_at" timestamptz not null,
      "variant_id" uuid null,
      "variant_external" text not null,
      "sku" text null,
      "product_type" text null,
      "location_id" text not null,
      "on_hand" int not null,
      "available" int not null,
      "committed" int null,
      "incoming" int null,
      "out_of_stock" boolean not null,
      "is_physical" boolean not null,
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      constraint "sync_shopify_inventory_snapshots_pkey" primary key ("id")
    );`);

    // Idempotency for a snapshot day. Also the conflict target the daily upsert relies on, so it
    // must be a real constraint, not a bare index.
    this.addSql(`alter table "sync_shopify_inventory_snapshots" add constraint "sync_shopify_inventory_snapshots_day_key" unique ("snapshot_date", "variant_external", "location_id", "organization_id", "tenant_id");`);

    // Column order matches the `oosRatio` lookup exactly: scope, variant, then a date-range scan.
    this.addSql(`create index "sync_shopify_inventory_snapshots_lookup_idx" on "sync_shopify_inventory_snapshots" ("organization_id", "tenant_id", "variant_external", "snapshot_date");`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "sync_shopify_inventory_snapshots" cascade;`);
  }

}
