export default function StrategyPatternEvidence({
  pattern,
  confirmation = null,
}) {
  if (
    !pattern?.label || typeof pattern.label !== 'string'
    || !Number.isFinite(pattern.score) || pattern.score < 70
    || !Array.isArray(pattern.evidence)
  ) return null
  const evidence = pattern.evidence.filter((value) => typeof value === 'string')
  if (!evidence.length) return null
  return (
    <div className="strategy-pattern-evidence" aria-label="形态依据">
      <b>{pattern.recallAdded ? '新增召回：' : '形态：'}{pattern.label}</b>
      <span>{evidence.join('；')}</span>
      {confirmation?.summary && (
        <span className="strategy-pattern-confirmation">
          <strong>触价后核对：</strong>{confirmation.summary}
        </span>
      )}
    </div>
  )
}
