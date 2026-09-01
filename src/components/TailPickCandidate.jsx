import Icon from './Icon'
import StockName from './StockName'

function price(value) {
  return value != null
    && value !== ''
    && Number.isFinite(Number(value))
    ? Number(value).toFixed(2)
    : '--'
}

function fundText(candidate) {
  const main = Number(candidate.fund?.mainNetYi)
  const retail = Number(candidate.fund?.retailNetYi)
  const days = Number(candidate.fund?.historyDayCount) || 0
  if (!Number.isFinite(main) || !Number.isFinite(retail)) {
    return '主力或小单资金数据缺失'
  }
  return `${
    days ? `${days}日资金；` : ''
  }主力${main >= 0 ? '净流入' : '净流出'}${Math.abs(main).toFixed(2)}亿，`
    + `小单${retail >= 0 ? '净流入' : '净流出'}${Math.abs(retail).toFixed(2)}亿`
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
  const decisionWarnings = Array.isArray(candidate.decisionWarnings)
    ? candidate.decisionWarnings
    : []
  const evidence = [...new Set((near
    ? [
        missingRules.length
          ? `未满足：${missingRules.join('、')}`
          : null,
        ...decisionWarnings.map((item) => `风险提示：${item}`),
        candidate.sector?.name
          ? `${candidate.sector.name}方向`
          : '暂未匹配主线方向',
        fundText(candidate),
      ].filter(Boolean)
    : [
        ...decisionWarnings.map((item) => `风险提示：${item}`),
        candidate.sector?.name
          ? `${candidate.sector.name}方向`
          : null,
        candidate.evidence?.[0],
        fundText(candidate),
      ].filter(Boolean)
  ))]
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
              ? '加入自选，后续由你结合计算结果判断'
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
