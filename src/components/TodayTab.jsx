import { useState, useMemo } from 'react'
import Icon from './Icon'
import LimitPool from './LimitPool'
import DailyReport from './DailyReport'
import OpportunityRadar from './OpportunityRadar'
import ErrorBoundary from './ErrorBoundary'
import { fmtPct, pctClass, fmtRaw } from '../format'
import { deriveMarketRegime } from '../../shared/marketRegime.js'
import {
  buildMarketBoardGuidance,
  buildSentimentGuidance,
} from '../../shared/marketGuidance.js'

// ============ 今日决策：先定方向，再核验个股 ============
export default function TodayTab({
  market,
  sectors,
  snapshot,
  snapshotLoading,
  snapshotError,
}) {
  const state = (key) => ({
    data: snapshot?.[key] || null,
    loading: snapshotLoading,
    error: snapshot?.errors?.[key] || snapshotError,
  })
  const zt = state('limitUp')
  const zb = state('brokenLimit')

  return (
    <div className="today">
      <MarketLight
        market={market}
        sectors={sectors}
        limitUp={zt.data}
      />
      <SentimentGauge zt={zt.data} zb={zb.data} market={market} />
      <ErrorBoundary label="机会雷达">
        <OpportunityRadar />
      </ErrorBoundary>
      <LimitPool
        dataByKind={{
          zt: zt.data,
          zb: zb.data,
        }}
        loading={snapshotLoading}
        errors={snapshot?.errors}
      />
    </div>
  )
}

function MarketInterpretation({ guidance, compact = false }) {
  return (
    <div
      className={
        'market-interpretation'
        + (compact ? ' compact' : '')
      }
      data-tone={guidance.tone}
      role="note"
      aria-label="盘面数据解读"
    >
      <span className="market-interpretation-icon">
        <Icon name={guidance.icon} size={15} />
      </span>
      <div className="market-interpretation-body">
        <div className="market-interpretation-title">
          <span>这些数据说明</span>
          <strong>{guidance.conclusion}</strong>
        </div>
        <p>{guidance.evidence}</p>
        <div className="market-interpretation-action">
          <span>操作参考</span>
          <b>{guidance.action}</b>
        </div>
      </div>
    </div>
  )
}

// ---------- 市场情绪温度计（用涨停/炸板池本地计算，不占接口）----------
function SentimentGauge({ zt, zb, market }) {
  const g = useMemo(() => {
    const ztList = (zt && zt.list) || []
    const zbList = (zb && zb.list) || []
    const ztCount = Number.isFinite(Number(zt?.total)) ? Number(zt.total) : ztList.length
    const zbCount = Number.isFinite(Number(zb?.total)) ? Number(zb.total) : zbList.length
    // 炸板率 = 炸板数 /(涨停数+炸板数)
    const breakRate = (ztCount + zbCount) ? Math.round(zbCount / (ztCount + zbCount) * 100) : null
    // 连板梯队：按 lbc(连板数) 分布
    const tiers = {}
    let maxBoard = 0
    ztList.forEach((s) => {
      const lb = s.lbc || 1
      if (lb > maxBoard) maxBoard = lb
      const key = lb >= 2 ? lb : 1
      tiers[key] = (tiers[key] || 0) + 1
    })
    const lianban = ztList.length - (tiers[1] || 0) // 连板数(>=2板)
    const b = (market && market.breadth) || {}
    // 情绪温度分：涨停多、炸板率低、连板高 → 高分
    let score = 50
    if (ztCount >= 60) score += 15; else if (ztCount >= 30) score += 8; else if (ztCount < 15) score -= 12
    if (breakRate != null) { if (breakRate <= 15) score += 12; else if (breakRate >= 35) score -= 15 }
    if (maxBoard >= 5) score += 10; else if (maxBoard >= 3) score += 5
    if (b.limitDown > 10) score -= 10
    score = Math.max(0, Math.min(100, score))
    const level = score >= 70 ? { t: '情绪火热', c: 'red' } : score >= 55 ? { t: '情绪偏暖', c: 'gold' } : score >= 40 ? { t: '情绪中性', c: 'muted' } : { t: '情绪偏冷', c: 'green' }
    return { ztCount, zbCount, breakRate, maxBoard, lianban, score, level, b }
  }, [zt, zb, market])
  const guidance = buildSentimentGuidance(g)

  if (!zt) return null
  return (
    <section className="panel senti-gauge workbench-aside">
      <div className="sg-head">
        <div role="heading" aria-level="2" className="panel-title"><Icon name="fire" size={16} /> 市场情绪温度计</div>
        <span className={'sg-level ' + g.level.c}>{g.level.t} · {g.score}分</span>
      </div>
      <div className="sg-bar"><span className={'sg-bar-fill ' + g.level.c} style={{ width: g.score + '%' }} /></div>
      <div className="sg-cells">
        <div className="sg-cell"><span className="sg-k">涨停</span><span className="sg-v red">{g.ztCount}</span></div>
        <div className="sg-cell"><span className="sg-k">炸板</span><span className="sg-v">{g.zbCount}</span></div>
        <div className="sg-cell"><span className="sg-k">炸板率</span><span className={'sg-v ' + (g.breakRate != null && g.breakRate >= 35 ? 'green' : g.breakRate != null && g.breakRate <= 15 ? 'red' : '')}>{g.breakRate != null ? g.breakRate + '%' : '--'}</span></div>
        <div className="sg-cell"><span className="sg-k">最高板</span><span className="sg-v gold">{g.maxBoard || '--'}板</span></div>
        <div className="sg-cell"><span className="sg-k">连板数</span><span className="sg-v">{g.lianban}</span></div>
        <div className="sg-cell"><span className="sg-k">跌停</span><span className="sg-v green">{g.b.limitDown ?? '--'}</span></div>
      </div>
      <MarketInterpretation guidance={guidance} compact />
    </section>
  )
}

// ---------- 大盘盘面（指数全景 + 情绪红绿灯 + 今日操作建议）----------
function MarketLight({ market, sectors, limitUp }) {
  const b = (market && market.breadth) || {}
  const idx = (market && market.indices) || []
  const ratio = b.down ? b.up / b.down : (b.up ? 9 : 1)
  const zt = Number.isFinite(Number(limitUp?.total))
    ? Number(limitUp.total)
    : b.limitUp
  const dt = b.limitDown
  const regime = deriveMarketRegime({
    ...(market || {}),
    breadth: {
      ...b,
      limitUp: zt,
      limitDown: dt,
    },
  })
  const regimeView = {
    TREND_STRONG: {
      light: 'green',
      status: '可以做',
      text: '趋势偏强，可在风险预算内顺势参与',
      icon: 'target',
      title: '今日按强势趋势执行',
      sub: `优先主线强势股，目标总仓位 ${regime.targetPositionPct.min}~${regime.targetPositionPct.max}%`,
    },
    RANGE: {
      light: 'yellow',
      status: '震荡应对',
      text: '震荡均衡，低吸高抛但不追涨',
      icon: 'gauge',
      title: '今日以持仓管理为主',
      sub: `优先做T与回踩确认，目标总仓位 ${regime.targetPositionPct.min}~${regime.targetPositionPct.max}%`,
    },
    TRANSITION: {
      light: 'yellow',
      status: '方向未明',
      text: '市场方向切换，只有量价与资金共振后才考虑小仓试错',
      icon: 'gauge',
      title: '今日暂不主动加仓',
      sub: `只处理确定性较高的机会，目标总仓位 ${regime.targetPositionPct.min}~${regime.targetPositionPct.max}%`,
    },
    RISK_OFF: {
      light: 'red',
      status: '控制风险',
      text: '风险偏高，暂停普通新增仓位',
      icon: 'shield',
      title: '今日优先降低风险',
      sub: `先处理弱势持仓，目标总仓位 ${regime.targetPositionPct.min}~${regime.targetPositionPct.max}%`,
    },
    UNKNOWN: {
      light: 'red',
      status: '数据不足',
      text: '关键市场证据不足',
      icon: 'shield',
      title: '今日暂停新增风险',
      sub: '等待指数与市场广度恢复后再评估',
    },
  }[regime.regime]
  const { light } = regimeView
  const topSector = (sectors && sectors.list && sectors.list[0]) || null
  const guidance = buildMarketBoardGuidance({
    regime,
    indices: idx,
    breadth: b,
    topSector,
    limitUp: zt,
    limitDown: dt,
  })

  const [reportOpen, setReportOpen] = useState(false) // 策略日报抽屉

  return (
    <section className="panel market-board workbench-primary">
      <div className="panel-head">
        <div role="heading" aria-level="2" className="panel-title"><Icon name="pulse" size={16} /> 大盘盘面 <span className="sub-name">开盘先看势，定今日仓位</span></div>
        <div className="market-actions">
          <button className="btn btn-primary" onClick={() => setReportOpen(true)}>
            <Icon name="clipboard" size={13} />
            策略日报
          </button>
          <div className={'mb-light ' + light}>
            <span className="orb-dot" />
            {regimeView.status} · {regimeView.text}
          </div>
        </div>
      </div>
      {reportOpen && <DailyReport onClose={() => setReportOpen(false)} />}

      {/* 今日操作建议：盘面纪律由实时涨跌家数与涨跌停结构确定。 */}
      {(() => {
        const plan = {
          icon: regimeView.icon,
          title: regimeView.title,
          sub: regimeView.sub,
          tone: regimeView.light,
        }
        return (
          <div className={'mb-plan ' + plan.tone}>
            <span className="mb-plan-icon"><Icon name={plan.icon} size={18} /></span>
            <div className="mb-plan-txt">
              <div className="mb-plan-title">{plan.title}</div>
              <div className="mb-plan-sub">{plan.sub}</div>
            </div>
          </div>
        )
      })()}

      <div className="mb-body">
        {/* 指数全景：上证/深证/创业板/北证 */}
        <div className="mb-indices">
          {idx.map((i) => (
            <div className="mb-idx" key={i.code}>
              <div className="mb-idx-name">{i.name}</div>
              <div className={'mb-idx-price ' + pctClass(i.pct)}>{i.price ? fmtRaw(i.price) : '--'}</div>
              <div className={'mb-idx-pct ' + pctClass(i.pct)}>{fmtPct(i.pct)}</div>
            </div>
          ))}
        </div>
        {/* 情绪指标 */}
        <div className="mb-stats">
          <div className="mb-stat">
            <div className="mb-stat-label">涨/跌停</div>
            <div className="mb-stat-val"><span className="red">{zt ?? '--'}</span><span className="sep">/</span><span className="green">{dt ?? '--'}</span></div>
          </div>
          <div className="mb-stat">
            <div className="mb-stat-label">涨/跌家数</div>
            <div className="mb-stat-val"><span className="red">{b.up || 0}</span><span className="sep">/</span><span className="green">{b.down || 0}</span></div>
          </div>
          <div className="mb-stat">
            <div className="mb-stat-label">涨跌比</div>
            <div className={'mb-stat-val ' + (ratio >= 1 ? 'red' : 'green')}>{ratio.toFixed(2)}</div>
          </div>
          {topSector && (
            <div className="mb-stat">
              <div className="mb-stat-label">最强板块</div>
              <div className="mb-stat-val gold" style={{ fontSize: 14 }}>{topSector.name}</div>
            </div>
          )}
        </div>
      </div>
      <MarketInterpretation guidance={guidance} />
    </section>
  )
}
