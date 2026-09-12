import { useState } from 'react'
import ReactDOM from 'react-dom/client'

import '../../tokens.css'
import '../../src/styles.css'
import '../../src/styles/precision.css'
import { MainApp } from '../../src/App.jsx'
import { planStore } from '../../src/planStore.js'
import {
  activateAccountSession,
} from '../../shared/accountSessionScope.js'

if (!import.meta.env.DEV || location.hostname !== '127.0.0.1') {
  throw new Error('Continuous historical replay is local only')
}

const [report, book, quotes, timeline] = await Promise.all([
  fetch('/harness-artifacts/continuous-market/report.json').then(
    (response) => response.json(),
  ),
  fetch('/harness-artifacts/continuous-market/final-book.json').then(
    (response) => response.json(),
  ),
  fetch('/harness-artifacts/continuous-market/latest-quotes.json').then(
    (response) => response.json(),
  ),
  fetch('/harness-artifacts/continuous-market/timeline.json').then(
    (response) => response.json(),
  ),
])

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, options = {}) => {
  const url = new URL(
    typeof input === 'string' ? input : input.url,
    location.origin,
  )
  if (!url.pathname.startsWith('/api/')) {
    if (url.origin !== location.origin) {
      throw new Error('Historical replay external network blocked')
    }
    return nativeFetch(input, options)
  }
  const empty = {
    ok: true,
    list: [],
    history: [],
    updatedAt: report.finishedAt,
  }
  const response = url.pathname === '/api/quote'
    ? { ...empty, list: quotes }
    : url.pathname === '/api/market_snapshot'
      ? {
          ...empty,
          market: {
            indices: [],
            breadth: {
              up: 0,
              down: 0,
              flat: 0,
              limitUp: 0,
              limitDown: 0,
            },
          },
          sectors: empty,
          limitUp: empty,
          brokenLimit: empty,
          movers: empty,
          speed: empty,
          errors: {},
        }
      : empty
  return new Response(JSON.stringify(response), {
    headers: { 'Content-Type': 'application/json' },
  })
}

activateAccountSession('continuous-historical-simulation')
planStore.setData(book)
planStore.registerSaver(async () => true)

function formatMoney(value) {
  return Number(value || 0).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function timeText(value) {
  return new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  })
}

function AcceptancePanel() {
  const [expanded, setExpanded] = useState(false)
  const events = expanded ? timeline : timeline.slice(-12)
  return (
    <section
      aria-label="连续历史市场验收结果"
      style={{
        padding: '16px',
        borderBottom: '1px solid var(--border-subtle)',
        background: 'var(--surface-primary)',
      }}
    >
      <div className="section-header">
        <div>
          <h1 style={{ margin: 0, fontSize: 20 }}>
            连续历史市场验收
          </h1>
          <p className="muted" style={{ margin: '6px 0 0' }}>
            {report.dates[0]} 至 {report.dates.at(-1)}
            {' · '}{report.frames} 个五分钟时钟步
            {' · '}本地隔离账户
          </p>
        </div>
        <span
          className={`status-pill ${report.passed ? 'success' : 'danger'}`}
        >
          {report.passed ? '流程完成' : '流程失败'}
        </span>
      </div>

      <dl className="decision-rationale-facts" style={{ marginTop: 12 }}>
        <div>
          <dt>模型决策</dt>
          <dd>{report.decisions.length} 次</dd>
        </div>
        <div>
          <dt>订单 / 成交</dt>
          <dd>{report.orders.length} / {report.transactions.length}</dd>
        </div>
        <div>
          <dt>最终总资产</dt>
          <dd>{formatMoney(report.final.totalAssets)} 元</dd>
        </div>
        <div>
          <dt>费后结果</dt>
          <dd>{formatMoney(report.final.totalPnl)} 元</dd>
        </div>
      </dl>

      <h2 style={{ fontSize: 16, margin: '18px 0 8px' }}>
        待评估问题
      </h2>
      <div style={{ display: 'grid', gap: 8 }}>
        {report.issues.map((issue) => (
          <article
            key={issue.id}
            style={{
              borderLeft: issue.severity === 'CRITICAL'
                ? '3px solid var(--color-up)'
                : '3px solid var(--color-warning)',
              padding: '8px 10px',
              background: 'var(--surface-secondary)',
            }}
          >
            <strong>{issue.severity} · {issue.summary}</strong>
            <p className="muted" style={{ margin: '4px 0 0' }}>
              {issue.evidence}
            </p>
          </article>
        ))}
      </div>

      <div className="section-header" style={{ marginTop: 18 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>最近时钟事件</h2>
        <button type="button" onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起' : `查看全部 ${timeline.length} 条`}
        </button>
      </div>
      <div style={{ overflowX: 'auto', marginTop: 8 }}>
        <table style={{ width: '100%', minWidth: 720 }}>
          <thead>
            <tr>
              <th>时间</th>
              <th>事件</th>
              <th>股票</th>
              <th>动作 / 结果</th>
            </tr>
          </thead>
          <tbody>
            {events.map((item, index) => (
              <tr key={`${item.at}:${item.type}:${index}`}>
                <td>{timeText(item.at)}</td>
                <td>{item.type}</td>
                <td>{item.code || '账户'}</td>
                <td>
                  {item.action || item.reason
                    || (item.totalAssets != null
                      ? `总资产 ${formatMoney(item.totalAssets)} 元`
                      : item.fillable === true ? '成交' : '')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ReplayApp() {
  return (
    <>
      <AcceptancePanel />
      <MainApp />
    </>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<ReplayApp />)
