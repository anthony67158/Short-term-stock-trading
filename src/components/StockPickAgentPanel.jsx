import Icon from './Icon'
import { openStockDetail } from '../detailStore'
import { fmtRaw } from '../format'

const DECISION_LABEL = Object.freeze({
  BUY_NOW: '可按条件买入',
  WAIT_TRIGGER: '等待触发',
  LAYOUT_SMALL: '小仓布局',
  WATCH_NEXT_DAY: '次日观察',
  REJECT: '本轮放弃',
})

export default function StockPickAgentPanel({
  selection,
  references = [],
  modeLabel = '',
}) {
  if (!selection) {
    return (
      <section className="panel stock-pick-agent empty" aria-label={`${modeLabel}结果`}>
        <div className="panel-title">
          <Icon name="target" size={16} /> {modeLabel}结论
        </div>
        <p className="stock-pick-empty">运行 Agent 后在此查看可解释结论。</p>
      </section>
    )
  }
  if (selection.conclusion === 'SELECT' && selection.selections?.length) {
    return (
      <section className="panel stock-pick-agent" aria-label={`${modeLabel}结果`}>
        <header className="stock-pick-result-head">
          <div>
            <div className="panel-title">
              <Icon name="target" size={16} />
              {modeLabel} · {selection.selections.length} 只
            </div>
            {selection.stageAssessment && (
              <p>{selection.stageAssessment}</p>
            )}
          </div>
          <span className="stock-pick-result-model">
            {selection.agentModel || '选股 Agent'}
          </span>
        </header>
        {selection.overallReason && (
          <p className="stock-pick-agent-reason">{selection.overallReason}</p>
        )}
        <div className="stock-pick-agent-list">
          {selection.selections.map((item) => (
            <AgentCard key={item.code} selection={item} />
          ))}
        </div>
        {!!selection.limitations?.length && (
          <div className="stock-pick-limitations">
            <Icon name="info" size={13} />
            {selection.limitations.join('；')}
          </div>
        )}
      </section>
    )
  }
  return (
    <section className="panel stock-pick-agent unselected" aria-label={`${modeLabel}未选`}>
      <div className="panel-title">
        <Icon name="shield" size={16} /> {modeLabel} · 本轮不选
      </div>
      <p className="stock-pick-agent-reason">
        {selection.reason
          || selection.overallReason
          || '当前证据不足，未形成可执行结论'}
      </p>
      {references?.length > 0 && (
        <div className="stock-pick-refs">
          <div className="stock-pick-refs-head">
            排序 Top 候选，仅供复核，未经本模式 Agent 选中
          </div>
          {references.map((item) => (
            <button
              type="button"
              key={item.code}
              className="stock-pick-ref-row"
              onClick={() => openStockDetail(item.code, item.name)}
            >
              <span className="stock-pick-ref-stock">
                <strong>{item.name}</strong><small>{item.code}</small>
              </span>
              <span className="stock-pick-ref-source">
                {item.rankingSource === 'MODEL' ? '模型分' : '规则分'}{' '}
                {fmtRaw(item.rankingScore)}
              </span>
              <span className="stock-pick-ref-reasons">
                {(item.recallReasons || []).slice(0, 2).join(' · ')}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

function AgentCard({ selection }) {
  return (
    <article className="stock-pick-agent-card">
      <button
        type="button"
        className="stock-pick-agent-card-open"
        onClick={() => openStockDetail(selection.code, selection.name)}
        aria-label={`查看${selection.name || selection.code}详情`}
      >
        <span className="stock-pick-agent-rank">#{selection.rank}</span>
        <strong>{selection.name}</strong>
        <small>{selection.code}</small>
        <span className="stock-pick-decision">
          {DECISION_LABEL[selection.decision] || '等待确认'}
        </span>
        <Icon name="chevronRight" size={14} />
      </button>
      <p className="stock-pick-agent-rationale">{selection.rationale}</p>
      <dl className="stock-pick-agent-grid">
        <div>
          <dt>买入策略</dt>
          <dd>
            <strong>
              {selection.buyStrategy?.entryPrice != null
                ? `参考 ${fmtRaw(selection.buyStrategy.entryPrice)}`
                : '等待触发价'}
              {selection.buyStrategy?.positionPctMax
                ? ` · 仓位≤${selection.buyStrategy.positionPctMax}%`
                : ''}
            </strong>
            {selection.buyStrategy?.plan && <small>{selection.buyStrategy.plan}</small>}
          </dd>
        </div>
        <div>
          <dt>触发时机</dt>
          <dd>
            <strong>{selection.timing?.trigger || '—'}</strong>
            {selection.timing?.window && <small>{selection.timing.window}</small>}
          </dd>
        </div>
        <div>
          <dt>T+1 约束</dt>
          <dd>
            <strong>{selection.t1Plan?.rule || '买入当日不可卖出'}</strong>
            {selection.t1Plan?.overnightRisk && (
              <small>{selection.t1Plan.overnightRisk}</small>
            )}
          </dd>
        </div>
        <div>
          <dt>下一步</dt>
          <dd>
            <strong>
              {selection.t1Plan?.nextDayAction
                || selection.timing?.nextSession
                || '下一交易日复核'}
            </strong>
          </dd>
        </div>
      </dl>
      <div className="stock-pick-risk-grid">
        {selection.counterCase && (
          <p><span>反方</span>{selection.counterCase}</p>
        )}
        {selection.invalidation && (
          <p><span>失效</span>{selection.invalidation}</p>
        )}
      </div>
      {!!selection.evidence?.length && (
        <ul className="stock-pick-evidence">
          {selection.evidence.map((item, index) => (
            <li key={`${item.tool}-${index}`}>
              <code>{item.tool}</code>
              <span>{item.summary}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}
