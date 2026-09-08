import { normalizeSelectionOrigin } from '../../shared/selectionOrigin.js'

export default function SelectionOrigin({ value }) {
  const origin = normalizeSelectionOrigin(value)
  if (!origin) return null
  const expired = origin.entry.validUntil != null
    && origin.entry.validUntil < Date.now()
  return (
    <details className="selection-origin" onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}>
      <summary>
        选入依据 · {origin.label}
        {expired ? ' · 原关注条件已过期' : ''}
      </summary>
      <div>
        <small>
          加入时间 {new Date(origin.capturedAt).toLocaleString('zh-CN', { hour12: false })}
        </small>
        {origin.reasons.map((reason, index) => <p key={index}>{reason}</p>)}
        {origin.entry.price && (
          <p>原关注价 {origin.entry.price}元 · {origin.entry.trigger}</p>
        )}
        <p>{origin.entry.window}</p>
        {(origin.exit.stopPrice || origin.exit.targetPrice) && (
          <p>
            原止损 {origin.exit.stopPrice ?? '--'}元
            {' · '}原目标 {origin.exit.targetPrice ?? '--'}元
          </p>
        )}
        {origin.exit.timeStopDate && <p>原定复核日期 {origin.exit.timeStopDate}</p>}
        {origin.risks.map((risk, index) => <p className="muted" key={index}>{risk}</p>)}
        {origin.sourceUrl && (
          <a href={origin.sourceUrl} target="_blank" rel="noopener noreferrer">原始公告</a>
        )}
      </div>
    </details>
  )
}
