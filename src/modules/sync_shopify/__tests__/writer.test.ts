import {
  buildCommandContext,
  createEntityWriter,
  pruneEmptyCustomFieldValues,
  toImportItem,
  writeCustomFields,
  type CommandBusPort,
  type EntityRow,
  type EntityWriterOptions,
  type ExternalIdMappingPort,
  type FindOnePort,
  type UpsertSpec,
} from '../lib/writer'

// The framework never loads at test runtime, so every collaborator is a recorded stub. The
// assertions below deliberately check the exact identifier STRINGS handed to each stub: crossing
// the three id dialects fails silently in production, so the only place it can be caught is here.

const SCOPE = { organizationId: 'org-1', tenantId: 'tenant-1' }
const INTEGRATION_ID = 'sync_shopify_products'
const CONTAINER = { resolve: () => undefined } as unknown as EntityWriterOptions['container']

type CommandCall = { commandId: string; input: Record<string, unknown>; ctx: unknown }
type MappingStoreCall = {
  integrationId: string
  entityType: string
  localId: string
  externalId: string
}
type FindOneCall = { entityName: unknown; where: Record<string, unknown>; scope: unknown }

function makeHarness(
  overrides: {
    mappedId?: string | null
    results?: Record<string, unknown>
    onExecute?: (call: CommandCall) => void
  } = {},
) {
  const commandCalls: CommandCall[] = []
  const mappingStores: MappingStoreCall[] = []
  const lookupCalls: Array<{ entityType: string; externalId: string }> = []
  const findOneCalls: FindOneCall[] = []
  const rows = new Map<string, EntityRow>()

  const commandBus: CommandBusPort = {
    async execute(commandId, options) {
      const call = { commandId, input: options.input as Record<string, unknown>, ctx: options.ctx }
      commandCalls.push(call)
      overrides.onExecute?.(call)
      return { result: overrides.results?.[commandId] ?? { productId: 'local-new' } }
    },
  }

  const externalIdMapping: ExternalIdMappingPort = {
    async lookupLocalId(_integrationId, entityType, externalId) {
      lookupCalls.push({ entityType, externalId })
      return overrides.mappedId ?? null
    },
    async storeExternalIdMapping(integrationId, entityType, localId, externalId) {
      mappingStores.push({ integrationId, entityType, localId, externalId })
      return {}
    },
  }

  const findOne: FindOnePort = async (entityName, where, _options, scope) => {
    findOneCalls.push({ entityName, where, scope })
    // Stand-in for a scoped read: a row is only visible if the store holds it AND the where clause
    // asks for live rows, which is what makes the soft-delete case below meaningful.
    if (where.deletedAt !== null) return null
    if (typeof where.id === 'string') return rows.get(where.id) ?? null
    const [field, value] = Object.entries(where).find(
      ([key]) => !['id', 'organizationId', 'tenantId', 'deletedAt'].includes(key),
    ) ?? []
    if (!field) return null
    for (const row of rows.values()) if (row[field] === value) return row
    return null
  }

  const writer = createEntityWriter({
    container: CONTAINER,
    scope: SCOPE,
    integrationId: INTEGRATION_ID,
    commandBus,
    externalIdMapping,
    findOne,
  })

  return { writer, commandCalls, mappingStores, lookupCalls, findOneCalls, rows }
}

function makeSpec(h: ReturnType<typeof makeHarness>, over: Partial<UpsertSpec> = {}): UpsertSpec {
  return {
    externalId: 'gid://shopify/Product/1',
    mappingEntityType: 'catalog_product',
    createCommand: 'catalog.products.create',
    updateCommand: 'catalog.products.update',
    resultKey: 'productId',
    readById: h.writer.rowReader('CatalogProduct'),
    findByNaturalKey: () => h.writer.naturalKeyLookup('CatalogProduct', 'sku')('SKU-1'),
    buildCreateInput: () => ({ title: 'Shirt', sku: 'SKU-1' }),
    buildUpdateInput: () => ({ title: 'Shirt' }),
    ...over,
  }
}

describe('buildCommandContext', () => {
  it('pins the organization scope to the single organization being synced', () => {
    const ctx = buildCommandContext(CONTAINER, SCOPE)
    // auth is null: a scheduled sync has no end user.
    expect(ctx.auth).toBeNull()
    expect(ctx.organizationScope).toEqual({
      selectedId: 'org-1',
      filterIds: ['org-1'],
      allowedIds: ['org-1'],
      tenantId: 'tenant-1',
    })
    expect(ctx.selectedOrganizationId).toBe('org-1')
    expect(ctx.organizationIds).toEqual(['org-1'])
  })
})

describe('createEntityWriter — create path', () => {
  it('creates via the CommandBus and maps the returned id', async () => {
    const h = makeHarness()
    const outcome = await h.writer.upsert(makeSpec(h))

    expect(outcome).toEqual({
      ok: true,
      action: 'create',
      externalId: 'gid://shopify/Product/1',
      localId: 'local-new',
      resolvedVia: 'created',
    })
    expect(h.commandCalls).toHaveLength(1)
    expect(h.commandCalls[0]!.commandId).toBe('catalog.products.create')
    expect(h.commandCalls[0]!.input).toEqual({ title: 'Shirt', sku: 'SKU-1' })
    expect(h.mappingStores).toEqual([
      {
        integrationId: INTEGRATION_ID,
        entityType: 'catalog_product',
        localId: 'local-new',
        externalId: 'gid://shopify/Product/1',
      },
    ])
  })

  it('passes the same command context to every command', async () => {
    const h = makeHarness()
    await h.writer.upsert(makeSpec(h))
    expect(h.commandCalls[0]!.ctx).toBe(h.writer.commandContext)
  })
})

describe('createEntityWriter — update path', () => {
  it('updates the mapped row and merges its id into the input', async () => {
    const h = makeHarness({ mappedId: 'local-7' })
    h.rows.set('local-7', { id: 'local-7', sku: 'SKU-1' })

    const outcome = await h.writer.upsert(makeSpec(h))

    expect(outcome).toMatchObject({ ok: true, action: 'update', localId: 'local-7', resolvedVia: 'mapping' })
    expect(h.commandCalls).toHaveLength(1)
    expect(h.commandCalls[0]!.commandId).toBe('catalog.products.update')
    expect(h.commandCalls[0]!.input).toEqual({ title: 'Shirt', id: 'local-7' })
  })

  it('calls storeExternalIdMapping on the update branch too', async () => {
    const h = makeHarness({ mappedId: 'local-7' })
    h.rows.set('local-7', { id: 'local-7', sku: 'SKU-1' })

    await h.writer.upsert(makeSpec(h))

    expect(h.mappingStores).toHaveLength(1)
    expect(h.mappingStores[0]).toMatchObject({ localId: 'local-7', entityType: 'catalog_product' })
  })

  it('never predicts the action before the write — a mapped-but-missing row still reports create', async () => {
    // No stored row and no natural-key match: despite a mapping hit, this is a create.
    const h = makeHarness({ mappedId: 'local-gone' })
    const outcome = await h.writer.upsert(makeSpec(h, { findByNaturalKey: undefined }))

    expect(outcome).toMatchObject({ action: 'create', resolvedVia: 'created' })
    expect(h.commandCalls[0]!.commandId).toBe('catalog.products.create')
  })
})

describe('createEntityWriter — resolution', () => {
  it('re-reads the mapped row and falls back to the natural key when it is soft-deleted', async () => {
    // The mapping survives the soft delete; the row does not. Without the re-read this would take
    // the update branch and resurrect the deleted record.
    const h = makeHarness({ mappedId: 'local-deleted' })
    h.rows.set('local-live', { id: 'local-live', sku: 'SKU-1' })

    const outcome = await h.writer.upsert(makeSpec(h))

    expect(outcome).toMatchObject({ ok: true, action: 'update', localId: 'local-live', resolvedVia: 'natural_key' })
    expect(h.commandCalls[0]!.input).toEqual({ title: 'Shirt', id: 'local-live' })
  })

  it('heals a natural-key match by repointing the mapping at the live row', async () => {
    const h = makeHarness({ mappedId: null })
    h.rows.set('local-live', { id: 'local-live', sku: 'SKU-1' })

    await h.writer.upsert(makeSpec(h))

    expect(h.mappingStores).toEqual([
      {
        integrationId: INTEGRATION_ID,
        entityType: 'catalog_product',
        localId: 'local-live',
        externalId: 'gid://shopify/Product/1',
      },
    ])
  })

  it('scopes every read with organizationId, tenantId and deletedAt: null', async () => {
    const h = makeHarness({ mappedId: 'local-7' })
    h.rows.set('local-7', { id: 'local-7', sku: 'SKU-1' })

    await h.writer.upsert(makeSpec(h))

    expect(h.findOneCalls).not.toHaveLength(0)
    for (const call of h.findOneCalls) {
      expect(call.where).toMatchObject({
        organizationId: 'org-1',
        tenantId: 'tenant-1',
        deletedAt: null,
      })
      expect(call.scope).toEqual(SCOPE)
    }
  })

  it('does not match on a blank natural key', async () => {
    const h = makeHarness({ mappedId: null })
    h.rows.set('local-live', { id: 'local-live', sku: '  ' })

    const outcome = await h.writer.upsert(
      makeSpec(h, { findByNaturalKey: () => h.writer.naturalKeyLookup('CatalogProduct', 'sku')('  ') }),
    )

    expect(outcome).toMatchObject({ action: 'create' })
  })
})

describe('createEntityWriter — skip path', () => {
  it('reports skip and issues no command when buildUpdateInput returns null', async () => {
    const h = makeHarness({ mappedId: 'local-7' })
    h.rows.set('local-7', { id: 'local-7', sku: 'SKU-1' })

    const outcome = await h.writer.upsert(makeSpec(h, { buildUpdateInput: () => null }))

    expect(outcome).toMatchObject({ ok: true, action: 'skip', localId: 'local-7' })
    expect(h.commandCalls).toHaveLength(0)
  })

  it('does not rewrite a mapping it already resolved through (skips are the re-run hot path)', async () => {
    const h = makeHarness({ mappedId: 'local-7' })
    h.rows.set('local-7', { id: 'local-7', sku: 'SKU-1' })

    await h.writer.upsert(makeSpec(h, { buildUpdateInput: () => null }))

    expect(h.mappingStores).toHaveLength(0)
  })

  it('still heals a natural-key match that turns out to be unchanged', async () => {
    const h = makeHarness({ mappedId: null })
    h.rows.set('local-live', { id: 'local-live', sku: 'SKU-1' })

    await h.writer.upsert(makeSpec(h, { buildUpdateInput: () => null }))

    expect(h.mappingStores).toEqual([
      expect.objectContaining({ localId: 'local-live', externalId: 'gid://shopify/Product/1' }),
    ])
  })

  it('hands the existing row to buildUpdateInput so a content hash can decide', async () => {
    const h = makeHarness({ mappedId: 'local-7' })
    h.rows.set('local-7', { id: 'local-7', sku: 'SKU-1', contentHash: 'abc' })
    const seen: Array<{ localId: string; row: EntityRow }> = []

    await h.writer.upsert(
      makeSpec(h, {
        buildUpdateInput: (existing) => {
          seen.push(existing)
          return existing.row.contentHash === 'abc' ? null : { title: 'Shirt' }
        },
      }),
    )

    expect(seen).toHaveLength(1)
    expect(seen[0]!.row.contentHash).toBe('abc')
    expect(h.commandCalls).toHaveLength(0)
  })
})

describe('createEntityWriter — result key', () => {
  it('falls back to `id` when the command does not use a per-entity key', async () => {
    const h = makeHarness({ results: { 'catalog.categories.create': { id: 'cat-9' } } })
    const outcome = await h.writer.upsert(
      makeSpec(h, {
        mappingEntityType: 'catalog_product_category',
        createCommand: 'catalog.categories.create',
        updateCommand: 'catalog.categories.update',
        resultKey: 'categoryId',
        findByNaturalKey: undefined,
      }),
    )

    expect(outcome).toMatchObject({ ok: true, action: 'create', localId: 'cat-9' })
    expect(h.mappingStores[0]).toMatchObject({ localId: 'cat-9', entityType: 'catalog_product_category' })
  })

  it('fails the item when neither the result key nor `id` is present', async () => {
    // Storing `undefined` here would poison every later lookup for this record.
    const h = makeHarness({ results: { 'catalog.products.create': { somethingElse: 'x' } } })
    const outcome = await h.writer.upsert(makeSpec(h, { findByNaturalKey: undefined }))

    expect(outcome.ok).toBe(false)
    expect(outcome).toMatchObject({ action: 'failed' })
    if (outcome.ok) throw new Error('expected failure')
    expect(outcome.errorMessage).toContain('productId')
    expect(h.mappingStores).toHaveLength(0)
  })

  it('rejects an empty-string id as hard as a missing one', async () => {
    const h = makeHarness({ results: { 'catalog.products.create': { productId: '' } } })
    const outcome = await h.writer.upsert(makeSpec(h, { findByNaturalKey: undefined }))

    expect(outcome.ok).toBe(false)
    expect(h.mappingStores).toHaveLength(0)
  })

  it('reads through the bus envelope, not the raw result', async () => {
    // execute() resolves to { result, logEntry } — the id sits one level deeper than it reads.
    const h = makeHarness({ results: { 'catalog.products.create': { productId: 'p-1' } } })
    const outcome = await h.writer.upsert(makeSpec(h, { findByNaturalKey: undefined }))
    expect(outcome).toMatchObject({ localId: 'p-1' })
  })
})

describe('createEntityWriter — error containment', () => {
  it('returns a failure outcome instead of throwing when a command fails', async () => {
    // A throw would escape the adapter loop and finalise the whole run as failed.
    const h = makeHarness({
      onExecute: () => {
        throw new Error('catalog.products.create rejected: title is required')
      },
    })

    const outcome = await h.writer.upsert(makeSpec(h, { findByNaturalKey: undefined }))

    expect(outcome).toMatchObject({
      ok: false,
      action: 'failed',
      externalId: 'gid://shopify/Product/1',
      errorMessage: 'catalog.products.create rejected: title is required',
    })
  })

  it('contains a failure raised while resolving, not just while writing', async () => {
    // Needs a mapping hit, otherwise the re-read never runs and there is nothing to throw.
    const h = makeHarness({ mappedId: 'local-7' })
    const outcome = await h.writer.upsert(
      makeSpec(h, {
        readById: async () => {
          throw new Error('db unavailable')
        },
        findByNaturalKey: undefined,
      }),
    )
    expect(outcome).toMatchObject({ ok: false, action: 'failed', errorMessage: 'db unavailable' })
  })

  it('contains a failure raised while building the payload', async () => {
    const h = makeHarness()
    const outcome = await h.writer.upsert(
      makeSpec(h, {
        buildCreateInput: () => {
          throw new Error('payload build failed')
        },
        findByNaturalKey: undefined,
      }),
    )
    expect(outcome).toMatchObject({ ok: false, errorMessage: 'payload build failed' })
  })

  it('contains a failure raised by the mapping write after the command already succeeded', async () => {
    // The row is written but unmapped. Reporting `failed` is correct: the next run re-resolves it
    // by natural key and heals the mapping, which is exactly why that fallback exists.
    const h = makeHarness()
    const outcome = await createEntityWriter({
      container: CONTAINER,
      scope: SCOPE,
      integrationId: INTEGRATION_ID,
      commandBus: { async execute() { return { result: { productId: 'p-1' } } } },
      externalIdMapping: {
        async lookupLocalId() { return null },
        async storeExternalIdMapping() { throw new Error('mapping table unavailable') },
      },
      findOne: async () => null,
    }).upsert(makeSpec(h, { findByNaturalKey: undefined }))

    expect(outcome).toMatchObject({ ok: false, action: 'failed', errorMessage: 'mapping table unavailable' })
  })

  it('stringifies a non-Error throw rather than reporting an empty message', async () => {
    const h = makeHarness({
      onExecute: () => {
        throw 'plain string rejection'
      },
    })
    const outcome = await h.writer.upsert(makeSpec(h, { findByNaturalKey: undefined }))
    expect(outcome).toMatchObject({ ok: false, errorMessage: 'plain string rejection' })
  })
})

describe('createEntityWriter — id dialects', () => {
  it('uses bare snake for the mapping, dot for commands, and never crosses them', async () => {
    const h = makeHarness({ mappedId: 'local-7' })
    h.rows.set('local-7', { id: 'local-7', sku: 'SKU-1' })

    await h.writer.upsert(makeSpec(h))

    // BARE SNAKE on both mapping calls — a colon id here silently looks up nothing.
    expect(h.lookupCalls).toEqual([
      { entityType: 'catalog_product', externalId: 'gid://shopify/Product/1' },
    ])
    expect(h.mappingStores[0]!.entityType).toBe('catalog_product')
    expect(h.mappingStores[0]!.entityType).not.toContain(':')
    expect(h.mappingStores[0]!.entityType).not.toContain('.')

    // DOT for the command id.
    expect(h.commandCalls[0]!.commandId).toBe('catalog.products.update')
    expect(h.commandCalls[0]!.commandId).not.toContain(':')
  })

  it('uses the colon dialect for custom fields', async () => {
    const calls: Array<{ entityId: string; values: Record<string, unknown> }> = []
    const wrote = await writeCustomFields({
      write: async (input) => {
        calls.push({ entityId: input.entityId, values: input.values })
      },
      entityId: 'catalog:catalog_product',
      recordId: 'local-7',
      scope: SCOPE,
      values: { shopifyHandle: 'shirt' },
    })

    expect(wrote).toBe(true)
    expect(calls[0]!.entityId).toBe('catalog:catalog_product')
    expect(calls[0]!.entityId).toContain(':')
  })
})

describe('custom fields', () => {
  it('never blanks a field it has no data for', async () => {
    // setCustomFieldsIfAny writes a per-key null straight through, so pruning has to happen first.
    expect(
      pruneEmptyCustomFieldValues({
        keep: 'value',
        zero: 0,
        no: false,
        dropNull: null,
        dropUndefined: undefined,
        dropBlank: '   ',
        dropEmptyArray: [],
        keepArray: ['a'],
      }),
    ).toEqual({ keep: 'value', zero: 0, no: false, keepArray: ['a'] })
  })

  it('skips the write entirely when nothing survives pruning', async () => {
    const write = jest.fn()
    const wrote = await writeCustomFields({
      write,
      entityId: 'catalog:catalog_product',
      recordId: 'local-7',
      scope: SCOPE,
      values: { oosRatio: null, note: '' },
    })

    expect(wrote).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('forwards the scope as tenantId/organizationId', async () => {
    const write = jest.fn()
    await writeCustomFields({
      write,
      entityId: 'catalog:catalog_product_variant',
      recordId: 'v-1',
      scope: SCOPE,
      values: { barcode: '123' },
    })

    expect(write).toHaveBeenCalledWith({
      entityId: 'catalog:catalog_product_variant',
      recordId: 'v-1',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      values: { barcode: '123' },
    })
  })
})

describe('toImportItem', () => {
  it('puts the message where logImportItemFailures reads it', async () => {
    const h = makeHarness({
      onExecute: () => {
        throw new Error('boom')
      },
    })
    const outcome = await h.writer.upsert(makeSpec(h, { findByNaturalKey: undefined }))
    const item = toImportItem(outcome, { rowNumber: 3 })

    expect(item).toEqual({
      externalId: 'gid://shopify/Product/1',
      action: 'failed',
      data: {
        rowNumber: 3,
        sourceIdentifier: 'gid://shopify/Product/1',
        errorMessage: 'boom',
      },
    })
  })

  it('reports the action the writer actually took', async () => {
    const h = makeHarness()
    const outcome = await h.writer.upsert(makeSpec(h, { findByNaturalKey: undefined }))
    const item = toImportItem(outcome)

    expect(item.action).toBe('create')
    expect(item.data).toMatchObject({ localId: 'local-new', resolvedVia: 'created' })
  })
})
