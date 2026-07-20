import type { AwilixContainer } from 'awilix'
import type { COMMAND, MAPPING_ENTITY_TYPE, OM_ENTITY_ID } from './constants'

/**
 * The shared native-entity write helper. Every entity adapter (products, collections, customers,
 * orders) upserts through this, so the contracts below are encoded once instead of four times.
 *
 * WHY IT LOOKS LIKE THIS — five things that are not obvious and cost a day each when missed:
 *
 * 1. WRITES GO THROUGH THE COMMAND BUS, NOT THE ORM. The bus fires audit, undo, cache
 *    invalidation, domain events and query-index updates internally. A direct `em.persist` writes
 *    the row and nothing downstream ever hears about it: no events, stale query index, invisible
 *    in list views. Entity classes exist here only so rows can be READ.
 *
 * 2. RESOLUTION RE-VALIDATES. A mapping hit is not proof the row still exists — mappings outlive
 *    soft-deleted records. Without the re-read, a stale mapping resurrects a deleted record by
 *    updating it back into existence. So: mapping → re-read → fall through to the natural key.
 *
 * 3. NOTHING TRANSACTS ABOVE ONE ITEM. `withAtomicFlush` appears exactly once in Akeneo's
 *    2,912-line importer. There is no rollback: a product that fails at its price step keeps its
 *    product and variant writes. Hence every path is idempotent under re-run, and per-item errors
 *    are RETURNED as a failure outcome — never thrown. A throw escapes the adapter's loop and the
 *    engine finalises the entire run as failed, losing every item that would have succeeded.
 *
 * 4. THREE ID DIALECTS, and crossing them fails SILENTLY with a wrong lookup rather than an error.
 *    They are enforced here by TYPE, not by convention — `MappingEntityType`, `CommandId` and
 *    `CustomFieldEntityId` are unions drawn from `lib/constants.ts`, so passing a colon id where a
 *    bare-snake one belongs is a compile error. Adding an entity means appending to `constants.ts`;
 *    that friction is the point.
 *
 * 5. COMMAND RESULT KEYS ARE NOT UNIFORM — `productId`, `variantId`, `categoryId`, `offerId`,
 *    `priceId`, `channelId`. And the bus wraps them: `execute()` resolves to
 *    `{ result, logEntry }`, so the id is at `.result.productId`, one level deeper than it reads.
 *    Guessing wrong yields `undefined`, which would be stored as the mapping's local id and
 *    silently poison every subsequent lookup. We throw instead.
 *
 * TESTABILITY — and why there is not one `@open-mercato` import here, not even a type-only one.
 * `yarn typecheck` resolves with `moduleResolution: Bundler`, which honours the packages' exports
 * map and rewrites `@open-mercato/shared/lib/x` to `shared/src/lib/x.ts`. ts-jest overrides that
 * with `moduleResolution: node`, which ignores exports maps and looks for a physical
 * `shared/lib/x` that does not exist — so NO specifier resolves under both, and a type-only import
 * still fails ts-jest with TS2307 even though it is erased at runtime. Every framework type this
 * module needs is therefore mirrored below, each against the shipped file it was read from.
 * (This is why the other tested helpers — token, throttle, client, probe — import nothing from the
 * framework either, while the untested ones do.) Collaborators arrive as injected ports, so tests
 * stub them outright.
 */

// ── Mirrored framework types ─────────────────────────────────────────────────────────────────
// Structural copies, not approximations — each was read from the shipped 0.6.6 source named
// alongside it. They are checked against the real ones the moment an adapter passes a real
// service in. If one drifts, that adapter stops compiling under `yarn typecheck`.

/** `data_sync/lib/adapter.ts` — `TenantScope`. */
export type TenantScope = {
  organizationId: string
  tenantId: string
}

/** `data_sync/lib/adapter.ts` — `ImportItem`. `action` is the engine's tally key. */
export type ImportItem = {
  externalId: string
  data: Record<string, unknown>
  action: 'create' | 'update' | 'skip' | 'failed'
  hash?: string
}

/**
 * `shared/lib/commands/types.ts` — the fields of `CommandRuntimeContext` a sync populates.
 *
 * Narrower than the real type (which also carries optional `request`, `bulkImport`,
 * `transactionalEm`, …) but structurally assignable to it, so this value can be handed straight to
 * the real `commandBus.execute`.
 */
export type SyncCommandContext = {
  container: AwilixContainer
  auth: null
  organizationScope: {
    selectedId: string
    filterIds: string[]
    allowedIds: string[]
    tenantId: string
  }
  selectedOrganizationId: string
  organizationIds: string[]
}

// ── Dialect-enforcing types (drawn from lib/constants.ts — never widen these to `string`) ────

/** BARE SNAKE (`catalog_product`) — `SyncExternalIdMapping.internalEntityType`. */
export type MappingEntityType = (typeof MAPPING_ENTITY_TYPE)[keyof typeof MAPPING_ENTITY_TYPE]

/** DOT (`catalog.products.create`) — CommandBus command ids. */
export type CommandId = (typeof COMMAND)[keyof typeof COMMAND]

/** COLON (`catalog:catalog_product`) — custom fields, query-index events, CustomFieldDef.entityId. */
export type CustomFieldEntityId = (typeof OM_ENTITY_ID)[keyof typeof OM_ENTITY_ID]

// ── Injected ports ───────────────────────────────────────────────────────────────────────────
// Structural subsets of the real framework services. Narrow on purpose: a test stub implements
// four methods rather than standing up a whole container, and an adapter satisfies them by passing
// the real service straight in (see the conformance note at the foot of this file).

export type CommandBusPort = {
  execute(
    commandId: string,
    options: { input: unknown; ctx: SyncCommandContext },
  ): Promise<{ result: unknown }>
}

export type ExternalIdMappingPort = {
  lookupLocalId(
    integrationId: string,
    entityType: string,
    externalId: string,
    scope: TenantScope,
  ): Promise<string | null>
  storeExternalIdMapping(
    integrationId: string,
    entityType: string,
    localId: string,
    externalId: string,
    scope: TenantScope,
  ): Promise<unknown>
}

/**
 * `findOneWithDecryption` with its `em` already bound by the caller.
 *
 * The EntityManager stays in adapter/DI code so this module keeps zero runtime framework imports.
 * Wire it as: `(entity, where, options, scope) => findOneWithDecryption(em, entity, where, options, scope)`.
 */
export type FindOnePort = (
  entityName: unknown,
  where: Record<string, unknown>,
  options: unknown,
  scope: { organizationId: string; tenantId: string },
) => Promise<EntityRow | null>

/** Minimum we need back from a scoped read: enough to know the row exists and what its id is. */
export type EntityRow = { id: string } & Record<string, unknown>

// ── Outcomes ─────────────────────────────────────────────────────────────────────────────────

/** How the existing row was found. Drives whether the mapping needs healing. */
export type ResolvedVia = 'mapping' | 'natural_key' | 'created'

export type WriteOutcome =
  | {
      ok: true
      /** Assigned from the branch actually taken — never predicted before the write. */
      action: 'create' | 'update' | 'skip'
      externalId: string
      localId: string
      resolvedVia: ResolvedVia
    }
  | {
      ok: false
      action: 'failed'
      externalId: string
      errorMessage: string
      /** Kept for logging; the engine only reads `errorMessage`. */
      cause: unknown
    }

export class WriterResultKeyError extends Error {
  constructor(
    readonly commandId: string,
    readonly resultKey: string,
    readonly received: unknown,
  ) {
    super(
      `[internal] ${commandId} returned no \`${resultKey}\` and no \`id\`; refusing to store an empty external-id mapping`,
    )
    this.name = 'WriterResultKeyError'
  }
}

// ── Command context ──────────────────────────────────────────────────────────────────────────

/**
 * Build the runtime context every command executes under.
 *
 * `auth: null` because a scheduled sync has no end user. The organization scope is pinned to the
 * single organization being synced — the bus enforces writes against it, so a too-wide scope here
 * would let a mapping bug write into a sibling organization without erroring.
 */
export function buildCommandContext(
  container: AwilixContainer,
  scope: TenantScope,
): SyncCommandContext {
  return {
    container,
    auth: null,
    organizationScope: {
      selectedId: scope.organizationId,
      filterIds: [scope.organizationId],
      allowedIds: [scope.organizationId],
      tenantId: scope.tenantId,
    },
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
  }
}

// ── Upsert specification ─────────────────────────────────────────────────────────────────────

export type UpsertSpec = {
  /** Shopify's id for this record, as persisted in the mapping table. */
  externalId: string
  mappingEntityType: MappingEntityType
  createCommand: CommandId
  updateCommand: CommandId
  /**
   * Key holding the new id in the create command's result (`productId`, `variantId`, …).
   * Falls back to `id`; if neither is present we throw rather than map an empty id.
   */
  resultKey: string
  /** Re-read used to validate a mapping hit. Build with `writer.rowReader(...)`. */
  readById: (localId: string) => Promise<EntityRow | null>
  /** Natural-key fallback (sku / handle / email). Build with `writer.naturalKeyLookup(...)`. */
  findByNaturalKey?: () => Promise<EntityRow | null>
  buildCreateInput: () => Record<string, unknown> | Promise<Record<string, unknown>>
  /**
   * Update payload for an existing row. Return `null` to record a `skip` — that is the seam a
   * content-hash check hangs off, so an unchanged record costs one read and no write.
   * `id` is merged in automatically.
   */
  buildUpdateInput: (existing: {
    localId: string
    row: EntityRow
  }) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>
}

export type EntityWriter = {
  /** Shared across every command in this run. */
  readonly commandContext: SyncCommandContext
  /** A scoped `id` read for one entity class. Always adds tenant/org/deletedAt. */
  rowReader(entityName: unknown): (localId: string) => Promise<EntityRow | null>
  /** A scoped single-field lookup (sku / handle / email). Always adds tenant/org/deletedAt. */
  naturalKeyLookup(
    entityName: unknown,
    field: string,
  ): (value: string | null | undefined) => Promise<EntityRow | null>
  upsert(spec: UpsertSpec): Promise<WriteOutcome>
}

export type EntityWriterOptions = {
  container: AwilixContainer
  scope: TenantScope
  /** Owning integration id — the mapping table is partitioned by it. */
  integrationId: string
  commandBus: CommandBusPort
  externalIdMapping: ExternalIdMappingPort
  findOne: FindOnePort
}

/**
 * Build the writer once per sync run, then upsert each item through it.
 *
 * Everything an adapter would otherwise have to remember — command context, scoped reads,
 * two-stage resolution, mapping healing, result-key unwrapping, error containment — lives behind
 * `upsert`, so the four adapters differ only in their payload builders.
 */
export function createEntityWriter(options: EntityWriterOptions): EntityWriter {
  const { container, scope, integrationId, commandBus, externalIdMapping, findOne } = options
  const commandContext = buildCommandContext(container, scope)

  // Every read this module performs carries the full scope. `deletedAt: null` is what keeps a
  // soft-deleted row from being treated as live, and is the reason the mapping re-read works.
  const scopedWhere = (extra: Record<string, unknown>): Record<string, unknown> => ({
    ...extra,
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    deletedAt: null,
  })

  const rowReader =
    (entityName: unknown) =>
    async (localId: string): Promise<EntityRow | null> =>
      findOne(entityName, scopedWhere({ id: localId }), undefined, scope)

  const naturalKeyLookup =
    (entityName: unknown, field: string) =>
    async (value: string | null | undefined): Promise<EntityRow | null> => {
      // A blank natural key would otherwise match an arbitrary row with a null column.
      if (typeof value !== 'string' || value.trim() === '') return null
      return findOne(entityName, scopedWhere({ [field]: value }), undefined, scope)
    }

  /**
   * Mapping first, natural key second, re-validating in between.
   *
   * The re-read is not optional. `lookupLocalId` answers "did we ever map this?", not "does the
   * row still exist?" — so a mapping surviving a soft delete would otherwise route us into the
   * update branch and resurrect the deleted record.
   */
  async function resolveExisting(
    spec: UpsertSpec,
  ): Promise<{ localId: string; row: EntityRow; via: ResolvedVia } | null> {
    const mappedId = await externalIdMapping.lookupLocalId(
      integrationId,
      spec.mappingEntityType,
      spec.externalId,
      scope,
    )
    if (mappedId) {
      const row = await spec.readById(mappedId)
      if (row) return { localId: mappedId, row, via: 'mapping' }
      // Mapping points at a row that is gone. Fall through — the natural key may find a live
      // replacement, and if it does the mapping gets repointed at it below.
    }

    const row = await spec.findByNaturalKey?.()
    if (row) return { localId: row.id, row, via: 'natural_key' }

    return null
  }

  /** Unwrap the bus envelope and the command's own non-uniform id key. */
  function readCreatedId(commandId: string, resultKey: string, result: unknown): string {
    const payload = (result ?? {}) as Record<string, unknown>
    const id = payload[resultKey] ?? payload.id
    if (typeof id !== 'string' || id === '') {
      throw new WriterResultKeyError(commandId, resultKey, result)
    }
    return id
  }

  return {
    commandContext,
    rowReader,
    naturalKeyLookup,

    async upsert(spec: UpsertSpec): Promise<WriteOutcome> {
      // One try/catch around the whole item. Anything that escapes here aborts the run for every
      // other item too, so the adapter gets a failure OUTCOME rather than an exception.
      try {
        const existing = await resolveExisting(spec)

        if (existing) {
          const updateInput = await spec.buildUpdateInput(existing)

          if (updateInput === null) {
            // Nothing changed. Still heal a natural-key match, or every future run repeats the
            // fallback lookup for this record; a mapping hit needs no rewrite, and skips are the
            // hot path on re-runs.
            if (existing.via === 'natural_key') {
              await externalIdMapping.storeExternalIdMapping(
                integrationId,
                spec.mappingEntityType,
                existing.localId,
                spec.externalId,
                scope,
              )
            }
            return {
              ok: true,
              action: 'skip',
              externalId: spec.externalId,
              localId: existing.localId,
              resolvedVia: existing.via,
            }
          }

          await commandBus.execute(spec.updateCommand, {
            input: { ...updateInput, id: existing.localId },
            ctx: commandContext,
          })

          // Store on the update branch too. This is what heals a row matched by the natural key
          // rather than by an existing mapping — without it such a row is re-resolved the slow way
          // forever, and an upstream sku/handle change orphans it entirely.
          await externalIdMapping.storeExternalIdMapping(
            integrationId,
            spec.mappingEntityType,
            existing.localId,
            spec.externalId,
            scope,
          )

          return {
            ok: true,
            action: 'update',
            externalId: spec.externalId,
            localId: existing.localId,
            resolvedVia: existing.via,
          }
        }

        const createInput = await spec.buildCreateInput()
        const created = await commandBus.execute(spec.createCommand, {
          input: createInput,
          ctx: commandContext,
        })
        const localId = readCreatedId(spec.createCommand, spec.resultKey, created?.result)

        await externalIdMapping.storeExternalIdMapping(
          integrationId,
          spec.mappingEntityType,
          localId,
          spec.externalId,
          scope,
        )

        return {
          ok: true,
          action: 'create',
          externalId: spec.externalId,
          localId,
          resolvedVia: 'created',
        }
      } catch (error) {
        return {
          ok: false,
          action: 'failed',
          externalId: spec.externalId,
          errorMessage: error instanceof Error ? error.message : String(error),
          cause: error,
        }
      }
    },
  }
}

// ── Reporting ────────────────────────────────────────────────────────────────────────────────

/**
 * Convert an outcome into the engine's `ImportItem`.
 *
 * The failure shape is load-bearing: `logImportItemFailures` reads `data.errorMessage`, so an
 * error recorded anywhere else is counted as failed but reported as blank in the admin UI.
 */
export function toImportItem(
  outcome: WriteOutcome,
  data: Record<string, unknown> = {},
): ImportItem {
  if (!outcome.ok) {
    return {
      externalId: outcome.externalId,
      action: 'failed',
      data: { ...data, sourceIdentifier: outcome.externalId, errorMessage: outcome.errorMessage },
    }
  }
  return {
    externalId: outcome.externalId,
    action: outcome.action,
    data: { ...data, localId: outcome.localId, resolvedVia: outcome.resolvedVia },
  }
}

// ── Custom fields ────────────────────────────────────────────────────────────────────────────

/**
 * Drop values we have no data for.
 *
 * `setCustomFieldsIfAny` only short-circuits when the WHOLE map is empty — a per-key `null` is
 * written through and BLANKS the stored value. Since Shopify omits fields it has nothing for
 * (and a metafield absent from a payload is not the same as one cleared upstream), a sync would
 * otherwise erase data every time an optional field was missing. Prune first.
 */
export function pruneEmptyCustomFieldValues(
  values: Record<string, unknown>,
): Record<string, unknown> {
  const pruned: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && value.trim() === '') continue
    if (Array.isArray(value) && value.length === 0) continue
    pruned[key] = value
  }
  return pruned
}

/** Injected `setCustomFieldsIfAny`, wired by the adapter so no framework code loads here. */
export type CustomFieldWriterPort = (input: {
  entityId: string
  recordId: string
  tenantId: string
  organizationId: string
  values: Record<string, unknown>
}) => Promise<void>

/**
 * Write custom-field values for one record, if there are any worth writing.
 *
 * `entityId` is typed to the COLON dialect — the commands' dot ids and the mapping table's bare
 * snake ids are both compile errors here, which is the only reliable defence against a mix-up
 * that would otherwise store values against an entity type nothing ever reads.
 */
export async function writeCustomFields(input: {
  write: CustomFieldWriterPort
  entityId: CustomFieldEntityId
  recordId: string
  scope: TenantScope
  values: Record<string, unknown>
}): Promise<boolean> {
  const values = pruneEmptyCustomFieldValues(input.values)
  if (Object.keys(values).length === 0) return false
  await input.write({
    entityId: input.entityId,
    recordId: input.recordId,
    tenantId: input.scope.tenantId,
    organizationId: input.scope.organizationId,
    values,
  })
  return true
}

// ── Port conformance ─────────────────────────────────────────────────────────────────────────
// The ports above were verified assignable from the real `CommandBus` and `ExternalIdMappingService`
// with `type Assert<P, A extends P> = A` while those types were importable; the assertion was
// confirmed to fail (TS2344) against a deliberately wrong port before being removed, so the check
// was doing real work rather than passing vacuously. It cannot live here permanently — importing
// the framework types breaks ts-jest, per the module note above. The check still happens, just
// later and once per entity: the first adapter that passes a real service into
// `createEntityWriter` re-proves both ports under `yarn typecheck`.
