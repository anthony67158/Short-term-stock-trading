import { useEffect, useMemo, useState } from 'react'
import Icon from './Icon'
import {
  modelTrainingStore,
  useModelTrainingStore,
} from '../modelTrainingStore'
import { formatQuantMetric } from '../../shared/quantRetrainReport'
import { humanizeUserFacingText } from '../../shared/userFacingLanguage'

const STATUS = {
  published: { label: '已发布', tone: 'ok' },
  passed: { label: '通过待审核', tone: 'ok' },
  rejected: { label: '未通过', tone: 'warn' },
  skipped: { label: '等待数据', tone: 'neutral' },
  failed: { label: '运行异常', tone: 'bad' },
  cancelled: { label: '已取消', tone: 'neutral' },
}

function formatTime(value) {
  if (!value) return '未提供'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '未提供'
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function count(value) {
  return value == null || !Number.isFinite(Number(value))
    ? '未提供'
    : Number(value).toLocaleString('zh-CN')
}

function metricValue(metric) {
  if (metric.value == null) return '未提供'
  if (metric.unit === 'percent-points') {
    return `${Number(metric.value).toFixed(3)}%`
  }
  if (metric.unit === 'r') return `${Number(metric.value).toFixed(4)} R`
  return Number(metric.value).toFixed(4)
}

function seedMetricText(item) {
  return Object.entries(item)
    .filter(([key]) => key !== 'seed')
    .map(([key, value]) => {
      if (/ReturnPct$/i.test(key)) return `${Number(value).toFixed(3)}%`
      if (/MaeR$/i.test(key)) return `${Number(value).toFixed(4)} R`
      return Number(value).toFixed(4)
    })
    .join(' · ')
}

function ModelSummary({ model, active, selected, onSelect }) {
  const status = STATUS[model.latest?.status] || STATUS.failed
  return (
    <button
      type="button"
      className={`mtc-model${selected ? ' active' : ''}`}
      aria-pressed={selected}
      onClick={() => onSelect(model.id)}
    >
      <span className="mtc-model-main">
        <strong>{model.name}</strong>
        <small>{model.task}</small>
      </span>
      <span className={`mtc-status ${status.tone}`}>
        {model.latest ? status.label : '暂无训练'}
      </span>
      <span className="mtc-model-count">{model.runs} 次</span>
      {(model.activeVersion || (
        model.id === 'opportunity-decision' && active?.modelVersion
      )) && (
        <span className="mtc-active-version" title={
          model.activeVersion || active?.modelVersion
        }>
          现役 {model.activeVersion || active?.modelVersion}
        </span>
      )}
    </button>
  )
}

function TrainingFacts({ run }) {
  const data = run.data || {}
  const range = data.startDate || data.endDate
    ? `${data.startDate || '未提供'} 至 ${data.endDate || '未提供'}`
    : '历史记录未提供'
  return (
    <dl className="mtc-facts">
      <div><dt>算法</dt><dd>{run.algorithm || '历史记录未提供'}</dd></div>
      <div><dt>训练目标</dt><dd>{run.objective || '历史记录未提供'}</dd></div>
      <div><dt>标签</dt><dd>{run.label || '历史记录未提供'}</dd></div>
      <div><dt>标签版本</dt><dd>{run.labelVersion || '历史记录未提供'}</dd></div>
      <div><dt>数据区间</dt><dd>{range}</dd></div>
      <div><dt>成熟样本</dt><dd>{count(data.samples)}</dd></div>
      <div><dt>训练 / 验证</dt><dd>{count(data.trainSamples)} / {count(data.testSamples)}</dd></div>
      <div><dt>交易日</dt><dd>{count(data.dates)}</dd></div>
      <div><dt>最低门槛</dt><dd>{count(run.gate?.minimumSamples)} 样本 · {count(run.gate?.minimumDates)} 日</dd></div>
      <div><dt>生产指针</dt><dd>{run.productionChanged ? '本轮已切换' : '本轮未切换'}</dd></div>
    </dl>
  )
}

function TrainingMetrics({ run }) {
  if (!run.metrics?.length && !run.comparisonMetrics?.length) return null
  return (
    <section className="mtc-detail-section">
      <h4>评估指标</h4>
      {run.metrics?.length > 0 && (
        <div className="mtc-metric-grid">
          {run.metrics.map((metric) => (
            <div key={metric.key}>
              <span>{metric.label}</span>
              <strong>{metricValue(metric)}</strong>
            </div>
          ))}
        </div>
      )}
      {run.comparisonMetrics?.length > 0 && (
        <div className="mtc-table-wrap">
          <table className="mtc-table">
            <thead>
              <tr><th>指标</th><th>生产对照</th><th>本次训练</th><th>发布组合</th></tr>
            </thead>
            <tbody>
              {run.comparisonMetrics.map((metric, index) => (
                <tr key={`${metric.label}-${index}`}>
                  <th>{metric.label}</th>
                  <td>{formatQuantMetric(metric.champion, metric.unit)}</td>
                  <td>{formatQuantMetric(metric.challenger, metric.unit)}</td>
                  <td>{formatQuantMetric(metric.selected, metric.unit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function TrainingRun({ run, expanded }) {
  const status = STATUS[run.status] || STATUS.failed
  return (
    <article className="mtc-run">
      <div className="mtc-run-head">
        <div>
          <strong>{run.modelName}</strong>
          <time>{formatTime(run.runAt)}</time>
        </div>
        <span className={`mtc-status ${status.tone}`}>{status.label}</span>
      </div>
      <div className="mtc-run-strip">
        <span>版本 <b>{run.version || '未生成'}</b></span>
        <span>样本 <b>{count(run.data?.samples)}</b></span>
        <span>交易日 <b>{count(run.data?.dates)}</b></span>
        <span>种子 <b>{run.seeds?.length ? run.seeds.join(' / ') : '未提供'}</b></span>
      </div>
      <details open={expanded}>
        <summary>训练数据、指标与门禁详情</summary>
        <TrainingFacts run={run} />
        {run.features?.length > 0 && (
          <section className="mtc-detail-section">
            <h4>输入特征 · {run.features.length} 项</h4>
            <div className="mtc-features">
              {run.features.map((feature) => <code key={feature}>{feature}</code>)}
            </div>
          </section>
        )}
        <TrainingMetrics run={run} />
        {run.seedMetrics?.length > 0 && (
          <section className="mtc-detail-section">
            <h4>随机种子稳定性</h4>
            <div className="mtc-seeds">
              {run.seedMetrics.map((item) => (
                <span key={item.seed}>
                  Seed {item.seed} <b>{seedMetricText(item)}</b>
                </span>
              ))}
            </div>
          </section>
        )}
        {run.components?.length > 0 && (
          <section className="mtc-detail-section">
            <h4>组成部分评估</h4>
            <div className="mtc-components">
              {run.components.map((component, index) => (
                <div key={`${component.label}-${index}`}>
                  <strong>{component.label}</strong>
                  <span>{component.status || '待核对'}</span>
                  {component.notes.map((note) => (
                    <p key={note}>{humanizeUserFacingText(note)}</p>
                  ))}
                </div>
              ))}
            </div>
          </section>
        )}
        {run.thresholds?.length > 0 && (
          <section className="mtc-detail-section">
            <h4>发布门禁阈值</h4>
            <div className="mtc-thresholds">
              {run.thresholds.map((threshold) => (
                <span key={threshold.key}>
                  {threshold.key} <b>{threshold.value}</b>
                </span>
              ))}
            </div>
          </section>
        )}
        {run.facts?.length > 0 && (
          <dl className="mtc-facts mtc-legacy-facts">
            {run.facts.map((fact, index) => (
              <div key={`${fact.label}-${index}`}>
                <dt>{fact.label}</dt><dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {run.reasons?.length > 0 && (
          <section className="mtc-detail-section">
            <h4>门禁结论</h4>
            <ul className="mtc-reasons">
              {run.reasons.map((reason) => (
                <li key={reason}>{humanizeUserFacingText(reason)}</li>
              ))}
            </ul>
          </section>
        )}
        <div className="mtc-audit">
          <span>报告 {run.reportPath || '历史记录未提供'}</span>
          <span>视图哈希 {run.sourceViewHash || '历史记录未提供'}</span>
          <span>产物 {run.artifacts?.length ? run.artifacts.join('、') : '本轮无候选产物'}</span>
        </div>
      </details>
    </article>
  )
}

export default function ModelTrainingCenter() {
  const state = useModelTrainingStore()
  const [modelId, setModelId] = useState('all')

  useEffect(() => {
    modelTrainingStore.load()
  }, [])

  const visible = useMemo(
    () => state.runs.filter((run) =>
      modelId === 'all' || run.modelId === modelId
    ),
    [modelId, state.runs],
  )

  if (state.loading && !state.loaded) {
    return (
      <div className="mtc-empty" role="status">
        <Icon name="refresh" size={16} className="spin" />
        正在读取全部模型训练记录
      </div>
    )
  }

  return (
    <div className="mtc">
      <div className="mtc-toolbar">
        <div>
          <strong>统一训练台账</strong>
          <span>{state.models.length} 个模型 · {state.runs.length} 次运行</span>
        </div>
        <button
          type="button"
          className="btn mtc-refresh"
          disabled={state.loading}
          onClick={() => modelTrainingStore.load({ force: true })}
        >
          <Icon name="refresh" size={13} className={state.loading ? 'spin' : ''} />
          刷新
        </button>
      </div>

      {state.error && (
        <div className="mtc-error" role="alert">
          <span>{state.error}</span>
          <button type="button" onClick={() => modelTrainingStore.load({ force: true })}>重试</button>
        </div>
      )}
      {state.warnings.map((warning) => (
        <div className="mtc-warning" role="status" key={warning}>{warning}</div>
      ))}

      <div className="mtc-models" role="group" aria-label="按模型筛选训练记录">
        <button
          type="button"
          className={`mtc-model mtc-model-all${modelId === 'all' ? ' active' : ''}`}
          aria-pressed={modelId === 'all'}
          onClick={() => setModelId('all')}
        >
          <span className="mtc-model-main"><strong>全部模型</strong><small>统一时间线</small></span>
          <span className="mtc-model-count">{state.runs.length} 次</span>
        </button>
        {state.models.map((model) => (
          <ModelSummary
            key={model.id}
            model={model}
            active={state.active}
            selected={modelId === model.id}
            onSelect={setModelId}
          />
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="mtc-empty">
          <Icon name="gauge" size={20} />
          <span>暂无该模型的训练记录</span>
        </div>
      ) : (
        <div className="mtc-runs">
          {visible.map((run, index) => (
            <TrainingRun key={run.id} run={run} expanded={index === 0} />
          ))}
        </div>
      )}
    </div>
  )
}
