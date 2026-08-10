import { useState, useEffect } from 'react'
import { usePolling } from '../hooks'
import { aiStore } from '../aiStore'
import Icon from './Icon'
import StockName from './StockName'
import { fmtPct, pctClass, fmtInflow, fmtNum , fmtRaw } from '../format'

const KEY = 'watchlist_codes'

export default function Watchlist({ interval }) {
  const [codes, setCodes] = useState(() => {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]') } catch { return [] }
  })
  const [input, setInput] = useState('')

  useEffect(() => { localStorage.setItem(KEY, JSON.stringify(codes)) }, [codes])

  const { data } = usePolling(
    codes.length ? `/api/quote?codes=${codes.join(',')}` : null,
    interval,
    [codes.join(',')]
  )
  const list = (data && data.list) || []

  const add = () => {
    const c = input.trim().replace(/[^0-9]/g, '')
    if (c.length === 6 && !codes.includes(c)) setCodes([...codes, c])
    setInput('')
  }
  const remove = (c) => setCodes(codes.filter((x) => x !== c))

  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <div className="panel-head">
        <div className="panel-title"><Icon name="eye" size={16} /> 自选股监控 <span className="sub-name">账号 OSS 保存 · 点「问 AI」在助手中诊断/追问</span></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="wl-input"
            placeholder="输入6位代码，回车添加"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button className="btn" onClick={add}>添加</button>
        </div>
      </div>
      {codes.length === 0 ? (
        <div className="empty">添加你的自选股（如 600519、300750），实时盯盘资金流，并可一键送入 AI 助手诊断</div>
      ) : (
        <div className="scroll" style={{ maxHeight: 460 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>名称</th><th>现价</th><th>涨跌幅</th><th>换手</th><th>量比</th><th>主力净流入</th><th style={{ textAlign: 'center' }}>AI</th><th></th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.code}>
                  <td><StockName code={s.code} name={s.name} />{s.isLimitUp && <span className="tag tag-lu">涨停</span>}</td>
                  <td>{fmtRaw(s.price)}</td>
                  <td className={pctClass(s.pct)}>{fmtPct(s.pct)}</td>
                  <td className={s.turnover > 10 ? 'gold' : ''}>{fmtNum(s.turnover, 1)}%</td>
                  <td className={s.volRatio > 2 ? 'gold' : ''}>{fmtNum(s.volRatio, 1)}</td>
                  <td className={pctClass(s.mainInflow)}>{fmtInflow(s.mainInflow)}</td>
                  <td style={{ textAlign: 'center' }}>
                    <button className="row-btn" onClick={() => aiStore.focusStock({ code: s.code, name: s.name }, 'diagnose')}>问 AI</button>
                  </td>
                  <td><span className="del" onClick={() => remove(s.code)}>×</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
