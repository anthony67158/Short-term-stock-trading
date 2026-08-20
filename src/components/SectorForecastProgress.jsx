import Icon from './Icon'

const CLOSE_STEPS = Object.freeze([
  ['collecting', '采集盘面'],
  ['scoring', '构建评分'],
  ['quant', '量化预测'],
  ['searching', '搜索证据'],
  ['explaining', '深度解释'],
  ['finalizing', '校验结果'],
  ['saving', '保存正式版'],
])

const OVERNIGHT_STEPS = Object.freeze([
  ['loading', '读取正式版'],
  ['searching', '搜索隔夜证据'],
  ['explaining', '深度复核'],
  ['finalizing', '校验排名'],
  ['saving', '保存复核版'],
])

function safePercent(value) {
  const number = Number(value)
  return Number.isFinite(number)
    ? Math.max(1, Math.min(99, Math.round(number)))
    : 3
}

export default function SectorForecastProgress({
  task,
  generating,
}) {
  const active = task?.active
  if (!generating && !active) return null

  const progress = active?.progress || {
    stage: 'preparing',
    percent: 3,
    message: '正在启动板块前瞻任务',
  }
  const percent = safePercent(progress.percent)
  const steps = active?.session === 'overnight'
    ? OVERNIGHT_STEPS
    : CLOSE_STEPS
  const currentIndex = steps.findIndex(
    ([stage]) => stage === progress.stage,
  )

  return (
    <div
      className="sector-forecast-progress"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="sector-progress-current">
        <Icon name="pulse" size={15} />
        <span>{progress.message || '正在生成板块前瞻'}</span>
        <b>{percent}%</b>
      </div>
      <div
        className="sector-progress-track"
        role="progressbar"
        aria-label="板块前瞻生成进度"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={percent}
        style={{ '--sector-progress': `${percent}%` }}
      >
        <i />
      </div>
      <ol className="sector-progress-steps">
        {steps.map(([stage, label], index) => {
          const state = currentIndex < 0
            ? 'pending'
            : index < currentIndex
              ? 'done'
              : index === currentIndex ? 'active' : 'pending'
          return (
            <li
              key={stage}
              data-state={state}
              aria-current={state === 'active' ? 'step' : undefined}
            >
              <span>{state === 'done' ? '✓' : index + 1}</span>
              <b>{label}</b>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
