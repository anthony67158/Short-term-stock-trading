import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  clearStockFormulaPriceCache,
  formulaSelectionCacheKey,
  formulaSelectionClientError,
  formulaPriceCachePolicy,
  isFormulaSelectionTransientError,
  loadStockFormulaPrice,
  staleFormulaPricePayload,
} from '../src/formulaSelectionClient.js'

const selection = fs.readFileSync(
  new URL('../src/components/FormulaSelection.jsx', import.meta.url),
  'utf8',
)
const candidate = fs.readFileSync(
  new URL(
    '../src/components/FormulaSelectionCandidate.jsx',
    import.meta.url,
  ),
  'utf8',
)
const progress = fs.readFileSync(
  new URL(
    '../src/components/FormulaSelectionProgress.jsx',
    import.meta.url,
  ),
  'utf8',
)
const tailPick = fs.readFileSync(
  new URL('../src/components/TailPick.jsx', import.meta.url),
  'utf8',
)
const price = fs.readFileSync(
  new URL('../src/components/FormulaPrice.jsx', import.meta.url),
  'utf8',
)
const today = fs.readFileSync(
  new URL('../src/components/TodayTab.jsx', import.meta.url),
  'utf8',
)
const detail = fs.readFileSync(
  new URL('../src/components/StockDetail.jsx', import.meta.url),
  'utf8',
)
const client = fs.readFileSync(
  new URL('../src/formulaSelectionClient.js', import.meta.url),
  'utf8',
)
const styles = fs.readFileSync(
  new URL('../src/styles/precision.css', import.meta.url),
  'utf8',
)
const design = fs.readFileSync(
  new URL('../docs/DESIGN.md', import.meta.url),
  'utf8',
)

test('今日决策由机会雷达统一承载公式与尾盘结果', () => {
  assert.match(today, /OpportunityRadar/)
  assert.doesNotMatch(today, /<TailPick/)
  assert.doesNotMatch(today, /<FormulaSelection/)
  assert.match(selection, /公式选股/)
  assert.match(selection, /盘中机会/)
  assert.match(selection, /次日关注/)
  assert.match(selection, /尾盘反转/)
  assert.match(selection, /<TailPick/)
})

test('尾盘反转复用公式选股单面板而不是上下叠两张卡', () => {
  assert.match(
    selection,
    /mode === 'tail'[\s\S]*<TailPick[\s\S]*title="公式选股"/,
  )
  assert.match(selection, /navigation=\{tabs\}/)
  assert.doesNotMatch(
    selection,
    /<\/section>\s*\{mode === 'tail' && <TailPick/,
  )
  assert.match(tailPick, /title = '尾盘拾金'/)
  assert.match(tailPick, /\{navigation\}/)
})

test('公式候选只允许加入自选且展示唯一主价位', () => {
  assert.match(candidate, /primaryPrice/)
  assert.match(candidate, /priceType/)
  assert.match(candidate, /加入自选/)
  assert.match(candidate, /OBSERVE_ONLY/)
  assert.doesNotMatch(selection, /planStore\.buy/)
})

test('个股详情独立展示公式价位和军师参考权重', () => {
  assert.match(detail, /<FormulaPrice/)
  assert.match(price, /公式价位/)
  assert.match(price, /effectiveWeight/)
  assert.match(price, /唯一/)
  assert.match(price, /refreshFormulaPrice/)
  assert.match(price, /staleFormulaPricePayload/)
  assert.match(price, /setInterval/)
})

test('公式选股请求携带账号凭证和明确超时', () => {
  assert.match(client, /accountRequestHeaders/)
  assert.match(client, /AbortController/)
  assert.match(client, /\/api\/formula_selection/)
  assert.match(client, /loadStockFormulaPrice/)
  assert.match(client, /loadFormulaSelectionProgress/)
})

test('公式价位前端不直接展示HTTP 501', () => {
  assert.equal(
    formulaSelectionClientError('HTTP 501', 500),
    '行情数据暂时不可用，请稍后重试',
  )
  assert.equal(
    formulaSelectionClientError('Failed to fetch'),
    '行情数据暂时不可用，请稍后重试',
  )
  assert.match(client, /stockFormulaCache/)
  assert.match(client, /stale:\s*true/)
})

test('公式价位旧快照按账号隔离且只在临时故障时回退', () => {
  assert.notEqual(
    formulaSelectionCacheKey('600001', {
      'X-Account-Nick': 'account-a',
    }),
    formulaSelectionCacheKey('600001', {
      'X-Account-Nick': 'account-b',
    }),
  )
  assert.equal(
    isFormulaSelectionTransientError({
      status: 503,
      errorCode: 'MARKET_DATA_UNAVAILABLE',
    }),
    true,
  )
  assert.equal(
    isFormulaSelectionTransientError({
      errorCode: 'NETWORK_ERROR',
    }),
    true,
  )
  assert.equal(
    isFormulaSelectionTransientError({
      status: 401,
      message: '请先登录',
    }),
    false,
  )
  assert.match(client, /if \(payload\?\.stale !== true\)/)
})

test('收盘公式跨休市复用且在开盘或账户变化后重新计算', async () => {
  clearStockFormulaPriceCache()
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      decision: { action: 'HOLD' },
      requestNumber: ++calls,
    }),
  })
  const fridayClose = Date.parse('2026-08-28T15:20:00+08:00')
  const mondayPreopen = Date.parse('2026-08-31T08:50:00+08:00')
  const mondayOpen = Date.parse('2026-08-31T09:30:00+08:00')
  const accountState = {
    plan: [],
    holding: [{ code: '600001', qty: 1, buyPrice: 10 }],
    closed: [],
    account: { cash: 10000 },
  }
  try {
    const first = await loadStockFormulaPrice('600001', {
      now: fridayClose,
      accountState,
    })
    const cached = await loadStockFormulaPrice('600001', {
      now: mondayPreopen,
      accountState,
    })
    assert.equal(cached.requestNumber, first.requestNumber)
    assert.equal(calls, 1)

    await loadStockFormulaPrice('600001', {
      now: mondayOpen,
      accountState,
    })
    assert.equal(calls, 2)

    await loadStockFormulaPrice('600001', {
      now: mondayOpen + 30_000,
      accountState,
    })
    assert.equal(calls, 2)

    await loadStockFormulaPrice('600001', {
      now: mondayOpen + 60_001,
      accountState,
    })
    assert.equal(calls, 3)

    await loadStockFormulaPrice('600001', {
      now: mondayOpen + 60_001,
      accountState: {
        ...accountState,
        holding: [{ code: '600001', qty: 2, buyPrice: 10 }],
      },
    })
    assert.equal(calls, 4)

    await loadStockFormulaPrice('600001', {
      now: mondayOpen + 60_001,
      accountState,
      force: true,
    })
    assert.equal(calls, 5)
  } finally {
    globalThis.fetch = originalFetch
    clearStockFormulaPriceCache()
  }
})

test('同一账号同股的并发公式请求只计算一次', async () => {
  clearStockFormulaPriceCache()
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 10))
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        decision: { action: 'HOLD' },
      }),
    }
  }
  const now = Date.parse('2026-08-31T10:00:00+08:00')
  const accountState = {
    plan: [],
    holding: [{ code: '600001', qty: 1, buyPrice: 10 }],
    closed: [],
    account: { cash: 10000 },
  }
  try {
    await Promise.all([
      loadStockFormulaPrice('600001', { now, accountState }),
      loadStockFormulaPrice('600001', { now, accountState }),
    ])
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
    clearStockFormulaPriceCache()
  }
})

test('公式故障回退只限同一行情窗口且降级为不可执行', () => {
  const payload = staleFormulaPricePayload({
    ok: true,
    decision: {
      positionMode: 'UNOWNED',
      action: 'WATCH_BUY',
      primaryPrice: 10,
      stopPrice: 9.5,
      targetPrice: 11,
      riskReward: 2,
      priceContractValid: true,
      dataFresh: true,
      blockers: [],
    },
    advisorReference: {
      effectiveWeight: 0.05,
      conflicts: [],
    },
  })

  assert.equal(payload.stale, true)
  assert.equal(payload.decision.action, 'AVOID')
  assert.equal(payload.decision.primaryPrice, null)
  assert.equal(payload.decision.dataFresh, false)
  assert.equal(payload.advisorReference.effectiveWeight, 0)
  assert.match(
    payload.decision.blockers.join('；'),
    /行情数据已过期/,
  )
})

test('行情窗口切换后请求失败不会沿用上一窗口价位', async () => {
  clearStockFormulaPriceCache()
  const originalFetch = globalThis.fetch
  let failed = false
  globalThis.fetch = async () => {
    if (failed) throw new TypeError('Failed to fetch')
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        decision: { action: 'WATCH_BUY' },
      }),
    }
  }
  const accountState = {
    plan: [],
    holding: [],
    closed: [],
    account: { cash: 10000 },
  }
  try {
    await loadStockFormulaPrice('600002', {
      now: Date.parse('2026-08-31T14:59:30+08:00'),
      accountState,
    })
    failed = true
    await assert.rejects(
      loadStockFormulaPrice('600002', {
        now: Date.parse('2026-08-31T15:01:00+08:00'),
        accountState,
      }),
      /行情数据暂时不可用/,
    )
  } finally {
    globalThis.fetch = originalFetch
    clearStockFormulaPriceCache()
  }
})

test('公式价位缓存窗口区分盘中、午休和收盘', () => {
  const morning = formulaPriceCachePolicy(
    Date.parse('2026-08-31T10:00:00+08:00'),
  )
  const lunch = formulaPriceCachePolicy(
    Date.parse('2026-08-31T12:00:00+08:00'),
  )
  const close = formulaPriceCachePolicy(
    Date.parse('2026-08-31T15:20:00+08:00'),
  )
  const closingMinute = formulaPriceCachePolicy(
    Date.parse('2026-08-31T15:00:00+08:00'),
  )
  const settledClose = formulaPriceCachePolicy(
    Date.parse('2026-08-31T15:01:00+08:00'),
  )
  const weekend = formulaPriceCachePolicy(
    Date.parse('2026-08-30T12:00:00+08:00'),
  )

  assert.equal(morning.maxAgeMs, 60_000)
  assert.equal(lunch.key, 'lunch:2026-08-31')
  assert.equal(close.key, 'close:2026-08-31')
  assert.equal(closingMinute.key, 'live:2026-08-31')
  assert.equal(settledClose.key, 'close:2026-08-31')
  assert.equal(weekend.key, 'close:2026-08-28')
  assert.match(price, /formulaPriceAccountFingerprint/)
  assert.match(price, /\[code,\s*accountFingerprint\]/)
})

test('公式选股展示服务端真实计算阶段而不是静态计算中文案', () => {
  assert.match(selection, /FormulaSelectionProgress/)
  assert.match(selection, /loadFormulaSelectionProgress/)
  assert.match(progress, /role="progressbar"/)
  assert.match(progress, /核验市场/)
  assert.match(progress, /读取全市场/)
  assert.match(progress, /检查日线/)
  assert.match(progress, /复核资金/)
  assert.match(progress, /生成结果/)
  assert.match(progress, /aria-live="polite"/)
  assert.match(tailPick, /FormulaSelectionProgress/)
})

test('公式选股明确展示全市场完整读取数量', () => {
  assert.match(
    selection,
    /全市场完整读取[\s\S]*inspectedCount[\s\S]*total/,
  )
  assert.match(progress, /counts\.total/)
  assert.match(progress, /已读取/)
})

test('个股公式价位沿用详情页单层信息带并隐藏内部枚举', () => {
  assert.match(price, /formula-price-command/)
  assert.match(price, /formula-price-levels/)
  assert.match(price, /buildFormulaPriceExplanation/)
  assert.doesNotMatch(price, /\{decision\.formulaId \|\|/)
  assert.match(
    styles,
    /\.formula-price-panel\s*{[\s\S]*background:\s*transparent/,
  )
  assert.match(
    styles,
    /\.formula-price-levels\s*{[\s\S]*background:\s*var\(--color-paper-3\)/,
  )
  assert.doesNotMatch(
    styles,
    /\.formula-price-levels > div\s*{[\s\S]{0,240}border:\s*1px/,
  )
})

test('个股公式未命中时展示已计算状态和具体失败条件', () => {
  assert.match(price, /buildFormulaPriceExplanation/)
  assert.match(price, /formula-price-reason/)
  assert.match(price, /为什么暂不买/)
  assert.match(price, /explanation\.reasons/)
  assert.match(price, /explanation\.alternative/)
  assert.doesNotMatch(price, /本轮条件不足，不给价格/)
})

test('设计参考固化 Apple 空间秩序与 Material 状态清晰度', () => {
  assert.match(design, /Apple/)
  assert.match(design, /Material/)
  assert.match(design, /单层表面/)
  assert.match(design, /真实进度/)
  assert.match(design, /44px/)
  assert.match(design, /prefers-reduced-motion/)
})

test('公式选股桌面信息密集且移动端稳定单列', () => {
  assert.match(styles, /\.formula-selection-tabs/)
  assert.match(styles, /\.formula-selection-row/)
  assert.match(
    styles,
    /@media \(max-width: 720px\)[\s\S]*\.formula-selection-row/,
  )
  assert.match(styles, /\.formula-price-panel/)
})
