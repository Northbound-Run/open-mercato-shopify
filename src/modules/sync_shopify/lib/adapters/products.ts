import type {
  DataMapping,
  DataSyncAdapter,
  ImportBatch,
  StreamImportInput,
  TenantScope,
} from '@open-mercato/core/modules/data_sync/lib/adapter'
import { SEARCH_DEBUG_HEADER, type ShopifyClient } from '../client'
import { childrenOfType, runBulkExport, type BulkExportOptions, type BulkNode } from '../bulk'
import {
  advanceCursor,
  normalizeTimestamp,
  parseCursor,
  serializeCursor,
  type CursorPointer,
  type ShopifyCursorState,
} from '../cursor'
import {
  COMMAND,
  COMMAND_RESULT_KEY,
  ENTITY_TYPE,
  INTEGRATION_ID,
  MAPPING_ENTITY_TYPE,
  PROVIDER_KEY,
} from '../constants'
import {
  toImportItem,
  type EntityRow,
  type EntityWriter,
  type ExternalIdMappingPort,
  type ImportItem,
} from '../writer'
import {
  PRICE_KIND_CODE,
  ProductMappingError,
  mapPrice,
  mapProduct,
  mapVariant,
  priceExternalId,
  readContentHash,
  resolveCurrencyCode,
  toPriceIntents,
  type PriceIntent,
  type PriceKindCode,
  type ShopifyProductNode,
  type ShopifyVariantNode,
} from '../mappers/product'

/**
 * The Shopify products import adapter.
 *
 * The engine owns run records, counters, cursor persistence and cancellation; we own an async
 * generator. `ImportBatch.items[].action` REPORTS what this adapter already did — the writes have
 * happened by the time a batch is yielded — so a batch is a statement of fact, not an instruction.
 *
 * Backfill and delta both live inside `streamImport` and the engine cannot tell them apart, which
 * is exactly why the contract fits: the adapter picks its mode from whether a cursor exists.
 *
 * FIVE THINGS THAT DECIDE WHETHER THIS IS CORRECT OR CATASTROPHIC:
 *
 * 1. 🔴 PER-PRODUCT VARIANT RECONCILIATION. Shopify returns a product with its ENTIRE variant set,
 *    so a variant deleted upstream is simply ABSENT from a payload we already hold — there is no
 *    deletion signal to react to. Akeneo's importer has no equivalent because it receives one
 *    variant per row. We therefore diff each product's variants against what we just wrote and
 *    deactivate the remainder, scoped to that product. This is safe on a delta run too: a product
 *    we were given is a product whose variants we have in full.
 *
 * 2. 🔴 …BUT ONLY WHEN THE VARIANT SET IS COMPLETE. A product may carry up to 2048 variants, and a
 *    truncated `variants(first:)` connection is indistinguishable from a product whose variants
 *    were deleted. Acting on one would deactivate every variant past the page boundary. Hence
 *    `variantsComplete`, which the paged path reads from `pageInfo.hasNextPage` and bulk always
 *    sets true. A product too wide for one page keeps its variants until the next backfill.
 *
 * 3. 🔴 CATALOG-WIDE RECONCILIATION IS GUARDED ON `!input.cursor`. A delta run legitimately sees
 *    only changed records, so reconciling against it would soft-delete the entire catalog. The
 *    guard is the difference between a correct sync and a data-loss incident, and it is
 *    deliberately the raw `input.cursor` rather than anything derived from it.
 *
 * 4. PRICE KINDS MUST PRE-EXIST. Core looks `CatalogPriceKind` up and never creates it. Akeneo
 *    `continue`s when one is missing, producing a run that reports success and writes zero prices.
 *    We resolve both kinds before the first batch and fail the run by name instead.
 *
 * 5. PER-ITEM FAILURES ARE REPORTED, NEVER THROWN. A throw escapes the generator and the engine
 *    finalises the whole run as failed, losing every item that had already succeeded. Everything
 *    per-item goes through the writer's outcome contract; only run-level faults (bad credentials,
 *    a missing price kind) are allowed to raise.
 */

// ── Injected collaborators ───────────────────────────────────────────────────────────────────
// Nothing here imports framework runtime code — see the note in `lib/writer.ts` for why that
// matters. `di.ts` builds the runtime against a request container and passes it in; a test passes
// four closures. The scoped reads are handed over PRE-BOUND (built with `writer.rowReader` and
// `writer.naturalKeyLookup`) so this file never needs an entity class.

export type ProductsMappingPort = ExternalIdMappingPort & {
  /**
   * Which Shopify record a local row came from, or null when this integration does not own it.
   *
   * This is the external-id gate from §4.8: rows created by an operator or another integration
   * must never be deactivated by our reconciliation.
   */
  lookupExternalId(
    integrationId: string,
    entityType: string,
    localId: string,
    scope: TenantScope,
  ): Promise<string | null>
  /**
   * Forget a mapping whose row we just deleted.
   *
   * Without this the mapping outlives the row, and the next run resolves through it, re-reads
   * nothing, and creates a replacement — resurrecting the price we deliberately removed.
   */
  deleteExternalIdMapping(
    integrationId: string,
    entityType: string,
    localId: string,
    scope: TenantScope,
  ): Promise<boolean>
}

export type ProductsRuntime = {
  writer: EntityWriter
  mapping: ProductsMappingPort
  readProduct(localId: string): Promise<EntityRow | null>
  readVariant(localId: string): Promise<EntityRow | null>
  readPrice(localId: string): Promise<EntityRow | null>
  findProductByHandle(handle: string): Promise<EntityRow | null>
  findVariantBySku(sku: string): Promise<EntityRow | null>
  /**
   * `CatalogPriceKind` by code.
   *
   * ⚠ Scope this by TENANT ONLY. The row's `organization_id` is nullable and core's seeder writes
   * null for a tenant-wide kind, so adding the organization to the where clause finds nothing and
   * lands you in the silent-no-prices failure this adapter exists to avoid.
   */
  findPriceKindByCode(code: string): Promise<EntityRow | null>
  /** Live variants of one product — the left-hand side of per-product reconciliation. */
  findVariantsByProductId(productLocalId: string): Promise<EntityRow[]>
  /** Local ids this integration has mapped for an entity type. Ownership-gated by construction. */
  listOwnedLocalIds(entityType: string): Promise<string[]>
  /**
   * Dispatch a command the writer's `upsert` shape cannot express — currently only deletes.
   *
   * `di.ts` wires this to `commandBus.execute(commandId, { input, ctx: writer.commandContext })`,
   * so a delete carries the same organization scope and fires the same side effects as every other
   * write in the run. The command id still comes from `lib/constants.ts` on this side.
   */
  execute(commandId: string, input: Record<string, unknown>): Promise<void>
}

export type ProductsAdapterDeps = {
  createClient(credentials: Record<string, unknown>): ShopifyClient
  createRuntime(input: {
    scope: TenantScope
    integrationId: string
    credentials: Record<string, unknown>
  }): Promise<ProductsRuntime> | ProductsRuntime
  /** Bulk polling knobs, injected so tests do not sleep. */
  bulkOptions?: BulkExportOptions
}

// ── Tuning ───────────────────────────────────────────────────────────────────────────────────

/**
 * Page sizes for the delta path.
 *
 * A single query may cost at most 1000 points and a nested connection multiplies: 250 products
 * each carrying 250 variants is ~62,000 and is rejected outright. These values keep the worst case
 * near 800, which leaves headroom for the fields themselves. Raising either without doing that
 * arithmetic turns every delta run into a permanent `max_cost_exceeded`.
 */
export const DELTA_PRODUCT_PAGE_SIZE = 20
export const DELTA_VARIANT_PAGE_SIZE = 40

const PRODUCT_FIELDS = `
        id
        title
        descriptionHtml
        handle
        status
        productType
        vendor
        tags
        updatedAt
        priceRangeV2 { maxVariantPrice { amount currencyCode } }`

const VARIANT_FIELDS = `
            id
            title
            sku
            barcode
            price
            compareAtPrice
            updatedAt
            selectedOptions { name value }`

/**
 * Backfill document.
 *
 * Two connections and two levels of nesting, both inside the bulk limits (max 5 and max 2). No
 * pagination arguments: a bulk query describes the whole set and Shopify walks it.
 */
export const PRODUCTS_BULK_QUERY = `
  {
    products {
      edges {
        node {${PRODUCT_FIELDS}
          variants {
            edges {
              node {${VARIANT_FIELDS}
              }
            }
          }
        }
      }
    }
  }
`

/**
 * Delta document.
 *
 * `sortKey: UPDATED_AT` is not optional decoration — paired with an `updated_at` filter it is what
 * keeps a large collection from timing out instead of paginating.
 */
export const PRODUCTS_DELTA_QUERY = `#graphql
  query SyncShopifyProductsDelta($first: Int!, $after: String, $query: String, $variantFirst: Int!) {
    products(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {${PRODUCT_FIELDS}
          variants(first: $variantFirst) {
            pageInfo { hasNextPage }
            edges {
              node {${VARIANT_FIELDS}
              }
            }
          }
        }
      }
    }
  }
`

const SHOP_CURRENCY_QUERY = `#graphql
  query SyncShopifyShopCurrency {
    shop { currencyCode }
  }
`

export class ProductsSyncError extends Error {
  constructor(
    readonly code: 'missing_price_kind' | 'search_filter_ignored' | 'shop_currency_unavailable',
    message: string,
  ) {
    super(message)
    this.name = 'ProductsSyncError'
  }
}

// ── Source shapes ────────────────────────────────────────────────────────────────────────────

type ProductPage = {
  nodes: ShopifyProductNode[]
  /** Where to resume. Null once the source is exhausted, which is what promotes the watermark. */
  next: CursorPointer | null
}

type GraphQLConnection<T> = {
  pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null
  edges?: ({ node?: T | null } | null)[] | null
}

type DeltaResponse = {
  products?: GraphQLConnection<Record<string, unknown>> | null
}

function edgeNodes<T>(connection: GraphQLConnection<T> | null | undefined): T[] {
  const edges = connection?.edges ?? []
  return edges
    .map((edge) => edge?.node)
    .filter((node): node is T => node !== null && node !== undefined)
}

function asVariant(raw: Record<string, unknown>): ShopifyVariantNode {
  return raw as unknown as ShopifyVariantNode
}

/** One reassembled bulk record. Children arrive on their own JSONL lines, keyed by GID type. */
function fromBulkNode(node: BulkNode): ShopifyProductNode {
  return {
    ...(node.fields as unknown as Omit<ShopifyProductNode, 'id' | 'variants' | 'variantsComplete'>),
    id: node.id,
    variants: childrenOfType(node, 'ProductVariant').map((child) =>
      asVariant({ ...child.fields, id: child.id }),
    ),
    // A bulk export streams every child of every parent; there is no page to be cut off at.
    variantsComplete: true,
  }
}

function fromDeltaNode(raw: Record<string, unknown>): ShopifyProductNode {
  const variants = raw.variants as GraphQLConnection<Record<string, unknown>> | null | undefined
  return {
    ...(raw as unknown as Omit<ShopifyProductNode, 'variants' | 'variantsComplete'>),
    variants: edgeNodes(variants).map(asVariant),
    variantsComplete: variants?.pageInfo?.hasNextPage !== true,
  }
}

// ── Adapter ──────────────────────────────────────────────────────────────────────────────────

export function createShopifyProductsAdapter(deps: ProductsAdapterDeps): DataSyncAdapter {
  const integrationId = INTEGRATION_ID.products

  /**
   * Resolve both price kinds before anything is written.
   *
   * Doing this up front rather than per-variant is the whole point: a missing kind is a
   * configuration fault affecting every price in the run, and discovering it 900 products in — the
   * way a per-item lookup would — buys nothing but a longer wait for the same failure.
   */
  async function resolvePriceKinds(
    runtime: ProductsRuntime,
  ): Promise<Record<PriceKindCode, string>> {
    const resolved = {} as Record<PriceKindCode, string>
    for (const code of Object.values(PRICE_KIND_CODE)) {
      const row = await runtime.findPriceKindByCode(code)
      if (!row?.id) {
        throw new ProductsSyncError(
          'missing_price_kind',
          `CatalogPriceKind '${code}' does not exist for this tenant. Seed it before syncing — ` +
            'without it every price in this run would be skipped and the run would still report success.',
        )
      }
      resolved[code] = row.id
    }
    return resolved
  }

  async function resolveShopCurrency(client: ShopifyClient): Promise<string> {
    const data = await client.request<{ shop?: { currencyCode?: string | null } | null }>(
      SHOP_CURRENCY_QUERY,
      { estimatedCost: 1 },
    )
    const code = data?.shop?.currencyCode?.trim().toUpperCase()
    if (!code || !/^[A-Z]{3}$/.test(code)) {
      // Guessing a currency writes prices that look right and reconcile against nothing.
      throw new ProductsSyncError(
        'shop_currency_unavailable',
        '[internal] shop { currencyCode } returned no usable currency; refusing to guess one for prices',
      )
    }
    return code
  }

  type RunContext = {
    scope: TenantScope
    runtime: ProductsRuntime
    priceKinds: Record<PriceKindCode, string>
    currencyCode: string
  }

  // ── Writes ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Remove price rows that should no longer exist — in practice, the `sale` row after a sale ends.
   *
   * 🔴 This is a commercial bug, not housekeeping. `selectBestPrice` scores a promotional kind
   * above a regular one, so a `sale` row left behind keeps winning and the customer keeps paying
   * the sale price indefinitely. Nothing surfaces it: the run reports success and the regular
   * price is updated correctly, it simply never gets used.
   *
   * No query is needed. The price kinds are a closed set and the external id is deterministic, so
   * every row this adapter could have written for a variant is enumerable — and a mapping hit is
   * itself the §4.8 ownership proof, because the mapping table is partitioned by integration. A
   * price row a human added by hand has no mapping and is therefore invisible here.
   *
   * Prices are DELETED rather than deactivated, per §4.8: only products, variants and categories
   * are deactivated.
   */
  async function reconcilePrices(
    variant: ShopifyVariantNode,
    desired: PriceIntent[],
    currencyCode: string,
    ctx: RunContext,
  ): Promise<ImportItem[]> {
    // Nothing derived means Shopify reported no usable price — which is also what a value we
    // failed to parse looks like. Deleting on that evidence would turn a mapping bug of ours into
    // silent data loss, so an empty desired set means "no opinion", not "remove everything".
    if (desired.length === 0) return []

    const keep = new Set(desired.map((intent) => intent.externalId))
    const items: ImportItem[] = []

    for (const kindCode of Object.values(PRICE_KIND_CODE)) {
      const externalId = priceExternalId(variant.id, kindCode, currencyCode)
      if (keep.has(externalId)) continue

      try {
        const localId = await ctx.runtime.mapping.lookupLocalId(
          integrationId,
          MAPPING_ENTITY_TYPE.productPrice,
          externalId,
          ctx.scope,
        )
        // Never written, or already cleaned up by an earlier run.
        if (!localId) continue

        // The mapping can outlive the row. Deleting one that is already gone would fail the item
        // for no reason, but dropping the stale mapping is still worth doing.
        const row = await ctx.runtime.readPrice(localId)
        if (row) {
          await ctx.runtime.execute(COMMAND.priceDelete, {
            id: localId,
            organizationId: ctx.scope.organizationId,
            tenantId: ctx.scope.tenantId,
          })
        }
        await ctx.runtime.mapping.deleteExternalIdMapping(
          integrationId,
          MAPPING_ENTITY_TYPE.productPrice,
          localId,
          ctx.scope,
        )

        items.push({
          externalId,
          action: row ? 'update' : 'skip',
          data: { localId, kind: kindCode, reason: 'price_kind_no_longer_offered' },
        })
      } catch (error) {
        // Per-item, like every other write: a failed cleanup must not abort the run.
        items.push({
          externalId,
          action: 'failed',
          data: {
            sourceIdentifier: externalId,
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        })
      }
    }

    return items
  }

  async function importPrices(
    variant: ShopifyVariantNode,
    variantLocalId: string,
    node: ShopifyProductNode,
    ctx: RunContext,
  ): Promise<ImportItem[]> {
    const currencyCode = resolveCurrencyCode(node, ctx.currencyCode)
    const intents = toPriceIntents(variant, currencyCode)
    const items: ImportItem[] = []

    for (const intent of intents) {
      const input = mapPrice(intent, variantLocalId, ctx.priceKinds[intent.kindCode], ctx.scope)
      const outcome = await ctx.runtime.writer.upsert({
        externalId: intent.externalId,
        mappingEntityType: MAPPING_ENTITY_TYPE.productPrice,
        createCommand: COMMAND.priceCreate,
        updateCommand: COMMAND.priceUpdate,
        resultKey: COMMAND_RESULT_KEY.price,
        readById: ctx.runtime.readPrice,
        buildCreateInput: () => input,
        // Prices have no natural key of their own, so the stored amount is the comparison. It is
        // compared as text: `'19.90' !== 19.9` is precisely the distinction worth keeping.
        buildUpdateInput: ({ row }) =>
          String(row.unitPriceGross ?? '') === intent.amount ? null : input,
      })
      items.push(toImportItem(outcome, { kind: intent.kindCode, amount: intent.amount }))
    }

    items.push(...(await reconcilePrices(variant, intents, currencyCode, ctx)))
    return items
  }

  async function importVariant(
    variant: ShopifyVariantNode,
    productLocalId: string,
    node: ShopifyProductNode,
    ctx: RunContext,
  ): Promise<{ items: ImportItem[]; localId: string | null }> {
    const mapped = mapVariant(variant, productLocalId, ctx.scope)

    const outcome = await ctx.runtime.writer.upsert({
      externalId: variant.id,
      mappingEntityType: MAPPING_ENTITY_TYPE.productVariant,
      createCommand: COMMAND.variantCreate,
      updateCommand: COMMAND.variantUpdate,
      resultKey: COMMAND_RESULT_KEY.variant,
      readById: ctx.runtime.readVariant,
      findByNaturalKey: mapped.sku === null ? undefined : () => ctx.runtime.findVariantBySku(mapped.sku!),
      buildCreateInput: () => mapped.input,
      buildUpdateInput: ({ row }) =>
        readContentHash(row) === mapped.contentHash ? null : mapped.input,
    })

    const items = [toImportItem(outcome, { productLocalId })]
    if (!outcome.ok) return { items, localId: null }

    items.push(...(await importPrices(variant, outcome.localId, node, ctx)))
    return { items, localId: outcome.localId }
  }

  /**
   * Deactivate variants this integration owns that Shopify no longer reports for this product.
   *
   * Scoped to one product by construction — `findVariantsByProductId` cannot see a sibling — which
   * is what makes it safe to run on every product of every run, delta included.
   */
  async function reconcileVariants(
    productLocalId: string,
    seenLocalIds: Set<string>,
    ctx: RunContext,
  ): Promise<ImportItem[]> {
    const live = await ctx.runtime.findVariantsByProductId(productLocalId)
    const items: ImportItem[] = []

    for (const row of live) {
      if (seenLocalIds.has(row.id)) continue

      const externalId = await ctx.runtime.mapping.lookupExternalId(
        integrationId,
        MAPPING_ENTITY_TYPE.productVariant,
        row.id,
        ctx.scope,
      )
      // No mapping means an operator or another integration created this variant. Not ours to touch.
      if (!externalId) continue

      const outcome = await ctx.runtime.writer.upsert({
        externalId,
        mappingEntityType: MAPPING_ENTITY_TYPE.productVariant,
        createCommand: COMMAND.variantCreate,
        updateCommand: COMMAND.variantUpdate,
        resultKey: COMMAND_RESULT_KEY.variant,
        readById: ctx.runtime.readVariant,
        buildCreateInput: () => {
          // Only reachable if the row vanished between the read above and this call. Recreating a
          // variant Shopify has deleted would undo the very thing being reconciled.
          throw new Error(`refusing to recreate variant ${externalId} during reconciliation`)
        },
        // Already inactive: report a skip rather than rewriting it on every run.
        buildUpdateInput: ({ row: current }) =>
          current.isActive === false
            ? null
            : {
                organizationId: ctx.scope.organizationId,
                tenantId: ctx.scope.tenantId,
                isActive: false,
              },
      })

      items.push(toImportItem(outcome, { reason: 'absent_from_shopify_payload', productLocalId }))
    }

    return items
  }

  async function importProduct(
    node: ShopifyProductNode,
    ctx: RunContext,
    seenProductLocalIds: Set<string>,
  ): Promise<ImportItem[]> {
    let mapped: ReturnType<typeof mapProduct>
    try {
      mapped = mapProduct(node, ctx.scope)
    } catch (error) {
      // A payload we cannot map is one item's problem. `sourceIdentifier` + `errorMessage` is the
      // exact shape `logImportItemFailures` reads.
      const message = error instanceof ProductMappingError ? error.message : String(error)
      return [
        {
          externalId: node.id,
          action: 'failed',
          data: { sourceIdentifier: node.id, errorMessage: message },
        },
      ]
    }

    const outcome = await ctx.runtime.writer.upsert({
      externalId: node.id,
      mappingEntityType: MAPPING_ENTITY_TYPE.product,
      createCommand: COMMAND.productCreate,
      updateCommand: COMMAND.productUpdate,
      resultKey: COMMAND_RESULT_KEY.product,
      readById: ctx.runtime.readProduct,
      findByNaturalKey:
        mapped.handle === null ? undefined : () => ctx.runtime.findProductByHandle(mapped.handle!),
      buildCreateInput: () => mapped.input,
      buildUpdateInput: ({ row }) =>
        readContentHash(row) === mapped.contentHash ? null : mapped.input,
    })

    const items = [toImportItem(outcome, { variantCount: node.variants.length })]
    // Without a product id there is nothing to hang a variant off; reporting the failure and
    // moving on keeps the rest of the batch alive.
    if (!outcome.ok) return items

    seenProductLocalIds.add(outcome.localId)

    const seenVariantLocalIds = new Set<string>()
    for (const variant of node.variants) {
      const result = await importVariant(variant, outcome.localId, node, ctx)
      items.push(...result.items)
      if (result.localId !== null) seenVariantLocalIds.add(result.localId)
    }

    if (node.variantsComplete) {
      items.push(...(await reconcileVariants(outcome.localId, seenVariantLocalIds, ctx)))
    }

    return items
  }

  /**
   * Deactivate products this integration owns that a FULL run never saw.
   *
   * Only ever called behind the `!input.cursor` guard. Products are deactivated rather than
   * deleted, per §4.8 — only prices and offers are removed outright.
   */
  async function reconcileProducts(
    seenProductLocalIds: Set<string>,
    ctx: RunContext,
  ): Promise<ImportItem[]> {
    const owned = await ctx.runtime.listOwnedLocalIds(MAPPING_ENTITY_TYPE.product)
    const items: ImportItem[] = []

    for (const localId of owned) {
      if (seenProductLocalIds.has(localId)) continue

      const externalId = await ctx.runtime.mapping.lookupExternalId(
        integrationId,
        MAPPING_ENTITY_TYPE.product,
        localId,
        ctx.scope,
      )
      if (!externalId) continue

      const outcome = await ctx.runtime.writer.upsert({
        externalId,
        mappingEntityType: MAPPING_ENTITY_TYPE.product,
        createCommand: COMMAND.productCreate,
        updateCommand: COMMAND.productUpdate,
        resultKey: COMMAND_RESULT_KEY.product,
        readById: ctx.runtime.readProduct,
        buildCreateInput: () => {
          throw new Error(`refusing to recreate product ${externalId} during reconciliation`)
        },
        buildUpdateInput: ({ row }) =>
          row.isActive === false
            ? null
            : {
                organizationId: ctx.scope.organizationId,
                tenantId: ctx.scope.tenantId,
                isActive: false,
              },
      })

      items.push(toImportItem(outcome, { reason: 'absent_from_shopify_full_sync' }))
    }

    return items
  }

  // ── Sources ────────────────────────────────────────────────────────────────────────────────

  async function* bulkPages(client: ShopifyClient, batchSize: number): AsyncIterable<ProductPage> {
    const result = await runBulkExport(client, PRODUCTS_BULK_QUERY, deps.bulkOptions ?? {})
    const pointer: CursorPointer = { kind: 'bulk', bulkOperationId: result.operation.id }

    if (!result.nodes) {
      // A COMPLETED operation that matched nothing has no result URL at all. One empty page still
      // has to be yielded so the run promotes its watermark instead of restarting next time.
      yield { nodes: [], next: null }
      return
    }

    let buffer: ShopifyProductNode[] = []
    for await (const node of result.nodes) {
      // Variants arrive as children of their parent line, never as top-level records.
      if (node.type !== 'Product') continue
      buffer.push(fromBulkNode(node))
      if (buffer.length >= batchSize) {
        yield { nodes: buffer, next: pointer }
        buffer = []
      }
    }
    yield { nodes: buffer, next: null }
  }

  /**
   * Prove Shopify honoured the `updated_at` filter.
   *
   * A typo in a search field is not an error — *"if you specify an invalid field, then the query is
   * ignored and all results are returned"*. That turns a delta into a silent full scan that still
   * reports success, and the only visible symptom is records older than the window we asked for.
   * The client consumes `extensions` internally, so the returned data is the evidence available.
   */
  /**
   * Shopify's own account of whether it understood the search query.
   *
   * The first of two independent R-13 defences, and the more direct one: it catches the fault on
   * the request itself rather than inferring it from the rows that came back. It only works
   * because the request sends `SEARCH_DEBUG_HEADER` — Shopify populates `extensions.search`
   * solely when asked, so dropping that header makes this silently pass forever.
   *
   * `assertDeltaWindowRespected` below is kept as the second belt precisely because this one has
   * that dependency: it needs no header, no cooperation from Shopify, and would still catch a
   * filter that was honoured in form but not in effect.
   */
  function assertSearchWarningsEmpty(extensions: Record<string, unknown> | undefined): void {
    const search = extensions?.search
    if (!Array.isArray(search)) return

    const warnings = search.flatMap((entry) => {
      const list = (entry as { warnings?: unknown } | null)?.warnings
      return Array.isArray(list) ? list : []
    })
    if (warnings.length === 0) return

    throw new ProductsSyncError(
      'search_filter_ignored',
      `[internal] Shopify reported search warnings for the delta query: ${JSON.stringify(warnings)}; ` +
        'an unrecognised field is ignored rather than rejected, so this run would rescan everything',
    )
  }

  function assertDeltaWindowRespected(nodes: ShopifyProductNode[], updatedAfter: string): void {
    const floor = Date.parse(updatedAfter)
    for (const node of nodes) {
      const seen = normalizeTimestamp(node.updatedAt)
      if (seen !== null && Date.parse(seen) < floor) {
        throw new ProductsSyncError(
          'search_filter_ignored',
          `[internal] delta query asked for updated_at > ${updatedAfter} but Shopify returned ` +
            `${node.id} updated at ${seen}; the search filter was ignored and this run would ` +
            'silently rescan the whole catalog',
        )
      }
    }
  }

  async function* deltaPages(
    client: ShopifyClient,
    options: { updatedAfter: string; after: string | null },
  ): AsyncIterable<ProductPage> {
    let after = options.after

    for (;;) {
      const { data, extensions } = await client.requestDetailed<DeltaResponse>(PRODUCTS_DELTA_QUERY, {
        variables: {
          first: DELTA_PRODUCT_PAGE_SIZE,
          after,
          query: `updated_at:>'${options.updatedAfter}'`,
          variantFirst: DELTA_VARIANT_PAGE_SIZE,
        },
        estimatedCost: DELTA_PRODUCT_PAGE_SIZE * (1 + DELTA_VARIANT_PAGE_SIZE),
        // Without this header Shopify never populates `extensions.search`, and the warning check
        // below is wired but permanently silent.
        headers: SEARCH_DEBUG_HEADER,
      })

      const connection = data?.products
      const nodes = edgeNodes(connection).map(fromDeltaNode)
      assertSearchWarningsEmpty(extensions)
      assertDeltaWindowRespected(nodes, options.updatedAfter)

      const endCursor = connection?.pageInfo?.endCursor ?? null
      const hasNextPage = connection?.pageInfo?.hasNextPage === true && endCursor !== null

      yield { nodes, next: hasNextPage ? { kind: 'paging', endCursor: endCursor! } : null }
      if (!hasNextPage) return
      after = endCursor
    }
  }

  /**
   * Backfill or delta, decided by the cursor alone.
   *
   * A `bulk` or `paging` cursor is a run that died mid-flight and resumes where it stopped; an
   * `idle` cursor carrying a watermark is a normal incremental run; anything else — including a
   * cursor too malformed to trust — starts over with a full export.
   */
  function chooseSource(
    client: ShopifyClient,
    state: ShopifyCursorState | null,
    batchSize: number,
  ): AsyncIterable<ProductPage> {
    if (state?.kind === 'paging' && state.updatedAfter) {
      return deltaPages(client, { updatedAfter: state.updatedAfter, after: state.endCursor })
    }
    if (state?.kind === 'idle' && state.updatedAfter) {
      return deltaPages(client, { updatedAfter: state.updatedAfter, after: null })
    }
    return bulkPages(client, batchSize)
  }

  function latestUpdatedAt(nodes: ShopifyProductNode[]): string | null {
    let max: string | null = null
    for (const node of nodes) {
      const seen = normalizeTimestamp(node.updatedAt)
      if (seen !== null && (max === null || Date.parse(seen) > Date.parse(max))) max = seen
    }
    return max
  }

  return {
    providerKey: PROVIDER_KEY.products,
    direction: 'import',
    supportedEntities: [ENTITY_TYPE.product],

    async getMapping(): Promise<DataMapping> {
      return {
        entityType: ENTITY_TYPE.product,
        matchStrategy: 'externalId',
        fields: [
          { externalField: 'id', localField: 'externalId', mappingKind: 'external_id', required: true, dedupeRole: 'primary' },
          { externalField: 'title', localField: 'title', mappingKind: 'core', required: true },
          { externalField: 'descriptionHtml', localField: 'description', mappingKind: 'core' },
          { externalField: 'handle', localField: 'handle', mappingKind: 'core', dedupeRole: 'secondary' },
          { externalField: 'status', localField: 'isActive', mappingKind: 'core', transform: 'ACTIVE→true; DRAFT/ARCHIVED→false' },
          { externalField: 'tags', localField: 'tags', mappingKind: 'relation' },
          { externalField: 'vendor', localField: 'metadata.shopify.vendor', mappingKind: 'metadata' },
          { externalField: 'productType', localField: 'metadata.shopify.productType', mappingKind: 'metadata' },
          { externalField: 'variants.sku', localField: 'variant.sku', mappingKind: 'core' },
          { externalField: 'variants.barcode', localField: 'variant.barcode', mappingKind: 'core' },
          { externalField: 'variants.selectedOptions', localField: 'variant.optionValues', mappingKind: 'core' },
          { externalField: 'variants.price', localField: 'price.unitPriceGross', mappingKind: 'relation' },
          { externalField: 'variants.compareAtPrice', localField: 'price.unitPriceGross', mappingKind: 'relation', transform: 'list price when on sale' },
          { externalField: 'media', localField: '', mappingKind: 'ignore' },
          { externalField: 'metafields', localField: '', mappingKind: 'ignore' },
        ],
      }
    },

    async *streamImport(input: StreamImportInput): AsyncIterable<ImportBatch> {
      // Read once, from the raw input. Deriving this from the parsed state would let a malformed
      // cursor — which parses to null — masquerade as a full run and reconcile a delta's worth of
      // records against the whole catalog.
      const fullSync = !input.cursor

      const client = deps.createClient(input.credentials)
      const runtime = await deps.createRuntime({
        scope: input.scope,
        integrationId,
        credentials: input.credentials,
      })

      const ctx: RunContext = {
        scope: input.scope,
        runtime,
        priceKinds: await resolvePriceKinds(runtime),
        currencyCode: await resolveShopCurrency(client),
      }

      // `null` from `parseCursor` means "no cursor, or one too malformed to trust". An idle state
      // with no watermark says exactly the same thing to `chooseSource` and `advanceCursor`, and
      // saves the final batch having to re-derive a cursor from nothing.
      let state: ShopifyCursorState = parseCursor(input.cursor) ?? { kind: 'idle', updatedAfter: null }
      let batchIndex = 0
      const seenProductLocalIds = new Set<string>()
      const batchSize = input.batchSize > 0 ? input.batchSize : DELTA_PRODUCT_PAGE_SIZE

      for await (const page of chooseSource(client, state, batchSize)) {
        const items: ImportItem[] = []
        for (const node of page.nodes) {
          items.push(...(await importProduct(node, ctx, seenProductLocalIds)))
        }

        state = advanceCursor(state, {
          next: page.next,
          maxUpdatedAt: latestUpdatedAt(page.nodes),
        })

        yield {
          items,
          cursor: serializeCursor(state),
          // A reconcile pass still to come is "more", even when the pages have run out.
          hasMore: page.next !== null || fullSync,
          batchIndex: batchIndex++,
          processedCount: page.nodes.length,
        }
      }

      if (!fullSync) return

      // 🔴 Everything below is reachable ONLY on a full run. A delta sees just the changed
      // records, so reconciling one would deactivate the entire catalog.
      yield {
        items: await reconcileProducts(seenProductLocalIds, ctx),
        cursor: serializeCursor(state),
        hasMore: false,
        batchIndex: batchIndex++,
        message: 'Reconciling Shopify products after the final batch',
      }
    },
  }
}
