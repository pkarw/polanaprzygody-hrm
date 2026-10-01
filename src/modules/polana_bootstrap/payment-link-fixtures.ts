import { POLANA_CATALOG_FIXTURES } from './catalog-fixtures'

export const POLANA_PAYMENT_TEMPLATE_PREFIX = 'Polana — '
export const POLANA_MULTI_PAYMENT_TEMPLATE_NAME = `${POLANA_PAYMENT_TEMPLATE_PREFIX}wizyta wieloskładnikowa`
export const POLANA_MULTI_PAYMENT_FIXTURE_KEY = 'visit:multi'
export const POLANA_CHECKOUT_LOGO_URL = 'https://polanaprzygody.pl/logo-polana.svg'

export const GENERIC_CHECKOUT_TEMPLATE_NAMES = [
  'Consulting Fee',
  'Donation',
  'Event Ticket',
] as const

export type PolanaPaymentTemplateFixture = {
  fixtureKey: string
  sku: string | null
  name: string
  title: string
  description: string
  fixedPriceAmount: number
  status: 'active' | 'draft'
}

export const POLANA_PAYMENT_TEMPLATE_FIXTURES: readonly PolanaPaymentTemplateFixture[] = [
  ...POLANA_CATALOG_FIXTURES.map((service) => ({
    fixtureKey: `service:${service.sku}`,
    sku: service.sku,
    name: `${POLANA_PAYMENT_TEMPLATE_PREFIX}${service.title}`,
    title: service.title,
    description: service.description ?? 'Płatność za wizytę w Centrum Rozwoju Dziecka Polana Przygody.',
    fixedPriceAmount: service.pricePln,
    status: 'active' as const,
  })),
  {
    fixtureKey: POLANA_MULTI_PAYMENT_FIXTURE_KEY,
    sku: null,
    name: POLANA_MULTI_PAYMENT_TEMPLATE_NAME,
    title: 'Płatność za wizytę',
    description: 'Bazowy szablon płatności za wizytę obejmującą więcej niż jedną usługę.',
    fixedPriceAmount: 1,
    status: 'draft',
  },
] as const
