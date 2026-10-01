import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'public_booking',
  title: 'Public booking',
  version: '0.1.0',
  description: 'Anonymous appointment discovery and booking for Polana Przygody.',
  author: 'Polana Przygody',
  license: 'UNLICENSED',
  requires: ['catalog', 'staff', 'resources', 'customers', 'patient', 'api_keys'],
}

export default metadata
