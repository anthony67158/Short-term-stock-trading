import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || 'playwright'
)
const base = process.env.UI_TEST_ORIGIN || 'http://127.0.0.1:5174'
assert.equal(new URL(base).hostname, '127.0.0.1')
const preview = `${base}/test/ui/llm-role-preview.html`
const output = 'harness-artifacts/llm-role-ui'
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
    await page.locator('.llm-cfg').waitFor()

    const text = await page.locator('.llm-cfg').innerText()
    assert.match(text, /4 个角色 · 5 个端点/)
    assert.match(text, /V3决策与组合解释/)
    assert.match(text, /智能体助手/)
    assert.match(text, /策略日报/)
    assert.match(text, /板块前瞻/)
    assert.doesNotMatch(text, /交易确认 Judge|军师操作建议生成|复核角色/)
    assert.equal(await page.locator('.llm-role-group').count(), 4)
    assert.equal(await page.locator('.llm-role-endpoint').count(), 5)

    const geometry = await page.evaluate(() => {
      const modal = document.querySelector('.llm-cfg')
      const bounds = modal.getBoundingClientRect()
      return {
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        modalLeft: bounds.left,
        modalRight: bounds.right,
        modalWidth: modal.clientWidth,
        modalScrollWidth: modal.scrollWidth,
      }
    })
    assert.ok(
      geometry.scrollWidth <= geometry.width + 1,
      JSON.stringify(geometry),
    )
    assert.ok(
      geometry.modalLeft >= -1
        && geometry.modalRight <= geometry.width + 1,
      JSON.stringify(geometry),
    )
    assert.ok(
      geometry.modalScrollWidth <= geometry.modalWidth + 1,
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
    roles: 4,
    endpoints: 5,
  }))
} finally {
  await browser.close()
}
