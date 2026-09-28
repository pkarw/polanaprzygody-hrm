import { redirect } from 'next/navigation'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'

function isAutoLoginEnabled(): boolean {
  return Boolean(process.env.OM_AUTOLOGIN_EMAIL?.trim() && process.env.OM_AUTOLOGIN_PASSWORD)
}

// The home route is a pure router: it never renders. It sends visitors
// straight into the app (backend when authenticated, login otherwise). The
// onboarding/role-picker page remains reachable directly at /start.
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

  redirect(auth ? '/backend' : '/login')
}
