#!/usr/bin/env node
// Standalone Shopify connection probe.
//
// The same probe is exposed as `yarn mercato sync_shopify test-connection` once the module is
// installed in an Open Mercato app. This runner exists so credentials can be validated BEFORE
// installing anything — the probe's import chain (probe → client → token → shop-domain →
// throttle) deliberately pulls in no @open-mercato runtime code, only @shopify/admin-api-client.
//
//   yarn probe --shop mystore.myshopify.com --client-id <id> --client-secret <secret>
//
// Or via environment, including Node's own .env support:
//   node --env-file=.env scripts/probe.mjs
//
// Exit code is 0 for a working connection (warnings included) and 1 for a broken one, so it is
// usable in a health check.

import { formatProbeResult, probeConnection } from '../dist/modules/sync_shopify/lib/probe.js'

const ENV = {
  shopDomain: 'OM_INTEGRATION_SHOPIFY_SHOP_DOMAIN',
  clientId: 'OM_INTEGRATION_SHOPIFY_CLIENT_ID',
  clientSecret: 'OM_INTEGRATION_SHOPIFY_CLIENT_SECRET',
  apiVersion: 'OM_INTEGRATION_SHOPIFY_API_VERSION',
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const body = arg.slice(2)
    const eq = body.indexOf('=')
    if (eq !== -1) {
      out[body.slice(0, eq)] = body.slice(eq + 1)
      continue
    }
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out[body] = next
      i += 1
    } else {
      out[body] = true
    }
  }
  return out
}

const flags = parseArgs(process.argv.slice(2))

if (flags.help || flags.h) {
  console.log(`
Shopify connection probe

  yarn probe --shop <domain> --client-id <id> --client-secret <secret> [--api-version <v>]

Flags fall back to environment variables:
  ${ENV.shopDomain}
  ${ENV.clientId}
  ${ENV.clientSecret}
  ${ENV.apiVersion}          (optional)

Node can load these from a file directly:
  node --env-file=.env scripts/probe.mjs
`)
  process.exit(0)
}

const shopDomain = flags.shop ?? flags['shop-domain'] ?? process.env[ENV.shopDomain] ?? ''
const clientId = flags['client-id'] ?? process.env[ENV.clientId] ?? ''
const clientSecret = flags['client-secret'] ?? process.env[ENV.clientSecret] ?? ''
const apiVersion = flags['api-version'] ?? process.env[ENV.apiVersion] ?? undefined

if (!shopDomain || !clientId || !clientSecret) {
  const missing = [
    !shopDomain && '--shop',
    !clientId && '--client-id',
    !clientSecret && '--client-secret',
  ].filter(Boolean)
  console.error(`\n  ✗ Missing ${missing.join(', ')}.  Run with --help for usage.\n`)
  process.exit(1)
}

console.log(`\nProbing ${shopDomain}\n`)

try {
  const result = await probeConnection({ shopDomain, clientId, clientSecret, apiVersion })
  console.log(formatProbeResult(result))
  console.log('')
  process.exit(result.ok ? 0 : 1)
} catch (error) {
  // A throw here is a bug in the probe itself — every expected failure is reported as a step.
  console.error(`\n  ✗ Probe crashed: ${error?.stack ?? error}\n`)
  process.exit(1)
}
