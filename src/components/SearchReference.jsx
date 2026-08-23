import { visibleSearchReference } from '../../shared/aiSearchUi.js'
import { useAiSearchConfig } from '../aiSearchConfigStore'
import Icon from './Icon'

export default function SearchReference({
  reference,
  compact = false,
  enabled,
}) {
  const config = useAiSearchConfig()
  const visible = visibleSearchReference(
    enabled == null ? config.enabled : enabled,
    reference,
  )
  if (!visible) return null

  return (
    <section
      className={'search-reference' + (compact ? ' compact' : '')}
      aria-label="检索参考"
    >
      <div className="search-reference-head">
        <span><Icon name="search" size={12} /> 检索参考</span>
        <b>{visible.sources.length} 条</b>
      </div>
      <div className="search-reference-list">
        {visible.sources.map((item, index) => {
          const content = (
            <>
              <span className="search-reference-title">{item.title}</span>
              <span className="search-reference-meta">
                {item.src || '豆包搜索'}{item.date ? ` · ${item.date}` : ''}
              </span>
              {!compact && item.summary && (
                <span className="search-reference-summary">{item.summary}</span>
              )}
            </>
          )
          return item.url
            ? (
              <a
                className="search-reference-item"
                href={item.url}
                target="_blank"
                rel="noreferrer"
                key={`${item.url}-${index}`}
              >
                {content}
                <Icon name="chevronRight" size={11} />
              </a>
            )
            : <div className="search-reference-item" key={`${item.title}-${index}`}>{content}</div>
        })}
      </div>
    </section>
  )
}
