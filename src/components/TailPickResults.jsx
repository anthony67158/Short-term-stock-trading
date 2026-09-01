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
  allowExecution,
  onAdd,
}) {
  const candidates = result?.result?.candidates || []
  const nearCandidates = result?.result?.nearCandidates || []
  const noTrade = result?.result?.decision === 'NO_TRADE'
  const hasNearCandidates = nearCandidates.length > 0
  const marketWarnings = result?.marketGate?.blockers || []
  return (
    <>
      <div
        className="tail-pick-summary"
        data-result={noTrade && !hasNearCandidates ? 'empty' : 'observing'}
      >
        <div>
          <span>
            {result.session?.isFormal ? '14:50正式版' : '手动试算'}
            {' · '}
            {noTrade
              ? hasNearCandidates
                ? `严格公式0只 · 接近条件${nearCandidates.length}只`
                : '本次未发现匹配结果'
              : `${candidates.length}只严格公式观察股`}
          </span>
          <strong>{result.result?.reason}</strong>
        </div>
        <small>数据截至 {timeLabel(result.session?.dataAsOf)}</small>
      </div>

      {marketWarnings.length > 0 && (
        <div className="tail-pick-market-notes">
          <strong>市场环境参考</strong>
          <span>{marketWarnings.join('；')}</span>
        </div>
      )}

      {noTrade && !hasNearCandidates && (
        <div className="tail-pick-no-trade">
          <Icon name="target" size={22} />
          <strong>本次没有匹配结果</strong>
          <span>
            {result.marketGate?.blockers?.[0]
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
            <strong>接近公式计算结果</strong>
            <span>按接近度排序，完整展示缺失条件与风险项</span>
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
        <b>计算结果仅供判断，不自动下单</b>
      </div>
    </>
  )
}
