import { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import '../../tokens.css'
import '../../src/styles.css'
import '../../src/styles/precision.css'
import DecisionSummary from '../../src/components/DecisionSummary.jsx'

function Preview() {
  const [items, setItems] = useState([])
  const [error, setError] = useState('')
  useEffect(() => {
    fetch('/harness-artifacts/entry-instructions/synthetic.json', { signal: AbortSignal.timeout(5000) })
      .then((response) => {
        if (!response.ok) throw new Error('尚未生成验收数据')
        return response.json()
      }).then(setItems).catch((reason) => setError(reason.message))
  }, [])
  return (
    <main className="main">
      <h1>合成场景验收</h1>
      <p>本页面使用假股票、假模型与隔离账本，不创建交易。</p>
      {error && <p role="alert">{error}</p>}
      {items.map((item) => {
        const advice = structuredClone(item.advice)
        // Keep historical fixture actions visible while testing current layouts.
        advice.decisionPlan.validUntil = new Date(Date.now() + 3600000).toISOString()
        advice.decisionRationale.entryInstruction.validUntil = Date.now() + 3600000
        return (
          <section key={item.id} data-case={item.id}>
            <h2>{item.id}</h2>
            <DecisionSummary
              code="600001" advice={advice}
              holdingLots={item.held ? 2 : 0} sellableLots={item.held ? 2 : 0}
              detailed
            />
          </section>
        )
      })}
    </main>
  )
}
ReactDOM.createRoot(document.getElementById('root')).render(<Preview />)
