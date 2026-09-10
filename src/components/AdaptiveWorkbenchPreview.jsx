import { useEffect } from 'react'
import AdaptiveWorkbench from './AdaptiveWorkbench.jsx'

const market = {
  breadth: {
    up: 3180,
    down: 1620,
    flat: 190,
    limitUp: 54,
    limitDown: 5,
  },
  sentiment: {
    breakRatePct: 19,
  },
  score: 67,
}

const book = {
  account: {
    totalAssets: 120000,
    cash: 68000,
  },
  holding: [],
  plan: [],
  alerts: [],
  executionPlans: [],
  closed: [],
}

const opportunities = [
  {
    code: '002594',
    name: '比亚迪',
    state: 'READY',
    stateLabel: '优先执行',
    quote: { price: 108.36, pct: 3.24 },
    sector: { name: '新能源汽车' },
    entryPlan: {
      type: 'IMMEDIATE',
      price: 108.36,
      maxPositionPct: 8.5,
      trigger: '现价保持在分时均价上方且板块扩散未转弱',
    },
    exitPlan: {
      hardStopPrice: 105.72,
      takeProfitPrice: 112.48,
    },
    adaptive: {
      tier: 'ATTACK',
      actionLabel: '优先执行',
      playbook: { label: '主升突破', score: 82 },
      estimate: {
        source: 'V3_DIRECT',
        productionReady: true,
        pFill: 0.88,
        pWinGivenFill: 0.64,
        expectedNetR: 0.42,
      },
      risk: { riskPct: 0.46 },
      cautions: [],
    },
  },
  {
    code: '300750',
    name: '宁德时代',
    state: 'WAIT_TRIGGER',
    stateLabel: '小仓验证',
    quote: { price: 296.18, pct: 1.06 },
    sector: { name: '固态电池' },
    entryPlan: {
      type: 'PULLBACK',
      price: 292.6,
      maxPositionPct: 4.2,
      trigger: '回踩292.60元后重新站稳，主力资金未转为流出',
    },
    exitPlan: {
      hardStopPrice: 286.9,
      takeProfitPrice: 302.1,
    },
    adaptive: {
      tier: 'PROBE',
      actionLabel: '小仓验证',
      playbook: { label: '核心回踩', score: 75 },
      estimate: {
        source: 'V3_DIRECT',
        productionReady: true,
        pFill: 0.66,
        pWinGivenFill: 0.59,
        expectedNetR: 0.26,
      },
      risk: { riskPct: 0.2 },
      cautions: ['板块轮动较快，回踩确认前不追价'],
    },
  },
  {
    code: '688981',
    name: '中芯国际',
    state: 'WAIT_TRIGGER',
    stateLabel: '等待优势扩大',
    quote: { price: 126.8, pct: -1.45 },
    sector: { name: '先进制程' },
    entryPlan: {
      type: 'BREAKOUT',
      price: 129.2,
      maxPositionPct: 3.1,
      trigger: '放量突破129.20元并保持承接',
    },
    exitPlan: {
      hardStopPrice: 123.7,
      takeProfitPrice: 137.8,
    },
    adaptive: {
      tier: 'WATCH',
      actionLabel: '等待优势扩大',
      playbook: { label: '催化先手', score: 68 },
      estimate: {
        source: 'V3_DIRECT',
        productionReady: true,
        pFill: 0.48,
        pWinGivenFill: 0.55,
        expectedNetR: 0.18,
      },
      risk: { riskPct: 0 },
      cautions: ['当前量能尚未确认突破'],
    },
  },
]

const previewSnapshot = {
  ok: true,
  phase: 'INTRADAY',
  defaultLane: 'intraday',
  opportunityContext: {
    phase: 'MAINLINE_ADVANCE',
    baseRiskPct: 0.48,
  },
  lanes: {
    intraday: opportunities,
    next: opportunities.slice(1),
  },
}

export default function AdaptiveWorkbenchPreview() {
  useEffect(() => {
    document.getElementById('app-splash')?.remove()
  }, [])
  return (
    <main className="main adaptive-preview">
      <AdaptiveWorkbench
        market={market}
        book={book}
        quotes={[]}
        previewSnapshot={previewSnapshot}
      />
    </main>
  )
}
