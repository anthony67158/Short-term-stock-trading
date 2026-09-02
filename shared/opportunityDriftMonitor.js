// 机会雷达漂移监控（P2-2）。
//
// 消费按时间排序的基线快照序列（buildOpportunityRadarBaseline 的输出快照），
// 对比最新窗与参考窗，检测校准/收益漂移、胜率下滑、样本覆盖率骤降与连续亏损。
//
// 设计原则：
// - 样本不足或历史窗不足两期时，明确返回"监控中/样本不足"，绝不伪造告警；
// - 纯函数、无副作用、不联网；
// - 只做只读监控信号，不改变任何排序或个股结论，也不自动下线模型。

export const OPPORTUNITY_DRIFT_SCHEMA_VERSION =
  'opportunity-drift.v1'

// 默认阈值：期望净R 跌幅、胜率跌幅(百分点)、覆盖率骤降比例、连续亏损窗口数。
const DEFAULT_NET_R_DROP = 0.15
const DEFAULT_WIN_RATE_DROP_PCT = 15
const DEFAULT_COVERAGE_DROP_RATIO = 0.5
const DEFAULT_LOSS_STREAK_WINDOWS = 3

function finite(value, fallback = null) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function round(value, digits = 4) {
  const number = finite(value)
  return number == null ? null : +number.toFixed(digits)
}

function overallOf(snapshot) {
  return snapshot && typeof snapshot === 'object'
    ? snapshot.overall || {}
    : {}
}

function sufficient(overall) {
  return overall?.sampleSufficient === true
}

export function detectOpportunityDrift({
  history = [],
  netRDrop = DEFAULT_NET_R_DROP,
  winRateDropPct = DEFAULT_WIN_RATE_DROP_PCT,
  coverageDropRatio = DEFAULT_COVERAGE_DROP_RATIO,
  lossStreakWindows = DEFAULT_LOSS_STREAK_WINDOWS,
} = {}) {
  const snapshots = (Array.isArray(history) ? history : [])
    .filter((item) => item && typeof item === 'object')
    .slice()
    .sort((left, right) =>
      finite(left.generatedAt, 0) - finite(right.generatedAt, 0),
    )

  const base = {
    schemaVersion: OPPORTUNITY_DRIFT_SCHEMA_VERSION,
    windows: snapshots.length,
    alerts: [],
  }

  if (snapshots.length < 2) {
    return { ...base, state: 'INSUFFICIENT_HISTORY' }
  }

  const latest = snapshots[snapshots.length - 1]
  const previous = snapshots[snapshots.length - 2]
  const latestOverall = overallOf(latest)
  const previousOverall = overallOf(previous)

  // 最新窗或参考窗样本不足，则只监控不判漂移。
  if (!sufficient(latestOverall) || !sufficient(previousOverall)) {
    return { ...base, state: 'INSUFFICIENT_SAMPLE' }
  }

  const alerts = []

  // 1) 期望净R 漂移：跌幅超阈值，或从非负跌入负区。
  const latestNetR = finite(latestOverall.expectedNetRGivenFill)
  const prevNetR = finite(previousOverall.expectedNetRGivenFill)
  if (latestNetR != null && prevNetR != null) {
    const drop = prevNetR - latestNetR
    if (drop >= netRDrop || (prevNetR >= 0 && latestNetR < 0)) {
      alerts.push({
        metric: 'expectedNetRGivenFill',
        severity: latestNetR < 0 ? 'HIGH' : 'MEDIUM',
        from: round(prevNetR),
        to: round(latestNetR),
        message:
          `成交后期望净回报从 ${round(prevNetR)} 降到 ${round(latestNetR)}，`
          + '扣费后优势明显减弱，需要复核公式与市场状态适配性。',
      })
    }
  }

  // 2) 胜率下滑
  const latestWin = finite(latestOverall.winRatePct)
  const prevWin = finite(previousOverall.winRatePct)
  if (
    latestWin != null
    && prevWin != null
    && prevWin - latestWin >= winRateDropPct
  ) {
    alerts.push({
      metric: 'winRatePct',
      severity: 'MEDIUM',
      from: round(prevWin, 2),
      to: round(latestWin, 2),
      message:
        `成交后胜率从 ${round(prevWin, 2)}% 降到 ${round(latestWin, 2)}%，`
        + '下滑超过阈值，需要确认是否市场状态切换或样本偏差。',
    })
  }

  // 3) 样本覆盖率骤降：最新窗样本相对上一窗大幅减少。
  const latestSamples = finite(latestOverall.samples, 0)
  const prevSamples = finite(previousOverall.samples, 0)
  if (
    prevSamples > 0
    && latestSamples < prevSamples * coverageDropRatio
  ) {
    alerts.push({
      metric: 'coverage',
      severity: 'MEDIUM',
      from: prevSamples,
      to: latestSamples,
      message:
        `本窗成熟样本从 ${prevSamples} 降到 ${latestSamples}，`
        + '覆盖率骤降，统计结论稳定性下降，需检查数据源与结算链路。',
    })
  }

  // 4) 连续亏损窗口：末尾连续多个窗口期望净R 为负。
  let streak = 0
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const value = finite(overallOf(snapshots[index]).expectedNetRGivenFill)
    if (value != null && value < 0) streak += 1
    else break
  }
  if (streak >= lossStreakWindows) {
    alerts.push({
      metric: 'lossStreak',
      severity: 'HIGH',
      windows: streak,
      message:
        `连续 ${streak} 个窗口成交后期望净回报为负，`
        + '需要人工复核是否暂缓新增风险并重新校准。',
    })
  }

  return {
    ...base,
    state: alerts.length ? 'DRIFT_DETECTED' : 'STABLE',
    latestWindow: {
      generatedAt: finite(latest.generatedAt),
      samples: latestSamples,
      winRatePct: round(latestWin, 2),
      expectedNetRGivenFill: round(latestNetR),
    },
    alerts,
  }
}
