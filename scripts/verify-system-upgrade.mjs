import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.UI_TEST_ORIGIN || 'http://127.0.0.1:5174'
assert.ok(new URL(base).hostname === '127.0.0.1', 'Only the isolated local fixture is allowed')
const preview = `${base}/test/ui/system-upgrade-preview.html`
const output = 'harness-artifacts/system-upgrade'
await fs.mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results = []

try {
  for (const width of [320, 768, 1024, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url())
      return url.origin === base ? route.continue() : route.abort()
    })
    async function check(view) {
      await page.locator('h1').scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${output}/${page.viewportSize().width}-${view}.png`, fullPage: true })
      const geometry = await page.evaluate(() => {
        const rect = (element) => {
          const r = element.getBoundingClientRect()
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
        }
        const visible = (element) => element.getClientRects().length
          && getComputedStyle(element).visibility !== 'hidden'
        const buttons = [...document.querySelectorAll('.nav-tabs .nav-tab')].filter(visible)
        const assistant = document.querySelector('.ai-fab')
        const overlaps = assistant && visible(assistant) && buttons.some((button) => {
          const a = rect(assistant)
          const b = rect(button)
          return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
            && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
        })
        return {
          width: innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          navigationButtons: buttons.length,
          assistantOverlap: Boolean(overlaps),
          heading: document.querySelector('h1')?.textContent,
        }
      })
      assert.ok(geometry.scrollWidth <= geometry.width + 1, JSON.stringify({ view, geometry }))
      assert.equal(geometry.navigationButtons, 3)
      assert.equal(geometry.assistantOverlap, false)
      results.push({ view, ...geometry })
    }
    await page.goto(preview, { waitUntil: 'networkidle' })
    await page.getByRole('heading', { level: 1, name: '今日作战' }).waitFor()
    await page.locator('.combat-command-center').waitFor()
    assert.equal(
      await page.locator('.combat-command-group').first()
        .getByText('演示标准仓').count(),
      1,
    )
    assert.equal(
      await page.locator('.combat-command-center')
        .getByText('当前没有需要立即处理的操作。').count(),
      0,
    )
    await check('selection')
    await page.locator('.nav-tabs:visible').getByRole('button', { name: /持仓/ }).click()
    await page.locator('.account-risk-strip').waitFor()
    await page.locator('.execution-queue').waitFor()
    const monitoredHolding = page.locator(
      '.trade-card[data-code="002475"]',
    )
    await monitoredHolding.locator('.monitoring-rules').waitFor()
    assert.equal(
      await monitoredHolding
        .locator('.action-command-primary')
        .textContent(),
      '继续持有',
    )
    assert.equal(
      await monitoredHolding
        .locator('.action-command-qty')
        .textContent(),
      '1手',
    )
    assert.equal(
      await monitoredHolding
        .locator('.monitoring-rules-head b')
        .textContent(),
      '运行中',
    )
    assert.deepEqual(
      await monitoredHolding
        .locator('.monitoring-rule strong')
        .allTextContents(),
      [
        '股价≤54元 或 主力净额≤-3亿元 → 清仓1手',
        '股价≥56元 → 清仓1手',
        '主力净额≥0亿元 且 股价站上分时均价线持续60秒 → 继续持有',
      ],
    )
    const monitoredText = await monitoredHolding.textContent()
    assert.doesNotMatch(monitoredText, /51\.88|59\.5/)
    const monitoredGeometry = await monitoredHolding.evaluate(
      (element) => {
        const rows = [
          ...element.querySelectorAll('.monitoring-rule'),
        ]
        const rules = element.querySelector(
          '.monitoring-rules',
        )
        const ruleStyle = rows[0]
          ? getComputedStyle(rows[0])
          : null
        const containerStyle = rules
          ? getComputedStyle(rules)
          : null
        return {
          width: element.clientWidth,
          scrollWidth: element.scrollWidth,
          rules: rows.length,
          monitoringBorderTop:
            containerStyle?.borderTopWidth,
          monitoringBorderRadius:
            containerStyle?.borderRadius,
          monitoringBackground:
            containerStyle?.backgroundColor,
          ruleBorderTop: ruleStyle?.borderTopWidth,
          redundantProgress:
            element.querySelectorAll(
              '.action-progress',
            ).length,
          childrenInsideRows: rows.every((row) => {
            const bounds = row.getBoundingClientRect()
            return [...row.children].every((child) => {
              const childBounds = child.getBoundingClientRect()
              return childBounds.left >= bounds.left - 1
                && childBounds.right <= bounds.right + 1
                && childBounds.top >= bounds.top - 1
                && childBounds.bottom <= bounds.bottom + 1
                && child.scrollWidth <= child.clientWidth + 1
            })
          }),
        }
      },
    )
    assert.ok(
      monitoredGeometry.scrollWidth
        <= monitoredGeometry.width + 1,
      JSON.stringify({ width, monitoredGeometry }),
    )
    assert.equal(monitoredGeometry.rules, 3)
    assert.equal(monitoredGeometry.childrenInsideRows, true)
    assert.equal(monitoredGeometry.monitoringBorderTop, '0px')
    assert.equal(monitoredGeometry.monitoringBorderRadius, '0px')
    assert.equal(
      monitoredGeometry.monitoringBackground,
      'rgba(0, 0, 0, 0)',
    )
    assert.equal(monitoredGeometry.ruleBorderTop, '0px')
    assert.equal(monitoredGeometry.redundantProgress, 0)
    results.push({
      view: 'monitoring-card',
      width,
      ...monitoredGeometry,
    })
    await monitoredHolding.screenshot({
      path: `${output}/${width}-monitoring-card.png`,
    })
    const conditional = page.locator('.plan-cand').filter({ hasText: '演示候选A' })
    const approved = page.locator('.plan-cand').filter({ hasText: '演示候选B' })
    assert.equal(
      await conditional.locator('.action-command-qty').textContent(),
      '预案最多 · 20手',
    )
    assert.equal(await approved.locator('.action-command-qty').textContent(), '1手')
    await page.locator('.selection-origin > summary').first().click()
    assert.equal(await page.locator('.selection-origin[open]').count(), 1)
    await check('positions')
    await page.locator('.plan-cand .stock-name-link').first().click()
    await page.locator('.detail-panel .selection-origin').waitFor()
    await page.waitForTimeout(400)
    const dialog = await page.locator('.detail-panel').boundingBox()
    assert.ok(dialog.x >= -1 && dialog.x + dialog.width <= width + 1)
    await page.screenshot({ path: `${output}/${width}-stock-detail.png` })
    await page.getByRole('button', { name: '关闭个股详情', exact: true }).click()
    await page.getByRole('button', { name: '资金与仓位', exact: true }).click()
    await page.locator('.acc-hero').waitFor()
    await check('account')
    await page.locator('.nav-tabs:visible').getByRole('button', { name: /复盘/ }).click()
    await page.locator('.selection-performance').waitFor()
    await check('review')
    await page.goto(`${preview}?tab=research`, { waitUntil: 'networkidle' })
    await page.locator('.research').waitFor()
    await check('legacy-research')
    await page.goto(`${preview}?tab=hub&sub=account`, { waitUntil: 'networkidle' })
    await page.locator('.acc-hero').waitFor()
    await check('legacy-account')
    if (width === 1440) {
      await page.getByRole('button', { name: '切到白天模式', exact: true }).click()
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'light')
      await check('light-account')
      await page.setViewportSize({ width: 320, height: 900 })
      await check('light-account')
    }
    assert.deepEqual(errors, [])
    await context.close()
  }
  await fs.writeFile(`${output}/geometry.json`, JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ passed: results.length, results }, null, 2))
} finally {
  await browser.close()
}
