import Icon from './Icon'
import { openStockDetail } from '../detailStore'
import { fmtRaw } from '../format'

export default function StockPickCandidatePool({
  snapshot,
  selectable = false,
  selectedCodes = [],
  onToggle,
}) {
  const candidates = snapshot?.candidates || []
  const selected = new Set(selectedCodes)
  if (!candidates.length) {
    return (
      <section className="panel stock-pick-pool" aria-label="候选池">
        <div className="panel-title">
          <Icon name="layers" size={16} /> 模型候选池
        </div>
        <p className="stock-pick-empty">
          {snapshot?.availability === 'UNAVAILABLE'
            ? snapshot.reason || '全市场召回不可用'
            : '点击“全市场扫描”生成真实模型候选。'}
        </p>
      </section>
    )
  }
  return (
    <section className="panel stock-pick-pool" aria-label="模型候选池">
      <header className="stock-pick-pool-head">
        <div>
          <div className="panel-title">
            <Icon name="layers" size={16} />
            模型候选池 · {candidates.length} 只
          </div>
          <p>
            {snapshot.rankingSource === 'MODEL'
              ? `统一基础模型 ${snapshot.modelVersion || '已发布版本'}`
              : '模型分不可用，当前仅显示规则召回，不冒充模型预测'}
          </p>
        </div>
        {selectable && (
          <span className="stock-pick-selected-count">
            已选 {selected.size} / 12
          </span>
        )}
      </header>
      <div className="stock-pick-pool-list">
        {candidates.map((item, index) => {
          const checked = selected.has(item.code)
          return (
            <div
              className={'stock-pick-pool-row' + (checked ? ' selected' : '')}
              key={item.code}
            >
              {selectable ? (
                <label
                  className="stock-pick-check"
                  title={checked ? '移出次日关注' : '加入次日关注'}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!checked && selected.size >= 12}
                    aria-label={`${checked ? '移出' : '加入'}次日关注：${item.name || item.code}`}
                    onChange={() => onToggle?.(item.code)}
                  />
                  <Icon name={checked ? 'checkSquare' : 'square'} size={16} />
                </label>
              ) : (
                <span className="stock-pick-pool-rank">{index + 1}</span>
              )}
              <button
                type="button"
                className="stock-pick-pool-open"
                onClick={() => openStockDetail(item.code, item.name)}
              >
                <span className="stock-pick-pool-stock">
                  <strong>{item.name}</strong><small>{item.code}</small>
                </span>
                <span className="stock-pick-pool-score">
                  {item.ranking?.source === 'MODEL' ? '模型' : '规则'}{' '}
                  {fmtRaw(item.ranking?.score)}
                </span>
                <span className="stock-pick-pool-quote">
                  {item.quote?.pct != null ? `${fmtRaw(item.quote.pct)}%` : '—'}
                </span>
                <span className="stock-pick-pool-reasons">
                  {(item.recallReasons || []).slice(0, 2).join(' · ')}
                </span>
                <Icon name="chevronRight" size={14} />
              </button>
            </div>
          )
        })}
      </div>
    </section>
  )
}
