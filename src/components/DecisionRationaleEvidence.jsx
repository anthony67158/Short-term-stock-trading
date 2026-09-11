function price(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0
    ? `${number.toFixed(2)}元`
    : '--'
}

function valueTone(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number === 0) return 'neutral'
  return number > 0 ? 'positive' : 'negative'
}

export default function DecisionRationaleEvidence({ rationale }) {
  if (rationale?.schemaVersion !== 'decision-rationale.v1') return null
  const entryContext = rationale.context === 'ENTRY'
  const comparisons = entryContext
    ? rationale.pathComparison
    : rationale.actionComparison

  return (
    <section
      className="decision-rationale"
      aria-label={entryContext ? '价格与手数依据' : '持仓动作与手数依据'}
    >
      {entryContext && (
        <dl className="decision-rationale-facts">
          <div>
            <dt>价格怎么来</dt>
            <dd>{rationale.price?.explanation}</dd>
          </div>
          <div>
            <dt>手数怎么定</dt>
            <dd>{rationale.quantity?.explanation}</dd>
          </div>
        </dl>
      )}

      {Array.isArray(comparisons) && comparisons.length > 0 && (
        <div
          className="decision-rationale-comparison"
          aria-label={entryContext ? '候选价格路径比较' : '持仓动作比较'}
        >
          <strong className="decision-rationale-heading">
            {entryContext ? '三条路径比较' : '当前动作比较'}
          </strong>
          {comparisons.map((item) => (
            <div
              className="decision-rationale-row"
              data-selected={item.selected || undefined}
              key={entryContext ? item.route : item.action}
            >
              <div className="decision-rationale-row-title">
                <b>{item.label}</b>
                {item.selected && <span>当前选择</span>}
                {entryContext && <strong>{price(item.entryPrice)}</strong>}
              </div>
              {entryContext && (
                <p>
                  止损 {price(item.stopPrice)} · 目标 {price(item.targetPrice)}
                  {item.trigger ? ` · ${item.trigger}` : ''}
                </p>
              )}
              <p data-tone={valueTone(item.actionUtilityR ?? item.expectedNetR)}>
                {item.explanation}
              </p>
            </div>
          ))}
        </div>
      )}

      {!entryContext && (
        <dl className="decision-rationale-facts">
          <div>
            <dt>手数怎么定</dt>
            <dd>{rationale.quantity?.explanation}</dd>
          </div>
        </dl>
      )}

      <p className="decision-rationale-boundary">
        <b>模型边界</b>
        {rationale.modelBoundary}
      </p>
    </section>
  )
}
