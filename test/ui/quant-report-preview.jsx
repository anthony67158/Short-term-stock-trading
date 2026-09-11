import ReactDOM from 'react-dom/client'
import '../../tokens.css'
import '../../src/styles.css'
import '../../src/styles/precision.css'
import { quantReportUiStore, useQuantReportOpen } from '../../src/quantReportUiStore.js'

if (!import.meta.env.DEV) throw new Error('Local fixture only')
document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') || 'light'
const now = Date.now()
const report = {
  id: 'preview-v3-release',
  schemaVersion: 'quant-retrain-report.v3',
  at: now,
  model: 'opportunity',
  decision: 'promote',
  summary: '本轮横截面排序与尾部风险通过单项改善和整体兼容性验证，已自动发布。',
  meta: {
    runId: 123456,
    runNumber: 88,
    workflowUrl: 'https://github.com/anthony67158/Short-term-stock-trading/actions/runs/123456',
    trainingAt: now,
  },
  details: {
    facts: [
      { label: '生产对照版本', value: 'opportunity-score.20260910.ensemble3' },
      { label: '训练候选版本', value: 'opportunity-score.20260911.ensemble3' },
      { label: '发布版本', value: 'opportunity-score.20260911.ensemble3.selective' },
      { label: '晋级方式', value: '组成部分选择性晋级' },
      { label: '晋级组成', value: '尾部风险、横截面排序' },
      { label: '组合验证', value: '2/3 组通过' },
    ],
    metrics: [
      { label: 'Top5费后净R', champion: 0.31, challenger: 0.34, selected: 0.36, unit: 'r' },
      { label: 'Top5净R下置信界', champion: 0.08, challenger: 0.10, selected: 0.11, unit: 'r' },
      { label: 'Top5正净R命中率', champion: 0.58, challenger: 0.61, selected: 0.63, unit: 'percent' },
      { label: '成交概率F1', champion: 0.67, challenger: 0.68, selected: 0.67, unit: 'percent' },
      { label: '盈利概率召回率', champion: 0.62, challenger: 0.64, selected: 0.62, unit: 'percent' },
      { label: '千条推理耗时', champion: 8.2, challenger: 8.8, selected: 8.5, unit: 'ms' },
    ],
    components: [
      { component: 'fillProbability', label: '成交概率', status: 'UNCHANGED', improvements: [], blockers: [] },
      { component: 'winProbability', label: '盈利概率', status: 'BLOCKED', improvements: [], blockers: ['准确率下降超过0.5个百分点'] },
      { component: 'payoff', label: '胜负幅度', status: 'UNCHANGED', improvements: [], blockers: [] },
      { component: 'tailRisk', label: '尾部风险', status: 'IMPROVED', improvements: ['Q10覆盖率向90%目标改善至少0.5个百分点'], blockers: [] },
      { component: 'ranking', label: '横截面排序', status: 'IMPROVED', improvements: ['Top5费后净R至少提升0.01R'], blockers: [] },
    ],
    thresholds: {
      overall: {
        lowerBoundMinimum: 0,
        meanNetRMaxDrop: 0.01,
        precisionMaxDrop: 0.02,
        drawdownRelativeIncrease: 0.05,
        drawdownAbsoluteIncrease: 0.05,
        inferenceLatencyRelativeIncrease: 0.25,
        inferenceLatencyAbsoluteIncreaseMsPer1000: 1,
      },
    },
    blockers: [],
  },
}
globalThis.fetch = async (url) => {
  if (String(url).includes('/api/quant_report')) {
    return new Response(JSON.stringify({
      ok: true,
      reports: [report],
      workflow: {
        available: true,
        current: null,
        latest: {
          runId: 123456,
          runNumber: 88,
          state: 'success',
          event: 'schedule',
          startedAt: now - 1200000,
          completedAt: now,
          durationSec: 1200,
          url: report.meta.workflowUrl,
        },
      },
      opportunity: {
        at: now,
        label: '当前模型直接使用',
        directUse: true,
        productionEligible: true,
        modelVersion: 'opportunity-score.20260911.ensemble3.selective',
        samples: 73004,
        filledSamples: 37516,
        dates: 124,
        blockers: [],
        lastReleaseDecision: {
          action: 'PUBLISH',
          releaseMode: 'PARTIAL',
          promotedComponents: ['tailRisk', 'ranking'],
        },
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return new Response('{}', { status: 404 })
}
const { default: QuantReport } = await import('../../src/components/QuantReport.jsx')
quantReportUiStore.open()

function Preview() {
  const open = useQuantReportOpen()
  return open ? <QuantReport /> : <button onClick={() => quantReportUiStore.open()}>打开量化汇报</button>
}

ReactDOM.createRoot(document.getElementById('root')).render(<Preview />)
