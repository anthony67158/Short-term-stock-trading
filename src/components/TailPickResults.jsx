import Icon from './Icon'
import TailPickCandidate from './TailPickCandidate'

function timeLabel(value) {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '--'
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export default function TailPickResults({
  result,
  book,
  accountGate,
  allowExecution,
  onAdd,
}) {
  const candidates = result?.result?.candidates || []
  const nearCandidates = result?.result?.nearCandidates || []
  const noTrade = result?.result?.decision === 'NO_TRADE'
  const hasNearCandidates = nearCandidates.length > 0
  return (
    <>
      <div
        className="tail-pick-summary"
        data-result={noTrade ? 'blocked' : 'observing'}
      >
        <div>
          <span>
            {result.session?.isFormal ? '14:50正式版' : '手动试算'}
            {' · '}
            {noTrade
              ? hasNearCandidates
                ? `严格公式0只 · 接近观察${nearCandidates.length}只`
                : '今日不开仓'
              : `${candidates.length}只严格公式观察股`}
          </span>
          <strong>{result.result?.reason}</strong>
        </div>
        <small>数据截至 {timeLabel(result.session?.dataAsOf)}</small>
      </div>

      {!accountGate.allowRiskIncrease && (
        <div className="tail-pick-account-block">
          <Icon name="shield" size={16} />
          <span>
            {accountGate.blockers?.[0]?.message
              || '账户纪律已阻止新增风险'}
          </span>
        </div>
      )}

      {noTrade && (
        <div className="tail-pick-no-trade">
          <Icon name="shield" size={22} />
          <strong>
            {hasNearCandidates
              ? '严格公式今日不新开仓'
              : '唯一操作：今天不新开仓'}
          </strong>
          <span>
            {hasNearCandidates
              ? '下方股票只接近原公式，条件补齐前仅观察'
              : result.marketGate?.blockers?.[0]
                || result.result?.reason}
          </span>
        </div>
      )}

      {candidates.length > 0 && (
        <div className="tail-pick-list">
          {candidates.map((candidate) => (
            <TailPickCandidate
              key={candidate.code}
              candidate={candidate}
              allowExecution={allowExecution}
              added={book.plan.some(
                (item) => item.code === candidate.code,
              )}
              onAdd={onAdd}
            />
          ))}
        </div>
      )}

      {hasNearCandidates && (
        <section className="tail-pick-near-section">
          <div className="tail-pick-near-head">
            <strong>接近公式观察</strong>
            <span>最多缺2项次要条件，仅可加入自选</span>
          </div>
          <div className="tail-pick-list">
            {nearCandidates.map((candidate) => (
              <TailPickCandidate
                key={candidate.code}
                candidate={candidate}
                allowExecution={false}
                added={book.plan.some(
                  (item) => item.code === candidate.code,
                )}
                onAdd={onAdd}
              />
            ))}
          </div>
        </section>
      )}

      <div className="tail-pick-foot">
        <span>
          全市场检查 {result.result?.universe?.inspectedCount ?? 0} 只
        </span>
        <span>
          严格命中 {result.result?.universe?.formulaMatchCount ?? 0} 只
        </span>
        <span>
          接近公式 {result.result?.universe?.nearFormulaCount ?? 0} 只
        </span>
        <b>尚未通过分钟级样本外回测，不自动下单</b>
      </div>
    </>
  )
}
