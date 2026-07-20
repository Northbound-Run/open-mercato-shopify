export const metadata = {
  id: 'sync_shopify',
  title: 'Shopify Sync',
  description:
    'Sync a Shopify store into Open Mercato: products, variants and prices, collections, customers and orders.',
  // Both must be enabled in the host app: `integrations` owns credentials/state/logs,
  // `data_sync` owns the run engine, cursors and queues.
  requires: ['integrations', 'data_sync'],
  ejectable: true,
}

export default metadata
