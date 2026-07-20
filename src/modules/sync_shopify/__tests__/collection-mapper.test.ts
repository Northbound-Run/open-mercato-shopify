import {
  mapCollection,
  mapCollectionProductIds,
  readRuleInfo,
  toNodeList,
  toSlug,
} from '../lib/mappers/collection'

// Pure mapping only — no client, no writer, no container. Every fixture below is shaped like a
// real GraphQL/JSONL payload rather than like the mapper's own types, because the mapper's job is
// precisely to survive what Shopify actually sends.

const BASE = {
  id: 'gid://shopify/Collection/42',
  title: 'Summer Sale',
  handle: 'summer-sale',
  descriptionHtml: '<p>Everything for the season.</p>',
  updatedAt: '2026-07-19T10:00:00Z',
}

describe('toNodeList', () => {
  it('flattens the connection, nodes and plain-list forms alike', () => {
    const expected = [{ id: 'a' }, { id: 'b' }]
    expect(toNodeList({ edges: [{ node: { id: 'a' } }, { node: { id: 'b' } }] })).toEqual(expected)
    expect(toNodeList({ nodes: [{ id: 'a' }, { id: 'b' }] })).toEqual(expected)
    expect(toNodeList([{ id: 'a' }, { id: 'b' }])).toEqual(expected)
  })

  it('returns nothing for shapes it does not recognise instead of throwing', () => {
    for (const value of [null, undefined, 'text', 7, {}, { edges: null }]) {
      expect(toNodeList(value)).toEqual([])
    }
  })
})

describe('toSlug', () => {
  it('passes a conventional Shopify handle through unchanged', () => {
    expect(toSlug('summer-sale')).toBe('summer-sale')
    expect(toSlug('new_arrivals_2026')).toBe('new_arrivals_2026')
  })

  it('coerces a handle that would fail slugSchema rather than letting the command reject it', () => {
    // slugSchema is /^[a-z0-9\-_]+$/ — an accented or spaced handle is a 400 from the command.
    expect(toSlug('Été Collection')).toBe('t-collection')
    expect(toSlug('  Spaced  Out  ')).toBe('spaced-out')
    expect(toSlug('trailing---')).toBe('trailing')
  })

  it('caps at the 150-character slug limit', () => {
    expect(toSlug('a'.repeat(400))).toHaveLength(150)
  })

  it('returns null rather than an empty or invented slug', () => {
    expect(toSlug('!!!')).toBeNull()
    expect(toSlug('')).toBeNull()
    expect(toSlug(undefined)).toBeNull()
  })
})

describe('mapCollection', () => {
  it('maps title, handle and description onto the category fields', () => {
    const mapped = mapCollection(BASE)
    expect(mapped).not.toBeNull()
    expect(mapped!.externalId).toBe('gid://shopify/Collection/42')
    expect(mapped!.name).toBe('Summer Sale')
    expect(mapped!.slug).toBe('summer-sale')
    expect(mapped!.description).toBe('<p>Everything for the season.</p>')
    expect(mapped!.updatedAt).toBe('2026-07-19T10:00:00Z')
  })

  it('never derives a parent: Shopify collections are flat and no hierarchy is recoverable', () => {
    // A handle that *looks* hierarchical must not become one. Inventing a tree from a separator
    // would produce a structure an operator would reasonably believe came from Shopify.
    const mapped = mapCollection({ ...BASE, handle: 'mens-shoes-boots', title: 'Mens > Shoes > Boots' })
    expect(mapped).not.toHaveProperty('parentId')
    expect(mapped!.name).toBe('Mens > Shoes > Boots')
  })

  it('emits an empty description rather than null so a cleared description clears locally', () => {
    // The command reads `parsed.description?.trim()?.length ? … : null`, so '' clears the column
    // while an omitted key leaves it alone — and null fails zod outright (optional, not nullable).
    const mapped = mapCollection({ ...BASE, descriptionHtml: undefined })
    expect(mapped!.description).toBe('')
  })

  it('truncates to the lengths the category schema accepts', () => {
    const mapped = mapCollection({
      ...BASE,
      title: 'T'.repeat(400),
      descriptionHtml: 'D'.repeat(5000),
    })
    expect(mapped!.name).toHaveLength(255)
    expect(mapped!.description).toHaveLength(2000)
  })

  it('falls back to the handle when the title is blank, since name is required', () => {
    const mapped = mapCollection({ ...BASE, title: '   ' })
    expect(mapped!.name).toBe('summer-sale')
  })

  it('returns null for a payload that cannot become a category', () => {
    expect(mapCollection(null)).toBeNull()
    expect(mapCollection('nope')).toBeNull()
    // No id: nothing to map an external id to.
    expect(mapCollection({ title: 'Orphan' })).toBeNull()
    // No id, no title, no handle: nothing to name it either.
    expect(mapCollection({ id: BASE.id, title: '', handle: '' })).toBeNull()
  })

  it('tolerates a payload missing every optional field', () => {
    const mapped = mapCollection({ id: BASE.id, title: 'Bare' })
    expect(mapped).toEqual({
      externalId: BASE.id,
      name: 'Bare',
      slug: null,
      description: '',
      updatedAt: null,
      rules: { hasUnpreservedSources: false, readFrom: 'none', sourceTypes: [] },
    })
  })
})

describe('readRuleInfo — the 2026-07 sources model', () => {
  it('reads `sources` and flags the definition as unpreserved', () => {
    const info = readRuleInfo({
      ...BASE,
      sources: [{ __typename: 'CollectionSourceInclusion' }, { __typename: 'CollectionSourceInclusion' }],
    })
    expect(info).toEqual({
      hasUnpreservedSources: true,
      readFrom: 'sources',
      // Deduplicated: the point is to notice an unfamiliar type name after an API bump, not to
      // count occurrences.
      sourceTypes: ['CollectionSourceInclusion'],
    })
  })

  it('reads `sources` in connection form too, in case a release changes its shape', () => {
    const info = readRuleInfo({
      ...BASE,
      sources: { edges: [{ node: { __typename: 'CollectionSourceInclusion' } }] },
    })
    expect(info.hasUnpreservedSources).toBe(true)
    expect(info.readFrom).toBe('sources')
  })

  it('prefers `sources` over `ruleSet` when a payload carries both', () => {
    // On 2026-07 both can appear. `ruleSet` is the deprecated one and is the one that will vanish.
    const info = readRuleInfo({
      ...BASE,
      sources: [{ __typename: 'CollectionSourceInclusion' }],
      ruleSet: { appliedDisjunctively: false, rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'sale' }] },
    })
    expect(info.readFrom).toBe('sources')
  })

  it('degrades gracefully on a legacy ruleSet-only payload', () => {
    // A pre-2026-07 capture. We never QUERY ruleSet, but a fixture or a replayed payload should
    // still report honestly rather than read as "manual collection, no rules".
    const info = readRuleInfo({
      ...BASE,
      ruleSet: {
        appliedDisjunctively: true,
        rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'summer' }],
      },
    })
    expect(info).toEqual({ hasUnpreservedSources: true, readFrom: 'ruleSet', sourceTypes: [] })
  })

  it('treats an empty ruleSet as a manual collection', () => {
    expect(readRuleInfo({ ...BASE, ruleSet: { rules: [] } })).toEqual({
      hasUnpreservedSources: false,
      readFrom: 'ruleSet',
      sourceTypes: [],
    })
  })

  it('reports a manual collection when neither field is present', () => {
    expect(readRuleInfo(BASE)).toEqual({ hasUnpreservedSources: false, readFrom: 'none', sourceTypes: [] })
    expect(readRuleInfo({ ...BASE, sources: [] })).toEqual({
      hasUnpreservedSources: false,
      readFrom: 'none',
      sourceTypes: [],
    })
  })

  it('surfaces source information through mapCollection, where the adapter reads it', () => {
    const mapped = mapCollection({ ...BASE, sources: [{ __typename: 'CollectionSourceInclusion' }] })
    expect(mapped!.rules.hasUnpreservedSources).toBe(true)
  })
})

describe('mapCollectionProductIds', () => {
  it('reads a live products connection', () => {
    const ids = mapCollectionProductIds({
      edges: [
        { node: { id: 'gid://shopify/Product/1' } },
        { node: { id: 'gid://shopify/Product/2' } },
      ],
    })
    expect(ids).toEqual(['gid://shopify/Product/1', 'gid://shopify/Product/2'])
  })

  it('reads already-flattened bulk child nodes', () => {
    const ids = mapCollectionProductIds([
      { id: 'gid://shopify/Product/1', type: 'Product', fields: {}, children: {} },
      { id: 'gid://shopify/Product/2', type: 'Product', fields: {}, children: {} },
    ])
    expect(ids).toEqual(['gid://shopify/Product/1', 'gid://shopify/Product/2'])
  })

  it('deduplicates while preserving Shopify order, which becomes assignment position', () => {
    const ids = mapCollectionProductIds([{ id: 'p-2' }, { id: 'p-1' }, { id: 'p-2' }])
    expect(ids).toEqual(['p-2', 'p-1'])
  })

  it('drops entries with no id rather than emitting a blank member', () => {
    expect(mapCollectionProductIds([{ id: 'p-1' }, {}, { id: '' }, { id: null }])).toEqual(['p-1'])
  })

  it('returns nothing when the connection is absent', () => {
    expect(mapCollectionProductIds(undefined)).toEqual([])
  })
})
