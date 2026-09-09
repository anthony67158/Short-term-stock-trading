import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || 'playwright'
)
const base =
  process.env.UI_TEST_ORIGIN || 'http://127.0.0.1:5174'
assert.equal(
  new URL(base).hostname,
  '127.0.0.1',
  'Only the isolated local fixture is allowed',
)

const output = 'harness-artifacts/banner-lifecycle'
await fs.mkdir(output, { recursive: true })
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
})
const results = []

try {
  for (const width of [320, 1440]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      serviceWorkers: 'block',
    })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) =>
      errors.push(error.message)
    )
    await page.goto(
      `${base}/test/ui/banner-lifecycle-preview.html`,
      { waitUntil: 'domcontentloaded' },
    )

    await page.waitForTimeout(500)
    assert.equal(
      await page.locator('.alert-banner').count(),
      0,
      '历史云端事件不应重新弹横幅',
    )

    const banner = page.locator('.alert-banner')
    await banner.getByText(
      '实时新事件｜减仓1手',
      { exact: true },
    ).waitFor()
    const bounds = await banner.boundingBox()
    assert.ok(bounds)
    assert.ok(bounds.x >= -1)
    assert.ok(bounds.x + bounds.width <= width + 1)
    assert.ok(
      await banner.evaluate((element) =>
        element.scrollWidth <= element.clientWidth + 1
      ),
    )
    await page.screenshot({
      path: `${output}/${width}-live.png`,
      fullPage: true,
    })

    await page.waitForTimeout(4500)
    assert.equal(
      await page.locator('.alert-banner').count(),
      0,
      '实时横幅应在4秒后自动消失',
    )
    assert.deepEqual(errors, [])
    results.push({
      width,
      title: '实时新事件｜减仓1手',
      historyBannerCount: 0,
      liveBannerCount: 1,
      autoDismissed: true,
      bounds,
    })
    await context.close()
  }
} finally {
  await browser.close()
}

await fs.writeFile(
  `${output}/report.json`,
  JSON.stringify({ passed: true, results }, null, 2),
)
console.log(JSON.stringify({ passed: true, results }, null, 2))
