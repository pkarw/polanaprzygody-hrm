// Renders .ai/specs/assets/patient-ui-mockups.html into one PNG per screen frame.
// Usage: node .ai/specs/assets/render-patient-mockups.mjs
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const src = `file://${path.join(dir, 'patient-ui-mockups.html')}`

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 })
await page.goto(src, { waitUntil: 'load' })
const screens = await page.evaluate(() => window.__SCREENS)

let n = 0
for (const s of screens) {
  n += 1
  const slug = s.label.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)
  const file = path.join(dir, `patient-ui-${String(n).padStart(2, '0')}-${slug}.png`)
  await page.locator(`#${s.id}`).screenshot({ path: file })
  console.log(`${file}`)
}
await browser.close()
