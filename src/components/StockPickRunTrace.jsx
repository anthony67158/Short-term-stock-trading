import Icon from './Icon'

const TYPE_ICON = Object.freeze({
  stage: 'pulse',
  tool: 'bolt',
  validation: 'shield',
  result: 'check',
  error: 'info',
})

function eventState(event) {
  if (event?.status === 'error') return ' error'
  if (event?.status === 'running') return ' running'
  return ' done'
}

export default function StockPickRunTrace({ trace, active = false }) {
  if (!trace && !active) return null
  const events = Array.isArray(trace?.events) ? trace.events : []
  const percent = Math.max(0, Math.min(100, Number(trace?.percent) || 0))
  const running = active || trace?.status === 'RUNNING'
  return (
    <section
      className="panel stock-pick-trace"
      aria-label="Agent 执行过程"
      aria-live="polite"
      aria-busy={running}
    >
      <header className="stock-pick-trace-head">
        <div>
          <div className="panel-title">
            <Icon name="activity" size={16} />
            Agent 执行过程
          </div>
          <p>
            {running
              ? '正在调用工具、核对证据并调整判断'
              : trace?.status === 'FAILED'
                ? '本轮执行中断，已保留完成步骤'
                : '本轮工具调用与校验记录'}
          </p>
        </div>
        <strong>{percent}%</strong>
      </header>
      <div
        className="stock-pick-trace-progress"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={percent}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      <ol className="stock-pick-trace-events">
        {events.length ? events.map((event) => (
          <li className={'stock-pick-trace-event' + eventState(event)} key={event.id}>
            <span className="stock-pick-trace-icon">
              <Icon
                name={TYPE_ICON[event.type] || 'dot'}
                size={13}
                className={event.status === 'running' ? 'spin' : ''}
              />
            </span>
            <span className="stock-pick-trace-copy">
              <strong>{event.label || '处理中'}</strong>
              {event.detail && <small>{event.detail}</small>}
            </span>
            {event.tool && <code>{event.tool}</code>}
          </li>
        )) : (
          <li className="stock-pick-trace-event running">
            <span className="stock-pick-trace-icon">
              <Icon name="refresh" size={13} className="spin" />
            </span>
            <span className="stock-pick-trace-copy">
              <strong>准备执行</strong>
              <small>正在创建可追踪运行记录</small>
            </span>
          </li>
        )}
      </ol>
    </section>
  )
}
