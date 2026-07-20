import type {
  DataMapping,
  DataSyncAdapter,
  ImportBatch,
  ImportItem,
  StreamImportInput,
  TenantScope,
} from '@open-mercato/core/modules/data_sync/lib/adapter'
import type { ShopifyClient } from '../client'
import type { BulkExport, BulkNode } from '../bulk'
import { childrenOfType, runBulkExport } from '../bulk'
import {
  COMMAND,
  COMMAND_RESULT_KEY,
  ENTITY_TYPE,
  INTEGRATION_ID,
  MAPPING_ENTITY_TYPE,
  OM_ENTITY_ID,
  PROVIDER_KEY,
} from '../constants'
import { advanceCursor, parseCursor, serializeCursor, type ShopifyCursorState } from '../cursor'
import { toImportItem, type CommandBusPort, type EntityRow, type EntityWriter } from '../writer'
import {
  customerContentHash,
  mapCustomer,
  type MappedAddress,
  type MappedCustomer,
  type ShopifyCustomerNode,
  type ShopifyMailingAddress,
} from '../mappers/customer'

/**
 * The Shopify customers import adapter.
 *
 * Backfill runs as a bulk operation, delta as a paged `updated_at:>…` query, and the engine cannot
 * tell them apart — which is exactly why the `DataSyncAdapter` contract fits. Core owns the run
 * record, the counters, cursor persistence and cancellation; this file owns only the generator.
 *
 * 🔒 PII IS THE DOMINANT CONSTRAINT HERE. Unlike products, every record this adapter touches is
 * personal data. Two rules follow, and both are structural rather than advisory:
 *
 *  1. Nothing but GIDs, counts and fixed codes ever reaches the logger or an error message.
 *     `lib/mappers/customer.ts` reports its compromises as codes precisely so they can be counted
 *     and logged without carrying a value. Run logs are retained and readable by every operator in
 *     the tenant, so a value in an error message is a leak that outlives the run.
 *  2. Item failures carry `errorMessage` — which the admin UI renders — so `describeFailure` is
 *     the ONLY place an error string is built, and it names the GID and the stage, never the data.
 *
 * FOUR THINGS THAT WOULD BE WRONG IN AN OBVIOUS-LOOKING IMPLEMENTATION:
 *
 *  - `customers.people.*` returns **`entityId`, not `personId`** — the row it creates is a
 *    `CustomerEntity` with the person profile hanging off it. `COMMAND_RESULT_KEY.person` encodes
 *    that. Reading `personId` yields the profile id, which would then be stored as the customer's
 *    external-id mapping and poison every later lookup — silently, because both are valid uuids.
 *  - Address reconciliation is **per customer**. Shopify hands over the customer's entire address
 *    set, so an address deleted upstream is simply absent from a payload we already hold. A global
 *    sweep cannot see that, and a delta run must not attempt one.
 *  - Customer reconciliation is guarded on **`!input.cursor`**. A delta run legitimately sees only
 *    changed customers, so reconciling on one would deactivate the entire customer base.
 *  - A per-item throw aborts the whole run via `finalizeRun('failed')`, losing every item that had
 *    already succeeded. Failures are therefore RETURNED as `action: 'failed'` items.
 *
 * Collaborators arrive through `CustomerSyncRuntime` rather than a container lookup, so the module
 * holds no runtime framework import and the whole generator is testable against stubs.
 */

// ── Injected runtime ─────────────────────────────────────────────────────────────────────────

/**
 * Everything one run needs, assembled by DI.
 *
 * The entity classes arrive as opaque values because they are only ever handed straight back to
 * `findOneWithDecryption`; typing them would require importing the framework at runtime, which is
 * what keeps this file out of ts-jest (see the module note in `lib/writer.ts`).
 */
export type CustomerSyncRuntime = {
  client: ShopifyClient
  writer: EntityWriter
  /** Needed for address deletion — the writer only creates and updates. */
  commandBus: CommandBusPort
  /** `CustomerEntity` class, for the writer's scoped id reads. */
  customerEntity: unknown
  /** `CustomerAddress` class, same. */
  customerAddress: unknown
  /** Natural-key fallback: resolve a customer by `primaryEmail` when no mapping exists yet. */
  findCustomerByEmail(email: string): Promise<EntityRow | null>
  /** Live addresses belonging to one customer. Scoped read — org + tenant + `deletedAt: null`. */
  listAddresses(customerLocalId: string): Promise<EntityRow[]>
  /**
   * Reverse mapping lookup (`externalIdMappingService.lookupExternalId`).
   *
   * This is the ownership gate: a local row with no mapping from THIS integration was created by a
   * human or another connector and must never be deleted by a sync.
   */
  lookupExternalId(entityType: string, localId: string): Promise<string | null>
  /** Every customer this integration has mapped, for full-sync reconciliation. */
  listSyncedCustomers(): Promise<{ localId: string; externalId: string }[]>
  /**
   * Where the per-record content hash lives — OPTIONAL, and absent by default.
   *
   * There is no framework-provided home for it: `CustomerEntity` has no such column,
   * `storeExternalIdMapping` accepts no metadata, and `ImportItem.hash` is declared on the
   * contract but read by nothing in `data_sync`. A hash compared against a store that does not
   * exist is worse than no hash at all — it either never matches (pointless) or matches by
   * accident (a skip that silently drops a real update).
   *
   * So the skip is opt-in. Wire this to a custom field on `OM_ENTITY_ID.customerEntity` once a
   * definition is declared, and unchanged customers cost one read instead of a write. Leave it
   * unset and every resolved customer is rewritten: more writes, never a wrong skip.
   */
  contentHash?: {
    read(customerLocalId: string): Promise<string | null>
    write(customerLocalId: string, hash: string): Promise<void>
  }
}

/** Codes and counts only — never a mapped value. See the PII note above. */
export type CustomerSyncLogEvent =
  | { kind: 'batch'; batchIndex: number; items: number; mode: 'backfill' | 'delta' }
  | { kind: 'mapping_notes'; externalId: string; notes: string[] }
  | { kind: 'addresses_removed'; externalId: string; count: number }
  | { kind: 'reconciled'; deactivated: number; skippedNotOwned: number }
  | { kind: 'bulk_partial'; objectCount: number | null }

export type CustomersAdapterOptions = {
  createRuntime(input: {
    credentials: Record<string, unknown>
    scope: TenantScope
  }): Promise<CustomerSyncRuntime>
  /** Optional diagnostics sink. Receives codes and counts only. */
  log?: (event: CustomerSyncLogEvent) => void
  /** Addresses fetched per customer on the delta path. Well above any realistic customer's count. */
  addressPageSize?: number
  /**
   * Seam for the bulk pipeline, defaulting to `runBulkExport`.
   *
   * Overridden in tests so the backfill path — which is where full-sync reconciliation lives, and
   * therefore the most consequential branch in this file — can be exercised without standing up
   * mutation, polling and a signed JSONL download.
   */
  bulkExport?: (client: ShopifyClient, query: string) => Promise<BulkExport>
}

const DEFAULT_ADDRESS_PAGE_SIZE = 50

/** Shopify caps a page at 250 regardless of what the engine asks for. */
const MAX_PAGE_SIZE = 250

// ── GraphQL ──────────────────────────────────────────────────────────────────────────────────

/**
 * Field selection, shared by both paths so they can never drift into importing different data.
 *
 * Every accessor here was checked against the pinned 2026-07 schema: `defaultEmailAddress` and
 * `defaultPhoneNumber` replace the deprecated flat `email`/`phone`, and addresses are
 * `MailingAddress` — the Admin API has no `CustomerAddress` type at all. `countryCodeV2` is
 * selected because the bare `countryCode` is the deprecated one.
 */
const CUSTOMER_FIELDS = `
    id
    firstName
    lastName
    displayName
    defaultEmailAddress { emailAddress }
    defaultPhoneNumber { phoneNumber }
    note
    tags
    state
    updatedAt
    defaultAddress { id }
`

const ADDRESS_FIELDS = `
      id
      address1
      address2
      city
      province
      provinceCode
      country
      countryCodeV2
      zip
      company
      firstName
      lastName
      name
`

/**
 * The backfill query.
 *
 * Two connections (`customers`, `addressesV2`) and two nesting levels — both at the documented
 * bulk ceiling of 5 and 2 respectively. `defaultAddress` is a plain object, not a connection, so
 * it costs nothing against that budget and is inlined on the customer's own JSONL line rather than
 * arriving as a child.
 *
 * No pagination arguments: a bulk operation scans the whole collection by definition, and adding
 * `first:` is what silently truncates a backfill.
 */
export function buildCustomerBulkQuery(): string {
  return `{
  customers {
    edges {
      node {${CUSTOMER_FIELDS}        addressesV2 {
          edges {
            node {${ADDRESS_FIELDS}            }
          }
        }
      }
    }
  }
}`
}

/**
 * The delta query.
 *
 * `sortKey: UPDATED_AT` is not optional decoration: paired with an `updated_at:>…` filter it is
 * what lets Shopify walk an index. Without it, large collections time out instead of paginating.
 */
const CUSTOMERS_DELTA_QUERY = `#graphql
  query SyncShopifyCustomersDelta($first: Int!, $after: String, $query: String, $addresses: Int!) {
    customers(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      edges {
        node {${CUSTOMER_FIELDS}        addressesV2(first: $addresses) {
            nodes {${ADDRESS_FIELDS}          }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`

/**
 * Build the `updated_at:>…` search filter.
 *
 * Exported so a test can assert on the exact string. That matters more than it looks: **an invalid
 * search field is IGNORED and Shopify returns everything** — *"If you specify an invalid field,
 * then the query is ignored and all results are returned"* — so a typo here does not error, it
 * turns every delta run into a full scan that still reports success. Shopify surfaces this on
 * `extensions.search[].warnings`, which `ShopifyClient.request` does not currently expose, so
 * pinning the built string is the check available to us.
 *
 * The timestamp is single-quoted because an unquoted one is parsed as several terms.
 */
export function buildUpdatedAtFilter(updatedAfter: string | null): string | null {
  if (!updatedAfter) return null
  return `updated_at:>'${updatedAfter}'`
}

// ── Payload normalisation ────────────────────────────────────────────────────────────────────

type DeltaResponse = {
  customers?: {
    edges?: ({ node?: ShopifyCustomerNode | null } | null)[] | null
    pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null
  } | null
}

/**
 * Fold a reassembled bulk node back into the same shape the delta path produces.
 *
 * Bulk JSONL delivers a connection's members as separate lines linked by `__parentId`, so a
 * customer's addresses arrive as children rather than nested. Normalising here means the mapper
 * sees one shape and the two paths cannot diverge in what they import.
 */
export function bulkNodeToCustomer(node: BulkNode): ShopifyCustomerNode {
  const fields = node.fields as Omit<ShopifyCustomerNode, 'id' | 'addressesV2'>
  const addresses = childrenOfType(node, 'MailingAddress').map(
    (child) => ({ id: child.id, ...child.fields }) as ShopifyMailingAddress,
  )
  return { ...fields, id: node.id, addressesV2: { nodes: addresses } }
}

// ── Failure reporting ────────────────────────────────────────────────────────────────────────

/**
 * The one place an item's `errorMessage` is composed.
 *
 * `logImportItemFailures` renders this string in the admin UI, so it must identify the record
 * without describing it: the Shopify GID and the stage that failed, never a name, email, phone or
 * address. Any underlying message is deliberately NOT interpolated — a Zod error quotes the value
 * it rejected, which is precisely the PII that must not reach a retained log.
 */
function describeFailure(externalId: string, stage: string): string {
  return `Shopify customer ${externalId} failed at ${stage}; details withheld (personal data)`
}

function failedItem(externalId: string, stage: string): ImportItem {
  return {
    externalId,
    action: 'failed',
    data: { sourceIdentifier: externalId, errorMessage: describeFailure(externalId, stage) },
  }
}

// ── Address writing ──────────────────────────────────────────────────────────────────────────

function addressInput(address: MappedAddress, scope: TenantScope): Record<string, unknown> {
  return {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    addressLine1: address.addressLine1,
    addressLine2: address.addressLine2,
    city: address.city,
    region: address.region,
    postalCode: address.postalCode,
    country: address.country,
    companyName: address.companyName,
    name: address.name,
    isPrimary: address.isPrimary,
  }
}

/**
 * Write one customer's addresses and remove the ones that disappeared upstream.
 *
 * Reconciliation is scoped to THIS customer, which is both correct and necessary: Shopify sends
 * the complete set every time, so absence is meaningful here in a way it never is across a delta
 * run as a whole. A global sweep would be both wrong and unable to see the deletion at all.
 *
 * Deletion is ownership-gated on the external-id mapping. A local address with no mapping from
 * this integration was entered by a person or another connector, and a sync has no business
 * deleting it — so it is left untouched and counted.
 *
 * Exactly one primary is guaranteed upstream of here: the mapper picks a single index and derives
 * every flag from it. Core then demotes the customer's other addresses whenever one is written
 * with `isPrimary: true`, so the two mechanisms agree rather than fight.
 */
async function syncAddresses(
  runtime: CustomerSyncRuntime,
  scope: TenantScope,
  customerLocalId: string,
  addresses: MappedAddress[],
  log: ((event: CustomerSyncLogEvent) => void) | undefined,
  customerExternalId: string,
): Promise<{ ok: boolean; written: number; removed: number }> {
  const writtenLocalIds = new Set<string>()
  let ok = true

  for (const address of addresses) {
    const outcome = await runtime.writer.upsert({
      externalId: address.externalId,
      mappingEntityType: MAPPING_ENTITY_TYPE.customerAddress,
      createCommand: COMMAND.addressCreate,
      updateCommand: COMMAND.addressUpdate,
      resultKey: COMMAND_RESULT_KEY.address,
      readById: runtime.writer.rowReader(runtime.customerAddress),
      buildCreateInput: () => ({ ...addressInput(address, scope), entityId: customerLocalId }),
      // No hash short-circuit: an address is small, and its parent has already been established as
      // changed by the customer-level hash before this runs.
      buildUpdateInput: () => addressInput(address, scope),
    })
    if (outcome.ok) writtenLocalIds.add(outcome.localId)
    else ok = false
  }

  // Only a complete write lets us conclude anything from absence. If one address failed, a local
  // row missing from `writtenLocalIds` may simply be the one that failed — deleting it then would
  // destroy data because of a transient error.
  if (!ok) return { ok, written: writtenLocalIds.size, removed: 0 }

  let removed = 0
  for (const existing of await runtime.listAddresses(customerLocalId)) {
    if (writtenLocalIds.has(existing.id)) continue
    const owned = await runtime.lookupExternalId(MAPPING_ENTITY_TYPE.customerAddress, existing.id)
    if (!owned) continue
    await runtime.commandBus.execute(COMMAND.addressDelete, {
      input: { id: existing.id },
      ctx: runtime.writer.commandContext,
    })
    removed += 1
  }

  if (removed > 0) {
    log?.({ kind: 'addresses_removed', externalId: customerExternalId, count: removed })
  }
  return { ok, written: writtenLocalIds.size, removed }
}

// ── Customer writing ─────────────────────────────────────────────────────────────────────────

function personInput(mapped: MappedCustomer, scope: TenantScope): Record<string, unknown> {
  return {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    displayName: mapped.displayName,
    firstName: mapped.firstName,
    lastName: mapped.lastName,
    primaryEmail: mapped.primaryEmail,
    primaryPhone: mapped.primaryPhone,
    description: mapped.description,
    status: mapped.status,
    isActive: true,
    // `tags` is deliberately absent: core expects CustomerTag UUIDs there, and Shopify's labels
    // would fail Zod and take the whole customer down. See `MappedCustomer.tags`.
  }
}

/**
 * Upsert one customer and its addresses.
 *
 * The content hash hangs off `buildUpdateInput` returning null, which the writer records as a
 * `skip` — so an unchanged customer costs one read and no write. Addresses are only touched when
 * the customer itself changed, since the hash covers them too.
 */
async function importCustomer(
  runtime: CustomerSyncRuntime,
  scope: TenantScope,
  node: ShopifyCustomerNode,
  log: ((event: CustomerSyncLogEvent) => void) | undefined,
): Promise<{ item: ImportItem; localId: string | null; updatedAt: string | null }> {
  let mapped: MappedCustomer
  try {
    mapped = mapCustomer(node)
  } catch {
    return { item: failedItem(node.id, 'mapping'), localId: null, updatedAt: null }
  }

  if (mapped.notes.length > 0) {
    log?.({ kind: 'mapping_notes', externalId: mapped.externalId, notes: mapped.notes })
  }

  const hash = customerContentHash(mapped)
  const hashStore = runtime.contentHash

  const outcome = await runtime.writer.upsert({
    externalId: mapped.externalId,
    mappingEntityType: MAPPING_ENTITY_TYPE.customerEntity,
    createCommand: COMMAND.personCreate,
    updateCommand: COMMAND.personUpdate,
    // ⚠️ `entityId`, NOT `personId` — `customers.people.create` returns both, and the profile id is
    // the wrong one to map. See the header note.
    resultKey: COMMAND_RESULT_KEY.person,
    readById: runtime.writer.rowReader(runtime.customerEntity),
    // Email is the only natural key a customer has. It heals rows created by an earlier import or
    // by hand, so they are adopted rather than duplicated.
    findByNaturalKey: mapped.primaryEmail
      ? () => runtime.findCustomerByEmail(mapped.primaryEmail as string)
      : undefined,
    buildCreateInput: () => personInput(mapped, scope),
    buildUpdateInput: async ({ localId }) => {
      if (!hashStore) return personInput(mapped, scope)
      const stored = await hashStore.read(localId)
      // Returning null is the writer's `skip` seam: no command dispatched, no addresses touched.
      return stored === hash ? null : personInput(mapped, scope)
    },
  })

  if (!outcome.ok) {
    return { item: failedItem(mapped.externalId, 'customer write'), localId: null, updatedAt: mapped.updatedAt }
  }

  if (outcome.action !== 'skip') {
    const addressResult = await syncAddresses(
      runtime,
      scope,
      outcome.localId,
      mapped.addresses,
      log,
      mapped.externalId,
    )
    if (!addressResult.ok) {
      // The customer itself landed; only its addresses are incomplete. Reporting the item as failed
      // is still right — a partially-addressed customer is not a clean import — and the next run
      // repairs it, because every write here is idempotent.
      return {
        item: failedItem(mapped.externalId, 'address write'),
        localId: outcome.localId,
        updatedAt: mapped.updatedAt,
      }
    }
    // Recorded only after the addresses land, so a run that dies between the two does NOT leave a
    // hash claiming the customer is current — the next run would skip it and the missing addresses
    // would never appear.
    await hashStore?.write(outcome.localId, hash)
  }

  return {
    item: {
      ...toImportItem(outcome, { addressCount: mapped.addresses.length, notes: mapped.notes }),
      hash,
    },
    localId: outcome.localId,
    updatedAt: mapped.updatedAt,
  }
}

// ── Reconciliation ───────────────────────────────────────────────────────────────────────────

/**
 * Deactivate customers this integration owns that a FULL run did not see.
 *
 * Deactivation, not deletion: the plan's asymmetry is that leaf rows (prices, offers, addresses)
 * are deleted while records other data points at — products, categories, customers — are only
 * deactivated. A deleted customer would orphan its orders.
 *
 * Ownership-gated the same way addresses are, and only ever called when `!input.cursor`.
 */
async function reconcileCustomers(
  runtime: CustomerSyncRuntime,
  scope: TenantScope,
  seenExternalIds: Set<string>,
  log: ((event: CustomerSyncLogEvent) => void) | undefined,
): Promise<{ deactivated: number; skippedNotOwned: number }> {
  let deactivated = 0
  let skippedNotOwned = 0

  for (const { localId, externalId } of await runtime.listSyncedCustomers()) {
    if (seenExternalIds.has(externalId)) continue

    const owned = await runtime.lookupExternalId(MAPPING_ENTITY_TYPE.customerEntity, localId)
    if (!owned) {
      skippedNotOwned += 1
      continue
    }

    await runtime.commandBus.execute(COMMAND.personUpdate, {
      input: {
        id: localId,
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        isActive: false,
      },
      ctx: runtime.writer.commandContext,
    })
    deactivated += 1
  }

  log?.({ kind: 'reconciled', deactivated, skippedNotOwned })
  return { deactivated, skippedNotOwned }
}

// ── Adapter ──────────────────────────────────────────────────────────────────────────────────

const CUSTOMER_MAPPING: DataMapping = {
  entityType: ENTITY_TYPE.customer,
  matchStrategy: 'externalId',
  fields: [
    { externalField: 'id', localField: 'externalId', mappingKind: 'external_id', dedupeRole: 'primary' },
    { externalField: 'firstName', localField: 'person.firstName', mappingKind: 'core' },
    { externalField: 'lastName', localField: 'person.lastName', mappingKind: 'core' },
    {
      externalField: 'defaultEmailAddress.emailAddress',
      localField: 'primaryEmail',
      mappingKind: 'core',
      dedupeRole: 'secondary',
    },
    { externalField: 'defaultPhoneNumber.phoneNumber', localField: 'primaryPhone', mappingKind: 'core' },
    { externalField: 'note', localField: 'description', mappingKind: 'core' },
    { externalField: 'state', localField: 'status', mappingKind: 'core' },
    { externalField: 'addressesV2', localField: 'addresses', mappingKind: 'relation' },
    // Carried but not written — core wants CustomerTag UUIDs, Shopify sends labels.
    { externalField: 'tags', localField: 'tags', mappingKind: 'ignore' },
  ],
}

export function createCustomersAdapter(options: CustomersAdapterOptions): DataSyncAdapter {
  const addressPageSize = options.addressPageSize ?? DEFAULT_ADDRESS_PAGE_SIZE
  const log = options.log

  async function* streamImport(input: StreamImportInput): AsyncIterable<ImportBatch> {
    const runtime = await options.createRuntime({ credentials: input.credentials, scope: input.scope })

    // 🔴 THE GUARD. A delta run sees only changed customers, so reconciling on one would deactivate
    // every customer that simply did not change. Deliberately keyed on the RAW input rather than on
    // the parsed state: a cursor that fails to parse still means a previous run existed, and the
    // safe reading of "we cannot tell what was already synced" is to skip reconciliation entirely.
    const isFullSync = !input.cursor

    let state = parseCursor(input.cursor)
    const pageSize = Math.min(Math.max(input.batchSize, 1), MAX_PAGE_SIZE)
    const seenExternalIds = new Set<string>()

    let batchIndex = 0
    let pending: ImportItem[] = []
    let processedCount = 0

    // `advanceCursor` promotes the watermark only when no pointer is passed, so `emit` always
    // reports where the run actually is — never where it is about to be.
    const emit = (next: ShopifyCursorState, hasMore: boolean, message?: string): ImportBatch => {
      const batch: ImportBatch = {
        items: pending,
        cursor: serializeCursor(next),
        hasMore,
        batchIndex,
        processedCount,
        ...(message ? { message } : {}),
      }
      pending = []
      batchIndex += 1
      return batch
    }

    async function handle(node: ShopifyCustomerNode): Promise<void> {
      seenExternalIds.add(node.id)
      const { item, updatedAt } = await importCustomer(runtime, input.scope, node, log)
      pending.push(item)
      processedCount += 1
      state = advanceCursor(state, { maxUpdatedAt: updatedAt })
    }

    const mode: 'backfill' | 'delta' = isFullSync || state?.kind === 'bulk' ? 'backfill' : 'delta'

    if (mode === 'backfill') {
      const exported = await (options.bulkExport ?? runBulkExport)(
        runtime.client,
        buildCustomerBulkQuery(),
      )

      if (exported.partial) {
        log?.({ kind: 'bulk_partial', objectCount: exported.operation.objectCount })
      }

      if (exported.nodes) {
        for await (const node of exported.nodes) {
          // Children arrive on their own lines; only top-level customers start a record.
          if (node.type !== 'Customer') continue
          await handle(bulkNodeToCustomer(node))
          if (pending.length >= pageSize) {
            log?.({ kind: 'batch', batchIndex, items: pending.length, mode })
            // A bulk export cannot be resumed mid-stream, so intermediate batches carry the state
            // unchanged: a crash here restarts the export rather than resuming into a gap.
            yield emit(state ?? { kind: 'idle', updatedAfter: null }, true)
          }
        }
      }
    } else {
      const updatedAfter = state?.updatedAfter ?? null
      const filter = buildUpdatedAtFilter(updatedAfter)
      let after = state?.kind === 'paging' ? state.endCursor : null

      for (;;) {
        const data = await runtime.client.request<DeltaResponse>(CUSTOMERS_DELTA_QUERY, {
          variables: { first: pageSize, after, query: filter, addresses: addressPageSize },
          estimatedCost: pageSize,
        })

        const edges = data?.customers?.edges ?? []
        for (const edge of edges) {
          if (edge?.node) await handle(edge.node)
        }

        const pageInfo = data?.customers?.pageInfo
        const endCursor = pageInfo?.endCursor ?? null
        after = endCursor

        if (pageInfo?.hasNextPage && endCursor) {
          state = advanceCursor(state, { next: { kind: 'paging', endCursor } })
          log?.({ kind: 'batch', batchIndex, items: pending.length, mode })
          yield emit(state, true)
          continue
        }
        break
      }
    }

    // No pointer: the run is over, so the watermark is promoted and the next run is incremental.
    state = advanceCursor(state, {})

    if (isFullSync) {
      // Yield the accumulated work before the sweep so the admin UI shows progress rather than
      // appearing to hang through it, then report the sweep as its own final batch.
      if (pending.length > 0) {
        log?.({ kind: 'batch', batchIndex, items: pending.length, mode })
        yield emit(state, true)
      }
      await reconcileCustomers(runtime, input.scope, seenExternalIds, log)
      yield {
        items: [],
        cursor: serializeCursor(state),
        hasMore: false,
        batchIndex,
        processedCount,
        refreshCoverageEntityTypes: [OM_ENTITY_ID.customerEntity],
        message: 'Reconciling Shopify customers after the final batch',
      }
      return
    }

    log?.({ kind: 'batch', batchIndex, items: pending.length, mode })
    const final = emit(state, false)
    yield { ...final, refreshCoverageEntityTypes: [OM_ENTITY_ID.customerEntity] }
  }

  return {
    providerKey: PROVIDER_KEY.customers,
    direction: 'import',
    supportedEntities: [ENTITY_TYPE.customer],
    operationalTelemetry: true,
    streamImport,
    async getInitialCursor() {
      // Null means "no watermark", which routes the first run down the bulk backfill.
      return null
    },
    async getMapping() {
      return CUSTOMER_MAPPING
    },
  }
}

/** The integration this adapter's mappings are partitioned by. */
export const CUSTOMERS_INTEGRATION_ID = INTEGRATION_ID.customers
