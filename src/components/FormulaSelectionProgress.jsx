import Icon from './Icon'

const FORMULA_STEPS = Object.freeze([
  { stages: ['MARKET_GATE'], label: '核验市场' },
  { stages: ['UNIVERSE', 'PREFILTER'], label: '读取全市场' },
  { stages: ['TECHNICAL'], label: '检查日线' },
  { stages: ['EVIDENCE'], label: '复核资金' },
  { stages: ['RANKING', 'SAVING', 'DONE'], label: '生成结果' },
])

const TAIL_STEPS = Object.freeze([
  { stages: ['MARKET_GATE'], label: '核验市场' },
  { stages: ['FORMULA_SCAN'], label: '读取全市场' },
  { stages: ['DISCIPLINE_GATE'], label: '执行风控' },
  { stages: ['DONE'], label: '生成结果' },
])

function safePercent(value) {
  const number = Number(value)
  return Number.isFinite(number)
    ? Math.max(1, Math.min(100, Math.round(number)))
    : 3
}

function activeStepIndex(steps, stage) {
  if (stage === 'FAILED') return -1
  return steps.findIndex((item) => item.stages.includes(stage))
}

function progressDetail(task = {}) {
  const counts = task.counts || {}
  if (
    Number.isFinite(Number(counts.technicalChecked))
    && Number.isFinite(Number(counts.technicalTotal))
  ) {
    return `日线 ${counts.technicalChecked}/${counts.technicalTotal}`
  }
  if (
    Number.isFinite(Number(counts.evidenceChecked))
    && Number.isFinite(Number(counts.evidenceTotal))
  ) {
    return `证据 ${counts.evidenceChecked}/${counts.evidenceTotal}`
  }
  if (Number(counts.inspected) > 0) {
    return `已读取 ${counts.inspected} 只`
  }
  return ''
}

export default function FormulaSelectionProgress({
  task,
  mode = 'formula',
}) {
  if (!task || task.status !== 'RUNNING') return null
  const steps = mode === 'tail' ? TAIL_STEPS : FORMULA_STEPS
  const percent = safePercent(task.percent ?? task.progress)
  const currentIndex = activeStepIndex(steps, task.stage)
  const detail = progressDetail(task)

  return (
    <div
      className="formula-run-progress"
      aria-live="polite"
      aria-atomic="true"
      aria-busy="true"
    >
      <div className="formula-run-current">
        <Icon name="pulse" size={15} />
        <span>{task.message || '正在计算公式结果'}</span>
        {detail && <small>{detail}</small>}
        <b>{percent}%</b>
      </div>
      <div
        className="formula-run-track"
        role="progressbar"
        aria-label="公式选股计算进度"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={percent}
        style={{ '--formula-progress': `${percent}%` }}
      >
        <i />
      </div>
      <ol className="formula-run-steps">
        {steps.map((item, index) => {
          const state = currentIndex < 0
            ? 'pending'
            : index < currentIndex
              ? 'done'
              : index === currentIndex ? 'active' : 'pending'
          return (
            <li
              key={`${item.label}-${index}`}
              data-state={state}
              aria-current={state === 'active' ? 'step' : undefined}
            >
              <span>{state === 'done' ? '✓' : index + 1}</span>
              <b>{item.label}</b>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
