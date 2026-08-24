import Icon from './Icon'
import Md from './Md'
import {
  existingSectorConceptText,
  sectorConceptExplanationSections,
  sectorConceptExplanationSummary,
} from '../../shared/sectorConceptExplanation.js'

export default function SectorConceptExplanation({
  sector,
  savedExplanation,
  loading = false,
  status = '',
  error = '',
  expanded = false,
  onToggle,
  onExplain,
}) {
  const embeddedText = existingSectorConceptText(sector)
  const conceptExplanation = savedExplanation || (
    embeddedText
      ? {
          name: sector?.name || '',
          text: embeddedText,
          evidence: [],
          model: '',
        }
      : null
  )

  if (!conceptExplanation) {
    return (
      <section className="sector-concept-explanation empty">
        <div className="sector-concept-explanation-head">
          <span><Icon name="info" size={15} />概念说明</span>
          <button
            type="button"
            className="row-btn sector-concept-explain-button"
            disabled={loading}
            onClick={onExplain}
          >
            <Icon name={loading ? 'pulse' : 'spark'} size={13} />
            {loading ? '解释中' : '解释'}
          </button>
        </div>
        {status && (
          <span className="sector-concept-explanation-status" role="status">
            {status}
          </span>
        )}
        {error && (
          <span className="sector-concept-explanation-error" role="alert">
            {error}
          </span>
        )}
      </section>
    )
  }

  const evidence = Array.isArray(conceptExplanation.evidence)
    ? conceptExplanation.evidence
    : []
  const summary = sectorConceptExplanationSummary(
    conceptExplanation.text,
  )
  const sections = sectorConceptExplanationSections(
    conceptExplanation.text,
  )
  return (
    <section
      className={
        'sector-concept-explanation'
        + (expanded ? ' expanded' : ' collapsed')
      }
    >
      <div className="sector-concept-explanation-head">
        <button
          type="button"
          className="sector-concept-toggle"
          aria-expanded={expanded}
          aria-label={`${expanded ? '收起' : '展开'}${sector?.name || ''}的概念说明`}
          onClick={onToggle}
        >
          <span className="sector-concept-heading">
            <Icon name="info" size={15} />
            <span>概念说明</span>
          </span>
          <Icon
            name={expanded ? 'chevronDown' : 'chevronRight'}
            size={13}
          />
        </button>
        <button
          type="button"
          className="row-btn sector-concept-explain-button"
          disabled={loading}
          onClick={onExplain}
        >
          <Icon name={loading ? 'pulse' : 'refresh'} size={13} />
          {loading ? '解释中' : '重新解释'}
        </button>
      </div>
      {!expanded && (
        <button
          type="button"
          className="sector-concept-collapsed-summary"
          aria-label={`展开${sector?.name || ''}的概念说明`}
          onClick={onToggle}
        >
          {summary}
        </button>
      )}
      {expanded && (
        <div className="sector-concept-explanation-body">
          <section className="sector-concept-core">
            <span className="sector-concept-section-label">
              一句话看懂
            </span>
            <Md text={sections.definition || summary} />
          </section>
          {(sections.reason || sections.boundary) && (
            <div className="sector-concept-detail-grid">
              {sections.reason && (
                <section className="sector-concept-detail">
                  <span className="sector-concept-section-label">
                    为什么形成
                  </span>
                  <Md text={sections.reason} />
                </section>
              )}
              {sections.boundary && (
                <section className="sector-concept-detail">
                  <span className="sector-concept-section-label">
                    怎么辨认
                  </span>
                  <Md text={sections.boundary} />
                </section>
              )}
            </div>
          )}
          {!!evidence.length && (
            <details className="sector-concept-sources">
              <summary>联网参考 {evidence.length}</summary>
              <ul>
                {evidence.map((item, index) => (
                  <li key={`${item.title}-${index}`}>
                    {item.url ? (
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {item.title}
                      </a>
                    ) : (
                      <span>{item.title}</span>
                    )}
                    <small>{item.source || '公开检索'} {item.date || ''}</small>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {status && (
        <span className="sector-concept-explanation-status" role="status">
          {status}
        </span>
      )}
      {error && (
        <span className="sector-concept-explanation-error" role="alert">
          {error}
        </span>
      )}
    </section>
  )
}
