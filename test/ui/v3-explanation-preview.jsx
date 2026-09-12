import ReactDOM from 'react-dom/client'
import '../../tokens.css'
import '../../src/styles.css'
import '../../src/styles/precision.css'
import { buildDecisionRationale } from '../../shared/decisionRationale.js'
import DecisionSummary from '../../src/components/DecisionSummary.jsx'

if (!import.meta.env.DEV) throw new Error('Local fixture only')

const now = Date.now()
const decisionId = 'decision-explanation-preview'
const adviceBase = {
  action: '清仓',
  actionPlan: '先观察约60秒；复核仍不划算时退出1手。',
  quantNote:
    '成交概率15.9%，成交后费后盈利率31.9%，费后期望-0.475505R',
  fundNote: '主力与小单资金方向存在分歧。',
  invalidation: '价格或账户事实变化后重新运行决策模型。',
  decisionSource: {
    engine: 'MULTI_TASK',
    state: 'READY',
    evaluatedAt: now,
    modelVersion: 'LOCAL_TEST_DOUBLE',
  },
  decisionPlan: {
    schemaVersion: 'decision-plan.v2',
    decisionId,
    mode: 'hold_advice',
    action: 'EXIT',
    actionability: 'CONDITIONAL',
    quantity: {
      lots: 1,
      holdingLots: 1,
      remainingLots: 0,
      sellableLots: 1,
    },
    prices: {
      current: 53.9,
      reference: 53.9,
      stop: 48.85,
      target: 58.2,
    },
    validUntil: new Date(now + 3 * 86400000).toISOString(),
  },
  selectedDecisionPlan: {
    route: 'IMMEDIATE',
    entryPlan: {
      price: 53.9,
      trigger: '现价保持在分时均价上方且主逻辑未失效',
    },
    exitPlan: {
      hardStopPrice: 48.85,
      takeProfitPrice: 58.2,
    },
    opportunityScore: {
      pFill: 0.159,
      pWinGivenFill: 0.319,
      expectedNetR: -0.475505,
      netRLowerBound: -0.21,
      expectedShortfall10: -2.367365,
    },
  },
  actionValues: {
    actions: [
      {
        action: 'HOLD',
        route: 'IMMEDIATE',
        feasible: true,
        actionUtilityR: -0.475505,
      },
      {
        action: 'REDUCE',
        route: 'IMMEDIATE',
        feasible: true,
        actionUtilityR: 0.34,
      },
      {
        action: 'EXIT',
        route: 'IMMEDIATE',
        feasible: true,
        actionUtilityR: 0.82,
      },
    ],
  },
  decisionExplanation: {
    schemaVersion: 'decision-explanation.v1',
    status: 'ready',
    decisionId,
    model: 'LOCAL_EXPLAIN_DOUBLE',
    generatedAt: now,
    summary: '当前持有路径的费后价值仍为正。',
    counterCase: '资金继续转弱时，持有优势可能消失。',
    invalidation: '跌破既定风险边界后重新运行决策模型。',
    evidenceGap: '缺少真实逐笔成交。',
  },
}
const advice = {
  ...adviceBase,
  decisionPaths: [adviceBase.selectedDecisionPlan],
  decisionRationale: buildDecisionRationale({
    advice: {
      ...adviceBase,
      decisionPaths: [adviceBase.selectedDecisionPlan],
    },
    decisionPlan: adviceBase.decisionPlan,
  }),
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <main style={{ maxWidth: 720, margin: '32px auto', padding: 16 }}>
    <DecisionSummary
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
