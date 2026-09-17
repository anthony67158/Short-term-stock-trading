import ReactDOM from 'react-dom/client'
import '../../tokens.css'
import '../../src/styles.css'
import '../../src/styles/precision.css'

if (!import.meta.env.DEV) throw new Error('Local fixture only')

document.documentElement.dataset.theme =
  new URLSearchParams(location.search).get('theme') || 'light'

const now = Date.now()
const stockRun = {
  id: 'learning-stock-pick',
  source: 'daily-learning',
  schemaVersion: 'learning-training-run.v1',
  modelId: 'stock-pick-ranking',
  modelName: '选股排序模型',
  task: '全市场候选排序',
  runId: 'b8eedb063aa34b8a04af',
  runAt: now,
  status: 'rejected',
  rawStatus: 'CHALLENGER_REJECTED',
  eligible: false,
  productionChanged: false,
  version: 'challenger-b8eedb063aa34b8a04af',
  algorithm: 'LightGBM LGBMRanker',
  objective: 'lambdarank',
  label: 'T+5双边费后收益同日排序',
  labelVersion: 'stock-pick-t5-fee-v2',
  features: [
    'rankingScore', 'pct', 'amount', 'turnover', 'volumeRatio',
    'mainInflow', 'mainRatio', 'recallScore', 'pFill',
    'pWinGivenFill', 'expectedNetR',
  ],
  data: {
    samples: 1240,
    dates: 48,
    startDate: '2026-07-10',
    endDate: '2026-09-16',
    trainSamples: 1160,
    testSamples: 80,
    trainDates: 45,
    testDates: 3,
  },
  gate: {
    minimumSamples: 60,
    minimumDates: 12,
    allSeedsMustNotRegress: true,
  },
  seeds: [17, 41, 97],
  seedMetrics: [
    { seed: 17, top5ReturnPct: 4.87 },
    { seed: 41, top5ReturnPct: 4.92 },
    { seed: 97, top5ReturnPct: 4.76 },
  ],
  metrics: [
    { key: 'samples', label: '成熟样本', value: 1240, unit: 'number' },
    { key: 'dates', label: '独立交易日', value: 48, unit: 'number' },
    { key: 'baselineTop5ReturnPct', label: '生产基线 Top5 费后收益', value: 4.9, unit: 'percent-points' },
    { key: 'challengerTop5ReturnPct', label: '挑战者 Top5 费后收益', value: 4.85, unit: 'percent-points' },
    { key: 'minimumSeedTop5ReturnPct', label: '最弱种子 Top5 费后收益', value: 4.76, unit: 'percent-points' },
  ],
  reasons: ['stock_pick_no_fee_adjusted_increment'],
  facts: [],
  comparisonMetrics: [],
  components: [],
  thresholds: [],
  artifacts: [],
  reportPath: 'learning/v1/training-runs/2026-09-17/b8eedb063aa34b8a04af/report.json',
  sourceViewHash: '85f983d747c45264bd16f9b1c54c778134a2e12770d1867cfe5086ee5387a909',
}

const decisionRun = {
  ...stockRun,
  id: 'legacy-opportunity',
  source: 'quant-report',
  schemaVersion: 'quant-retrain-report.v3',
  modelId: 'opportunity-decision',
  modelName: '决策机会模型',
  task: '成交、盈利与动作价值',
  runId: '35237807902',
  runAt: now - 3600000,
  status: 'published',
  rawStatus: 'promote',
  eligible: true,
  productionChanged: true,
  version: 'opportunity-score.20260917.ensemble3',
  algorithm: '三种子 LightGBM 动作价值 + CatBoost 排序集成',
  objective: null,
  label: null,
  labelVersion: null,
  features: [],
  seedMetrics: [],
  metrics: [],
  reasons: [],
  facts: [
    { label: '成熟样本', value: '73,004' },
    { label: '独立盲测样本', value: '8,200' },
    { label: '滚动时间窗', value: '5/5 窗通过' },
  ],
  comparisonMetrics: [
    { label: 'Top5费后净R', unit: 'r', champion: 0.31, challenger: 0.36, selected: 0.36 },
    { label: 'Top5正净R命中率', unit: 'percent', champion: 0.58, challenger: 0.63, selected: 0.63 },
  ],
  components: [
    { label: '成交概率', status: 'UNCHANGED', notes: [] },
    { label: '尾部风险', status: 'IMPROVED', notes: ['Q10覆盖率达到晋级要求'] },
  ],
  thresholds: [
    { key: 'lowerBoundMinimum', value: 0 },
    { key: 'drawdownRelativeIncrease', value: 0.05 },
  ],
  reportPath: 'quantreport/opportunity-35237807902.json',
  sourceViewHash: null,
  artifacts: [],
}

globalThis.fetch = async (url) => {
  if (String(url).includes('/api/model_training')) {
    return new Response(JSON.stringify({
      ok: true,
      schemaVersion: 'model-training-center.v1',
      models: [
        {
          id: 'stock-pick-ranking',
          name: '选股排序模型',
          task: '全市场候选排序',
          runs: 1,
          passed: 0,
          published: 0,
          latest: {
            id: stockRun.id,
            runAt: stockRun.runAt,
            status: stockRun.status,
            version: stockRun.version,
          },
        },
        {
          id: 'opportunity-decision',
          name: '决策机会模型',
          task: '成交、盈利与动作价值',
          runs: 1,
          passed: 1,
          published: 1,
          activeVersion: decisionRun.version,
          latest: {
            id: decisionRun.id,
            runAt: decisionRun.runAt,
            status: decisionRun.status,
            version: decisionRun.version,
          },
        },
      ],
      runs: [stockRun, decisionRun],
      active: { modelVersion: decisionRun.version },
      warnings: [],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return new Response('{}', { status: 404 })
}

const { llmConfigStore } = await import('../../src/llmConfigStore.js')
const { default: LLMConfig } = await import('../../src/components/LLMConfig.jsx')
llmConfigStore.open('training')

ReactDOM.createRoot(document.getElementById('root')).render(<LLMConfig />)
