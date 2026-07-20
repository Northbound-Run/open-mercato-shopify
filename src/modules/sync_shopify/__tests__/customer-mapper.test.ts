import {
  customerContentHash,
  isStorableEmail,
  isStorablePhone,
  mapAddress,
  mapCustomer,
  readEmail,
  readPhone,
  resolveNames,
  type ShopifyCustomerNode,
  type ShopifyMailingAddress,
} from '../lib/mappers/customer'

// Fixtures use obviously-fake personal data, but the PII assertions below treat it as real: the
// point of those tests is that the VALUES never escape into anything loggable, and a test that
// only worked for tidy data would not prove that.

const EMAIL = 'ada.lovelace@example.com'
const PHONE = '+442071234567'

function address(over: Partial<ShopifyMailingAddress> = {}): ShopifyMailingAddress {
  return {
    id: 'gid://shopify/MailingAddress/1',
    address1: '12 Riverside Walk',
    address2: 'Flat 4',
    city: 'London',
    province: 'Greater London',
    provinceCode: 'LND',
    country: 'United Kingdom',
    countryCodeV2: 'GB',
    zip: 'SE1 9RT',
    company: 'Analytical Engines Ltd',
    firstName: 'Ada',
    lastName: 'Lovelace',
    name: 'Ada Lovelace',
    ...over,
  }
}

function customer(over: Partial<ShopifyCustomerNode> = {}): ShopifyCustomerNode {
  return {
    id: 'gid://shopify/Customer/1001',
    firstName: 'Ada',
    lastName: 'Lovelace',
    displayName: 'Ada Lovelace',
    defaultEmailAddress: { emailAddress: EMAIL },
    defaultPhoneNumber: { phoneNumber: PHONE },
    note: 'Prefers courier delivery',
    tags: ['vip', 'wholesale'],
    state: 'ENABLED',
    updatedAt: '2026-07-19T10:00:00Z',
    defaultAddress: { id: 'gid://shopify/MailingAddress/1' },
    addressesV2: { nodes: [address()] },
    ...over,
  }
}

describe('accessors — 2026-07 replaces the deprecated flat fields', () => {
  it('prefers defaultEmailAddress/defaultPhoneNumber over the deprecated flat fields', () => {
    const node = customer({
      defaultEmailAddress: { emailAddress: 'new@example.com' },
      email: 'stale@example.com',
      defaultPhoneNumber: { phoneNumber: '+15551234567' },
      phone: '+441111111111',
    })
    expect(readEmail(node)).toBe('new@example.com')
    expect(readPhone(node)).toBe('+15551234567')
  })

  it('falls back to the deprecated flat fields when the accessor is absent', () => {
    // A deprecated field still RESOLVES, so an older pin or a replayed payload must keep mapping
    // rather than silently turning every email into null.
    const node = customer({
      defaultEmailAddress: null,
      email: 'legacy@example.com',
      defaultPhoneNumber: null,
      phone: PHONE,
    })
    expect(readEmail(node)).toBe('legacy@example.com')
    expect(readPhone(node)).toBe(PHONE)
  })

  it('returns null when neither accessor nor fallback carries a value', () => {
    const node = customer({ defaultEmailAddress: null, email: null, defaultPhoneNumber: null, phone: null })
    expect(readEmail(node)).toBeNull()
    expect(readPhone(node)).toBeNull()
  })
})

describe('mapCustomer — core fields', () => {
  it('maps names, email, phone, note and state', () => {
    const mapped = mapCustomer(customer())
    expect(mapped).toMatchObject({
      externalId: 'gid://shopify/Customer/1001',
      firstName: 'Ada',
      lastName: 'Lovelace',
      displayName: 'Ada Lovelace',
      primaryEmail: EMAIL,
      primaryPhone: PHONE,
      description: 'Prefers courier delivery',
      status: 'enabled',
      updatedAt: '2026-07-19T10:00:00Z',
    })
    expect(mapped.notes).toEqual([])
  })

  it('lowercases the email to match the command handler own normalization', () => {
    // The command lowercases on write; matching it here stops a re-run seeing a phantom change.
    expect(mapCustomer(customer({ defaultEmailAddress: { emailAddress: 'ADA@EXAMPLE.COM' } })).primaryEmail).toBe(
      'ada@example.com',
    )
  })

  it('lowercases state so ENABLED and enabled do not become two dictionary entries', () => {
    for (const state of ['ENABLED', 'DISABLED', 'INVITED', 'DECLINED']) {
      expect(mapCustomer(customer({ state })).status).toBe(state.toLowerCase())
    }
  })

  it('carries tags as labels but never as something writable', () => {
    // `personCreateSchema.tags` is `z.array(uuid())`, so labels must not reach the command.
    const mapped = mapCustomer(customer({ tags: ['vip', ' wholesale ', ''] }))
    expect(mapped.tags).toEqual(['vip', 'wholesale'])
  })

  it('maps a customer with no addresses', () => {
    const mapped = mapCustomer(customer({ addressesV2: { nodes: [] }, defaultAddress: null }))
    expect(mapped.addresses).toEqual([])
    expect(mapped.notes).toEqual([])
  })

  it('tolerates addressesV2 being absent entirely', () => {
    const mapped = mapCustomer(customer({ addressesV2: null, defaultAddress: null }))
    expect(mapped.addresses).toEqual([])
  })
})

describe('resolveNames — core requires both names, Shopify does not', () => {
  it('uses the given names and does not flag synthesis', () => {
    expect(resolveNames(customer())).toMatchObject({ firstName: 'Ada', lastName: 'Lovelace', synthesized: false })
  })

  it('synthesizes from displayName when the name fields are empty', () => {
    const node = customer({ firstName: null, lastName: null, displayName: 'Grace Brewster Hopper' })
    expect(resolveNames(node)).toMatchObject({
      firstName: 'Grace',
      lastName: 'Brewster Hopper',
      synthesized: true,
    })
  })

  it('falls back to the email local part, then to a constant', () => {
    const fromEmail = resolveNames(
      customer({ firstName: null, lastName: null, displayName: null, defaultEmailAddress: { emailAddress: EMAIL } }),
    )
    expect(fromEmail).toMatchObject({ firstName: 'ada.lovelace', lastName: 'Customer', synthesized: true })

    const bare = customer({
      firstName: null,
      lastName: null,
      displayName: null,
      defaultEmailAddress: null,
      email: null,
    })
    expect(resolveNames(bare)).toMatchObject({ firstName: 'Shopify', lastName: 'Customer', synthesized: true })
  })

  it('keeps a half-supplied name and only synthesizes the missing half', () => {
    const node = customer({ firstName: 'Ada', lastName: null, displayName: null })
    expect(resolveNames(node)).toMatchObject({ firstName: 'Ada', lastName: 'Customer', synthesized: true })
  })

  it('is deterministic, so a re-run produces the same content hash', () => {
    const node = customer({ firstName: null, lastName: null, displayName: null })
    expect(customerContentHash(mapCustomer(node))).toBe(customerContentHash(mapCustomer(node)))
  })

  it('reports synthesis as a note so a nameless customer is still imported', () => {
    const mapped = mapCustomer(customer({ firstName: null, lastName: null, displayName: null }))
    expect(mapped.notes).toContain('name_synthesized')
    expect(mapped.firstName.length).toBeGreaterThan(0)
    expect(mapped.lastName.length).toBeGreaterThan(0)
  })
})

describe('field validators mirror what core would throw on', () => {
  it('accepts an E.164 phone and rejects what isValidPhoneNumber rejects', () => {
    expect(isStorablePhone('+442071234567')).toBe(true)
    expect(isStorablePhone('+44 20 7123 4567')).toBe(true)
    // No leading `+` — core reports `missing_country_code`, which would throw and lose the customer.
    expect(isStorablePhone('02071234567')).toBe(false)
    expect(isStorablePhone('+44 (0) 207-123-4567 ext 9')).toBe(false)
    expect(isStorablePhone('+123456')).toBe(false)
    expect(isStorablePhone('+1234567890123456')).toBe(false)
  })

  it('drops an unstorable phone rather than failing the whole customer', () => {
    const mapped = mapCustomer(customer({ defaultPhoneNumber: { phoneNumber: '0207 123 4567' } }))
    expect(mapped.primaryPhone).toBeNull()
    expect(mapped.notes).toContain('phone_dropped_invalid')
    // The customer still imports — that is the entire point of dropping the field.
    expect(mapped.externalId).toBe('gid://shopify/Customer/1001')
    expect(mapped.firstName).toBe('Ada')
  })

  it('accepts a normal email and rejects what z.string().email() would', () => {
    expect(isStorableEmail('ada@example.com')).toBe(true)
    expect(isStorableEmail('not-an-email')).toBe(false)
    expect(isStorableEmail('two@at@example.com')).toBe(false)
    expect(isStorableEmail('trailing@example.')).toBe(false)
    expect(isStorableEmail('has space@example.com')).toBe(false)
  })

  it('drops an unstorable email rather than failing the whole customer', () => {
    const mapped = mapCustomer(customer({ defaultEmailAddress: { emailAddress: 'not-an-email' } }))
    expect(mapped.primaryEmail).toBeNull()
    expect(mapped.notes).toContain('email_dropped_invalid')
    expect(mapped.firstName).toBe('Ada')
  })
})

describe('addresses', () => {
  it('maps a MailingAddress onto the CustomerAddress column names', () => {
    const mapped = mapAddress(address(), {
      customerExternalId: 'gid://shopify/Customer/1001',
      index: 0,
      isPrimary: true,
    })
    expect(mapped).toEqual({
      externalId: 'gid://shopify/MailingAddress/1',
      isPrimary: true,
      addressLine1: '12 Riverside Walk',
      addressLine2: 'Flat 4',
      city: 'London',
      region: 'Greater London',
      postalCode: 'SE1 9RT',
      country: 'United Kingdom',
      companyName: 'Analytical Engines Ltd',
      name: 'Ada Lovelace',
    })
  })

  it('prefers full names over codes for region and country', () => {
    const codesOnly = mapAddress(address({ province: null, country: null }), {
      customerExternalId: 'c',
      index: 0,
      isPrimary: false,
    })
    expect(codesOnly).toMatchObject({ region: 'LND', country: 'GB' })
  })

  it('promotes address2 to the first line when address1 is missing', () => {
    // Core requires a non-empty `addressLine1`; Shopify's `address1` is nullable.
    const mapped = mapAddress(address({ address1: null }), {
      customerExternalId: 'c',
      index: 0,
      isPrimary: false,
    })
    expect(mapped?.addressLine1).toBe('Flat 4')
    // Not duplicated onto both lines.
    expect(mapped?.addressLine2).toBeNull()
  })

  it('drops an address with no locatable content at all', () => {
    const empty = address({ address1: null, address2: null, city: null, zip: null })
    expect(mapAddress(empty, { customerExternalId: 'c', index: 0, isPrimary: false })).toBeNull()
  })

  it('synthesizes a customer-scoped external id when the address carries none', () => {
    const mapped = mapAddress(address({ id: null }), {
      customerExternalId: 'gid://shopify/Customer/1001',
      index: 2,
      isPrimary: false,
    })
    expect(mapped?.externalId).toBe('gid://shopify/Customer/1001:address:2')
  })

  it('yields 3 rows with exactly one primary for a customer with 3 addresses', () => {
    const mapped = mapCustomer(
      customer({
        defaultAddress: { id: 'gid://shopify/MailingAddress/2' },
        addressesV2: {
          nodes: [
            address({ id: 'gid://shopify/MailingAddress/1', address1: 'One Way' }),
            address({ id: 'gid://shopify/MailingAddress/2', address1: 'Two Way' }),
            address({ id: 'gid://shopify/MailingAddress/3', address1: 'Three Way' }),
          ],
        },
      }),
    )
    expect(mapped.addresses).toHaveLength(3)
    expect(mapped.addresses.filter((a) => a.isPrimary)).toHaveLength(1)
    expect(mapped.addresses.find((a) => a.isPrimary)?.externalId).toBe('gid://shopify/MailingAddress/2')
  })

  it('promotes the first address when defaultAddress is missing, so a set is never primary-less', () => {
    const mapped = mapCustomer(
      customer({
        defaultAddress: null,
        addressesV2: {
          nodes: [
            address({ id: 'gid://shopify/MailingAddress/1' }),
            address({ id: 'gid://shopify/MailingAddress/2' }),
          ],
        },
      }),
    )
    expect(mapped.addresses.filter((a) => a.isPrimary)).toHaveLength(1)
    expect(mapped.addresses[0].isPrimary).toBe(true)
  })

  it('promotes another address when defaultAddress points at one that was dropped', () => {
    // The designated address has nothing locatable, so it is dropped — but the survivors must
    // still end up with exactly one primary rather than none.
    const mapped = mapCustomer(
      customer({
        defaultAddress: { id: 'gid://shopify/MailingAddress/9' },
        addressesV2: {
          nodes: [
            address({ id: 'gid://shopify/MailingAddress/9', address1: null, address2: null, city: null, zip: null }),
            address({ id: 'gid://shopify/MailingAddress/2' }),
          ],
        },
      }),
    )
    expect(mapped.addresses).toHaveLength(1)
    expect(mapped.addresses.filter((a) => a.isPrimary)).toHaveLength(1)
    expect(mapped.notes).toContain('address_dropped_unusable')
  })

  it('promotes the first address when defaultAddress names an address outside the set', () => {
    const mapped = mapCustomer(
      customer({
        defaultAddress: { id: 'gid://shopify/MailingAddress/404' },
        addressesV2: { nodes: [address({ id: 'gid://shopify/MailingAddress/1' })] },
      }),
    )
    expect(mapped.addresses.filter((a) => a.isPrimary)).toHaveLength(1)
  })

  it('ignores null members of the address list', () => {
    const mapped = mapCustomer(customer({ addressesV2: { nodes: [address(), null] } }))
    expect(mapped.addresses).toHaveLength(1)
  })
})

describe('customerContentHash', () => {
  it('is stable across identical payloads', () => {
    expect(customerContentHash(mapCustomer(customer()))).toBe(customerContentHash(mapCustomer(customer())))
  })

  it('ignores updatedAt, which Shopify bumps for changes this sync does not map', () => {
    const a = customerContentHash(mapCustomer(customer({ updatedAt: '2026-07-19T10:00:00Z' })))
    const b = customerContentHash(mapCustomer(customer({ updatedAt: '2026-07-20T23:59:00Z' })))
    expect(a).toBe(b)
  })

  it('ignores address ordering, which Shopify does not contractually guarantee', () => {
    const one = address({ id: 'gid://shopify/MailingAddress/1', address1: 'One Way' })
    const two = address({ id: 'gid://shopify/MailingAddress/2', address1: 'Two Way' })
    const forward = mapCustomer(
      customer({ defaultAddress: { id: 'gid://shopify/MailingAddress/1' }, addressesV2: { nodes: [one, two] } }),
    )
    const reversed = mapCustomer(
      customer({ defaultAddress: { id: 'gid://shopify/MailingAddress/1' }, addressesV2: { nodes: [two, one] } }),
    )
    expect(customerContentHash(forward)).toBe(customerContentHash(reversed))
  })

  it('changes when a mapped field changes', () => {
    const base = customerContentHash(mapCustomer(customer()))
    expect(customerContentHash(mapCustomer(customer({ firstName: 'Augusta' })))).not.toBe(base)
    expect(customerContentHash(mapCustomer(customer({ note: 'Changed' })))).not.toBe(base)
    expect(customerContentHash(mapCustomer(customer({ state: 'DISABLED' })))).not.toBe(base)
    expect(customerContentHash(mapCustomer(customer({ tags: ['vip'] })))).not.toBe(base)
  })

  it('changes when an address is added, edited or removed', () => {
    const base = customerContentHash(mapCustomer(customer()))
    const added = mapCustomer(
      customer({
        addressesV2: { nodes: [address(), address({ id: 'gid://shopify/MailingAddress/2' })] },
      }),
    )
    const edited = mapCustomer(customer({ addressesV2: { nodes: [address({ city: 'Bristol' })] } }))
    const removed = mapCustomer(customer({ addressesV2: { nodes: [] }, defaultAddress: null }))

    expect(customerContentHash(added)).not.toBe(base)
    expect(customerContentHash(edited)).not.toBe(base)
    expect(customerContentHash(removed)).not.toBe(base)
  })

  it('changes when the primary flag moves between addresses', () => {
    const nodes = [
      address({ id: 'gid://shopify/MailingAddress/1' }),
      address({ id: 'gid://shopify/MailingAddress/2' }),
    ]
    const first = mapCustomer(customer({ defaultAddress: { id: 'gid://shopify/MailingAddress/1' }, addressesV2: { nodes } }))
    const second = mapCustomer(customer({ defaultAddress: { id: 'gid://shopify/MailingAddress/2' }, addressesV2: { nodes } }))
    expect(customerContentHash(first)).not.toBe(customerContentHash(second))
  })
})

describe('PII containment', () => {
  it('reports compromises as codes that cannot carry a value', () => {
    const mapped = mapCustomer(
      customer({
        firstName: null,
        lastName: null,
        displayName: null,
        defaultEmailAddress: { emailAddress: 'not-an-email' },
        defaultPhoneNumber: { phoneNumber: '0207 123 4567' },
      }),
    )
    // Notes are a closed set of codes — the values that caused them are nowhere in the note.
    const serialized = JSON.stringify(mapped.notes)
    expect(serialized).not.toContain('not-an-email')
    expect(serialized).not.toContain('0207')
    expect(mapped.notes.every((note) => /^[a-z_]+$/.test(note))).toBe(true)
  })

  it('produces a content hash that does not embed the values it covers', () => {
    // The digest travels further than the record does, so it must not be reversible by inspection.
    const hash = customerContentHash(mapCustomer(customer()))
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toContain('ada')
    expect(hash).not.toContain('Riverside')
  })
})
