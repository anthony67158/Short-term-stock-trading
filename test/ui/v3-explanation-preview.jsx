import ReactDOM from 'react-dom/client'
import '../../tokens.css'
import '../../src/styles.css'
import '../../src/styles/precision.css'
import V3DecisionSummary from '../../src/components/V3DecisionSummary.jsx'

if (!import.meta.env.DEV) throw new Error('Local fixture only')

const now = Date.now()
const decisionId = 'decision-explanation-preview'
const advice = {
  action: '持有',
  actionPlan: '继续持有1手，价格或账户事实变化后重新评估。',
  quantNote: 'V3成交概率68.0%，成交后盈利概率59.0%。',
  fundNote: '主力与小单资金方向存在分歧。',
  invalidation: '价格或账户事实变化后重新运行V3。',
  decisionSource: {
    engine: 'V3',
    state: 'READY',
    evaluatedAt: now,
    modelVersion: 'LOCAL_TEST_DOUBLE',
  },
  decisionPlan: {
    schemaVersion: 'decision-plan.v2',
    decisionId,
    action: 'HOLD',
    actionability: 'HOLD',
    quantity: { lots: 0 },
    prices: { reference: 53.9, stop: 48.85, target: 58.2 },
    validUntil: new Date(now + 3600000).toISOString(),
  },
  selectedV3Plan: {
    opportunityScore: {
      pFill: 0.68,
      pWinGivenFill: 0.59,
      expectedNetR: 0.16,
      netRLowerBound: -0.21,
      expectedShortfall10: -0.74,
    },
  },
  v3Explanation: {
    schemaVersion: 'v3-explanation.v2',
    status: 'ready',
    decisionId,
    model: 'LOCAL_EXPLAIN_DOUBLE',
    generatedAt: now,
    summary: '当前持有路径的费后价值仍为正。',
    counterCase: '资金继续转弱时，持有优势可能消失。',
    invalidation: '跌破既定风险边界后重新运行V3。',
    evidenceGap: '缺少真实逐笔成交。',
  },
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <main style={{ maxWidth: 720, margin: '32px auto', padding: 16 }}>
    <V3DecisionSummary
      advice={advice}
      code="003036"
      holdingLots={1}
      sellableLots={1}
      currentPrice={53.9}
      stopPrice={48.85}
      detailed
    />
  </main>,
)
