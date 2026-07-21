import type {
  DataMapping,
  DataSyncAdapter,
  ImportBatch,
  ImportItem,
  StreamImportInput,
  TenantScope,
  ValidationResult,
} from '@open-mercato/core/modules/data_sync/lib/adapter'
import { SEARCH_DEBUG_HEADER, type ShopifyClient } from '../client'
import type { BulkAnomaly, BulkExportOptions, BulkNode, BulkOperation } from '../bulk'
import {
  bulkResultUrl,
  childrenOfType,
  fetchJsonlLines,
  pollBulkOperation,
  reassembleBulkStream,
  submitBulkQuery,
} from '../bulk'
import { advanceCursor, parseCursor, serializeCursor, type ShopifyCursorState } from '../cursor'
import {
  COMMAND,
  COMMAND_RESULT_KEY,
  ENTITY_TYPE,
  INTEGRATION_ID,
  MAPPING_ENTITY_TYPE,
  OM_ENTITY_ID,
  PROVIDER_KEY,
} from '../constants'
import { toImportItem, type CommandBusPort, type EntityWriter, type ExternalIdMappingPort } from '../writer'
import { mapCollection, mapCollectionProductIds, type MappedCollection } from '../mappers/collection'
import { heartbeatBatch, heartbeatWhile, type HeartbeatClock } from '../heartbeat'

/**
 * Shopify Collections → `catalog_product_categories` + `catalog_product_category_assignments`.
 *
 * Import-only. A collection becomes a category; the collection's products become category
 * assignments. Shopify's membership is many-to-many and so is Open Mercato's, which is the one
 * place in this connector where the two models line up without a compromise.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE FOUR THINGS THAT MAKE THIS FILE LONGER THAN IT LOOKS LIKE IT SHOULD BE
 *
 * 1. THERE IS NO ASSIGNMENT COMMAND. Membership is writable only from the product side, via
 *    `catalog.products.update { id, categoryIds }` — and that command REPLACES a product's entire
 *    category set (`syncCategoryAssignments` removes every assignment absent from the array). So
 *    writing "product P joins category C" as `{ id: P, categoryIds: [C] }` silently deletes P's
 *    membership of every OTHER collection. Every membership write here is therefore
 *    read-merge-write against P's current set. This is the single most dangerous thing in the file.
 *
 * 2. MEMBERSHIP IS RECONCILED ONLY ON A FULL RUN. A delta run legitimately sees only the
 *    collections that changed, so removing "assignments we did not see" would strip the catalog.
 *    Guarded on `!input.cursor`, exactly as the first-party pattern does it. A delta run is
 *    additive; removals land at the next full sync. Two narrower guards sit underneath it — see
 *    `syncMembership`.
 *
 * 3. PRODUCTS MAY NOT EXIST LOCALLY YET. The collections and products syncs are independent
 *    integrations on independent schedules, so a collection routinely references products this
 *    install has never imported. Those are RECORDED and SKIPPED. Fabricating a placeholder product
 *    to hang an assignment off would put a row in the catalog that no upstream record backs and
 *    that the products sync would then fight over.
 *
 * 4. PER-ITEM FAILURES ARE RETURNED, NOT THROWN. A throw escapes the generator and the engine
 *    finalises the whole run as failed, losing every collection that would have succeeded.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * API VERSION: this is the most version-fragile surface in the connector. Collections using the
 * 2026-07 multi-source model are SILENTLY FILTERED OUT of pre-2026-07 query results — an older pin
 * loses whole collections and reports success. Never "play safe" by pinning back. We read
 * `sources` and never the deprecated `ruleSet`; `collectionAddProducts`/`collectionRemoveProducts`
 * are deprecated and, being import-only, we call neither and model nothing on them.
 *
 * NOT A NETWORK-FREE MODULE, but a framework-free one: every framework collaborator arrives as an
 * injected port (`CollectionsRunContext`), so `di.ts` owns the container and these tests stub
 * plain objects. Pure mapping lives in `mappers/collection.ts`.
 */

// ── Paging sizes ─────────────────────────────────────────────────────────────────────────────

/**
 * Collections per delta page, and members fetched inline with each.
 *
 * These multiply. Shopify prices a nested connection at roughly `first × (1 + inner first)`, so
 * 10 × (1 + 80) ≈ 810 points — under the hard 1,000-point per-query ceiling with room for the
 * scalar fields. Raising either number is how you get `max_cost_exceeded`, which is permanent:
 * the query has to shrink, and retrying never helps.
 */
const COLLECTION_PAGE_SIZE = 10
const INLINE_MEMBER_PAGE_SIZE = 80

/**
 * Members per page when following up on a collection too large to read inline. One collection at a
 * time costs `1 × (1 + 250)`, so the maximum page size is affordable here and nowhere else.
 */
const MEMBER_PAGE_SIZE = 250

/**
 * Ceiling on member pages for one collection: 250 × 400 = 100,000 products.
 *
 * Not a real limit — it is a stop against a `pageInfo.hasNextPage` that never goes false, which
 * would otherwise spin forever inside a single item and hang the run with no error to read.
 */
const MAX_MEMBER_PAGES = 400

/** Anomalous JSONL lines retained for reporting. The count is always exact; the samples are not. */
const MAX_REPORTED_ANOMALIES = 10

// ── GraphQL ──────────────────────────────────────────────────────────────────────────────────

/**
 * Scalar fields, shared by the bulk and delta queries so the two paths cannot drift into mapping
 * different things.
 *
 * `descriptionHtml`, not `body`/`bodyHtml` — those are long deprecated. All five are current in
 * 2026-07 (`title: String!`, `handle: String!`, `descriptionHtml: HTML!`, `updatedAt: DateTime!`).
 *
 * `sortOrder`, `seo`, `image`, `productsCount` and `templateSuffix` are all available and all
 * deliberately UNREQUESTED: `categoryCreateSchema` accepts nothing beyond
 * name/slug/description/parentId/isActive, so there is nowhere to put them. `getMapping` declares
 * the notable ones as `ignore` rather than omitting them, because "we looked and chose not to" is a
 * different statement from "we never looked".
 */
const COLLECTION_SCALAR_FIELDS = `
    id
    title
    handle
    descriptionHtml
    updatedAt
`

/**
 * How we ask whether Shopify computes this collection's membership.
 *
 * Verified against the 2026-07 schema: `sources: [CollectionSource!]!` — a plain non-null LIST (not
 * a connection, so it adds nothing to the bulk query's connection budget and inlines straight into
 * the parent JSONL record) of an INTERFACE with two implementations, `CollectionConditionsSource`
 * and `CollectionSubCollectionsSource`. `__typename` needs no inline fragment on an interface,
 * which is why it can be selected on its own.
 *
 * And on its own is deliberately all we select, for two reasons beyond economy:
 *
 *  - The definitions cannot be honoured (see the note in `mappers/collection.ts`), so richer
 *    selections buy nothing but expose more field names to a quarterly rename — and an unknown
 *    field is a hard GraphQL error that fails the whole sync.
 *  - Reading the interesting parts (`inclusion`, `exclusion`, `collections`) requires INLINE
 *    FRAGMENTS on an interface, and nothing in Shopify's docs confirms the bulk-operation validator
 *    accepts those. The documented "must implement Node" rule covers connections, and `sources` is
 *    not one, so the case is simply unaddressed either way. `__typename` alone sidesteps the
 *    question entirely. Anyone tempted to expand this should first validate it with a throwaway
 *    `bulkOperationRunQuery` against a dev store — `userErrors` comes back synchronously, so the
 *    check is cheap.
 *
 * Isolated in one constant because R-3 asks for collection reads to sit behind a single seam. If a
 * future release rejects this selection, blanking this constant costs only the "definitions are not
 * preserved" diagnostic; nothing else in the adapter reads it.
 */
const COLLECTION_SOURCE_FIELDS = `
    sources { __typename }
`

const COLLECTION_FIELDS = `${COLLECTION_SCALAR_FIELDS}${COLLECTION_SOURCE_FIELDS}`

/**
 * Backfill query, submitted to the Bulk Operations API.
 *
 * Two connections (`collections`, `products`) at two levels of nesting — the limits are 5 and 2, so
 * this sits exactly at the nesting ceiling and has no room for a third level. Members arrive as
 * separate JSONL lines carrying `__parentId`, which `reassembleBulkStream` folds back into the
 * parent in a single pass; there is no member paging in this path because the export is complete
 * by construction.
 */
export function buildCollectionsBulkQuery(): string {
  return `
  {
    collections {
      edges {
        node {${COLLECTION_FIELDS}          products {
            edges { node { id } }
          }
        }
      }
    }
  }
`
}

/**
 * Delta page query.
 *
 * `sortKey: UPDATED_AT` is not optional decoration: paired with an `updated_at:>` filter it is what
 * lets Shopify walk the index. Without the matching sort key large collections time out rather
 * than paginate. (Verified present on `CollectionSortKeys` in 2026-07, alongside ID, RELEVANCE and
 * TITLE — it is the only one of the four that makes an incremental window possible.)
 */
export function buildCollectionsDeltaQuery(): string {
  return `#graphql
  query SyncShopifyCollectionsPage($first: Int!, $after: String, $query: String, $members: Int!) {
    collections(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      edges {
        node {${COLLECTION_FIELDS}          products(first: $members) {
            pageInfo { hasNextPage endCursor }
            edges { node { id } }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`
}

/** Follow-up query for a collection whose membership did not fit in one inline page. */
export function buildCollectionMembersQuery(): string {
  return `#graphql
  query SyncShopifyCollectionMembers($id: ID!, $first: Int!, $after: String) {
    collection(id: $id) {
      products(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        edges { node { id } }
      }
    }
  }
`
}

/**
 * Build the `query:` argument for a delta page.
 *
 * 🔴 A TYPO HERE IS INVISIBLE. Shopify's documented behaviour: *"If you specify an invalid field,
 * then the query is ignored and all results are returned."* So `updated_at` misspelled as
 * `updatedAt` does not error — it silently turns every delta run into a full scan that still
 * reports success and still writes correct data, just at catastrophic cost. The filter is built by
 * this one exported function so a unit test can assert its exact text; there is no other way to
 * catch it short of watching a bill.
 *
 * Returns null when there is no watermark yet, which the caller reads as "no filter" rather than
 * emitting an empty `query:` string.
 */
export function buildUpdatedAtFilter(updatedAfter: string | null): string | null {
  if (!updatedAfter) return null
  return `updated_at:>'${updatedAfter}'`
}

/**
 * Pull Shopify's search warnings out of a response's `extensions` envelope.
 *
 * This is the other half of the defence against R-13. When Shopify ignores a filter it says so in
 * `extensions.search[].warnings` — never as an error — so a warning here means the delta window was
 * discarded and this "incremental" run is really a full scan. That matters beyond the cost: a full
 * scan down the PAGING path saturates at 25,001 objects and truncates without complaint.
 *
 * Shopify only populates `extensions.search` when the request carries `Shopify-Search-Query-Debug`,
 * which the delta request now sends via `SEARCH_DEBUG_HEADER`. This is therefore a live check, not
 * one that passes vacuously. Written defensively enough to survive whatever shape the envelope
 * turns out to have.
 */
export function readSearchWarnings(extensions: Record<string, unknown> | undefined): string[] {
  const search = extensions?.search
  if (!Array.isArray(search)) return []

  const warnings: string[] = []
  for (const entry of search) {
    const raw = (entry as Record<string, unknown> | null)?.warnings
    if (!Array.isArray(raw)) continue
    for (const warning of raw) {
      if (typeof warning === 'string') {
        warnings.push(warning)
        continue
      }
      const record = warning as Record<string, unknown> | null
      const message = typeof record?.message === 'string' ? record.message : null
      const field = typeof record?.field === 'string' ? record.field : null
      if (message || field) warnings.push([field, message].filter(Boolean).join(': '))
    }
  }
  return warnings
}

// ── Injected ports ───────────────────────────────────────────────────────────────────────────

/**
 * Reads over `catalog_product_category_assignments`.
 *
 * Both directions are needed and neither is optional: `productIdsForCategory` computes what to add
 * and remove for a collection, and `categoryIdsForProduct` is what makes the replace-semantics of
 * `catalog.products.update` survivable (see note 1 at the top of this file).
 *
 * Implementations MUST scope every read by `organizationId` + `tenantId`, and must resolve through
 * `findWithDecryption` rather than a bare `em.find`.
 */
export type CategoryAssignmentPort = {
  /** Local product ids currently assigned to one category. */
  productIdsForCategory(categoryLocalId: string, scope: TenantScope): Promise<string[]>
  /** Local category ids one product currently belongs to. */
  categoryIdsForProduct(productLocalId: string, scope: TenantScope): Promise<string[]>
}

/** Per-run collaborators, resolved from a request container by `di.ts`. */
export type CollectionsRunContext = {
  writer: EntityWriter
  externalIdMapping: ExternalIdMappingPort
  commandBus: CommandBusPort
  assignments: CategoryAssignmentPort
  /**
   * The `CatalogProductCategory` entity class, handed to the writer's scoped reads.
   *
   * Passed as an opaque value rather than imported so this module keeps zero runtime framework
   * imports — importing the entity would drag MikroORM's ESM into every test in the suite.
   */
  categoryEntity: unknown
}

export type CollectionsAdapterDeps = {
  /** Build a Shopify client from the run's credentials. */
  createClient: (credentials: Record<string, unknown>) => ShopifyClient
  createRunContext: (input: { scope: TenantScope }) => Promise<CollectionsRunContext>
  /** Test seam for bulk polling/downloading. Defaults to the real HTTP path. */
  bulkOptions?: BulkExportOptions
  /**
   * Beat cadence for the bulk-poll liveness heartbeat. Defaults to `DEFAULT_HEARTBEAT_INTERVAL_MS`.
   * Production omits it; tests set it small. (There is no reconcile sweep here — removals are
   * interleaved per collection inside `syncMembership` — so no `now`/reconcile clock is needed.)
   */
  heartbeatIntervalMs?: number
  /** Injectable timer for the bulk-poll heartbeat; defaults to real `setTimeout`. Tests only. */
  heartbeatClock?: HeartbeatClock
}

// ── Internal shapes ──────────────────────────────────────────────────────────────────────────

type ParsedCollection = {
  mapped: MappedCollection
  /** Member product GIDs, deduplicated, in the order Shopify returned them. */
  productExternalIds: string[]
  /**
   * Whether the member list above is the WHOLE list.
   *
   * False when member paging was cut short, or when the rows came from a partial bulk export. A
   * truncated list is fine to add from and fatal to remove from, which is why this is checked
   * separately from the full-vs-delta guard: a full run can still hold an incomplete picture.
   */
  membershipComplete: boolean
}

type MembershipOutcome = {
  added: number
  removed: number
  /** Member GIDs with no local product. Expected before the products sync has run. */
  unmappedProductExternalIds: string[]
  /** Per-product write failures, already stringified. */
  errors: string[]
  /** Whether removals were computed at all — false means every gate below was not fully open. */
  reconciled: boolean
}

// ── Adapter ──────────────────────────────────────────────────────────────────────────────────

export function createShopifyCollectionsAdapter(deps: CollectionsAdapterDeps): DataSyncAdapter {
  /**
   * Resolve one Shopify product GID to a local product id.
   *
   * Note the integration id: products are mapped under `sync_shopify_products`, NOT under this
   * adapter's own `sync_shopify_collections`. The mapping table is partitioned by integration, so
   * looking these up under our own id would return null for every product forever — a silent,
   * total failure that presents as "the products sync has not run yet".
   */
  async function resolveProductLocalId(
    run: CollectionsRunContext,
    productExternalId: string,
    scope: TenantScope,
  ): Promise<string | null> {
    return run.externalIdMapping.lookupLocalId(
      INTEGRATION_ID.products,
      MAPPING_ENTITY_TYPE.product,
      productExternalId,
      scope,
    )
  }

  /**
   * Move one product into or out of one category.
   *
   * The read-merge-write is mandatory, not defensive. `catalog.products.update` hands `categoryIds`
   * straight to `syncCategoryAssignments`, which removes every assignment not present in the array
   * — so the array must always be the product's COMPLETE intended set, not a delta. Re-reading per
   * product also makes the order collections are processed in irrelevant: a product in three
   * collections accumulates all three, whichever order they arrive in.
   *
   * Deliberately uncached. A cache would have to be invalidated by our own writes and would still
   * be wrong the moment anything else touched the row; a read per (product, collection) pair is
   * affordable at backfill scale and is always right.
   */
  async function applyAssignment(
    run: CollectionsRunContext,
    input: { productLocalId: string; categoryLocalId: string; attach: boolean; scope: TenantScope },
  ): Promise<void> {
    const current = await run.assignments.categoryIdsForProduct(input.productLocalId, input.scope)
    const next = input.attach
      ? [...new Set([...current, input.categoryLocalId])]
      : current.filter((id) => id !== input.categoryLocalId)

    // Nothing to do. Skipping the command also skips the audit entry, the domain event and the
    // index refresh it would otherwise fire for a no-op write.
    if (next.length === current.length && next.every((id, index) => id === current[index])) return

    // `categoryIds` is `z.array(uuid()).max(100)`. Past that the command rejects the payload with a
    // zod error naming a path rather than a cause, so it is worth failing with something readable.
    if (next.length > 100) {
      throw new Error(
        `product ${input.productLocalId} would belong to ${next.length} categories; catalog.products.update accepts at most 100`,
      )
    }

    await run.commandBus.execute(COMMAND.productUpdate, {
      input: { id: input.productLocalId, categoryIds: next },
      ctx: run.writer.commandContext,
    })
  }

  /**
   * Bring one category's membership in line with its Shopify collection.
   *
   * Removals are gated three times over, because every one of the gates protects against a
   * different way of losing assignments that nothing upstream would flag:
   *
   *   `allowRemovals`        a delta run has not seen the whole catalog
   *   `membershipComplete`   member paging was cut short, so the desired set is truncated
   *   no unmapped members    a member we could not resolve is missing from the desired set, and
   *                          removing on that basis would drop an assignment that is genuinely
   *                          still upstream — it is our mapping that is incomplete, not Shopify's
   *                          collection
   *
   * Removing an assignment never touches the product itself: only the junction row is rewritten.
   */
  async function syncMembership(
    run: CollectionsRunContext,
    input: {
      categoryLocalId: string
      collection: ParsedCollection
      allowRemovals: boolean
      scope: TenantScope
    },
  ): Promise<MembershipOutcome> {
    const { categoryLocalId, collection, scope } = input
    const errors: string[] = []

    const desired: string[] = []
    const unmappedProductExternalIds: string[] = []
    for (const productExternalId of collection.productExternalIds) {
      const localId = await resolveProductLocalId(run, productExternalId, scope)
      // No local product. Record it and move on — never invent one to hang an assignment off.
      if (localId) desired.push(localId)
      else unmappedProductExternalIds.push(productExternalId)
    }

    const current = await run.assignments.productIdsForCategory(categoryLocalId, scope)
    const desiredSet = new Set(desired)
    const currentSet = new Set(current)

    const toAdd = desired.filter((id) => !currentSet.has(id))

    const reconciled =
      input.allowRemovals && collection.membershipComplete && unmappedProductExternalIds.length === 0
    const toRemove = reconciled ? current.filter((id) => !desiredSet.has(id)) : []

    let added = 0
    let removed = 0

    for (const productLocalId of toAdd) {
      try {
        await applyAssignment(run, { productLocalId, categoryLocalId, attach: true, scope })
        added += 1
      } catch (error) {
        errors.push(`attach ${productLocalId}: ${messageOf(error)}`)
      }
    }

    for (const productLocalId of toRemove) {
      try {
        await applyAssignment(run, { productLocalId, categoryLocalId, attach: false, scope })
        removed += 1
      } catch (error) {
        errors.push(`detach ${productLocalId}: ${messageOf(error)}`)
      }
    }

    return { added, removed, unmappedProductExternalIds, errors, reconciled }
  }

  /**
   * Upsert one collection and its membership, and describe what happened.
   *
   * Everything below returns an `ImportItem`; nothing throws. A membership failure flips the item
   * to `failed` even when the category itself landed, because a category whose membership is
   * half-written is not a success and the run tally is the only place an operator would see it.
   * Unmapped members do NOT flip it — before the products sync has run that would report every
   * collection as failed, when in fact each collection imported exactly as well as it could.
   */
  async function importCollection(
    run: CollectionsRunContext,
    collection: ParsedCollection,
    input: { allowRemovals: boolean; scope: TenantScope },
  ): Promise<ImportItem> {
    const { mapped } = collection

    const diagnostics: Record<string, unknown> = {
      title: mapped.name,
      handle: mapped.slug,
      memberCount: collection.productExternalIds.length,
      // False means the member list is truncated — a partial bulk export, or member paging that
      // could not be finished. Reported because it is the difference between "this collection has
      // 3 products" and "we managed to read 3 of its products".
      membershipComplete: collection.membershipComplete,
      // Read from `sources` and not preservable — Shopify assembles membership server-side and
      // Open Mercato has no rule engine, nor a column to keep the definition in. Reported so the
      // run log says so out loud rather than leaving an operator to assume rules round-tripped.
      hasUnpreservedSources: mapped.rules.hasUnpreservedSources,
      ruleSource: mapped.rules.readFrom,
      ...(mapped.rules.sourceTypes.length > 0 ? { sourceTypes: mapped.rules.sourceTypes } : {}),
      ...(mapped.rules.hasUnpreservedSources
        ? {
            membershipNote:
              'Shopify defines this collection from sources (smart-collection rules and/or curated lists). Those are not preserved; membership is imported as a static snapshot and will drift until the next sync.',
          }
        : {}),
    }

    const readById = run.writer.rowReader(run.categoryEntity)

    const outcome = await run.writer.upsert({
      externalId: mapped.externalId,
      mappingEntityType: MAPPING_ENTITY_TYPE.productCategory,
      createCommand: COMMAND.categoryCreate,
      updateCommand: COMMAND.categoryUpdate,
      resultKey: COMMAND_RESULT_KEY.category,
      readById,
      // Adopt a category that already carries this handle as its slug rather than failing on the
      // slug-uniqueness check the command enforces. The writer repoints the mapping at it, so an
      // operator-created category and its Shopify counterpart converge instead of colliding.
      findByNaturalKey: () => run.writer.naturalKeyLookup(run.categoryEntity, 'slug')(mapped.slug),
      buildCreateInput: () => ({
        organizationId: input.scope.organizationId,
        tenantId: input.scope.tenantId,
        name: mapped.name,
        slug: mapped.slug,
        description: mapped.description,
        // Never derived. Shopify collections are flat; inventing a tree from handle prefixes would
        // produce a hierarchy that looks authored.
        parentId: null,
        isActive: true,
      }),
      buildUpdateInput: ({ row }) => {
        // Cheap content check in place of a hash: four scalar fields, already in memory. An
        // unchanged collection costs one read and no write, which is the whole point on a re-run.
        const unchanged =
          row.name === mapped.name &&
          (row.slug ?? null) === mapped.slug &&
          (row.description ?? '') === mapped.description
        return unchanged
          ? null
          : { name: mapped.name, slug: mapped.slug, description: mapped.description }
      },
    })

    if (!outcome.ok) return toImportItem(outcome, diagnostics)

    let membership: MembershipOutcome
    try {
      membership = await syncMembership(run, {
        categoryLocalId: outcome.localId,
        collection,
        allowRemovals: input.allowRemovals,
        scope: input.scope,
      })
    } catch (error) {
      // A read failed rather than one product's write. Still contained: the category is written and
      // this one collection reports failed.
      return {
        externalId: mapped.externalId,
        action: 'failed',
        data: {
          ...diagnostics,
          localId: outcome.localId,
          sourceIdentifier: mapped.externalId,
          errorMessage: `membership sync failed: ${messageOf(error)}`,
        },
      }
    }

    const data: Record<string, unknown> = {
      ...diagnostics,
      localId: outcome.localId,
      resolvedVia: outcome.resolvedVia,
      assignmentsAdded: membership.added,
      assignmentsRemoved: membership.removed,
      membershipReconciled: membership.reconciled,
      ...(membership.unmappedProductExternalIds.length > 0
        ? {
            // Named precisely: these products are not missing from Shopify, they are missing from
            // THIS install. Re-running after the products sync resolves them.
            unmappedProductCount: membership.unmappedProductExternalIds.length,
            unmappedProductExternalIds: membership.unmappedProductExternalIds.slice(0, 20),
          }
        : {}),
    }

    if (membership.errors.length > 0) {
      return {
        externalId: mapped.externalId,
        action: 'failed',
        data: {
          ...data,
          sourceIdentifier: mapped.externalId,
          errorMessage: `${membership.errors.length} assignment write(s) failed: ${membership.errors.slice(0, 3).join('; ')}`,
        },
      }
    }

    return { externalId: mapped.externalId, action: outcome.action, data }
  }

  // ── Reading from Shopify ───────────────────────────────────────────────────────────────────

  /**
   * Page the rest of a collection's members.
   *
   * A collection with thousands of products does not fit in the inline page the list query can
   * afford, and assuming one page is enough is how membership silently truncates on exactly the
   * biggest, most important collections. Returns `complete: false` if paging is cut short, which
   * disqualifies the collection from removal reconciliation.
   */
  async function fetchRemainingMembers(
    client: ShopifyClient,
    input: { collectionExternalId: string; after: string; signal?: AbortSignal },
  ): Promise<{ ids: string[]; complete: boolean }> {
    const ids: string[] = []
    let after: string | null = input.after

    for (let page = 0; page < MAX_MEMBER_PAGES; page += 1) {
      const data = await client.request<{
        collection?: { products?: unknown } | null
      }>(buildCollectionMembersQuery(), {
        variables: { id: input.collectionExternalId, first: MEMBER_PAGE_SIZE, after },
        estimatedCost: MEMBER_PAGE_SIZE,
        signal: input.signal,
      })

      const products = data?.collection?.products as
        | { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } }
        | undefined
      ids.push(...mapCollectionProductIds(products))

      if (!products?.pageInfo?.hasNextPage) return { ids, complete: true }
      const endCursor = products.pageInfo.endCursor
      // `hasNextPage` with no cursor to follow: there is no honest way to continue, so say so
      // rather than stopping quietly and letting the truncated list drive removals.
      if (typeof endCursor !== 'string' || endCursor === '') return { ids, complete: false }
      after = endCursor
    }

    return { ids, complete: false }
  }

  /** One delta page of collections, with each collection's membership fully resolved. */
  async function fetchDeltaPage(
    client: ShopifyClient,
    input: { after: string | null; updatedAfter: string | null; pageSize: number; signal?: AbortSignal },
  ): Promise<{
    collections: ParsedCollection[]
    endCursor: string | null
    hasNextPage: boolean
    searchWarnings: string[]
  }> {
    // `requestDetailed` rather than `request`: the `extensions` envelope carries the only evidence
    // that a filter was ignored, and `request` discards it.
    const { data, extensions } = await client.requestDetailed<{
      collections?: {
        edges?: { node?: unknown }[]
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
      }
    }>(buildCollectionsDeltaQuery(), {
      variables: {
        first: input.pageSize,
        after: input.after,
        query: buildUpdatedAtFilter(input.updatedAfter),
        members: INLINE_MEMBER_PAGE_SIZE,
      },
      estimatedCost: input.pageSize * INLINE_MEMBER_PAGE_SIZE,
      signal: input.signal,
      // Makes Shopify report whether it honoured the updated_at filter (R-13). Without it,
      // `searchWarnings` below is always empty and the check passes vacuously.
      headers: SEARCH_DEBUG_HEADER,
    })

    const edges = data?.collections?.edges ?? []
    const collections: ParsedCollection[] = []

    for (const edge of edges) {
      const node = edge?.node as Record<string, unknown> | undefined
      const mapped = mapCollection(node)
      // A node we cannot map is surfaced as a failed item by the caller, which needs the raw node.
      if (!mapped) {
        collections.push({
          mapped: {
            externalId: '',
            name: '',
            slug: null,
            description: '',
            updatedAt: null,
            rules: { hasUnpreservedSources: false, readFrom: 'none', sourceTypes: [] },
          },
          productExternalIds: [],
          membershipComplete: false,
        })
        continue
      }

      const products = node?.products as
        | { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } }
        | undefined
      const productExternalIds = mapCollectionProductIds(products)
      let membershipComplete = true

      if (products?.pageInfo?.hasNextPage) {
        const endCursor = products.pageInfo.endCursor
        if (typeof endCursor === 'string' && endCursor !== '') {
          const rest = await fetchRemainingMembers(client, {
            collectionExternalId: mapped.externalId,
            after: endCursor,
            signal: input.signal,
          })
          productExternalIds.push(...rest.ids)
          membershipComplete = rest.complete
        } else {
          membershipComplete = false
        }
      }

      collections.push({
        mapped,
        productExternalIds: [...new Set(productExternalIds)],
        membershipComplete,
      })
    }

    return {
      collections,
      endCursor: data?.collections?.pageInfo?.endCursor ?? null,
      hasNextPage: data?.collections?.pageInfo?.hasNextPage === true,
      // Only meaningful when a filter was actually sent — an unfiltered first page has nothing to
      // ignore, so a warning there would be noise.
      searchWarnings: input.updatedAfter ? readSearchWarnings(extensions) : [],
    }
  }

  /**
   * Open the backfill stream, reusing an in-flight operation when the cursor names one.
   *
   * Resuming matters more here than it looks: a bulk export of a large store takes minutes, and
   * re-submitting after a worker restart both wastes that time and risks tripping the
   * already-in-progress rejection.
   */
  async function openBulkStream(
    client: ShopifyClient,
    input: { resumeOperationId: string | null; options: BulkExportOptions },
  ): Promise<{ operation: BulkOperation; nodes: AsyncIterable<BulkNode> | null; partial: boolean }> {
    const submitted = input.resumeOperationId
      ? { id: input.resumeOperationId }
      : await submitBulkQuery(client, buildCollectionsBulkQuery(), input.options)

    const operation = await pollBulkOperation(client, submitted.id, input.options)
    const result = bulkResultUrl(operation)

    // A COMPLETED operation that matched nothing has no URL at all — an empty store, not a failure.
    if (!result) return { operation, nodes: null, partial: operation.status !== 'COMPLETED' }

    return {
      operation,
      partial: result.partial,
      nodes: reassembleBulkStream(fetchJsonlLines(result.url, input.options), input.options),
    }
  }

  /**
   * Fold a reassembled bulk node into the same shape the delta path produces.
   *
   * `partial` is why this takes an argument at all. A COMPLETED export carries every child line for
   * its parent, so membership is complete by construction — there is no connection to page. But a
   * FAILED operation read via `partialDataUrl` is a truncated file, and a truncated file on a FULL
   * run is the one case where removals would be computed from an incomplete picture and would
   * delete assignments that are still live upstream. Marking every collection in a partial export
   * as incomplete is what stops that.
   */
  function parseBulkNode(node: BulkNode, partial: boolean): ParsedCollection | null {
    const mapped = mapCollection({ id: node.id, ...node.fields })
    if (!mapped) return null
    return {
      mapped,
      productExternalIds: mapCollectionProductIds(childrenOfType(node, 'Product')),
      membershipComplete: !partial,
    }
  }

  // ── streamImport ───────────────────────────────────────────────────────────────────────────

  async function* streamImport(input: StreamImportInput): AsyncIterable<ImportBatch> {
    const client = deps.createClient(input.credentials)
    const run = await deps.createRunContext({ scope: input.scope })

    let state: ShopifyCursorState | null = parseCursor(input.cursor)

    /**
     * 🔴 THE GUARD. Only a run reading the WHOLE catalog may remove assignments. A delta run
     * legitimately sees just the collections that changed, so reconciling on one would strip the
     * membership of every collection it did not happen to touch. This single boolean is the
     * difference between a correct sync and a catastrophic one — the same guard, for the same
     * reason, as the first-party pattern.
     *
     * Derived from the PARSED cursor rather than the raw string, which folds in one more case:
     * `parseCursor` returns null for anything it cannot fully trust, and a cursor we cannot read is
     * a cursor we cannot resume from. The honest recovery is a full re-read — and a full re-read is
     * exactly the condition that makes reconciling correct.
     *
     * A resumed backfill lands on the safe side: it carries a readable cursor, so it adds without
     * removing, and the next clean full run reconciles.
     */
    const isFullSync = state === null
    const allowRemovals = isFullSync

    const batchOptions = { allowRemovals, scope: input.scope }
    const batchSize = Math.max(1, input.batchSize || COLLECTION_PAGE_SIZE)
    let batchIndex = 0
    let unmappedProducts = 0

    /** Emit whatever has accumulated, and roll the cursor forward with it. */
    function toBatch(
      items: ImportItem[],
      advance: { next?: { kind: 'paging'; endCursor: string } | { kind: 'bulk'; bulkOperationId: string } | null; maxUpdatedAt: string | null },
      extra: { message?: string } = {},
    ): ImportBatch {
      state = advanceCursor(state, advance)
      const batch: ImportBatch = {
        items,
        cursor: serializeCursor(state),
        hasMore: Boolean(advance.next),
        batchIndex: batchIndex++,
        // Per-batch delta (matching products.ts), NOT a running cumulative: the engine SUMS
        // processedCount across batches, so a cumulative here triangular-inflates the total. The
        // empty bulk-poll heartbeats carry no items, so they add 0 to that sum.
        processedCount: items.length,
        ...(extra.message ? { message: extra.message } : {}),
      }
      return batch
    }

    function countUnmapped(items: ImportItem[]): void {
      for (const item of items) {
        const count = item.data?.unmappedProductCount
        if (typeof count === 'number') unmappedProducts += count
      }
    }

    // A run reads via bulk when it is reading everything (first run, full resync, unreadable
    // cursor) or when the cursor names an operation still in flight. Everything else — a paging
    // cursor, or the `idle` watermark a completed run leaves behind — is an incremental window and
    // pages instead. Full reads must go through bulk: deep pagination saturates at 25,001 objects.
    const resumeBulkId = state?.kind === 'bulk' ? state.bulkOperationId : null
    const useBulk = isFullSync || resumeBulkId !== null

    if (useBulk) {
      // ── Backfill ─────────────────────────────────────────────────────────────────────────
      const anomalies: BulkAnomaly[] = []
      let anomalyCount = 0
      // The bulk export blocks on a poll loop (up to an hour) that yields nothing. Stash the live
      // operation via `onPoll` and beat while it runs, so the job's heartbeat stays fresh past the
      // 60s watchdog and the run log shows scan progress — object counts only, never catalog data.
      let lastOp: BulkOperation | null = null
      const existingOnPoll = deps.bulkOptions?.onPoll
      const options: BulkExportOptions = {
        ...deps.bulkOptions,
        onAnomaly: (anomaly) => {
          // Collected rather than thrown: one unusable JSONL line should not discard a whole
          // catalog export. But it is never silent — the count rides out on the final batch and
          // the run is reported as having failures.
          anomalyCount += 1
          if (anomalies.length < MAX_REPORTED_ANOMALIES) anomalies.push(anomaly)
        },
        // Composed with any onPoll already on `deps.bulkOptions`, so the seam a caller wired for its
        // own telemetry keeps firing alongside the heartbeat's operation stash.
        onPoll: (op) => {
          lastOp = op
          existingOnPoll?.(op)
        },
      }

      // Race the export against the heartbeat timer: beat every interval until `openBulkStream`
      // settles, then re-await it for the value/throw. The heartbeat's `batchIndex++` shares
      // `toBatch`'s counter, so indices stay monotonic across beats and data batches alike.
      const streamPromise = openBulkStream(client, { resumeOperationId: resumeBulkId, options })
      yield* heartbeatWhile(
        streamPromise,
        () =>
          heartbeatBatch({
            cursor: serializeCursor(state ?? { kind: 'idle', updatedAfter: null }),
            batchIndex: batchIndex++,
            message: `Exporting Shopify collections… ${lastOp?.objectCount ?? 0} rows scanned`,
          }),
        { intervalMs: deps.heartbeatIntervalMs, clock: deps.heartbeatClock },
      )
      const stream = await streamPromise
      const bulkOperationId = stream.operation.id
      let items: ImportItem[] = []
      let maxUpdatedAt: string | null = null

      if (stream.nodes) {
        for await (const node of stream.nodes) {
          const parsed = parseBulkNode(node, stream.partial)
          if (!parsed) {
            items.push({
              externalId: node.id,
              action: 'failed',
              data: {
                sourceIdentifier: node.id,
                errorMessage: 'collection payload could not be mapped (missing id or title)',
              },
            })
          } else {
            items.push(await importCollection(run, parsed, batchOptions))
            maxUpdatedAt = laterOf(maxUpdatedAt, parsed.mapped.updatedAt)
          }

          if (items.length >= batchSize) {
            countUnmapped(items)
            // Still mid-export: park on the operation id so a crash resumes this same operation
            // rather than paying for a new one.
            yield toBatch(items, { next: { kind: 'bulk', bulkOperationId }, maxUpdatedAt })
            items = []
          }
        }
      }

      countUnmapped(items)

      if (anomalyCount > 0) {
        // A synthetic failed item so the run tally is not clean when rows were dropped. A bulk
        // export that loses records and still reports success is the failure mode worth engineering
        // against.
        items.push({
          externalId: `${ENTITY_TYPE.collection}:bulk_anomalies`,
          action: 'failed',
          data: {
            sourceIdentifier: bulkOperationId,
            errorMessage: `${anomalyCount} unusable line(s) in the bulk export`,
            anomalies: anomalies.map((anomaly) => anomaly.kind),
          },
        })
      }

      yield {
        ...toBatch(items, { maxUpdatedAt }, { message: finalMessage({ partial: stream.partial, unmappedProducts, reconciled: allowRemovals }) }),
        refreshCoverageEntityTypes: [OM_ENTITY_ID.productCategory],
      }
      return
    }

    // ── Delta ──────────────────────────────────────────────────────────────────────────────
    const updatedAfter = state?.updatedAfter ?? null
    let after = state?.kind === 'paging' ? state.endCursor : null

    for (;;) {
      const page = await fetchDeltaPage(client, {
        after,
        updatedAfter,
        pageSize: Math.min(batchSize, COLLECTION_PAGE_SIZE),
      })

      const items: ImportItem[] = []
      let maxUpdatedAt: string | null = null

      if (page.searchWarnings.length > 0) {
        // Shopify ignored our `updated_at` filter, so this run is scanning the whole catalog while
        // presenting as a delta — and the paging path saturates at 25,001 objects, which truncates
        // silently. Reported as a failure so the run is visibly not clean.
        items.push({
          externalId: `${ENTITY_TYPE.collection}:search_filter_ignored`,
          action: 'failed',
          data: {
            sourceIdentifier: buildUpdatedAtFilter(updatedAfter) ?? '(no filter)',
            errorMessage: `Shopify ignored the delta filter and returned everything: ${page.searchWarnings.join('; ')}`,
          },
        })
      }

      for (const collection of page.collections) {
        if (!collection.mapped.externalId) {
          items.push({
            externalId: '(unmapped)',
            action: 'failed',
            data: {
              sourceIdentifier: '(unmapped)',
              errorMessage: 'collection payload could not be mapped (missing id or title)',
            },
          })
          continue
        }
        items.push(await importCollection(run, collection, batchOptions))
        maxUpdatedAt = laterOf(maxUpdatedAt, collection.mapped.updatedAt)
      }

      countUnmapped(items)

      const hasMore = page.hasNextPage && typeof page.endCursor === 'string' && page.endCursor !== ''
      if (hasMore) {
        yield toBatch(items, { next: { kind: 'paging', endCursor: page.endCursor as string }, maxUpdatedAt })
        after = page.endCursor
        continue
      }

      yield {
        ...toBatch(items, { maxUpdatedAt }, { message: finalMessage({ partial: false, unmappedProducts, reconciled: allowRemovals }) }),
        refreshCoverageEntityTypes: [OM_ENTITY_ID.productCategory],
      }
      return
    }
  }

  // ── Contract surface ───────────────────────────────────────────────────────────────────────

  return {
    providerKey: PROVIDER_KEY.collections,
    // Import-only, and it stays that way: `collectionAddProducts` and `collectionRemoveProducts`
    // are deprecated, so there is no supported write path back to Shopify's membership even if we
    // wanted one.
    direction: 'import',
    supportedEntities: [ENTITY_TYPE.collection],

    streamImport,

    async getInitialCursor(): Promise<string | null> {
      // Null means "no watermark", which routes the first run into the bulk backfill.
      return null
    },

    async getMapping(): Promise<DataMapping> {
      return {
        entityType: ENTITY_TYPE.collection,
        matchStrategy: 'externalId',
        fields: [
          { externalField: 'id', localField: 'externalId', mappingKind: 'external_id', dedupeRole: 'primary', required: true },
          { externalField: 'title', localField: 'name', mappingKind: 'core', required: true },
          { externalField: 'handle', localField: 'slug', mappingKind: 'core' },
          { externalField: 'descriptionHtml', localField: 'description', mappingKind: 'core' },
          { externalField: 'products', localField: 'categoryAssignments', mappingKind: 'relation' },
          // Declared as ignored rather than omitted: "we saw this and chose not to map it" is a
          // different statement from "we never looked", and this is the field a future reader will
          // come looking for.
          { externalField: 'sources', localField: '', mappingKind: 'ignore' },
          { externalField: 'sortOrder', localField: '', mappingKind: 'ignore' },
        ],
      }
    },

    async validateConnection(input): Promise<ValidationResult> {
      try {
        const client = deps.createClient(input.credentials)
        // One collection, no members: the cheapest query that still proves `read_products` covers
        // Collections on this store, which is the failure this check exists to catch.
        await client.request('#graphql\n  query SyncShopifyCollectionsProbe { collections(first: 1) { edges { node { id } } } }\n', {
          estimatedCost: 2,
        })
        return { ok: true, message: 'Shopify collections are readable.' }
      } catch (error) {
        return {
          ok: false,
          message: `Could not read Shopify collections: ${messageOf(error)}`,
          details: { entityType: input.entityType },
        }
      }
    },
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Later of two ISO timestamps, tolerating either being absent. Feeds the cursor watermark. */
function laterOf(current: string | null, candidate: string | null): string | null {
  if (!candidate) return current
  if (!current) return candidate
  return Date.parse(candidate) > Date.parse(current) ? candidate : current
}

/**
 * The line the admin UI shows when the run ends.
 *
 * Worth spelling out: an operator seeing "imported 40 collections" has no way to know that 900
 * memberships were skipped because the products sync has not run, or that removals were withheld
 * because this was a delta run.
 */
function finalMessage(input: { partial: boolean; unmappedProducts: number; reconciled: boolean }): string {
  const parts = [
    input.reconciled
      ? 'Full sync: membership reconciled against Shopify.'
      : 'Delta sync: assignments added only, removals defer to the next full sync.',
  ]
  if (input.partial) {
    parts.push('The bulk export did not finish cleanly; this run read its partial data.')
  }
  if (input.unmappedProducts > 0) {
    parts.push(
      `${input.unmappedProducts} membership(s) reference products not yet imported — run the Shopify products sync, then re-run this one.`,
    )
  }
  return parts.join(' ')
}
