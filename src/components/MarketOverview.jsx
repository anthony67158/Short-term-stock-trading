import { useMemo, useState } from 'react'
import Icon from './Icon'
import DailyReport from './DailyReport'
import { fmtPct, pctClass, fmtRaw } from '../format'
import { deriveMarketRegime } from '../../shared/marketRegime.js'
import {
  buildMarketBoardGuidance,
  buildSentimentGuidance,
} from '../../shared/marketGuidance.js'

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
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

function MarketQuote({ item }) {
  return (
    <div className="market-external-quote">
      <span>{item.label || item.name}</span>
      <strong>{fmtRaw(item.price)}</strong>
      <b className={pctClass(item.pct)}>{fmtPct(item.pct)}</b>
    </div>
  )
}

function MarketExternalGroup({
  title,
  note,
  items,
  unavailable = false,
}) {
  const rows = Array.isArray(items) ? items : []
  return (
    <section
      className="market-external-group"
      aria-label={title}
    >
      <div className="market-external-head">
        <h3>{title}</h3>
        <span>{note}</span>
      </div>
      {rows.length ? (
        <div className="market-external-quotes">
          {rows.map((item, index) => (
            <MarketQuote
              key={`${item.label || item.name}-${index}`}
              item={item}
            />
          ))}
        </div>
      ) : (
        <div className="market-external-empty" role="status">
          {unavailable ? '行情源暂不可用' : '暂无可用行情'}
        </div>
      )}
    </section>
  )
}

function formatYi(value, {
  signed = false,
  digits = 1,
} = {}) {
  const number = finite(value)
  if (number == null) return '--'
  const sign = signed && number > 0 ? '+' : ''
  return `${sign}${number.toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}亿`
}

function marketFundsView(funds) {
  const mainNetYi = finite(funds?.mainNetYi)
  const direction = funds?.direction || 'UNKNOWN'
  const resonance = funds?.resonance || 'UNKNOWN'
  if (mainNetYi == null || direction === 'UNKNOWN') {
    return {
      tone: 'muted',
      headline: '整体资金待更新',
      verdict: '行业资金数据恢复后再判断资金方向',
    }
  }
  if (direction === 'INFLOW') {
    return {
      tone: 'red',
      headline: `净流入 ${formatYi(mainNetYi, { signed: true })}`,
      verdict: resonance === 'POSITIVE'
        ? '指数与主力资金同向走强，资金价格形成正向共振'
        : resonance === 'DIVERGENT'
          ? '主力净流入，但指数尚未同步走强'
          : '主力资金净流入，继续观察指数确认',
    }
  }
  if (direction === 'OUTFLOW') {
    return {
      tone: 'green',
      headline: `净流出 ${formatYi(mainNetYi)}`,
      verdict: resonance === 'NEGATIVE'
        ? '指数与主力资金同步走弱，整体环境偏防守'
        : resonance === 'DIVERGENT'
          ? '主力净流出，但指数尚有局部支撑'
          : '整体主力资金净流出，优先控制风险',
    }
  }
  return {
    tone: 'muted',
    headline: '主力净额接近平衡',
    verdict: '资金方向不集中，结合指数和成交量观察',
  }
}

function turnoverView(turnover = {}) {
  const amountYi = finite(turnover.amountYi)
  const deltaYi = finite(turnover.deltaYi)
  const deltaPct = finite(turnover.deltaPct)
  if (turnover.comparable && deltaYi != null) {
    return {
      tone: deltaYi > 0 ? 'red' : deltaYi < 0 ? 'green' : '',
      value: `${deltaYi >= 0 ? '增加' : '减少'} ${formatYi(Math.abs(deltaYi))}`,
      detail: `较5日均量 ${fmtPct(deltaPct)}`,
    }
  }
  return {
    tone: '',
    value: amountYi == null
      ? '--'
      : `盘中累计 ${formatYi(amountYi)}`,
    detail: amountYi == null
      ? '成交额待更新'
      : '收盘后再与近5日均量比较',
  }
}

function MarketFundsSummary({ funds }) {
  const view = marketFundsView(funds)
  const turnover = turnoverView(funds?.turnover)
  const strength = finite(funds?.netStrengthPct)
  const inflowCount = finite(funds?.inflowMarketCount)
  const outflowCount = finite(funds?.outflowMarketCount)
  const dominant = funds?.dominantMarket || null
  const dominantNetYi = finite(dominant?.mainNetYi)
  const dominantText = dominantNetYi == null
    ? '--'
    : `${dominant.label || dominant.name} ${
        dominantNetYi > 0 ? '净流入' : dominantNetYi < 0 ? '净流出' : '平衡'
      } ${formatYi(dominantNetYi, { signed: true })}`
  return (
    <section
      className="market-funds-summary"
      data-tone={view.tone}
      aria-label="全市场资金"
    >
      <div className="market-funds-primary">
        <span>
          <Icon name="wave" size={14} />
          全市场主力净额
        </span>
        <strong className={view.tone}>{view.headline}</strong>
        <small>{view.verdict}</small>
      </div>
      <dl className="market-funds-metrics">
        <div>
          <dt>净流强度</dt>
          <dd className={pctClass(strength)}>
            {strength == null ? '--' : fmtPct(strength)}
          </dd>
        </div>
        <div>
          <dt>流入 / 流出市场</dt>
          <dd>
            {inflowCount == null || outflowCount == null
              ? '--'
              : `${inflowCount} / ${outflowCount}`}
          </dd>
        </div>
        <div>
          <dt>最大资金方向</dt>
          <dd className={pctClass(dominantNetYi)}>
            {dominantText}
          </dd>
        </div>
        <div>
          <dt>流动性变化</dt>
          <dd className={turnover.tone}>
            {turnover.value}
            <small>{turnover.detail}</small>
          </dd>
        </div>
      </dl>
      <p>
        沪市、深市与北证主力净额汇总；创业板已包含在深市内
      </p>
    </section>
  )
}

function SentimentGauge({
  zt,
  zb,
  market,
  loading,
  error,
}) {
  const gauge = useMemo(() => {
    const ztList = (zt && zt.list) || []
    const zbList = (zb && zb.list) || []
    const breadth = (market && market.breadth) || {}
    const sentiment = (market && market.sentiment) || {}
    const ztCount = finite(zt?.total)
      ?? finite(sentiment.limitUp)
      ?? finite(breadth.limitUp)
      ?? ztList.length
    const zbCount = finite(zb?.total)
      ?? finite(sentiment.brokenLimit)
      ?? zbList.length
    const breakRate = (ztCount + zbCount)
      ? Math.round(zbCount / (ztCount + zbCount) * 100)
      : null
    const tiers = {}
    let maxBoard = finite(sentiment.maxBoardHeight) ?? 0
    ztList.forEach((stock) => {
      const boardCount = stock.lbc || 1
      if (boardCount > maxBoard) maxBoard = boardCount
      const key = boardCount >= 2 ? boardCount : 1
      tiers[key] = (tiers[key] || 0) + 1
    })
    const linkedBoardCount = finite(sentiment.linkedBoardCount) != null
      ? finite(sentiment.linkedBoardCount)
      : ztList.length - (tiers[1] || 0)
    const sentimentScore = finite(sentiment.score)
    let score = sentimentScore ?? 50
    if (sentimentScore == null) {
      if (ztCount >= 60) score += 15
      else if (ztCount >= 30) score += 8
      else if (ztCount < 15) score -= 12
      if (breakRate != null) {
        if (breakRate <= 15) score += 12
        else if (breakRate >= 35) score -= 15
      }
      if (maxBoard >= 5) score += 10
      else if (maxBoard >= 3) score += 5
      if (breadth.limitDown > 10) score -= 10
      score = Math.max(0, Math.min(100, score))
    }
    const level = score >= 70
      ? { text: '情绪火热', className: 'red' }
      : score >= 55
        ? { text: '情绪偏暖', className: 'gold' }
        : score >= 40
          ? { text: '情绪中性', className: 'muted' }
          : { text: '情绪偏冷', className: 'green' }
    return {
      ztCount,
      zbCount,
      breakRate,
      maxBoard,
      linkedBoardCount,
      score,
      level,
      breadth,
    }
  }, [zt, zb, market])
  const guidance = buildSentimentGuidance({
    ...gauge,
    lianban: gauge.linkedBoardCount,
    b: gauge.breadth,
  })

  if (!market && !zt && !zb) {
    return (
      <section className="panel senti-gauge workbench-aside">
        <div className="sg-head">
          <div
            role="heading"
            aria-level="2"
            className="panel-title"
          >
            <Icon name="fire" size={16} /> 市场情绪
          </div>
        </div>
        <div
          className={error ? 'err' : 'loading'}
          role={error ? 'alert' : 'status'}
        >
          {error
            ? `情绪数据暂不可用：${error}`
            : loading ? '正在更新市场情绪...' : '暂无市场情绪数据'}
        </div>
      </section>
    )
  }

  return (
    <section className="panel senti-gauge workbench-aside">
      <div className="sg-head">
        <div role="heading" aria-level="2" className="panel-title">
          <Icon name="fire" size={16} /> 市场情绪
        </div>
        <span className={`sg-level ${gauge.level.className}`}>
          {gauge.level.text} · {gauge.score}分
        </span>
      </div>
      <div className="sg-bar">
        <span
          className={`sg-bar-fill ${gauge.level.className}`}
          style={{ width: `${gauge.score}%` }}
        />
      </div>
      <div className="sg-cells">
        <div className="sg-cell">
          <span className="sg-k">涨停</span>
          <span className="sg-v red">{gauge.ztCount}</span>
        </div>
        <div className="sg-cell">
          <span className="sg-k">炸板</span>
          <span className="sg-v">{gauge.zbCount}</span>
        </div>
        <div className="sg-cell">
          <span className="sg-k">炸板率</span>
          <span className={
            'sg-v '
            + (
              gauge.breakRate != null && gauge.breakRate >= 35
                ? 'green'
                : gauge.breakRate != null && gauge.breakRate <= 15
                  ? 'red'
                  : ''
            )
          }>
            {gauge.breakRate != null ? `${gauge.breakRate}%` : '--'}
          </span>
        </div>
        <div className="sg-cell">
          <span className="sg-k">最高板</span>
          <span className="sg-v gold">
            {gauge.maxBoard || '--'}板
          </span>
        </div>
        <div className="sg-cell">
          <span className="sg-k">连板数</span>
          <span className="sg-v">{gauge.linkedBoardCount}</span>
        </div>
        <div className="sg-cell">
          <span className="sg-k">跌停</span>
          <span className="sg-v green">
            {gauge.breadth.limitDown ?? '--'}
          </span>
        </div>
      </div>
      <MarketInterpretation guidance={guidance} compact />
    </section>
  )
}

function MarketBoard({
  market,
  marketFunds,
  overseas,
  sectors,
  limitUp,
  loading,
  error,
  overseasError,
}) {
  const breadth = market?.breadth || {}
  const indices = market?.indices || []
  const overseasIndices = overseas?.indices || []
  const commodities = overseas?.commodities || []
  const up = Number(breadth.up)
  const down = Number(breadth.down)
  const ratio = down > 0 ? up / down : up > 0 ? 9 : null
  const limitUpCount = finite(limitUp?.total)
    ?? finite(breadth.limitUp)
  const limitDownCount = breadth.limitDown
  const regime = deriveMarketRegime({
    ...(market || {}),
    breadth: {
      ...breadth,
      limitUp: limitUpCount,
      limitDown: limitDownCount,
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
      text: '市场方向切换，只在量价与资金共振后小仓试错',
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
  const topSector = sectors?.list?.[0] || null
  const guidance = buildMarketBoardGuidance({
    regime,
    indices,
    breadth,
    topSector,
    limitUp: limitUpCount,
    limitDown: limitDownCount,
  })
  const [reportOpen, setReportOpen] = useState(false)
  const amountYi = finite(breadth.amountYi)
  const amountText = amountYi != null
    ? `${Math.round(amountYi).toLocaleString('zh-CN')}亿`
    : '--'
  const volumeText = breadth.volumeComparable === false
    ? '待收盘确认'
    : breadth.volVsAvg5 == null
      ? breadth.volLevel || '--'
      : `${breadth.volLevel || ''} ${fmtPct(breadth.volVsAvg5)}`.trim()

  return (
    <section className="panel market-board workbench-primary">
      <div className="panel-head">
        <div role="heading" aria-level="2" className="panel-title">
          <Icon name="pulse" size={16} />
          今日大盘
          <span className="sub-name">国内指数、市场广度与海外联动</span>
        </div>
        <div className="market-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setReportOpen(true)}
          >
            <Icon name="clipboard" size={13} />
            策略日报
          </button>
          <div className={`mb-light ${regimeView.light}`}>
            <span className="orb-dot" />
            {regimeView.status} · {regimeView.text}
          </div>
        </div>
      </div>
      {reportOpen && <DailyReport onClose={() => setReportOpen(false)} />}

      {loading && !market ? (
        <div className="loading" role="status">正在更新今日大盘...</div>
      ) : error && !market ? (
        <div className="err" role="alert">大盘数据暂不可用：{error}</div>
      ) : (
        <>
          <div className={`mb-plan ${regimeView.light}`}>
            <span className="mb-plan-icon">
              <Icon name={regimeView.icon} size={18} />
            </span>
            <div className="mb-plan-txt">
              <div className="mb-plan-title">{regimeView.title}</div>
              <div className="mb-plan-sub">{regimeView.sub}</div>
            </div>
          </div>

          <MarketFundsSummary funds={marketFunds} />

          <div className="market-section-label">
            <strong>A股指数</strong>
            <span>实时 / 最近收盘</span>
          </div>
          <div className="mb-body">
            <div className="mb-indices">
              {indices.length ? indices.map((item) => (
                <div className="mb-idx" key={item.code || item.name}>
                  <div className="mb-idx-name">{item.name}</div>
                  <div className={`mb-idx-price ${pctClass(item.pct)}`}>
                    {fmtRaw(item.price)}
                  </div>
                  <div className={`mb-idx-pct ${pctClass(item.pct)}`}>
                    {fmtPct(item.pct)}
                  </div>
                </div>
              )) : (
                <div className="market-index-empty" role="status">
                  A股指数暂不可用
                </div>
              )}
            </div>
            <div className="mb-stats">
              <div className="mb-stat">
                <div className="mb-stat-label">涨/跌停</div>
                <div className="mb-stat-val">
                  <span className="red">{limitUpCount ?? '--'}</span>
                  <span className="sep">/</span>
                  <span className="green">{limitDownCount ?? '--'}</span>
                </div>
              </div>
              <div className="mb-stat">
                <div className="mb-stat-label">涨/跌家数</div>
                <div className="mb-stat-val">
                  <span className="red">{breadth.up ?? '--'}</span>
                  <span className="sep">/</span>
                  <span className="green">{breadth.down ?? '--'}</span>
                </div>
              </div>
              <div className="mb-stat">
                <div className="mb-stat-label">两市成交额</div>
                <div className="mb-stat-val">{amountText}</div>
              </div>
              <div className="mb-stat">
                <div className="mb-stat-label">量能</div>
                <div className="mb-stat-val">{volumeText}</div>
              </div>
              <div className="mb-stat">
                <div className="mb-stat-label">涨跌比</div>
                <div className={`mb-stat-val ${ratio == null ? '' : ratio >= 1 ? 'red' : 'green'}`}>
                  {ratio == null ? '--' : ratio.toFixed(2)}
                </div>
              </div>
              {topSector && (
                <div className="mb-stat">
                  <div className="mb-stat-label">最强板块</div>
                  <div className="mb-stat-val gold">{topSector.name}</div>
                </div>
              )}
            </div>
          </div>

          <div className="market-external-grid">
            <MarketExternalGroup
              title="海外指数"
              note="行情可能延迟"
              items={overseasIndices}
              unavailable={Boolean(overseasError)}
            />
            <MarketExternalGroup
              title="关键商品"
              note="行情可能延迟"
              items={commodities}
              unavailable={Boolean(overseasError)}
            />
          </div>
          <MarketInterpretation guidance={guidance} />
        </>
      )}
    </section>
  )
}

export default function MarketOverview({
  market,
  marketFunds,
  overseas,
  sectors,
  limitUp,
  brokenLimit,
  loading = false,
  error = null,
  overseasError = null,
}) {
  return (
    <div className="research-market-overview">
      <MarketBoard
        market={market}
        marketFunds={marketFunds}
        overseas={overseas}
        sectors={sectors}
        limitUp={limitUp}
        loading={loading}
        error={error}
        overseasError={overseasError}
      />
      <SentimentGauge
        zt={limitUp}
        zb={brokenLimit}
        market={market}
        loading={loading}
        error={error}
      />
    </div>
  )
}
