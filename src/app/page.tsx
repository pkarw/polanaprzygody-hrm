import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import PublicBookingHomePage from '@/modules/public_booking/frontend/page'

export const metadata: Metadata = {
  title: 'Polana Przygody — Centrum Rozwoju Dziecka',
  description: 'Umów wizytę online w Centrum Rozwoju Dziecka Polana Przygody we Wrocławiu.',
}

function isAutoLoginEnabled(): boolean {
  return Boolean(process.env.OM_AUTOLOGIN_EMAIL?.trim() && process.env.OM_AUTOLOGIN_PASSWORD)
}

// Authenticated staff keep the direct backend entry. Anonymous visitors land
// on the app-owned public Polana site; /login remains available explicitly.
export default async function Home() {
  const auth = await getAuthFromCookies()

  // Demo autologin: when OM_AUTOLOGIN_* credentials are configured and there is
  // no active session, hand off to the autologin route which signs the visitor
  // in and drops them into the app. Fully gated behind env vars — with them
  // unset, behavior below is unchanged. The route falls back to /login when the
  // credentials are invalid, so a misconfigured demo can never loop.
  if (!auth && isAutoLoginEnabled()) {
    redirect('/api/auth/autologin')
  }

  if (auth) redirect('/backend')
  return <PublicBookingHomePage />
}
