import { useState } from 'react'
import { callAI } from '../ai'
import Reasoning from './Reasoning'
import Icon from './Icon'

// AI 盘面复盘面板：汇总大盘情绪+涨停+板块Top，交给 AI 解读
export default function AIMarket({ market, sectors, limitPool }) {
  const [loading, setLoading] = useState(false)
  const [res, setRes] = useState(null)
  const [err, setErr] = useState(null)

  const run = async () => {
    setLoading(true); setErr(null)
    try {
      const payload = {
        indices: (market?.indices || []).map((i) => ({ name: i.name, pct: i.pct })),
        breadth: market?.breadth || {},
        topSectors: (sectors?.list || []).slice(0, 8).map((s) => ({
          name: s.name, pct: s.pct, mainInflowYi: +(s.mainInflow / 1e8).toFixed(2),
        })),
        limitUpCount: (limitPool?.list || []).length,
        topBoards: (limitPool?.list || []).slice(0, 6).map((s) => ({
          name: s.name, lbc: s.lbc, sector: s.sector,
        })),
      }
      const r = await callAI('market', payload)
      if (r.ok) setRes(r.result); else setErr(r.error || 'AI 调用失败')
    } catch (e) { setErr(String(e.message || e)) }
    finally { setLoading(false) }
  }

  return (
    <section className="panel ai-panel">
      <div className="panel-head">
        <div role="heading" aria-level="2" className="panel-title"><Icon name="brain" size={16} /> AI 盘面复盘 <span className="sub-name">实时解读</span></div>
        <button className="btn btn-ai" onClick={run} disabled={loading}>
          {loading ? 'AI 分析中…' : '生成盘面分析'}
        </button>
      </div>
      <div className="ai-panel-body">
        {err && <div className="err">{err}</div>}
        {!res && !err && !loading && (
          <div className="ai-hint">点击右上角，让 AI 根据当前大盘情绪、涨停梯队、板块资金流，判断今日盘面强弱与短线主线。</div>
        )}
        {loading && <div className="ai-hint">正在综合分析实时数据…</div>}
        {res && (
          <div className="ai-result">
            {res.reasoning && <Reasoning text={res.reasoning} />}
            <div className="ai-senti">
              <span className={'ai-badge ' + sentiClass(res.sentiment)}>{res.sentiment || '—'}</span>
              {typeof res.score === 'number' && (
                <span className="ai-score">情绪分 <b>{res.score}</b>/100</span>
              )}
              <span className="ai-summary">{res.summary}</span>
            </div>
            {Array.isArray(res.mainLines) && res.mainLines.length > 0 && (
              <div className="ai-block">
                <div className="ai-label"><Icon name="target" size={13} /> 最强主线</div>
                {res.mainLines.map((m, i) => (
                  <div key={i} className="ai-line"><b>{m.name}</b> — {m.reason}</div>
                ))}
              </div>
            )}
            {Array.isArray(res.risks) && res.risks.length > 0 && (
              <div className="ai-block">
                <div className="ai-label"><Icon name="shield" size={13} /> 风险提示</div>
                {res.risks.map((r, i) => <div key={i} className="ai-line">· {r}</div>)}
              </div>
            )}
            {res.advice && (
              <div className="ai-block ai-advice">
                <div className="ai-label"><Icon name="clipboard" size={13} /> 操作建议</div>
                <div className="ai-line">{res.advice}</div>
              </div>
            )}
            <div className="ai-disclaimer">AI 基于实时数据的客观分析，仅供研究参考，不构成投资建议</div>
          </div>
        )}
      </div>
    </section>
  )
}

function sentiClass(s) {
  if (!s) return ''
  if (s.includes('多')) return 'up'
  if (s.includes('空')) return 'down'
  return 'neutral'
}
