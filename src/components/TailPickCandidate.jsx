import Icon from './Icon'
import StockName from './StockName'

function price(value) {
  return value != null
    && value !== ''
    && Number.isFinite(Number(value))
    ? Number(value).toFixed(2)
    : '--'
}

export default function TailPickCandidate({
  candidate,
  accountGate,
  added,
  allowPlanAction,
  onAdd,
}) {
  const primary = candidate.execution?.role === 'PRIMARY'
  const canAdd = !added && allowPlanAction
  const evidence = [
    candidate.sector?.name
      ? `${candidate.sector.name}方向`
      : null,
    candidate.evidence?.[0],
    candidate.fund?.historyDayCount
      ? `${candidate.fund.historyDayCount}日资金已核验`
      : '资金证据缺失',
  ].filter(Boolean)
  return (
    <article
      className="tail-pick-row"
      data-role={primary ? 'primary' : 'alternate'}
    >
      <div className="tail-pick-rank">
        <span>{primary ? '首选观察' : `候补 ${candidate.rank}`}</span>
        <strong>{candidate.score}分</strong>
      </div>
      <div className="tail-pick-stock">
        <StockName
          code={candidate.code}
          name={candidate.name}
          showTags={false}
        />
        <span>{candidate.code}</span>
      </div>
      <div className="tail-pick-prices">
        <span>现价 <b>{price(candidate.quote?.price)}</b></span>
        <span>均价 <b>{price(candidate.intraday?.vwap)}</b></span>
        <span>止损 <b>{price(candidate.execution?.stopPrice)}</b></span>
      </div>
      <div className="tail-pick-action">
        <strong>{candidate.execution?.action}</strong>
        {primary && (
          <>
            <span>{candidate.execution.firstLeg}</span>
            <span>{candidate.execution.secondLeg}</span>
          </>
        )}
        <span>
          {candidate.execution?.takeProfit}
          {candidate.execution?.finalExitDate
            ? `；最晚${candidate.execution.finalExitDate}退出`
            : ''}
        </span>
      </div>
      <div className="tail-pick-evidence">
        {evidence.map((item) => <span key={item}>{item}</span>)}
      </div>
      <button
        type="button"
        className={primary ? 'btn btn-primary' : 'chip-btn'}
        disabled={!canAdd}
        onClick={() => onAdd(candidate)}
        title={
          added
            ? '已在自选中'
            : !allowPlanAction
              ? '当前不是本场可执行时间'
            : !accountGate.allowRiskIncrease
              ? '仅加入观察，账户纪律当前不允许开仓'
              : primary ? '加入尾盘观察计划' : '加入自选'
        }
      >
        <Icon name={added ? 'check' : 'plus'} size={14} />
        {added ? '已加入' : primary ? '加入尾盘计划' : '加入自选'}
      </button>
    </article>
  )
}
