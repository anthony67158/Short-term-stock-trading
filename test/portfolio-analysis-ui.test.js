import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const account = read('src/components/AccountTab.jsx')
const component = read('src/components/PortfolioAnalysis.jsx')
const execution = read('src/components/PortfolioExecutionPlan.jsx')
const portfolioUi = component + execution
const config = read('src/components/LLMConfig.jsx')
const apiConfig = read('api/llm_config.js')
const styles = read('src/styles/precision.css')

test('持仓热力图下方接入仓位与仓位类别AI诊断', () => {
  assert.match(account, /import PortfolioAnalysis from '\.\/PortfolioAnalysis'/)
  assert.match(account, /<PortfolioAnalysis/)
  assert.match(component, /仓位诊断/)
  assert.match(component, /深度分析/)
  assert.match(component, /\/api\/portfolio_analysis/)
})

test('诊断面板展示生成阶段、证据、决策节点和结构化操作建议', () => {
  assert.match(component, /job\.phases/)
  assert.match(component, /job\.evidence/)
  assert.match(component, /job\.decisions/)
  assert.match(component, /<DecisionPath nodes=\{state\.decisions\}/)
  assert.match(component, /<EvidenceList evidence=\{state\.evidence\}/)
  assert.match(component, /positionAssessment/)
  assert.match(component, /categoryTargets/)
  assert.match(component, /stockActions/)
  assert.match(component, /recommendations/)
  assert.match(component, /dynamicRules/)
  assert.match(component, /concentration\?\.note/)
  assert.match(component, /item\.reducePct/)
  assert.match(component, /item\.targetWeightPct/)
})

test('诊断结果置顶今日执行清单并显示金额手数与失效条件', () => {
  assert.match(portfolioUi, /今日执行清单/)
  assert.match(portfolioUi, /executionPlan/)
  assert.match(portfolioUi, /estimatedAmount/)
  assert.match(portfolioUi, /estimatedLots/)
  assert.match(portfolioUi, /referencePrice/)
  assert.match(portfolioUi, /projectedWeightPct/)
  assert.match(portfolioUi, /projectedPositionPct/)
  assert.match(portfolioUi, /invalidation/)
  assert.match(portfolioUi, /t1Blocked/)
  assert.match(portfolioUi, /下次复核/)
})

test('诊断结果展示概念调仓前后、市场场景和执行单质量', () => {
  assert.match(portfolioUi, /概念调仓前后/)
  assert.match(portfolioUi, /conceptActions/)
  assert.match(portfolioUi, /scenarioPlan/)
  assert.match(portfolioUi, /执行单完整度/)
  assert.match(portfolioUi, /quality\.score/)
})

test('持仓模型失败或自动切换时展示真实恢复状态', () => {
  assert.match(component, /result\.warning/)
  assert.match(component, /result\.meta\?\.modelRecovered/)
  assert.match(component, /portfolio-analysis-warning/)
  assert.match(styles, /\.portfolio-analysis-warning\s*{/)
  assert.match(styles, /\.portfolio-analysis-warning\.recovered\s*{/)
})

test('LLM配置页可设置主端点最大在途请求数并保存', () => {
  assert.match(config, /primaryMaxInflight/)
  assert.match(config, /主端点最大在途/)
  assert.match(apiConfig, /primaryMaxInflight:\s*body/)
})

test('诊断面板具有稳定的桌面与移动端布局', () => {
  assert.match(styles, /\.portfolio-analysis\s*{/)
  assert.match(styles, /\.portfolio-analysis-grid\s*{/)
  assert.match(styles, /\.portfolio-execution-list\s*{/)
  assert.match(
    styles,
    /\.portfolio-concept-plan,\s*\n\.portfolio-scenario-plan\s*{/,
  )
  assert.match(
    styles,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.portfolio-analysis-grid\s*{/s,
  )
})

test('持仓诊断提交后台任务并轮询恢复跨页面结果', () => {
  assert.match(component, /op:\s*'start'/)
  assert.match(component, /op:\s*'status'/)
  assert.match(component, /setTimeout\(/)
  assert.match(component, /job\?\.status === 'done'/)
  assert.match(component, /后台/)
  assert.doesNotMatch(component, /response\.body\.getReader\(\)/)
  assert.doesNotMatch(component, /parseSseChunk/)
})

test('持仓分布区提供自动复核开关并可读取保留历史', () => {
  assert.match(component, /role="switch"/)
  assert.match(component, /自动复核/)
  assert.match(component, /op:\s*'setReview'/)
  assert.match(component, /op:\s*'history'/)
  assert.match(component, /portfolio-analysis-history/)
  assert.match(component, /data\?\.latest/)
  assert.match(component, /data\?\.history/)
  assert.match(styles, /\.portfolio-analysis-review-toggle\s*{/)
  assert.match(styles, /\.portfolio-analysis-history\s*{/)
})

test('持仓建议默认只突出操作结论、推荐股票和推荐原因', () => {
  assert.match(component, /buildPortfolioAdviceBrief/)
  assert.match(component, /className="portfolio-advice-brief"/)
  assert.match(component, /操作结论/)
  assert.match(component, /推荐股票/)
  assert.match(component, /item\.reason/)
  assert.match(component, /brief\.noRecommendationText/)
  assert.match(styles, /\.portfolio-advice-brief\s*{/)
  assert.match(styles, /\.portfolio-advice-recommendations\s*{/)
})

test('持仓建议的完整仓位逻辑和证据默认折叠', () => {
  assert.match(
    component,
    /<details className="portfolio-analysis-details">/,
  )
  assert.match(component, /展开详细分析/)
  assert.match(
    component,
    /portfolio-analysis-details[\s\S]*<PortfolioExecutionPlan/,
  )
  assert.match(
    component,
    /portfolio-analysis-details[\s\S]*<DecisionPath/,
  )
  assert.match(
    component,
    /portfolio-analysis-details[\s\S]*<EvidenceList/,
  )
  assert.doesNotMatch(
    component,
    /<details className="portfolio-analysis-details" open/,
  )
  assert.match(styles, /\.portfolio-analysis-details\s*{/)
})
