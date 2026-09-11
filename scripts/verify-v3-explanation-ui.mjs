import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || 'playwright'
)
const base = process.env.UI_TEST_ORIGIN || 'http://127.0.0.1:5174'
assert.equal(new URL(base).hostname, '127.0.0.1')
const preview = `${base}/test/ui/v3-explanation-preview.html`
const output = 'harness-artifacts/decision-explanation-ui'
await fs.mkdir(output, { recursive: true })
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
})
const results = []

try {
  for (const width of [320, 768, 1024, 1440]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      serviceWorkers: 'block',
    })
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === base
        ? route.continue()
        : route.abort())
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(preview, { waitUntil: 'networkidle' })
    await page.getByRole('button', {
      name: '决策依据',
      exact: true,
    }).click()
    const explanation = page.locator('.decision-ai-explanation')
    await explanation.waitFor()
    assert.match(
      await explanation.innerText(),
      /为什么.*最强反方.*何时失效.*证据缺口/s,
    )
    const geometry = await page.evaluate(() => {
      const summary = document.querySelector('.decision-summary')
      const bounds = summary.getBoundingClientRect()
      return {
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        summaryLeft: bounds.left,
        summaryRight: bounds.right,
        summaryWidth: summary.clientWidth,
        summaryScrollWidth: summary.scrollWidth,
      }
    })
    assert.ok(
      geometry.scrollWidth <= geometry.width + 1,
      JSON.stringify(geometry),
    )
    assert.ok(
      geometry.summaryLeft >= -1
        && geometry.summaryRight <= geometry.width + 1,
      JSON.stringify(geometry),
    )
    assert.ok(
      geometry.summaryScrollWidth <= geometry.summaryWidth + 1,
      JSON.stringify(geometry),
    )
    assert.deepEqual(errors, [])
    await page.screenshot({
      path: `${output}/${width}.png`,
      fullPage: true,
    })
    results.push(geometry)
    await context.close()
  }
  await fs.writeFile(
    `${output}/geometry.json`,
    JSON.stringify(results, null, 2),
  )
  console.log(JSON.stringify({
    passed: true,
    viewports: results.map((item) => item.width),
    sections: 4,
  }))
} finally {
  await browser.close()
}
