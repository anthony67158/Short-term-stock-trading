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
  added,
  allowExecution,
  onAdd,
}) {
  const primary = candidate.execution?.role === 'PRIMARY'
  const near = candidate.execution?.role === 'NEAR'
  const canAdd = !added
  const missingRules = (candidate.nearMatch?.failedRules || [])
    .map((item) => item.label)
    .filter(Boolean)
  const evidence = near
    ? [
        missingRules.length
          ? `未满足：${missingRules.join('、')}`
          : null,
        candidate.blockers?.[0],
        candidate.sector?.name
          ? `${candidate.sector.name}方向`
          : '暂未匹配主线方向',
        candidate.fund?.historyDayCount
          ? `${candidate.fund.historyDayCount}日资金通过承接检查`
          : null,
      ].filter(Boolean)
    : [
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
      data-role={near ? 'near' : primary ? 'primary' : 'alternate'}
    >
      <div className="tail-pick-rank">
        <span>
          {near
            ? `接近公式 ${candidate.rank}`
            : primary ? '首选观察' : `候补 ${candidate.rank}`}
        </span>
        <strong>
          {near
            ? `${candidate.nearMatch?.passedCount ?? '--'}/${
              candidate.nearMatch?.totalRuleCount ?? 14
            }项`
            : `${candidate.score}分`}
        </strong>
      </div>
      <div className="tail-pick-stock">
        <StockName
          code={candidate.code}
          name={candidate.name}
          showTags={false}
        />
      </div>
      <div className="tail-pick-prices">
        <span>现价 <b>{price(candidate.quote?.price)}</b></span>
        <span>
          {near ? '换手' : '均价'}
          {' '}
          <b>
            {near
              ? `${price(candidate.quote?.turnover)}%`
              : price(candidate.intraday?.vwap)}
          </b>
        </span>
        <span>
          {near ? '缺少' : '止损'}
          {' '}
          <b>
            {near
              ? `${missingRules.length}项`
              : price(candidate.execution?.stopPrice)}
          </b>
        </span>
      </div>
      <div className="tail-pick-action">
        <strong>{candidate.execution?.action}</strong>
        {primary && !near && (
          <>
            <span>{candidate.execution.firstLeg}</span>
            <span>{candidate.execution.secondLeg}</span>
          </>
        )}
        {candidate.execution?.takeProfit && (
          <span>
            {candidate.execution.takeProfit}
            {candidate.execution?.finalExitDate
              ? `；最晚${candidate.execution.finalExitDate}退出`
              : ''}
          </span>
        )}
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
            : near
              ? '加入自选观察，不生成买入动作'
              : !allowExecution
              ? '加入自选观察，不生成买入动作'
              : primary ? '加入尾盘观察计划' : '加入自选'
        }
      >
        <Icon name={added ? 'check' : 'plus'} size={14} />
        {added
          ? '已加入'
          : primary && allowExecution && !near
            ? '加入尾盘计划'
            : '加入自选'}
      </button>
    </article>
  )
}
