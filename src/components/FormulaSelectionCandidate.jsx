import Icon from './Icon'
import StockName from './StockName'

export const FORMULA_NAMES = {
  INTRADAY_VWAP_PULLBACK: '盘中回踩承接',
  INTRADAY_ACCUMULATION: '盘中资金先行',
  CLOSE_TREND_PULLBACK: '收盘趋势回踩',
  CLOSE_SQUEEZE: '收盘蓄势突破',
}

export const PRICE_LABELS = {
  PULLBACK_WATCH: '回踩观察',
  BREAKOUT_WATCH: '突破观察',
}

export function displayFormulaPrice(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0
    ? number.toFixed(2)
    : '--'
}

export default function FormulaSelectionCandidate({
  candidate,
  added,
  onAdd,
}) {
  return (
    <article className="formula-selection-row">
      <div className="formula-selection-rank">
        <span>观察 {candidate.rank}</span>
        <strong>{candidate.score}分</strong>
      </div>
      <StockName
        code={candidate.code}
        name={candidate.name}
        compact
        showTags
      />
      <div className="formula-selection-formula">
        <strong>
          {FORMULA_NAMES[candidate.formulaId] || candidate.formulaId}
        </strong>
        <span>
          {candidate.validationState === 'OBSERVE_ONLY'
            ? '观察中'
            : '已验证'}
        </span>
      </div>
      <div className="formula-selection-price">
        <span>
          {PRICE_LABELS[candidate.priceType] || '唯一主价位'}
        </span>
        <strong>{displayFormulaPrice(candidate.primaryPrice)}</strong>
      </div>
      <div className="formula-selection-risk">
        <span>止损 {displayFormulaPrice(candidate.stopPrice)}</span>
        <span>目标 {displayFormulaPrice(candidate.targetPrice)}</span>
        <span>赔率 {candidate.riskReward ?? '--'}:1</span>
      </div>
      <div className="formula-selection-evidence">
        {(candidate.evidence || []).slice(0, 2).map((item) => (
          <span key={item}>{item}</span>
        ))}
      </div>
      <button
        type="button"
        className="chip-btn"
        disabled={added}
        onClick={() => onAdd(candidate)}
      >
        <Icon name={added ? 'check' : 'plus'} size={13} />
        {added ? '已在自选中' : '加入自选'}
      </button>
    </article>
  )
}
