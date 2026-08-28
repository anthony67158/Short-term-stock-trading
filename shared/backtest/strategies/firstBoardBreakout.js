// 策略：首板打板（可回测的显式 playbook）。
//
// 逻辑：识别"高质量首板"——首次涨停(limitTimes=1)、封得实（开板次数少、
// 封单额相对流通市值够大）、非尾盘偷袭板（首封时间不太晚），在【次日开盘】
// 买入博弈连板/惯性溢价；次日不及预期即走。
//
// 输入：某标的的涨停事件序列（来自 limit_list_d，已按 code 过滤+按日期升序），
// 以及该标的日线 bars（用于退出）。输出 { date, side, lots, reason, plan } 信号，
// 引擎在次日开盘成交（首板日的下一交易日）。
//
// 注意：打板是高风险打法，涨停买入本身在回测里会被 assessAshareExecution 的
// LIMIT_UP_UNFILLED 拦截——所以这里买的是【首板次日开盘】，不是当日涨停价，
// 只要次日开盘未一字涨停即可成交，符合真实打板/接力可执行性。

function finite(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export const FIRST_BOARD_DEFAULTS = Object.freeze({
  maxOpenTimes: 3, // 当日开板次数上限（首板允许少量反复）
  minSealRatio: 0.005, // 封单额/流通市值 下限（fd与floatMv同为元；0.5%）
  latestFirstTime: '140000', // 首封时间不得晚于此（避免尾盘偷袭板）
  maxHoldDays: 2, // 打板持有极短，2日内定生死
  takeProfitPct: 9, // 次日冲高止盈
  stopLossPct: 5, // 跌破次日成本止损
  minFloatMvYuan: 1_000_000_000, // 流通市值下限(元)=10亿
  maxFloatMvYuan: 50_000_000_000, // 上限(元)=500亿，避免超大盘难拉
  lots: 1,
})

// 判定一条涨停记录是否为"高质量首板"。
export function isHighQualityFirstBoard(rec, cfg = FIRST_BOARD_DEFAULTS) {
  if (!rec) return false
  if (rec.limitType !== 'U') return false // 必须涨停（非跌停/炸板）
  if (finite(rec.limitTimes) !== 1) return false // 首板
  const openTimes = finite(rec.openTimes)
  if (openTimes != null && openTimes > cfg.maxOpenTimes) return false
  // 封单厚度：fdAmount / floatMv
  const fd = finite(rec.fdAmount)
  const floatMv = finite(rec.floatMv)
  if (fd != null && floatMv != null && floatMv > 0) {
    if (fd / floatMv < cfg.minSealRatio) return false
  }
  // 首封时间不太晚。真实数据形如 "93203"(=09:32:03)，须补零到6位再比较，
  // 否则 "93203" > "140000" 的字典序会误判。
  const ftRaw = String(rec.firstTime || '').replace(/\D/g, '')
  const ft = ftRaw ? ftRaw.padStart(6, '0').slice(0, 6) : ''
  if (ft && cfg.latestFirstTime && ft > cfg.latestFirstTime) return false
  // 市值区间（元）
  if (floatMv != null) {
    if (floatMv < cfg.minFloatMvYuan || floatMv > cfg.maxFloatMvYuan) return false
  }
  return true
}

// limitRecords: 该标的的涨停事件（升序）；bars: 该标的日线（升序，用于退出与止盈止损定价）。
export function generateFirstBoardSignals(limitRecords = [], bars = [], config = {}) {
  const cfg = { ...FIRST_BOARD_DEFAULTS, ...config }
  const events = (Array.isArray(limitRecords) ? limitRecords : [])
    .filter((r) => r?.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
  const rows = (Array.isArray(bars) ? bars : [])
    .filter((b) => b?.date && finite(b.close) != null)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
  const dateToIndex = new Map(rows.map((b, i) => [b.date, i]))
  const signals = []
  let position = null // { entryIndex, stopFrac, targetFrac } -- 用比例，次日开盘价定基准

  // 先把首板信号日收集起来（按 bar 索引），退出用状态机逐日推进。
  const boardExecIndex = new Map() // execIndex -> 首板记录
  for (const rec of events) {
    if (!isHighQualityFirstBoard(rec, cfg)) continue
    const idx = dateToIndex.get(rec.date)
    if (idx == null || idx + 1 >= rows.length) continue // 需次日可成交
    boardExecIndex.set(idx + 1, rec)
  }

  for (let index = 0; index < rows.length; index += 1) {
    const bar = rows[index]

    if (position) {
      const held = index - position.entryIndex
      const entryPx = position.entryPrice
      let exitReason = ''
      if (finite(bar.high) != null && bar.high >= entryPx * (1 + cfg.takeProfitPct / 100)) {
        exitReason = `冲高止盈+${cfg.takeProfitPct}%`
      } else if (finite(bar.low) != null && bar.low <= entryPx * (1 - cfg.stopLossPct / 100)) {
        exitReason = `跌破止损-${cfg.stopLossPct}%`
      } else if (held >= cfg.maxHoldDays) {
        exitReason = `打板${held}日未续强，次日撤`
      }
      if (exitReason) {
        signals.push({ date: bar.date, side: 'SELL', lots: cfg.lots, reason: exitReason })
        position = null
      }
      // 打板持仓期间不重复进场
      continue
    }

    const board = boardExecIndex.get(index)
    if (board) {
      // 次日开盘价作为进场基准（引擎会在本 bar 开盘成交）
      const entryPrice = finite(bar.open) ?? finite(bar.close)
      if (entryPrice == null) continue
      const stopPrice = +(entryPrice * (1 - cfg.stopLossPct / 100)).toFixed(2)
      const targetPrice = +(entryPrice * (1 + cfg.takeProfitPct / 100)).toFixed(2)
      signals.push({
        date: bar.date,
        side: 'BUY',
        lots: cfg.lots,
        reason: `首板次日接力(${board.industry || ''}${board.name || ''})`,
        plan: {
          entryTriggerPrice: +entryPrice.toFixed(2),
          stopPrice,
          targetPrice,
          boardDate: board.date,
          sealRatio: board.fdAmount != null && board.floatMv
            ? +(board.fdAmount / board.floatMv * 100).toFixed(2)
            : null,
          maxHoldDays: cfg.maxHoldDays,
          entryWindow: '首板次日开盘',
        },
      })
      position = { entryIndex: index, entryPrice }
    }
  }

  return signals
}
