import Icon from './Icon'
import Md from './Md'
import {
  existingSectorConceptText,
} from '../../shared/sectorConceptExplanation.js'

export default function SectorConceptExplanation({
  sector,
  savedExplanation,
  loading = false,
  status = '',
  error = '',
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
            {loading ? '解释中' : 'AI解释'}
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
  return (
    <section className="sector-concept-explanation">
      <div className="sector-concept-explanation-head">
        <span><Icon name="info" size={15} />概念说明</span>
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
      <Md text={conceptExplanation.text} />
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
    </section>
  )
}
