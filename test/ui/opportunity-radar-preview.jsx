import { useState } from 'react'
import ReactDOM from 'react-dom/client'
import '../../tokens.css'
import '../../src/styles.css'
import '../../src/styles/precision.css'
import './opportunity-radar-preview.css'
import Icon from '../../src/components/Icon.jsx'
import OpportunityRadarContent from '../../src/components/OpportunityRadarContent.jsx'

const sector = {
  code: 'BK1001',
  name: '高端制造',
  rank: 2,
  layoutRank: 1,
  phase: 'STARTUP',
}

function plan({
  code,
  name,
  state,
  formula,
  price,
  entry,
  score = null,
  blockers = [],
  concepts = [],
}) {
  return {
    code,
    name,
    state,
    stateLabel: state === 'READY' ? '满足买入条件' : '等待价格触发',
    sector,
    tags: { concepts },
    quote: { price, pct: 2.16, amount: 560_000_000 },
    score: 88,
    riskReward: 2.2,
    opportunityScore: score,
    entryPlan: {
      type: 'PULLBACK',
      price: entry,
      window: '今日有效',
      trigger: '回踩均价线后重新站稳，量能保持',
      maxPositionPct: 5,
    },
    exitPlan: {
      hardStopPrice: +(entry * 0.96).toFixed(2),
      takeProfitPrice: +(entry * 1.09).toFixed(2),
      timeStopDate: '2026-09-10',
      rule: '达到目标分批止盈；跌破止损位退出',
      t1Constraint: '当日买入不可卖出',
    },
    sourceSignals: ['板块前瞻', formula],
    evidence: ['趋势与板块方向一致', '资金承接得到确认'],
    blockers,
  }
}

const readyScore = {
  state: 'READY',
  pFill: 0.72,
  pWinGivenFill: 0.61,
  expectedNetR: 0.28,
  outOfDistribution: false,
}

const intradayRows = [
  plan({
    code: '600001',
    name: '精工科技',
    state: 'AVOID',
    formula: '盘中回踩承接',
    price: 18.36,
    entry: 18.18,
    score: readyScore,
    blockers: [
      '市场综合强度45分，当前为风险防守',
      '核心指数趋势未确认：深证成指低于20日线和60日线',
    ],
    concepts: ['机器人', '工业母机'],
  }),
  plan({
    code: '000002',
    name: '华创装备',
    state: 'WAIT_TRIGGER',
    formula: '盘中资金先行',
    price: 12.48,
    entry: 12.22,
    score: { state: 'NOT_READY' },
    blockers: ['等待回踩买入价并重新站稳'],
    concepts: ['高端装备'],
  }),
  plan({
    code: '002003',
    name: '新锐材料',
    state: 'AVOID',
    formula: '盘中回踩承接',
    price: 26.72,
    entry: 26.1,
    blockers: ['当前大盘不支持新增风险'],
    concepts: ['机器人'],
  }),
  {
    ...plan({
      code: '300006',
      name: '潜伏智造',
      state: 'WAIT_TRIGGER',
      formula: '预催化扫描',
      price: 16.28,
      entry: 16.52,
      blockers: ['预催化模型仍在积累样本，仅可等待量价确认'],
      concepts: ['工业自动化'],
    }),
    origin: 'PRE_CATALYST',
    activationScore: 78.6,
    underReactionScore: 84.2,
    flowProbeScore: 62.5,
    forecast: {
      state: 'CALIBRATING',
      pActivation1d: null,
      pActivation3d: null,
      sampleCount: 0,
    },
    event: {
      eventType: 'ORDER',
      eventLabel: '重大订单',
      title: '关于签订重大销售合同的公告',
      publishedAt: Date.parse('2026-09-03T18:20:00+08:00'),
      sourceAuthority: 'OFFICIAL',
      sourceUrl:
        'https://static.cninfo.com.cn/finalpage/2026-09-03/example.PDF',
    },
    sourceSignals: ['预催化扫描', '重大订单', '公告主体'],
    evidence: [
      '官方公告：关于签订重大销售合同的公告',
      '公告主体，事件尚未充分扩散到价格',
    ],
  },
  {
    ...plan({
      code: '600004',
      name: '智造股份',
      state: 'AVOID',
      formula: '尾盘反转',
      price: 9.86,
      entry: 9.9,
      blockers: ['今日尾盘执行窗口已结束'],
      concepts: ['工业自动化'],
    }),
    entryPlan: {
      type: 'TAIL_REVERSAL',
      price: 9.9,
      window: '14:50-14:55确认',
      trigger: '尾盘站稳分时均价线',
      maxPositionPct: 5,
    },
  },
  {
    code: '000005',
    name: '联动科技',
    state: 'AVOID',
    stateLabel: '仅作参考',
    sector,
    quote: { price: 15.42, pct: 1.35 },
    entryPlan: null,
    exitPlan: null,
    sourceSignals: ['板块前瞻', '尾盘接近公式'],
    evidence: ['尾盘价格结构接近条件'],
    blockers: ['仅接近公式，尚未完整命中'],
  },
]

const nextRows = [
  plan({
    code: '600011',
    name: '启明工业',
    state: 'WAIT_TRIGGER',
    formula: '收盘趋势回踩',
    price: 21.2,
    entry: 20.86,
    concepts: ['机器人'],
  }),
  plan({
    code: '000012',
    name: '先进机电',
    state: 'WAIT_TRIGGER',
    formula: '收盘蓄势突破',
    price: 8.75,
    entry: 8.82,
    concepts: ['高端装备'],
  }),
]

function portfolio(rows) {
  return {
    budget: { limitPct: 15, approvedPct: 10, includedCount: 2 },
    candidates: rows.map((row, index) => ({
      code: row.code,
      portfolioState: index < 2 ? 'INCLUDED' : 'CORRELATION_CAPPED',
      portfolioReason: index < 2
        ? '纳入本轮风险预算'
        : '与已纳入候选共同暴露于机器人主题',
    })),
  }
}

const snapshot = {
  phase: 'AFTER_CLOSE',
  tailSession: {
    canRun: true,
    reason: '14:50已自动完成，也可手动重算',
  },
  sourceStatus: {
    sector: { status: 'fresh', tradeDate: '2026-09-03' },
    formulaIntraday: { status: 'fresh', tradeDate: '2026-09-03' },
    formulaClose: { status: 'fresh', tradeDate: '2026-09-03' },
    tail: { status: 'fresh', tradeDate: '2026-09-03' },
    preCatalyst: { status: 'fresh', tradeDate: '2026-09-03' },
  },
  lanes: {
    intraday: intradayRows,
    next: nextRows,
  },
  portfolios: {
    intraday: portfolio(intradayRows),
    next: portfolio(nextRows),
  },
}

function Preview() {
  const [lane, setLane] = useState('intraday')
  return (
    <main className="opportunity-preview">
      <section className="panel opportunity-radar">
        <div className="panel-head opportunity-radar-head">
          <div role="heading" aria-level="2" className="panel-title">
            <Icon name="radar" size={16} />
            机会雷达
            <span className="sub-name">全站唯一选股入口</span>
            <span className="opportunity-phase">收盘后</span>
          </div>
          <div className="opportunity-radar-head-actions">
            <button type="button" className="btn btn-primary">
              <Icon name="play" size={14} />
              {lane === 'intraday' ? '扫描盘中机会' : '生成次日关注'}
            </button>
          </div>
        </div>
        <div
          className="opportunity-radar-tabs"
          role="tablist"
          aria-label="机会雷达视图"
        >
          {[
            ['intraday', '盘中机会'],
            ['next', '次日关注计划'],
          ].map(([id, label]) => (
            <button
              type="button"
              role="tab"
              aria-selected={lane === id}
              className={lane === id ? 'active' : ''}
              key={id}
              onClick={() => setLane(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <OpportunityRadarContent
          lane={lane}
          snapshot={snapshot}
          book={{ plan: [] }}
          onAdd={() => {}}
          onRunTail={() => {}}
        />
      </section>
    </main>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<Preview />)
