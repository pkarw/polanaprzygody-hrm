// Renders .ai/specs/assets/pbook-ui-mockups.html into one PNG per screen frame.
// Usage: node .ai/specs/assets/render-pbook-mockups.mjs
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const src = `file://${path.join(dir, 'pbook-ui-mockups.html')}`

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1700, height: 1100 }, deviceScaleFactor: 2 })
await page.goto(src, { waitUntil: 'load' })
const screens = await page.evaluate(() => window.__SCREENS)

let n = 0
for (const s of screens) {
  n += 1
  const file = path.join(dir, `pbook-ui-${String(n).padStart(2, '0')}-${s.label}.png`)
  await page.locator(`#${s.id}`).screenshot({ path: file })
  console.log(file)
}
await browser.close()
