import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const base = process.env.UI_TEST_ORIGIN || 'http://127.0.0.1:5174'
assert.equal(new URL(base).hostname, '127.0.0.1')
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const output = 'harness-artifacts/decision-workbench'
await fs.mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results = []
try {
  for (const width of [320, 768, 1024, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === base ? route.continue() : route.abort())
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.clock.install({ time: new Date('2026-09-10T02:10:00Z') })
    await page.goto(`${base}/test/ui/v3-workbench-preview.html?tab=positions`, { waitUntil: 'domcontentloaded' })
    await page.locator('.nav-tabs:visible').getByRole('button', { name: /持仓/ }).click()
    await page.locator('.plan-cand.decision-card').first().waitFor()
    const completedBatch = page.locator('.decision-batch-progress.done')
    await completedBatch.waitFor()
    await page.clock.fastForward(8050)
    await completedBatch.waitFor({ state: 'detached' })
    const holding = (code) => page.locator(`.hold-item[data-code="${code}"]`)
    const candidate = (code) => page.locator(`.plan-cand[data-code="${code}"]`)
    const pendingExitText = await holding('000001').innerText()
    assert.match(pendingExitText, /等待退出前复核/)
    assert.doesNotMatch(pendingExitText, /清仓 10 手/)
    assert.match(pendingExitText, /约60秒/)
    assert.match(await holding('600036').innerText(), /加仓 1 手/)
    assert.equal(
      await holding('600036').getByRole('button', {
        name: '记录加仓',
        exact: true,
      }).count(),
      1,
    )
    assert.match(
      await holding('300750').innerText(),
      /本轮未获得有效决策模型结果/,
    )
    assert.match(
      await candidate('002594').innerText(),
      /等待回踩 84元[\s\S]*回踩观察[\s\S]*84元[\s\S]*止损[\s\S]*目标/,
    )
    assert.match(
      await candidate('688981').innerText(),
      /买入 1 手[\s\S]*买入参考[\s\S]*120元[\s\S]*止损[\s\S]*目标/,
    )
    assert.match(await candidate('600519').innerText(), /仅收藏，尚未跟踪/)
    assert.match(
      await candidate('600522').innerText(),
      /尚无本轮系统决策/,
    )
    if (width === 1440) {
      const exitHolding = holding('000001')
      await exitHolding.locator(
        'summary[aria-label="平安银行更多操作"]',
      ).click()
      const manualSell = exitHolding.getByRole('button', {
        name: '记录自主卖出',
        exact: true,
      })
      assert.equal(await manualSell.count(), 1)
      await exitHolding.screenshot({
        path: `${output}/1440-manual-sell-menu.png`,
      })
      await manualSell.click()
      const sellForm = exitHolding.locator('.buy-inline')
      const sellQty = sellForm.getByPlaceholder('手', {
        exact: true,
      })
      const sellConfirm = sellForm.getByRole('button', {
        name: /确认减仓|确认清仓/,
      })
      assert.equal(await sellQty.getAttribute('max'), '10')
      await sellQty.fill('11')
      assert.equal(await sellConfirm.isDisabled(), true)
      await exitHolding.screenshot({
        path: `${output}/1440-manual-sell-form.png`,
      })
      await sellQty.fill('1')
      assert.equal(await sellConfirm.isEnabled(), true)
      await sellForm.getByRole('button', {
        name: '取消',
        exact: true,
      }).click()
    }
    const geometry = await page.evaluate(() => ({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      accountControls: [
        document.querySelector('.auto-ref-btn'),
        document.querySelector('.batch-entry'),
      ].map((element) => {
        const box = element?.getBoundingClientRect()
        return box ? {
          text: element.textContent.trim(),
          top: box.top,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
        } : null
      }),
      cards: [...document.querySelectorAll('.decision-card')].map((element) => {
        const card = element.getBoundingClientRect()
        const summary = element.querySelector('.decision-summary').getBoundingClientRect()
        const slot = element.querySelector('.card-decision-slot').getBoundingClientRect()
        const meta = element.querySelector('.card-decision-meta')?.getBoundingClientRect()
        const monitoring = element.querySelector('.monitoring-rules')
          ?.getBoundingClientRect()
        const decisionContentBottom = Math.max(
          ...[...element.querySelectorAll(
            '.decision-summary > *',
          )].map((node) => node.getBoundingClientRect().bottom),
          summary.top,
        )
        const nextSection = element.matches('.hold-item')
          ? element.querySelector('.hold-card-metrics')?.getBoundingClientRect()
          : element.querySelector('.trade-card-review-slot')?.getBoundingClientRect()
        const plan = element.querySelector('.holding-plan-summary')
          ?.getBoundingClientRect()
        const actions = element.matches('.hold-item')
          ? element.querySelector('.pi-actions')?.getBoundingClientRect()
          : element.querySelector('.pc-actions')?.getBoundingClientRect()
        const contentBottom = Math.max(
          decisionContentBottom,
          meta?.height > 0 ? meta.bottom : decisionContentBottom,
          monitoring?.height > 0
            ? monitoring.bottom
            : decisionContentBottom,
        )
        const beforeActionsBottom = Math.max(
          contentBottom,
          nextSection?.bottom || contentBottom,
          plan?.bottom || contentBottom,
        )
        return {
          code: element.dataset.code,
          type: element.matches('.hold-item') ? 'holding' : 'candidate',
          monitoring: !!monitoring?.height,
          top: card.top,
          bottom: card.bottom,
          width: element.clientWidth, scrollWidth: element.scrollWidth,
          height: element.clientHeight, scrollHeight: element.scrollHeight,
          summaryBottom: summary.bottom, slotBottom: slot.bottom,
          metaTop: meta?.height > 0 ? meta.top : slot.bottom,
          decisionGap: nextSection
            ? Math.max(0, nextSection.top - contentBottom)
            : null,
          actionGap: actions
            ? Math.max(0, actions.top - beforeActionsBottom)
            : null,
          actionBottomInset: actions
            ? Math.max(0, card.bottom - actions.bottom)
            : null,
        }
      }),
    }))
    assert.equal(geometry.scrollWidth, width)
    assert.ok(geometry.accountControls.every(Boolean))
    assert.match(geometry.accountControls[1].text, /批量更新决策 · 6只/)
    assert.ok(
      Math.abs(
        geometry.accountControls[0].height
        - geometry.accountControls[1].height,
      ) <= 1,
      JSON.stringify(geometry.accountControls),
    )
    assert.ok(
      geometry.accountControls.every((control) =>
        control.width > 0 && control.height >= 40
      ),
      JSON.stringify(geometry.accountControls),
    )
    for (const card of geometry.cards) {
      assert.ok(card.scrollWidth <= card.width + 1, JSON.stringify(card))
      assert.ok(card.scrollHeight <= card.height + 1, JSON.stringify(card))
      assert.ok(card.summaryBottom <= card.slotBottom + 1, JSON.stringify(card))
      assert.ok(card.summaryBottom <= card.metaTop + 1, JSON.stringify(card))
      assert.ok(card.decisionGap <= 32, JSON.stringify(card))
      assert.ok(card.actionBottomInset <= 24, JSON.stringify(card))
      if (width <= 720) {
        assert.ok(card.actionGap <= 32, JSON.stringify(card))
      }
      if (!card.monitoring && card.type === 'holding') {
        assert.ok(card.height <= 700, JSON.stringify(card))
      }
      if (card.type === 'candidate') {
        assert.ok(card.height <= 500, JSON.stringify(card))
      }
    }
    if (width > 720) {
      for (const type of ['holding', 'candidate']) {
        const rows = new Map()
        for (const card of geometry.cards.filter((item) => item.type === type)) {
          const rowKey = String(Math.round(card.top))
          rows.set(rowKey, [...(rows.get(rowKey) || []), card])
        }
        for (const row of rows.values()) {
          if (row.length < 2) continue
          const heights = row.map((card) => card.height)
          assert.ok(
            Math.max(...heights) - Math.min(...heights) <= 1,
            JSON.stringify({ width, type, row }),
          )
        }
      }
    }
    await page.screenshot({ path: `${output}/${width}-cards.png`, fullPage: true })
    await holding('300750').screenshot({
      path: `${output}/${width}-holding-compact.png`,
    })
    await candidate('600522').screenshot({
      path: `${output}/${width}-candidate-compact.png`,
    })
    await candidate('600519').getByRole('button', { name: '纳入作战', exact: true }).click()
    const confirm = page.getByRole('dialog', { name: '纳入作战并持续跟踪？' })
    await confirm.waitFor()
    await confirm.getByRole('button', { name: '取消', exact: true }).click()
    await candidate('688981').getByRole('button', { name: '记录买入', exact: true }).click()
    const buy = candidate('688981').locator('.buy-inline')
    await buy.getByPlaceholder('买入价').fill('120')
    await buy.getByPlaceholder('手', { exact: true }).fill('1')
    await buy.getByRole('checkbox').uncheck()
    await buy.locator('.act-buy.solid').click()
    await holding('688981').waitFor()
    assert.match(await holding('688981').innerText(), /T\+1锁定1手/)
    await holding('600036').locator('.stock-name-link').first().click()
    await page.locator('.detail-panel').waitFor()
    assert.equal(await page.getByRole('button', { name: '深度生成', exact: true }).count(), 0)
    assert.equal(await page.locator('.footbar-quick').innerText(), '更新决策')
    await page.getByRole('button', { name: '关闭个股详情', exact: true }).click()
    if ([320, 1440].includes(width)) {
      if (width === 1440) {
        await page.getByRole('button', {
          name: '切到白天模式',
          exact: true,
        }).click()
      } else {
        await page.evaluate(() => {
          document.documentElement.setAttribute('data-theme', 'light')
        })
      }
      assert.equal(
        await page.locator('html').getAttribute('data-theme'),
        'light',
      )
      await holding('300750').screenshot({
        path: `${output}/${width}-holding-compact-light.png`,
      })
      await candidate('600522').screenshot({
        path: `${output}/${width}-candidate-compact-light.png`,
      })
    }
    assert.deepEqual(errors, [])
    results.push(geometry)
    await context.close()
  }
  await fs.writeFile(`${output}/geometry.json`, JSON.stringify(results, null, 2))
  console.log(JSON.stringify({
    passed: true,
    viewports: results.map((item) => item.width),
    checks: [
      'exit-review-pending',
      'manual-sell',
      'desktop-row-equal-height',
      'six-states',
      'single-primary-action',
      'holding-add-action',
      'no-deep-generation',
      'enrollment-cancel',
      'record-buy',
      't1',
      'detail-return',
      'batch-decision-control',
      'batch-completion-auto-hide',
      'decision-price-strip',
      'no-overflow',
    ],
  }))
} finally {
  await browser.close()
}
