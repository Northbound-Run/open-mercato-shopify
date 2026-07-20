import type {
  IntegrationBundle,
  IntegrationDefinition,
} from '@open-mercato/shared/modules/integrations/types'
import { buildIntegrationDetailWidgetSpotId } from '@open-mercato/shared/modules/integrations/types'
import {
  BUNDLE_ID,
  DEFAULT_API_VERSION,
  HEALTH_CHECK_SERVICE,
  INTEGRATION_ID,
  PROVIDER_KEY,
  SUPPORTED_API_VERSIONS,
} from './lib/constants'

export const syncShopifyDetailWidgetSpotId = buildIntegrationDetailWidgetSpotId(BUNDLE_ID)

const PACKAGE_NAME = '@northbound-run/sync-shopify'

/**
 * One bundle holds the shared Shopify connection; each sync integration references it by
 * `bundleId` and inherits its credentials. Credential resolution falls through from the
 * integration to the bundle, so the merchant connects once and enables entities independently.
 *
 * NOTE ON OAUTH: we deliberately do NOT use the framework's declarative `oauth` credential-field
 * type here. It takes static `authUrl`/`tokenUrl`, but Shopify's OAuth endpoints are per-shop
 * (`https://{shop}.myshopify.com/admin/oauth/...`) and therefore only knowable after
 * `shopDomain` is entered. We drive the flow from our own api/oauth/{authorize,callback} routes
 * instead, which build the URL from the stored shopDomain.
 */
export const bundle: IntegrationBundle = {
  id: BUNDLE_ID,
  title: 'Shopify',
  description:
    'Sync products, collections, customers and orders from a Shopify store into Open Mercato.',
  icon: 'shopify',
  package: PACKAGE_NAME,
  healthCheck: { service: HEALTH_CHECK_SERVICE },
  credentials: {
    fields: [
      {
        key: 'shopDomain',
        label: 'Shop domain',
        type: 'url',
        required: true,
        placeholder: 'mystore.myshopify.com',
        helpText: 'Your permanent .myshopify.com domain, not a custom storefront domain.',
      },
      {
        key: 'clientId',
        label: 'Client ID',
        type: 'text',
        required: true,
        helpText: 'From your Shopify app in the Dev Dashboard, under API credentials.',
      },
      {
        key: 'clientSecret',
        label: 'Client secret',
        type: 'secret',
        required: true,
        helpText:
          'The value beginning shpss_. Used both for the OAuth exchange and to verify webhook signatures.',
      },
      {
        key: 'apiVersion',
        label: 'Admin API version',
        type: 'select',
        required: true,
        options: SUPPORTED_API_VERSIONS.map((version) => ({
          value: version,
          label: version === DEFAULT_API_VERSION ? `${version} (recommended)` : version,
        })),
        helpText:
          'Pin to a supported version. Older versions silently omit collections that use the 2026-07 model.',
      },
      {
        key: 'accessToken',
        label: 'Admin API access token',
        type: 'secret',
        required: false,
        placeholder: 'shpat_…',
        helpText:
          'Set automatically when you connect via OAuth. Only enter this by hand if you already hold a token from a pre-existing custom app.',
      },
    ],
  },
}

export const bundles: IntegrationBundle[] = [bundle]

function syncIntegration(
  id: string,
  providerKey: string,
  title: string,
  description: string,
): IntegrationDefinition {
  return {
    id,
    title,
    description,
    icon: 'shopify',
    bundleId: BUNDLE_ID,
    category: 'data_sync',
    hub: 'data_sync',
    providerKey,
    package: PACKAGE_NAME,
    author: 'Northbound',
    license: 'MIT',
    docsUrl: 'https://github.com/northbound-run/open-mercato-shopify#readme',
    tags: ['shopify', 'ecommerce', 'import'],
    detailPage: { widgetSpotId: syncShopifyDetailWidgetSpotId },
    // Enabling an integration is an explicit act — a freshly installed module should never
    // start pulling a merchant's store on its own.
    defaultState: { isEnabled: false },
  }
}

export const integrations: IntegrationDefinition[] = [
  syncIntegration(
    INTEGRATION_ID.products,
    PROVIDER_KEY.products,
    'Shopify — Products',
    'Imports products, variants and prices into the Open Mercato catalog.',
  ),
  syncIntegration(
    INTEGRATION_ID.collections,
    PROVIDER_KEY.collections,
    'Shopify — Collections',
    'Imports collections as product categories, including membership.',
  ),
  syncIntegration(
    INTEGRATION_ID.customers,
    PROVIDER_KEY.customers,
    'Shopify — Customers',
    'Imports customers and their addresses.',
  ),
  syncIntegration(
    INTEGRATION_ID.orders,
    PROVIDER_KEY.orders,
    'Shopify — Orders',
    'Imports orders, line items, addresses and payments. Limited to the last 60 days unless the app holds read_all_orders.',
  ),
]

export default integrations
