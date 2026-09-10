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
    await page.clock.install({
      time: new Date('2026-09-10T04:30:00Z'),
    })
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
    await page.locator('.aw-actions').waitFor()
    assert.equal(
      await page.locator('.aw-actions')
        .getByText('演示标准仓').count(),
      1,
    )
    assert.equal(
      await page.locator('.aw-actions')
        .getByText('持仓风险和待成交计划均无待办').count(),
      0,
    )
    await check('selection')
    await page.locator('.nav-tabs:visible').getByRole('button', { name: /持仓/ }).click()
    await page.locator('.account-risk-strip').waitFor()
    await page.locator('.execution-queue').waitFor()
    const actionStrip = page.locator('.position-action-strip')
    await actionStrip.waitFor()
    assert.match(await actionStrip.innerText(), /演示标准仓/)
    assert.match(await actionStrip.innerText(), /补录成交/)
    if (width > 720) {
      const holdingRows = await page.locator(
        '.hold-grid .hold-item',
      ).evaluateAll((cards) => cards.map((card) => {
        const bounds = card.getBoundingClientRect()
        return {
          code: card.dataset.code,
          top: bounds.top,
          height: bounds.height,
        }
      }))
      const rows = new Map()
      for (const card of holdingRows) {
        const rowKey = String(Math.round(card.top))
        rows.set(rowKey, [...(rows.get(rowKey) || []), card])
      }
      for (const row of rows.values()) {
        if (row.length < 2) continue
        const heights = row.map((card) => card.height)
        assert.ok(
          Math.max(...heights) - Math.min(...heights) <= 1,
          JSON.stringify({ width, row }),
        )
      }
    }
    const actionStripGeometry = await actionStrip.evaluate(
      (element) => ({
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        height: element.clientHeight,
        scrollHeight: element.scrollHeight,
      }),
    )
    assert.ok(
      actionStripGeometry.scrollWidth
        <= actionStripGeometry.width + 1,
      JSON.stringify({ width, actionStripGeometry }),
    )
    const ordinary = page.locator(
      '.plan-cand[data-code="600519"]',
    )
    assert.match(await ordinary.innerText(), /普通收藏/)
    await ordinary.getByRole('button', {
      name: '纳入作战',
      exact: true,
    }).click()
    const enrollmentDialog = page.getByRole('dialog', {
      name: '纳入作战并持续跟踪？',
    })
    await enrollmentDialog.waitFor()
    assert.match(
      await enrollmentDialog.innerText(),
      /价格、资金、板块和量价变化/,
    )
    await enrollmentDialog.getByRole('button', {
      name: '取消',
      exact: true,
    }).click()
    await enrollmentDialog.waitFor({ state: 'detached' })
    const monitoredHolding = page.locator(
      '.trade-card[data-code="002475"]',
    )
    await monitoredHolding.locator('.monitoring-rules').waitFor()
    assert.equal(
      await monitoredHolding
        .locator('.v3-decision-headline strong')
        .textContent(),
      '继续持有 1 手',
    )
    assert.equal(
      await monitoredHolding
        .locator('.monitoring-rules-head b')
        .textContent(),
      '运行中3项',
    )
    assert.deepEqual(
      await monitoredHolding
        .locator('.monitoring-rule strong')
        .allTextContents(),
      [
        '股价≤54元 或 主力净额≤-3亿元清仓1手',
        '股价≥56元清仓1手',
        '主力净额≥0亿元 且 股价站上分时均价线持续60秒继续持有',
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
          height: element.clientHeight,
          scrollHeight: element.scrollHeight,
          decisionBottom:
            element.querySelector('.card-decision-slot')
              ?.getBoundingClientRect().bottom,
          monitoringBottom: rules?.getBoundingClientRect().bottom,
          metricsTop:
            element.querySelector('.hold-card-metrics')
              ?.getBoundingClientRect().top,
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
    assert.ok(
      monitoredGeometry.scrollHeight
        <= monitoredGeometry.height + 1,
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
    assert.ok(
      monitoredGeometry.monitoringBottom
        <= monitoredGeometry.metricsTop + 1,
      JSON.stringify({ width, monitoredGeometry }),
    )
    results.push({
      view: 'monitoring-card',
      width,
      ...monitoredGeometry,
    })
    await monitoredHolding.screenshot({
      path: `${output}/${width}-monitoring-card.png`,
    })
    if (width === 1440) {
      await monitoredHolding.locator(
        'summary[aria-label="立讯精密更多操作"]',
      ).click()
      assert.equal(
        await monitoredHolding.getByRole('button', {
          name: '记录自主卖出',
          exact: true,
        }).count(),
        1,
      )
      await monitoredHolding.getByText(
        '记录自主做T',
        { exact: true },
      ).click()
      const tDialog = page.getByRole('dialog', {
        name: /做T · 立讯精密/,
      })
      await tDialog.waitFor()
      const tText = await tDialog.innerText()
      assert.match(tText, /查看当前V3做T边界/)
      assert.doesNotMatch(tText, /稳健|均衡|激进|生成做T参考/)
      await tDialog.getByRole('button', {
        name: '关闭做T弹层',
        exact: true,
      }).click()
    }
    const immediateHolding = page.locator(
      '.trade-card[data-code="000001"]',
    )
    await immediateHolding.locator('.v3-decision-summary').waitFor()
    assert.match(
      await immediateHolding
        .locator('.v3-decision-headline strong')
        .textContent(),
      /等待退出前复核/,
    )
    assert.match(
      await immediateHolding
        .locator('.v3-decision-reason')
        .textContent(),
      /约60秒/,
    )
    assert.equal(
      await immediateHolding.locator('.action-command-qty').count(),
      0,
    )
    assert.equal(
      await immediateHolding.locator('.monitoring-rules').count(),
      0,
    )
    assert.doesNotMatch(
      await immediateHolding.textContent(),
      /已到期|请重新生成/,
    )
    const immediateGeometry = await immediateHolding.evaluate(
      (element) => ({
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        height: element.clientHeight,
        scrollHeight: element.scrollHeight,
      }),
    )
    assert.ok(
      immediateGeometry.scrollWidth <= immediateGeometry.width + 1,
      JSON.stringify({ width, immediateGeometry }),
    )
    assert.ok(
      immediateGeometry.scrollHeight <= immediateGeometry.height + 1,
      JSON.stringify({ width, immediateGeometry }),
    )
    await immediateHolding.screenshot({
      path: `${output}/${width}-immediate-action-card.png`,
    })
    const conditional = page.locator('.plan-cand').filter({ hasText: '演示候选A' })
    const approved = page.locator('.plan-cand').filter({ hasText: '演示候选B' })
    assert.match(
      await conditional.locator('.v3-decision-headline strong').textContent(),
      /等待回踩 84元/,
    )
    assert.equal(
      await approved.locator('.v3-decision-headline strong').textContent(),
      '待买入 1 手',
    )
    const selectionOrigin = page.locator('.selection-origin > summary').first()
    if (await selectionOrigin.isVisible()) {
      await selectionOrigin.click()
      assert.equal(await page.locator('.selection-origin[open]').count(), 1)
    }
    await check('positions')
    await conditional.locator('.stock-name-link').click()
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
