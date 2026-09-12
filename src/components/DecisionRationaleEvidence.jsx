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

export function EntryInstruction({ instruction, executionOpen = true }) {
  if (instruction?.schemaVersion !== 'entry-instruction.v1') return null
  const expired = instruction.validUntil > 0 && instruction.validUntil <= Date.now()
  if (expired) return (
    <p className="entry-instruction-boundary">
      原{instruction.intentLabel}计划已过期，原价格与手数不可直接执行，需更新决策。
    </p>
  )
  if (instruction.state === 'READY' && !executionOpen) return (
    <p className="entry-instruction-boundary">
      原{instruction.intentLabel}计划当前不可执行；下一交易时段重新核定买价、手数与收益。
    </p>
  )
  return (
    <div
      className="entry-instruction"
      data-state={instruction.state}
    >
      <div className="entry-instruction-title">
        <strong>{instruction.intentLabel}计划</strong>
        <span>{instruction.timing?.headline}</span>
      </div>
      <dl className="decision-rationale-facts">
        <div>
          <dt>什么时候</dt>
          <dd>{instruction.timing?.explanation}</dd>
        </div>
        <div>
          <dt>多少钱</dt>
          <dd>
            {instruction.price?.explanation}
            {instruction.price?.stopPrice > 0
              ? ` 止损${price(instruction.price.stopPrice)}。`
              : ''}
            {instruction.price?.targetPrice > 0
              ? ` 目标${price(instruction.price.targetPrice)}。`
              : ''}
          </dd>
        </div>
        <div>
          <dt>买多少</dt>
          <dd>{instruction.quantity?.explanation}</dd>
        </div>
        <div>
          <dt>预期收益</dt>
          <dd>{instruction.expectedReturn?.explanation}</dd>
        </div>
        {instruction.validUntil > 0 && (
          <div>
            <dt>有效期限</dt>
            <dd>{new Date(instruction.validUntil).toLocaleString('zh-CN', {
              timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
              hour: '2-digit', minute: '2-digit', hour12: false,
            })}；行情或账本变化后需重新核定</dd>
          </div>
        )}
      </dl>
      <p className="entry-instruction-boundary">
        {instruction.modelBoundary}
      </p>
    </div>
  )
}

export default function DecisionRationaleEvidence({ rationale, hideEntry = false }) {
  if (rationale?.schemaVersion !== 'decision-rationale.v1') return null
  const entryContext = rationale.context === 'ENTRY'
  const entryInstruction = rationale.entryInstruction
  const comparisons = entryContext
    ? rationale.pathComparison
    : rationale.actionComparison

  return (
    <section
      className="decision-rationale"
      aria-label={entryContext ? '价格与手数依据' : '持仓动作与手数依据'}
    >
      {!hideEntry && <EntryInstruction instruction={entryInstruction} />}

      {entryContext && !entryInstruction && (
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
            <dt>当前仓位</dt>
            <dd>{rationale.quantity?.explanation}</dd>
          </div>
        </dl>
      )}

      {(!entryContext || !entryInstruction) && (
        <p className="decision-rationale-boundary">
          <b>模型边界</b>
          {rationale.modelBoundary}
        </p>
      )}
    </section>
  )
}
