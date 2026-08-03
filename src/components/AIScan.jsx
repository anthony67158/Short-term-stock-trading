import { useState } from 'react'
import { callAI } from '../ai'
import { openStockDetail } from '../detailStore'
import Reasoning from './Reasoning'

// AI 一键全盘扫描：综合大盘+板块+涨停+异动，输出当日 TOP3 方向
export default function AIScan({ market, sectors, limitPool, movers }) {
  const [loading, setLoading] = useState(false)
  const [res, setRes] = useState(null)
  const [err, setErr] = useState(null)

  const run = async () => {
    setLoading(true); setErr(null)
    try {
      const payload = {
        breadth: market?.breadth || {},
        indices: (market?.indices || []).map((i) => ({ name: i.name, pct: i.pct })),
        topSectors: (sectors?.list || []).slice(0, 10).map((s) => ({
          name: s.name, pct: s.pct, mainInflowYi: +(s.mainInflow / 1e8).toFixed(2), lead: s.leadName,
        })),
        limitUp: (limitPool?.list || []).slice(0, 12).map((s) => ({
          name: s.name, code: s.code, lbc: s.lbc, sector: s.sector,
        })),
        movers: (movers?.list || []).slice(0, 10).map((s) => ({
          name: s.name, code: s.code, pct: s.pct, mainInflowYi: +(s.mainInflow / 1e8).toFixed(2),
        })),
      }
      const r = await callAI('scan', payload)
      if (r.ok) setRes(r.result); else setErr(r.error || 'AI 调用失败')
    } catch (e) { setErr(String(e.message || e)) }
    finally { setLoading(false) }
  }

  return (
    <div className="scan-hero">
      <div className="scan-head">
        <div className="scan-title">✨ AI 一键全盘扫描 <span className="sub-name">综合资金·涨停·异动 → 当日 TOP3 方向</span></div>
        <button className="btn btn-ai" onClick={run} disabled={loading}>
          {loading ? '全盘分析中…' : '🔍 开始扫描'}
        </button>
      </div>
      <div className="scan-body">
        {err && <div className="err">{err}</div>}
        {!res && !err && !loading && (
          <div className="ai-hint">一键让 AI 综合分析大盘情绪、板块资金流、涨停连板梯队、盘中异动，给出今日最值得关注的 3 个方向、代表个股与操作策略。</div>
        )}
        {loading && <div className="ai-hint">正在综合全市场多维数据，生成今日主线判断…</div>}
        {res && (
          <>
            {res.reasoning && <Reasoning text={res.reasoning} />}
            {res.marketMood && <div className="scan-mood">🎯 {res.marketMood}</div>}
            {Array.isArray(res.topDirections) && (
              <div className="dir-grid">
                {res.topDirections.map((d, i) => (
                  <div className="dir-card" key={i}>
                    <div className="dir-rank">{d.rank || i + 1}</div>
                    <div className="dir-name">
                      {d.direction}
                      {d.strength && <span className={'dir-strength ' + (d.strength || '')}>{d.strength}</span>}
                    </div>
                    <div className="dir-logic">{d.logic}</div>
                    {Array.isArray(d.representStocks) && d.representStocks.length > 0 && (
                      <div className="dir-stocks">
                        {d.representStocks.map((s, j) => (
                          <span className="dir-stock" key={j} onClick={() => s.code && openStockDetail(s.code, s.name)} style={{ cursor: s.code ? 'pointer' : 'default' }}>{s.name}<span style={{ opacity: .5, marginLeft: 4 }}>{s.code}</span></span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="scan-foot">
              {res.strategy && (
                <div className="scan-strategy">
                  <div className="ai-label">📌 今日操作策略</div>
                  <div>{res.strategy}</div>
                </div>
              )}
              {res.topRisk && (
                <div className="scan-risk">
                  <div className="ai-label">⚠️ 首要风险</div>
                  <div>{res.topRisk}</div>
                </div>
              )}
            </div>
            <div className="ai-disclaimer">代表个股均来自实时真实数据，AI 综合多维数据分析，仅供研究参考，不构成投资建议</div>
          </>
        )}
      </div>
    </div>
  )
}
