import Icon from './Icon'
import OpportunityCandidateRow from './OpportunityCandidateRow'

const SOURCE_LABELS = Object.freeze({
  sector: '板块方向',
  formulaIntraday: '盘中公式',
  formulaClose: '收盘公式',
  tail: '尾盘反转',
})

const STATUS_LABELS = Object.freeze({
  fresh: '已更新',
  stale: '已过期',
  missing: '暂无',
  failed: '失败',
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
    else if (item.state === 'SECTOR_WATCH') summary.sectorWatch += 1
    else if (priced) summary.blocked += 1
    else summary.avoid += 1
    return summary
  }, {
    ready: 0,
    waiting: 0,
    sectorWatch: 0,
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
      title: `${summary.waiting}只到价后再买`,
      detail: '不提前抢跑，满足价格、量能和资金条件后再判断。',
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
  if (summary.sectorWatch > 0) {
    return {
      icon: 'compass',
      title: `${summary.sectorWatch}只只有方向依据`,
      detail: '板块方向可看，但个股尚无完整买卖价格合同。',
    }
  }
  return {
    icon: 'shield',
    title: lane === 'intraday'
      ? '当前没有可执行的盘中机会'
      : '当前没有形成完整买入计划',
    detail: '结果为空也是有效结论，不为凑数量降低条件。',
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

function SourceStatus({ sourceStatus = {} }) {
  return (
    <div className="opportunity-source-status" aria-label="数据来源状态">
      {Object.entries(SOURCE_LABELS).map(([key, label]) => {
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
            {time ? ` · ${time}` : ''}
          </span>
        )
      })}
    </div>
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
          另有 {capped} 只因同板块集中或预算已满先观察，避免同向重仓。
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
}) {
  const rows = snapshot?.lanes?.[lane] || []
  const portfolio = snapshot?.portfolios?.[lane] || null
  const portfolioMap = new Map(
    (portfolio?.candidates || []).map((item) => [item.code, item]),
  )
  const plannedRows = rows.filter((item) =>
    item.entryPlan && item.exitPlan,
  )
  const directionRows = rows.filter((item) =>
    !item.entryPlan || !item.exitPlan,
  )
  const summary = laneSummary(rows)
  const copy = laneCopy(lane, summary)
  const sectors = sectorsFromRows(rows)
  const sourceFailures = Object.entries(snapshot?.sourceStatus || {})
    .filter(([, value]) =>
      value?.status === 'failed' || value?.status === 'stale',
    )

  return (
    <>
      <div className="opportunity-radar-summary" role="status">
        <Icon name={copy.icon} size={17} />
        <div>
          <strong>{copy.title}</strong>
          <span>{copy.detail}</span>
        </div>
        <dl>
          <div><dt>可操作</dt><dd>{summary.ready}</dd></div>
          <div><dt>待触发</dt><dd>{summary.waiting}</dd></div>
          <div><dt>看方向</dt><dd>{summary.sectorWatch}</dd></div>
        </dl>
      </div>

      <DriftNotice drift={snapshot?.baseline?.drift} />
      <PortfolioBar portfolio={portfolio} />

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

      {plannedRows.length ? (
        <>
          <div className="opportunity-list-head">
            <strong>个股买卖计划</strong>
            <span>按当前可执行性排序，价格条件未满足前不买</span>
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
            板块方向不等于个股买点；需要个股公式同时给出
            入场价、止损、目标和合格赔率后才会进入这里。
          </span>
        </div>
      )}

      {!!directionRows.length && (
        <details className="opportunity-direction-watch">
          <summary>
            方向观察 {directionRows.length} 只
            <span>尚无完整价格，不代表可以买入</span>
          </summary>
          <CandidateList
            rows={directionRows}
            book={book}
            onAdd={onAdd}
            portfolioMap={portfolioMap}
          />
        </details>
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
      <SourceStatus sourceStatus={snapshot?.sourceStatus} />
    </>
  )
}
