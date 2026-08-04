// 自选/持仓「量化得分」按需评分器。
// 量化得分 = qlib 量化服务 /predict 返回的 score(0~100)，经 /api/stock_detail?quant=1 透传。
// 触发时机：①加入自选/首屏渲染时按需补分(ensureQuantScore) ②生成AI操作建议时带回最新分(adviceRunner 直接调 planStore.setQuantScore)。
// 得分写入 planStore 的专用字段 qScore/qBias/qAt，供自选卡排序 + 自选/持仓卡展示。
import { api } from './apiBase'
import { planStore } from './planStore'

const FRESH = 30 * 60 * 1000   // 30 分钟内的分数视为新鲜，不重复评分（量化基于日K，日内变化很小）
const inflight = new Map()      // code -> Promise，防止并发重复请求
const lastFail = new Map()      // code -> ts，失败后 2 分钟内不重试，避免冷启动风暴

// 找到某 code 在自选/持仓里已有的量化得分时间戳(取最新)
function lastScoredAt(code) {
  const st = planStore.get()
  let at = 0
  for (const x of [...(st.plan || []), ...(st.holding || [])]) {
    if (x.code === code && x.qAt) at = Math.max(at, x.qAt)
  }
  return at
}

// 按需给某只股评分：若已有新鲜分数则跳过；否则请求量化并写回 planStore。
// force=true 忽略新鲜度强制刷新（如用户手动点「刷新评分」）。
export async function ensureQuantScore(code, { force = false } = {}) {
  if (!code) return null
  if (inflight.has(code)) return inflight.get(code)
  if (!force) {
    if (Date.now() - lastScoredAt(code) < FRESH) return null       // 分数还新鲜
    if (Date.now() - (lastFail.get(code) || 0) < 120000) return null // 刚失败，稍后再说
  }
  const p = (async () => {
    try {
      const url = api(`/api/stock_detail?code=${code}&klt=101&lmt=60&quant=1&_t=${Date.now()}`)
      const r = await fetch(url)
      const j = await r.json().catch(() => null)
      const quant = j && j.quant
      if (quant && quant.score != null && !isNaN(quant.score)) {
        planStore.setQuantScore(code, { qScore: Number(quant.score), qBias: quant.bias || '' })
        lastFail.delete(code)
        return Number(quant.score)
      }
      lastFail.set(code, Date.now())  // 量化服务冷启动/无数据 → 记失败
      return null
    } catch {
      lastFail.set(code, Date.now())
      return null
    } finally {
      inflight.delete(code)
    }
  })()
  inflight.set(code, p)
  return p
}

// 批量按需评分：对一组 code 逐个补分，控制并发(每批3只)避免打爆冷启动的量化服务。
export async function ensureQuantScores(codes, opts) {
  const list = [...new Set((codes || []).filter(Boolean))]
  for (let i = 0; i < list.length; i += 3) {
    await Promise.all(list.slice(i, i + 3).map((c) => ensureQuantScore(c, opts)))
  }
}
