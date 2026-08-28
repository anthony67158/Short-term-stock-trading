// Walk-forward 样本外验证切分。
//
// 短线策略最大的自欺是"参数在历史上过拟合"。walk-forward 把时间轴切成
// 连续的 (训练窗, 样本外窗) 对：在训练窗观察/调参，只在【样本外】窗计入
// 成绩。样本外期望为正，才是真优势；样本内再漂亮都不算数。
//
// 本模块只负责按交易日索引切窗（纯函数）；调参与评分在 CLI 中组合。

function normDate(value) {
  const compact = String(value ?? '').replaceAll('-', '')
  return /^\d{8}$/.test(compact) ? compact : null
}

// dates: 升序交易日数组（'YYYYMMDD'）。
// trainDays / testDays: 每个 fold 的训练/样本外交易日数。
// 返回 [{ index, trainStart, trainEnd, testStart, testEnd }]，
// 以日期边界表达，供上层按日期过滤 bars 与 trades。
export function walkForwardFolds(dates = [], {
  trainDays = 250,
  testDays = 60,
} = {}) {
  const days = (Array.isArray(dates) ? dates : [])
    .map(normDate)
    .filter(Boolean)
    .sort((a, b) => (a < b ? -1 : 1))
  const folds = []
  if (days.length < trainDays + testDays) return folds
  let start = 0
  let index = 0
  while (start + trainDays + testDays <= days.length) {
    const trainStartIdx = start
    const trainEndIdx = start + trainDays - 1
    const testStartIdx = trainEndIdx + 1
    const testEndIdx = testStartIdx + testDays - 1
    folds.push({
      index,
      trainStart: days[trainStartIdx],
      trainEnd: days[trainEndIdx],
      testStart: days[testStartIdx],
      testEnd: days[testEndIdx],
    })
    start += testDays // 滚动前移一个样本外窗（非重叠样本外）
    index += 1
  }
  return folds
}

// 判断一笔交易是否落在某个样本外窗内（按入场日归属）。
export function tradeInWindow(trade, testStart, testEnd) {
  const entry = normDate(trade?.entryDate)
  if (!entry) return false
  return entry >= testStart && entry <= testEnd
}
