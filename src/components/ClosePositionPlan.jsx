import { fmtRaw } from '../format.js'
import Icon from './Icon'

function signedMoney(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '暂不估算'
  return `${number > 0 ? '+' : number < 0 ? '-' : ''}${
    Math.abs(Math.round(number))
  }元`
}

export default function ClosePositionPlan({ plan }) {
  const ready = plan?.state === 'READY'
  if (!ready) {
    return (
      <div className="close-position-plan invalid" role="status">
        <div className="decision-eyebrow">
          <span>收盘决策不可用</span>
        </div>
        <div className="decision-headline">
          <Icon name="info" size={21} />
          <strong>{plan?.conclusion?.headline || '尚未生成收盘预案'}</strong>
        </div>
        <p className="decision-reason">
          {plan?.summary || '请重新生成完整决策；当前不采用旧价格和手数。'}
        </p>
      </div>
    )
  }

  const actionValue = plan.risk?.actionValueAmount
  return (
    <div className="close-position-plan">
      <div className="decision-eyebrow">
        <span>次日交易预案</span>
        <span>{plan.nextSessionLabel}</span>
      </div>
      <div className="decision-headline">
        <Icon
          name={['EXIT', 'REDUCE'].includes(plan.conclusion.action)
            ? 'sell'
            : 'shield'}
          size={21}
        />
        <strong>{plan.conclusion.headline}</strong>
      </div>
      <p className="decision-reason">{plan.summary}</p>

      <dl className="close-position-facts" aria-label="收盘持仓风险">
        <div>
          <dt>收盘价</dt>
          <dd>{fmtRaw(plan.closePrice)}<small>元</small></dd>
        </div>
        <div>
          <dt>至止损额外风险</dt>
          <dd>{Math.round(plan.risk.lossToStopAmount)}<small>元</small></dd>
        </div>
        <div data-tone={
          Number(actionValue) > 0
            ? 'positive'
            : Number(actionValue) < 0
              ? 'negative'
              : 'neutral'
        }>
          <dt>{plan.risk.actionValueLabel}</dt>
          <dd>{signedMoney(actionValue)}</dd>
        </div>
      </dl>

      <div className="close-position-scenarios" aria-label="次日开盘三种路径">
        {plan.scenarios.map((scenario) => (
          <div
            key={scenario.key}
            className="close-position-scenario"
            data-tone={scenario.tone}
          >
            <span className="close-position-dot" aria-hidden="true" />
            <div>
              <strong>{scenario.label}</strong>
              <span>{scenario.condition}</span>
              <p>{scenario.instruction}</p>
            </div>
          </div>
        ))}
      </div>

      <dl className="decision-execution-facts close-position-meta">
        <div>
          <dt>失效条件</dt>
          <dd>{plan.invalidation}</dd>
        </div>
        <div>
          <dt>有效期</dt>
          <dd>{plan.validUntilLabel}；行情或账户变化后立即重算</dd>
        </div>
      </dl>
      <p className="close-position-risk-note">{plan.risk.note}</p>
    </div>
  )
}
