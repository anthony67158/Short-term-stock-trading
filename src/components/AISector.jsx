import { useState, useEffect } from 'react'
import { callAI } from '../ai'
import StockDetail from './StockDetail'

// AI 板块选股：基于选中板块的真实成分股，让 AI 挑短线候选
export default function AISector({ sector, stocks }) {
  const [loading, setLoading] = useState(false)
  const [res, setRes] = useState(null)
  const [err, setErr] = useState(null)
  const [detail, setDetail] = useState(null)

  // 切换板块时清空上次结果
  useEffect(() => { setRes(null); setErr(null) }, [sector && sector.code])

  if (!sector) return null

  const run = async () => {
    setLoading(true); setErr(null)
    try {
      const list = (stocks?.list || []).slice(0, 20).map((s) => ({
        name: s.name, code: s.code, pct: s.pct,
        turnover: s.turnover, volRatio: s.volRatio,
        mainInflowYi: +(s.mainInflow / 1e8).toFixed(2),
        isLimitUp: s.isLimitUp,
      }))
      const r = await callAI('sector', { sectorName: sector.name, stocks: list })
      if (r.ok) setRes(r.result); else setErr(r.error || 'AI 调用失败')
    } catch (e) { setErr(String(e.message || e)) }
    finally { setLoading(false) }
  }

  return (
    <div className="ai-sector" style={{ marginTop: 14 }}>
      <div className="ai-sector-head">
        <div className="ai-sector-title">
          <span className="ai-spark">✨</span>
          <span>AI 板块选股</span>
          <span className="ai-sector-badge">{sector.name}</span>
        </div>
        <button className="btn btn-ai" onClick={run} disabled={loading}>
          {loading ? '分析中…' : (res ? '重新选股' : 'AI 挑选短线候选')}
        </button>
      </div>

      <div className="ai-sector-body">
        {err && <div className="err">{err}</div>}
        {!res && !err && !loading && (
          <div className="ai-hint">让 AI 从「{sector.name}」的真实成分股中，结合资金流、量比、换手，挑出短线关注度高的个股。</div>
        )}
        {loading && (
          <div className="ai-loading">
            <span className="ai-loading-dot" /><span className="ai-loading-dot" /><span className="ai-loading-dot" />
            正在分析成分股资金与量价…
          </div>
        )}
        {res && (
          <div className="ai-result">
            {res.sectorView && (
              <div className="ai-sector-view">{res.sectorView}</div>
            )}
            {Array.isArray(res.picks) && res.picks.length > 0 && (
              <div className="pick-grid">
                {res.picks.map((p, i) => (
                  <div key={i} className="pick-card" onClick={() => p.code && setDetail({ name: p.name, code: p.code })}>
                    <div className="pick-top">
                      <span className="pick-idx">{i + 1}</span>
                      <span className="pick-name">{p.name}</span>
                      <span className="pick-code">{p.code}</span>
                    </div>
                    <div className="pick-row"><span className="pick-tag reason">逻辑</span><span>{p.reason}</span></div>
                    <div className="pick-row"><span className="pick-tag watch">关注</span><span>{p.watch}</span></div>
                  </div>
                ))}
              </div>
            )}
            {res.note && <div className="ai-line" style={{ marginTop: 8 }}>{res.note}</div>}
            <div className="ai-disclaimer">候选股均来自该板块真实成分股，AI 依据实时资金/量价筛选 · 点卡片看K线 · 仅供研究，非投资建议</div>
          </div>
        )}
      </div>

      {detail && <StockDetail stock={detail} onClose={() => setDetail(null)} />}
    </div>
  )
}
