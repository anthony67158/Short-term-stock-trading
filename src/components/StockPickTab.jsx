import { useEffect, useState, useCallback } from 'react'
import Icon from './Icon'
import ErrorBoundary from './ErrorBoundary'
import { openStockDetail } from '../detailStore'
import { fmtRaw } from '../format'
import {
  loadStockPick,
  runStockPickRecall,
  runStockPickAgent,
} from '../stockPickClient'

// ============ 选股结果：全市场召回 → 模型排序 → Agent 精选 ============
export default function StockPickTab() {
  const [state, setState] = useState({
    snapshot: null,
    agent: null,
    references: [],
    progress: null,
  })
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    try {
      const payload = await loadStockPick()
      setState({
        snapshot: payload.snapshot || null,
        agent: payload.agent || null,
        references: payload.references || [],
        progress: payload.progress || null,
      })
    } catch (cause) {
      setError(String(cause?.message || cause))
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const runRecall = async () => {
    if (busy) return
    setBusy('recall'); setError('')
    try {
      await runStockPickRecall()
      await refresh()
    } catch (cause) {
      setError(String(cause?.message || cause))
    } finally {
      setBusy('')
    }
  }

  const runAgent = async () => {
    if (busy) return
    setBusy('agent'); setError('')
    try {
      const payload = await runStockPickAgent()
      setState((prev) => ({
        ...prev,
        agent: payload.selection || null,
        references: payload.references || [],
      }))
      await refresh()
    } catch (cause) {
      setError(String(cause?.message || cause))
    } finally {
      setBusy('')
    }
  }

  const { snapshot, agent, references } = state
  return (
    <div className="stock-pick">
      <StockPickHeader
        snapshot={snapshot}
        busy={busy}
        onRecall={runRecall}
        onAgent={runAgent}
      />
      {error && (
        <div className="stock-pick-error" role="alert">{error}</div>
      )}
      <ErrorBoundary label="Agent 精选">
        <AgentSelection agent={agent} references={references} />
      </ErrorBoundary>
      <ErrorBoundary label="候选池">
        <CandidatePool snapshot={snapshot} />
      </ErrorBoundary>
    </div>
  )
}

function StockPickHeader({ snapshot, busy, onRecall, onAgent }) {
  const universe = snapshot?.universe || {}
  const sourceLabel = snapshot?.rankingSource === 'MODEL'
    ? '模型排序'
    : '规则召回排序'
  return (
    <section className="panel stock-pick-head" aria-label="选股操作">
      <div className="stock-pick-head-main">
        <div className="panel-title">
          <Icon name="radar" size={16} /> 全市场选股
        </div>
        <p>
          {snapshot
            ? `全市场 ${universe.total || 0} 只 · 候选 ${snapshot.candidates?.length || 0} 只 · ${sourceLabel}`
            : '尚未运行全市场扫描'}
        </p>
      </div>
      <div className="stock-pick-head-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={onRecall}
          disabled={!!busy}
        >
          <Icon name={busy === 'recall' ? 'refresh' : 'play'} size={14}
            className={busy === 'recall' ? 'spin' : ''} />
          {busy === 'recall' ? '全市场扫描中…' : '全市场召回'}
        </button>
        <button
          type="button"
          className="btn"
          onClick={onAgent}
          disabled={!!busy || !snapshot?.candidates?.length}
        >
          <Icon name={busy === 'agent' ? 'refresh' : 'spark'} size={14}
            className={busy === 'agent' ? 'spin' : ''} />
          {busy === 'agent' ? 'Agent 精选中…' : 'Agent 精选'}
        </button>
      </div>
    </section>
  )
}

function AgentSelection({ agent, references }) {
  if (!agent) return null
  if (agent.conclusion === 'SELECT' && agent.selections?.length) {
    return (
      <section className="panel stock-pick-agent" aria-label="Agent 精选结果">
        <div className="panel-title">
          <Icon name="target" size={16} /> Agent 精选 · {agent.selections.length} 只可买
        </div>
        {agent.overallReason && (
          <p className="stock-pick-agent-reason">{agent.overallReason}</p>
        )}
        <div className="stock-pick-agent-list">
          {agent.selections.map((sel) => (
            <AgentCard key={sel.code} selection={sel} />
          ))}
        </div>
      </section>
    )
  }
  // 不选/不可用：展示 Top 候选供参考（明确标注未经 Agent 精选）。
  return (
    <section className="panel stock-pick-agent unselected" aria-label="Agent 未精选">
      <div className="panel-title">
        <Icon name="shield" size={16} /> Agent 本轮不选
      </div>
      <p className="stock-pick-agent-reason">
        {agent.reason || agent.overallReason || 'Agent 未给出可买结论'}
      </p>
      {references?.length > 0 && (
        <div className="stock-pick-refs">
          <div className="stock-pick-refs-head">以下为排序 Top 候选，仅供参考，未经 Agent 精选：</div>
          {references.map((ref) => (
            <button
              type="button"
              key={ref.code}
              className="stock-pick-ref-row"
              onClick={() => openStockDetail(ref.code, ref.name)}
            >
              <span className="stock-pick-ref-stock">
                <strong>{ref.name}</strong><small>{ref.code}</small>
              </span>
              <span className="stock-pick-ref-source">
                {ref.rankingSource === 'MODEL' ? '模型分' : '规则分'} {fmtRaw(ref.rankingScore)}
              </span>
              <span className="stock-pick-ref-reasons">
                {(ref.recallReasons || []).slice(0, 2).join(' · ')}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

function AgentCard({ selection }) {
  return (
    <button
      type="button"
      className="stock-pick-agent-card"
      onClick={() => openStockDetail(selection.code, selection.name)}
    >
      <div className="stock-pick-agent-card-head">
        <span className="stock-pick-agent-rank">#{selection.rank}</span>
        <strong>{selection.name}</strong>
        <small>{selection.code}</small>
      </div>
      <p className="stock-pick-agent-rationale">{selection.rationale}</p>
      <div className="stock-pick-agent-grid">
        <div>
          <span>买入策略</span>
          <b>
            {selection.buyStrategy?.entryPrice != null
              ? `参考 ${fmtRaw(selection.buyStrategy.entryPrice)}`
              : '按触发价'}
            {selection.buyStrategy?.positionPctMax
              ? ` · 仓位≤${selection.buyStrategy.positionPctMax}%`
              : ''}
          </b>
          {selection.buyStrategy?.plan && <small>{selection.buyStrategy.plan}</small>}
        </div>
        <div>
          <span>时机</span>
          <b>{selection.timing?.trigger || '—'}</b>
          {selection.timing?.window && <small>有效期：{selection.timing.window}</small>}
          {selection.timing?.nextSession && <small>次日：{selection.timing.nextSession}</small>}
        </div>
      </div>
      {selection.counterCase && (
        <div className="stock-pick-agent-note">
          <span>反方</span>{selection.counterCase}
        </div>
      )}
      {selection.invalidation && (
        <div className="stock-pick-agent-note">
          <span>失效</span>{selection.invalidation}
        </div>
      )}
    </button>
  )
}

function CandidatePool({ snapshot }) {
  const candidates = snapshot?.candidates || []
  if (!candidates.length) {
    return (
      <section className="panel stock-pick-pool" aria-label="候选池">
        <div className="panel-title"><Icon name="layers" size={16} /> 候选池</div>
        <p className="stock-pick-empty">
          {snapshot?.availability === 'UNAVAILABLE'
            ? snapshot.reason || '全市场召回不可用'
            : '点击"全市场召回"扫描候选。'}
        </p>
      </section>
    )
  }
  return (
    <section className="panel stock-pick-pool" aria-label="候选池">
      <div className="panel-title">
        <Icon name="layers" size={16} /> 候选池 · {candidates.length} 只
      </div>
      <div className="stock-pick-pool-list">
        {candidates.map((item, index) => (
          <button
            type="button"
            key={item.code}
            className="stock-pick-pool-row"
            onClick={() => openStockDetail(item.code, item.name)}
          >
            <span className="stock-pick-pool-rank">{index + 1}</span>
            <span className="stock-pick-pool-stock">
              <strong>{item.name}</strong><small>{item.code}</small>
            </span>
            <span className="stock-pick-pool-score">
              {item.ranking?.source === 'MODEL' ? '模型' : '规则'} {fmtRaw(item.ranking?.score)}
            </span>
            <span className="stock-pick-pool-quote">
              {item.quote?.pct != null ? `${fmtRaw(item.quote.pct)}%` : '—'}
            </span>
            <span className="stock-pick-pool-reasons">
              {(item.recallReasons || []).slice(0, 2).join(' · ')}
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}
