import { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import '../../tokens.css'
import '../../src/styles.css'
import '../../src/styles/precision.css'
import DecisionSummary from '../../src/components/DecisionSummary.jsx'
import { OpportunityRow } from '../../src/components/AdaptiveWorkbench.jsx'

function Preview() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    fetch('/harness-artifacts/strategy-runtime/000001-decision.json', {
      signal: AbortSignal.timeout(5000),
    }).then((response) => {
      if (!response.ok) throw new Error('请先运行真实行情验收脚本')
      return response.json()
    }).then(setData).catch((reason) => setError(reason.message))
  }, [])
  if (!data) return <p role="status">{error || '正在读取验收快照'}</p>
  const pattern = data.patterns.patterns.find((item) => item.matched)
  const plan = data.advice.selectedDecisionPlan
  const opportunity = {
    code: data.code, name: data.quote.name, stateLabel: '本次不买入',
    entryPlan: plan.entryPlan, exitPlan: plan.exitPlan,
    strategyPattern: pattern,
    adaptive: {
      tier: 'AVOID', actionLabel: '本次不买入',
      estimate: plan.opportunityScore,
      cautions: ['真实收盘快照与合成账户，仅验证组件显示'],
    },
  }
  return (
    <main className="main">
      <h1>真实行情形态验收</h1>
      <p>{data.quote.name} {data.quote.tradeDate} 收盘 {data.quote.price} 元；不会创建交易。</p>
      <div className="aw-opportunity-list">
        <OpportunityRow opportunity={opportunity} rank={1} managed onOpen={() => {}} />
      </div>
      <DecisionSummary
        code={data.code}
        advice={{ ...data.advice, strategyPattern: pattern }}
        holdingLots={10}
        sellableLots={10}
        detailed
      />
    </main>
  )
}
ReactDOM.createRoot(document.getElementById('root')).render(<Preview />)
