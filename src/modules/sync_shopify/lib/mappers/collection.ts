/**
 * Shopify Collection → Open Mercato `CatalogProductCategory`.
 *
 * Pure translation only: no network, no framework, no writes. The adapter decides *what to do*
 * with a mapped collection; this file only decides *what it means*. That split is what lets the
 * fiddly parts below — which are all about Shopify's shape, not about Open Mercato's — be tested
 * against fixtures rather than against a store.
 *
 * THREE THINGS THAT LOOK LIKE DETAIL AND ARE NOT:
 *
 * 1. READ `sources`, NEVER `ruleSet`. API 2026-07 replaced a collection's single `ruleSet` with a
 *    multi-source model. The trap is not the rename — it is that collections using the new model
 *    are SILENTLY FILTERED OUT of pre-2026-07 query results. An older pin therefore loses whole
 *    collections with no error anywhere, which is why `DEFAULT_API_VERSION` is 2026-07 and why
 *    pinning back is not a safe fallback. `ruleSet` is still parsed here, but only so a payload
 *    captured from an older version degrades gracefully instead of being read as "no rules".
 *
 * 2. SMART-COLLECTION RULES ARE NOT PRESERVED, and cannot be. Shopify computes membership from
 *    conditions server-side; Open Mercato categories have no rule engine, and `categoryCreateSchema`
 *    has nowhere to put one — it accepts name, slug, description, parentId and isActive, and
 *    nothing else. So a smart collection syncs as a STATIC SNAPSHOT of whatever it contained at
 *    read time, and drifts from then on until the next run. The rule metadata parsed below exists
 *    purely so the adapter can SAY so in the item it reports; it is never persisted. A future
 *    reader will otherwise assume rules round-trip, because everything else here does.
 *
 * 3. SHOPIFY COLLECTIONS ARE FLAT; OPEN MERCATO CATEGORIES ARE A TREE. There is no conflict, but
 *    there is also no hierarchy to recover. Nothing here derives a parent from a handle prefix or
 *    a title separator: an invented tree is worse than an honest flat list, because it looks
 *    deliberate. `parentId` is never set.
 */

// ── Open Mercato field limits ────────────────────────────────────────────────────────────────
// Mirrored from `catalog/data/validators.ts` (`categoryCreateSchema`). Enforcing them here turns a
// command-level zod rejection — which costs a round trip and reports as a per-item failure — into
// a clean local truncation. Drift here is caught the first time a real payload exceeds a limit,
// which is why the source is named.

/** `name: z.string().trim().min(1).max(255)` — required, so an unusable title has to fail. */
const MAX_NAME_LENGTH = 255

/** `description: z.string().trim().max(2000)` — truncation beats failing the whole collection. */
const MAX_DESCRIPTION_LENGTH = 2000

/** `slug: slugSchema` — `/^[a-z0-9\-_]+$/`, max 150, lowercased. */
const MAX_SLUG_LENGTH = 150

// ── Parsed shapes ────────────────────────────────────────────────────────────────────────────

/**
 * What we learned about how Shopify decides this collection's membership.
 *
 * Diagnostic only — none of it is written to the category. It rides along on the reported
 * `ImportItem` so an operator can see, in the run log, that what landed locally is a snapshot and
 * that Shopify holds definition metadata we did not keep.
 */
export type CollectionRuleInfo = {
  /**
   * Shopify holds membership-defining metadata for this collection — 2026-07 `sources`, or a
   * legacy `ruleSet` carrying rules — that we do not and cannot preserve.
   *
   * Deliberately NOT called `isRuleDriven`. `sources` is `[CollectionSource!]!`, a list of an
   * interface with exactly two implementations in 2026-07: `CollectionConditionsSource` (carries
   * `inclusion`/`exclusion` conditions — smart-collection rules) and
   * `CollectionSubCollectionsSource` (membership composed from other collections). Both are
   * server-computed and neither is a hand-curated product list, so a genuinely manual collection
   * has no sources at all and this flag stays false for it.
   *
   * The name still avoids "rule" because sub-collection composition is not a rule, and because
   * pinning behaviour to concrete type names is what a quarterly release breaks. This asks the
   * question we can answer from `__typename` alone — "is there upstream definition metadata we
   * dropped?" — and errs toward saying yes. Over-warning costs a line in a run log; under-warning
   * lets an operator believe smart-collection rules survived the import.
   */
  hasUnpreservedSources: boolean
  /**
   * Which field told us. `sources` is the 2026-07 model and the one we query; `ruleSet` means the
   * payload predates it. `none` means neither was present — a hand-built collection, or a query
   * that did not ask.
   */
  readFrom: 'sources' | 'ruleSet' | 'none'
  /**
   * `__typename`s observed on `sources`, deduplicated. Kept because this is the surface most
   * likely to change at the next quarterly release: an unfamiliar name appearing in a run log is
   * the earliest warning available that the shape moved under us — and it is the raw evidence for
   * anyone who later needs the distinction this type declines to draw.
   */
  sourceTypes: string[]
}

export type MappedCollection = {
  /** The Shopify GID, verbatim. Stable across the legacy-numeric-id transition. */
  externalId: string
  /** `CatalogProductCategory.name`. */
  name: string
  /** `CatalogProductCategory.slug`, or null when the handle cannot be made to fit `slugSchema`. */
  slug: string | null
  /**
   * `CatalogProductCategory.description`, always a string — never null and never omitted.
   *
   * The command reads `parsed.description?.trim()?.length ? … : null`, so an empty string CLEARS
   * the stored value while an omitted key leaves it alone. Emitting `''` for "Shopify has no
   * description" is therefore what makes a description cleared upstream actually clear locally.
   * (Passing `null` is not an option: the field is `.optional()` but NOT `.nullable()`, so zod
   * would reject it and the whole collection would report as failed.)
   */
  description: string
  /** Watermark source for the cursor. Null when the payload carried no usable timestamp. */
  updatedAt: string | null
  rules: CollectionRuleInfo
}

// ── Primitives ───────────────────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * Flatten either connection form or a plain list into an array of records.
 *
 * Shopify is not consistent about this even within one type, and a field can change form across
 * versions without changing name. Accepting all three shapes means a version bump that turns a
 * list into a connection degrades into "we still read it" rather than "we silently read nothing".
 */
export function toNodeList(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.map(asRecord).filter((item): item is Record<string, unknown> => item !== null)
  }

  const record = asRecord(value)
  if (!record) return []

  if (Array.isArray(record.nodes)) return toNodeList(record.nodes)
  if (Array.isArray(record.edges)) {
    return record.edges
      .map((edge) => asRecord(asRecord(edge)?.node))
      .filter((node): node is Record<string, unknown> => node !== null)
  }
  return []
}

/**
 * Coerce a Shopify handle into something `slugSchema` accepts.
 *
 * Handles are already lowercase and hyphenated in practice, so this is almost always a no-op — but
 * "almost always" is exactly the case that fails in production on a store we did not test against.
 * A slug we cannot form becomes null rather than a mangled guess: the column is nullable, and the
 * adapter still resolves the row by its external-id mapping.
 */
export function toSlug(handle: unknown): string | null {
  const raw = asString(handle)
  if (!raw) return null
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9\-_]+/g, '-')
    // Collapse and trim the separators the substitution above can leave behind.
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
  return slug.length > 0 ? slug : null
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max)
}

// ── Rules ────────────────────────────────────────────────────────────────────────────────────

/**
 * Decide whether Shopify holds membership metadata this import drops, from either model.
 *
 * `sources` is checked first and wins: on 2026-07 both may be present, and the deprecated field is
 * the one that will disappear. Note how little is extracted — a `__typename` and a yes/no. The
 * rules themselves are deliberately not modelled, because modelling them would imply we could do
 * something with them, and we cannot (see the header note).
 */
export function readRuleInfo(raw: Record<string, unknown>): CollectionRuleInfo {
  const sources = toNodeList(raw.sources)
  if (sources.length > 0) {
    const sourceTypes = Array.from(
      new Set(sources.map((source) => asString(source.__typename)).filter((t): t is string => t !== null)),
    )
    // Any source at all counts. See `hasUnpreservedSources` for why this does not try to sort
    // condition-bearing sources from curated ones.
    return { hasUnpreservedSources: true, readFrom: 'sources', sourceTypes }
  }

  // Pre-2026-07 payload, or a fixture captured from one. Read it so such a collection still reports
  // honestly, but never query for it: `ruleSet` is deprecated and its absence is expected. Here the
  // distinction IS available — a `ruleSet` with no rules is genuinely a manual collection.
  const ruleSet = asRecord(raw.ruleSet)
  if (ruleSet) {
    const rules = toNodeList(ruleSet.rules)
    return { hasUnpreservedSources: rules.length > 0, readFrom: 'ruleSet', sourceTypes: [] }
  }

  return { hasUnpreservedSources: false, readFrom: 'none', sourceTypes: [] }
}

// ── Collection ───────────────────────────────────────────────────────────────────────────────

/**
 * Translate one collection node.
 *
 * Returns null when the payload cannot produce a valid category — no id, or no usable name. The
 * caller turns that into `action: 'failed'` for that one collection; returning null rather than
 * throwing is what keeps one malformed record from aborting the run for every other record.
 *
 * `title` is preferred for the name and the handle is the fallback, because `name` is required
 * (`min(1)`) and a collection with a blank title but a valid handle is still worth importing under
 * a recognisable label.
 */
export function mapCollection(raw: unknown): MappedCollection | null {
  const record = asRecord(raw)
  if (!record) return null

  const externalId = asString(record.id)
  if (!externalId) return null

  const title = asString(record.title)
  const handle = asString(record.handle)
  const name = title ?? handle
  if (!name) return null

  return {
    externalId,
    name: truncate(name, MAX_NAME_LENGTH),
    slug: toSlug(handle),
    // `descriptionHtml`, not the long-deprecated `body`/`bodyHtml`. Falls back to the plain-text
    // `description` only so a payload from a query that asked for that instead still maps.
    description: truncate(asString(record.descriptionHtml) ?? asString(record.description) ?? '', MAX_DESCRIPTION_LENGTH),
    updatedAt: asString(record.updatedAt),
    rules: readRuleInfo(record),
  }
}

// ── Membership ───────────────────────────────────────────────────────────────────────────────

/**
 * Product GIDs belonging to a collection, in the order Shopify returned them, deduplicated.
 *
 * Order is preserved because `syncCategoryAssignments` stores it as `position`. It carries no
 * meaning we can honour across collections — a product in three categories gets one position per
 * assignment and they are renumbered on every merge — but discarding it up front would throw away
 * information for nothing.
 *
 * Accepts either the bulk-export shape (already-flattened child nodes) or a live `products`
 * connection, via `toNodeList`.
 */
export function mapCollectionProductIds(rawProducts: unknown): string[] {
  const seen = new Set<string>()
  for (const node of toNodeList(rawProducts)) {
    const id = asString(node.id)
    if (id) seen.add(id)
  }
  return [...seen]
}
