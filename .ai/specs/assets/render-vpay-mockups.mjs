// Renders .ai/specs/assets/vpay-ui-mockups.html into one PNG per screen frame.
// Usage: node .ai/specs/assets/render-vpay-mockups.mjs
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const src = `file://${path.join(dir, 'vpay-ui-mockups.html')}`

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1700, height: 1200 }, deviceScaleFactor: 2 })
await page.goto(src, { waitUntil: 'load' })
const screens = await page.evaluate(() => window.__SCREENS)

for (const s of screens) {
  const file = path.join(dir, s.file)
  await page.locator(`#${s.id}`).screenshot({ path: file })
  console.log(file)
}
await browser.close()
