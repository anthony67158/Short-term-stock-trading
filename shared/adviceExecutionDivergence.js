// 建议应然表现 vs 人工实际执行偏差（并列统计，纯函数，无 IO）。
//
// 场景：系统只给唯一操作建议，用户自己严格操作。要回答两个不同的问题：
//   1) “建议本身好不好”——所有已发布建议按建议口径的应然期望（与用户是否执行无关）。
//   2) “我执行得好不好”——真实成交相对建议的偏差：漏单、滑价、延迟、期望实现误差。
// 二者必须分开，否则会把“建议差”和“执行差”混为一谈，无法定位问题。
//
// 输入为 executionAttribution.v1 单笔归因记录（executionAttribution.js 产出）。
// 本模块不复算价格/费用，只在既有归因字段上做并列汇总。

export const ADVICE_EXECUTION_DIVERGENCE_VERSION =
  'advice-execution-divergence.v1'

function finite(value) {
  if (value == null || value === '' || typeof value === 'boolean') {
    return null
  }
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function mean(values) {
  const nums = values.map(finite).filter((v) => v != null)
  return nums.length
    ? nums.reduce((s, v) => s + v, 0) / nums.length
    : null
}

function round(value, digits = 4) {
  const n = finite(value)
  return n == null ? null : Number(n.toFixed(digits))
}

// 记录归属：区分“建议已发布”“已执行(有真实成交)”“漏单(建议发布但未成交)”。
function classify(record) {
  const status = String(record?.status || '')
  const filled = finite(record?.filledLots) || 0
  if (filled > 0) return 'EXECUTED'
  if (status === 'NOT_EXECUTED' || filled === 0) return 'SKIPPED'
  return 'UNKNOWN'
}

export function summarizeAdviceVsExecution(records = []) {
  const valid = (records || []).filter(
    (r) => r && typeof r === 'object'
      && r.schemaVersion === 'execution-attribution.v1',
  )
  const published = valid.length
  const executed = valid.filter((r) => classify(r) === 'EXECUTED')
  const skipped = valid.filter((r) => classify(r) === 'SKIPPED')

  // 建议应然线：所有已发布建议的应然期望（不管是否执行）。
  const advisedExpectancy = valid
    .map((r) => finite(r.plannedExpectedNetR))
    .filter((v) => v != null)

  // 人工执行线：仅已完成且验证完成的真实结果。
  const realized = executed
    .filter((r) => r.validationComplete === true)
    .map((r) => finite(r.realizedNetR))
    .filter((v) => v != null)

  // 执行偏差分解。
  const fillRates = valid.map((r) => finite(r.fillRatePct)).filter((v) => v != null)
  const slippage = executed
    .map((r) => finite(r.decisionSlippageBps))
    .filter((v) => v != null)
  const delays = executed
    .map((r) => finite(r.recordDelayMs))
    .filter((v) => v != null)
  const expectancyErrors = executed
    .map((r) => finite(r.expectancyErrorR))
    .filter((v) => v != null)

  const advisedMean = mean(advisedExpectancy)
  const realizedMean = mean(realized)

  return {
    schemaVersion: ADVICE_EXECUTION_DIVERGENCE_VERSION,
    // 覆盖计数
    publishedAdvice: published,
    executedCount: executed.length,
    skippedCount: skipped.length,
    // 建议应然线
    advised: {
      samples: advisedExpectancy.length,
      meanExpectedNetR: round(advisedMean, 3),
    },
    // 人工执行线
    executedLine: {
      samples: realized.length,
      meanRealizedNetR: round(realizedMean, 3),
    },
    // 执行偏差
    divergence: {
      // 漏单率：建议了却没成交的比例——直接反映“未严格执行”。
      skipRatePct: published
        ? round(skipped.length / published * 100, 2)
        : null,
      averageFillRatePct: round(mean(fillRates), 2),
      // 平均不利滑点（成交价相对建议参考价，正数=更差）。
      averageDecisionSlippageBps: round(mean(slippage), 2),
      // 平均记录延迟（成交相对建议创建）。
      averageRecordDelayMs: round(mean(delays), 0),
      // 期望实现误差：真实净R - 建议期望净R；负数=执行落后于建议。
      meanExpectancyErrorR: round(mean(expectancyErrors), 3),
      // 建议线与执行线之差：正数=执行优于应然，负数=执行拖累。
      realizedMinusAdvisedR:
        realizedMean != null && advisedMean != null
          ? round(realizedMean - advisedMean, 3)
          : null,
    },
    // 数据充分性：真实完成样本太少时不下执行质量结论。
    executionProvable: realized.length >= 20,
    note: realized.length >= 20
      ? undefined
      : '真实完成样本不足20笔，执行偏差仅供观察，不作为执行质量结论。',
  }
}
