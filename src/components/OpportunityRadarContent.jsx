import { useState } from 'react'
import Icon from './Icon'
import OpportunityCandidateRow from './OpportunityCandidateRow'
import OpportunityIntradayNav from './OpportunityIntradayNav'

const SOURCE_LABELS = Object.freeze({
  sector: '板块方向',
  formulaIntraday: '盘中公式',
  formulaClose: '收盘公式',
  tail: '尾盘反转',
  preCatalyst: '预催化发现',
})

const STATUS_LABELS = Object.freeze({
  fresh: '已更新',
  stale: '已过期',
  missing: '暂无',
  failed: '失败',
  scheduled: '待生成',
  pending: '等待结果',
  running: '更新中',
  manual: '待手动生成',
})

function sourceTime(source = {}) {
  if (source.tradeDate) return source.tradeDate
  const timestamp = Number(source.dataAsOf)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function laneSummary(rows) {
  return rows.reduce((summary, item) => {
    const priced = !!(item.entryPlan && item.exitPlan)
    if (item.state === 'READY') summary.ready += 1
    else if (item.state === 'WAIT_TRIGGER') summary.waiting += 1
    else if (priced) summary.blocked += 1
    else summary.avoid += 1
    return summary
  }, {
    ready: 0,
    waiting: 0,
    blocked: 0,
    avoid: 0,
  })
}

function laneCopy(lane, summary) {
  if (summary.ready > 0) {
    return {
      icon: 'target',
      title: `${summary.ready}只满足买入条件`,
      detail:
        '先核对触发条件和仓位，再按对应止损、止盈与时间退出执行。',
    }
  }
  if (summary.waiting > 0) {
    return {
      icon: 'clock',
      title: `${summary.waiting}只进入今日提前布局`,
      detail: '已经完成买卖定价，价格、量能和资金条件满足后再判断。',
    }
  }
  if (summary.blocked > 0) {
    return {
      icon: 'shield',
      title: `${summary.blocked}只已算出计划但本次不买`,
      detail:
        '入场价、止损和目标已给出，但当前大盘或账户不支持新增风险，先观察不下手。',
    }
  }
  return {
    icon: 'shield',
    title: lane === 'intraday'
      ? '当前没有通过个股公式的盘中机会'
      : '尚未生成次日关注计划',
    detail: lane === 'intraday'
      ? '结果为空也是有效结论，不用无买点股票凑数。'
      : '收盘后手动运行，使用当日收盘数据生成。',
  }
}

function sectorsFromRows(rows) {
  const unique = new Map()
  for (const item of rows) {
    const sector = item.sector
    const key = String(sector?.code || sector?.name || '')
    if (!key || unique.has(key)) continue
    unique.set(key, sector)
  }
  return [...unique.values()].slice(0, 5)
}

function SourceStatus({ sourceStatus = {}, keys = [] }) {
  return (
    <div className="opportunity-source-status" aria-label="数据来源状态">
      {keys.map((key) => {
        const label = SOURCE_LABELS[key]
        const source = sourceStatus[key] || { status: 'missing' }
        const time = sourceTime(source)
        return (
          <span
            key={key}
            data-status={source.status}
            title={source.error || ''}
          >
            <i />
            {label} · {STATUS_LABELS[source.status] || '未知'}
            {source.message
              ? ` · ${source.message}`
              : time ? ` · ${time}` : ''}
          </span>
        )
      })}
    </div>
  )
}

function OpportunitySection({
  id,
  labelledBy,
  tone,
  icon,
  title,
  detail,
  rows,
  book,
  onAdd,
  portfolioMap,
  action = null,
  empty,
}) {
  return (
    <section
      id={id}
      className="opportunity-section"
      role="tabpanel"
      aria-labelledby={labelledBy}
      data-mode={tone}
    >
      <div className="opportunity-section-head">
        <div className="opportunity-section-title">
          <span className="opportunity-section-kicker">
            <Icon name={icon} size={14} />
            当前查看
          </span>
          <div>
            <strong>{title}</strong>
            <span>{detail}</span>
          </div>
        </div>
        <div className="opportunity-section-actions">
          <strong>{rows.length}只</strong>
          {action}
        </div>
      </div>
      {rows.length ? (
        <CandidateList
          rows={rows}
          book={book}
          onAdd={onAdd}
          portfolioMap={portfolioMap}
        />
      ) : (
        <div className="opportunity-section-empty">{empty}</div>
      )}
    </section>
  )
}

function CandidateList({ rows, book, onAdd, portfolioMap }) {
  const renderRow = (item) => (
    <OpportunityCandidateRow
      key={item.code}
      opportunity={item}
      portfolio={portfolioMap?.get(item.code) || null}
      added={(book?.plan || []).some(
        (candidate) => candidate.code === item.code,
      )}
      onAdd={onAdd}
    />
  )
  const visible = rows.slice(0, 8)
  const remaining = rows.slice(8)
  return (
    <div className="opportunity-radar-list">
      {visible.map(renderRow)}
      {!!remaining.length && (
        <details className="opportunity-more">
          <summary>查看其余 {remaining.length} 只</summary>
          <div>{remaining.map(renderRow)}</div>
        </details>
      )}
    </div>
  )
}

// 组合层概览：展示本轮新增风险预算占用与已纳入的独立机会数。
// 只在有可入场候选参与预算时显示，纯只读，不改变任何个股结论。
function PortfolioBar({ portfolio }) {
  const budget = portfolio?.budget
  if (!budget || !(Number(budget.limitPct) > 0)) return null
  const approved = Number(budget.approvedPct) || 0
  const limit = Number(budget.limitPct) || 0
  const included = Number(budget.includedCount) || 0
  const capped = (portfolio.candidates || []).filter((item) =>
    item.portfolioState === 'SECTOR_CAPPED'
    || item.portfolioState === 'CORRELATION_CAPPED'
    || item.portfolioState === 'BUDGET_CAPPED',
  ).length
  const ratio = limit > 0
    ? Math.min(100, Math.max(0, approved / limit * 100))
    : 0
  return (
    <div className="opportunity-portfolio-bar" role="status">
      <div className="opportunity-portfolio-head">
        <Icon name="shield" size={14} />
        <strong>组合风险预算</strong>
        <span>
          已纳入 {included} 个独立机会 · 占用约 {approved}% / 上限 {limit}%
        </span>
      </div>
      <div className="opportunity-portfolio-track" aria-hidden="true">
        <i style={{ width: `${ratio}%` }} />
      </div>
      {capped > 0 && (
        <small>
          另有 {capped} 只因板块、主题相关或预算已满先观察，
          避免同向重仓。
        </small>
      )}
    </div>
  )
}

// 漂移预警：只在样本充足且明确检出漂移时提示，样本不足/稳定时不显示噪音。
function DriftNotice({ drift }) {
  if (!drift || drift.state !== 'DRIFT_DETECTED') return null
  const alerts = Array.isArray(drift.alerts) ? drift.alerts : []
  if (!alerts.length) return null
  return (
    <div className="opportunity-drift" role="status">
      <Icon name="info" size={14} />
      <div>
        <strong>统计漂移提醒</strong>
        <span>{alerts[0].message}</span>
        {alerts.length > 1 && (
          <small>另有 {alerts.length - 1} 项指标同时预警，建议复核。</small>
        )}
      </div>
    </div>
  )
}

export default function OpportunityRadarContent({
  lane,
  snapshot,
  book,
  onAdd,
  onRunTail,
  tailRunning = false,
}) {
  const [intradayView, setIntradayView] = useState('')
  const rows = snapshot?.lanes?.[lane] || []
  const portfolio = snapshot?.portfolios?.[lane] || null
  const portfolioMap = new Map(
    (portfolio?.candidates || []).map((item) => [item.code, item]),
  )
  const tailRows = lane === 'intraday'
    ? rows.filter((item) =>
    (item.sourceSignals || []).some((signal) =>
      String(signal).includes('尾盘')
    )
  )
    : []
  const regularRows = rows.filter((item) =>
    !(item.sourceSignals || []).some((signal) =>
      String(signal).includes('尾盘')
    )
  )
  const readyRows = regularRows.filter((item) =>
    item.state === 'READY' && item.entryPlan && item.exitPlan,
  )
  const layoutRows = regularRows.filter((item) =>
    item.state !== 'READY' && item.entryPlan && item.exitPlan,
  )
  const strictTailRows = tailRows.filter((item) =>
    item.entryPlan && item.exitPlan && !item.sourceSignals.includes(
      '尾盘接近公式',
    ),
  )
  const tailWatchRows = tailRows.filter((item) =>
    !strictTailRows.includes(item),
  )
  const plannedRows = lane === 'next'
    ? rows.filter((item) => item.entryPlan && item.exitPlan)
    : [...readyRows, ...layoutRows]
  const intradayGroups = {
    ready: readyRows,
    layout: layoutRows,
    tail: [...strictTailRows, ...tailWatchRows],
  }
  const activeIntradayView = intradayView || (
    readyRows.length
      ? 'ready'
      : layoutRows.length
        ? 'layout'
        : 'tail'
  )
  const activeIntradayRows =
    intradayGroups[activeIntradayView] || readyRows
  const summary = laneSummary(rows)
  const copy = laneCopy(lane, summary)
  const sectors = sectorsFromRows(rows)
  const sourceKeys = lane === 'intraday'
    ? ['sector', 'formulaIntraday', 'preCatalyst', 'tail']
    : ['sector', 'formulaClose', 'preCatalyst']
  const sourceFailures = Object.entries(snapshot?.sourceStatus || {})
    .filter(([key, value]) =>
      sourceKeys.includes(key)
      && (value?.status === 'failed' || value?.status === 'stale'),
    )
  const pendingSources = Object.entries(snapshot?.sourceStatus || {})
    .filter(([key, value]) =>
      (
        lane === 'next'
          ? key === 'formulaClose'
            || key === 'preCatalyst'
          : ['formulaIntraday', 'preCatalyst', 'tail'].includes(key)
      )
      && ['scheduled', 'pending', 'running', 'manual'].includes(
        value?.status,
      )
    )
  const tailStatus = snapshot?.sourceStatus?.tail || {}
  const tailSession = snapshot?.tailSession || {}
  const tailButtonLabel = tailRunning
    ? '扫描中'
    : '手动扫描'
  const preCatalystCounts = snapshot?.preCatalyst?.counts || {}
  const preCatalystDetail = Number(
    preCatalystCounts.eligibleCandidates,
  ) > 0
    ? `预催化发现${Number(
        preCatalystCounts.eligibleCandidates,
      )}只；联网线索${Number(
        preCatalystCounts.externalLeads,
      ) || 0}条待官方核验`
    : '包含预催化潜伏与公式候选，均需等待价格、量能和资金确认'
  const intradayViewMeta = {
    ready: {
      title: '可立即买入',
      detail: '价格、量能、资金、板块和风险条件均已通过，可按计划人工执行',
      icon: 'target',
      empty: '当前0只。没有股票同时通过全部买入条件。',
    },
    layout: {
      title: '今日提前布局',
      detail: preCatalystDetail,
      icon: 'clock',
      empty: '当前0只。没有形成完整价格合同的提前布局候选。',
    },
    tail: {
      title: '尾盘反转',
      detail:
        tailStatus.message
        || tailSession.reason
        || '14:50自动扫描，也可手动运行',
      icon: 'history',
      empty: '当前0只。尚无今日尾盘公式结果；14:50自动扫描。',
    },
  }[activeIntradayView]

  return (
    <>
      {lane === 'intraday' ? (
        <OpportunityIntradayNav
          active={activeIntradayView}
          counts={{
            ready: readyRows.length,
            layout: layoutRows.length,
            tail: tailRows.length,
          }}
          onChange={setIntradayView}
        />
      ) : (
        <div className="opportunity-radar-summary" role="status">
          <Icon name={copy.icon} size={17} />
          <div>
            <strong>{copy.title}</strong>
            <span>{copy.detail}</span>
          </div>
          <dl>
            <div><dt>可操作</dt><dd>{summary.ready}</dd></div>
            <div><dt>待触发</dt><dd>{summary.waiting}</dd></div>
            <div><dt>暂不买</dt><dd>{summary.blocked + summary.avoid}</dd></div>
          </dl>
        </div>
      )}

      <DriftNotice drift={snapshot?.baseline?.drift} />
      <PortfolioBar portfolio={portfolio} />

      {!!pendingSources.length && (
        <div
          className="opportunity-source-warning pending"
          role="status"
        >
          <Icon name="clock" size={14} />
          <span>
            {pendingSources.map(([key, value]) =>
              `${SOURCE_LABELS[key]}${value.message
                ? `：${value.message}`
                : '正在更新'}`
            ).join('；')}。完成后本页自动更新。
          </span>
        </div>
      )}

      {!!sectors.length && (
        <div className="opportunity-sector-strip">
          <span>优先方向</span>
          <div>
            {sectors.map((sector) => (
              <span key={sector.code || sector.name}>
                <b>{sector.name}</b>
                <small>
                  #{sector.layoutRank || sector.rank || '--'}
                  {' · '}
                  {sector.phase === 'ACCUMULATION'
                    ? '潜伏'
                    : sector.phase === 'STARTUP'
                      ? '启动'
                      : '跟踪'}
                </small>
              </span>
            ))}
          </div>
        </div>
      )}

      {lane === 'intraday' ? (
        <>
          <OpportunitySection
            id="opportunity-intraday-panel"
            labelledBy={`opportunity-intraday-tab-${activeIntradayView}`}
            tone={activeIntradayView}
            icon={intradayViewMeta.icon}
            title={intradayViewMeta.title}
            detail={intradayViewMeta.detail}
            rows={activeIntradayRows}
            book={book}
            onAdd={onAdd}
            portfolioMap={portfolioMap}
            action={activeIntradayView === 'tail' ? (
              <button
                type="button"
                className="btn"
                onClick={onRunTail}
                disabled={tailRunning || !tailSession.canRun}
                aria-busy={tailRunning}
              >
                <Icon
                  name={tailRunning ? 'refresh' : 'play'}
                  size={13}
                  className={tailRunning ? 'spin' : ''}
                />
                {tailButtonLabel}
              </button>
            ) : null}
            empty={intradayViewMeta.empty}
          />
          {activeIntradayView === 'tail'
            && !!tailWatchRows.length
            && !strictTailRows.length && (
            <div className="opportunity-tail-note">
              <Icon name="info" size={13} />
              今日严格公式未完整命中；当前展示
              {tailWatchRows.length} 只接近公式，仅供核对，不可直接买入。
            </div>
          )}
        </>
      ) : plannedRows.length ? (
        <>
          <div className="opportunity-list-head">
            <strong>次日关注计划</strong>
            <span>当日收盘数据生成，次日开盘仍需确认</span>
          </div>
          <CandidateList
            rows={plannedRows}
            book={book}
            onAdd={onAdd}
            portfolioMap={portfolioMap}
          />
        </>
      ) : (
        <div className="opportunity-empty">
          <Icon name="shield" size={20} />
          <strong>当前没有形成完整买卖计划的股票</strong>
          <span>
            收盘后点击“生成次日关注”，只有同时给出入场价、
            止损、目标和合格赔率的公式候选才会进入这里。
          </span>
        </div>
      )}

      {!!sourceFailures.length && (
        <div className="opportunity-source-warning" role="status">
          <Icon name="info" size={14} />
          <span>
            {sourceFailures.map(([key, value]) =>
              `${SOURCE_LABELS[key]}${
                value.status === 'failed' ? '读取失败' : '已过期'
              }`,
            ).join('；')}。其它有效结果仍保留。
          </span>
        </div>
      )}
      <SourceStatus
        sourceStatus={snapshot?.sourceStatus}
        keys={sourceKeys}
      />
    </>
  )
}
