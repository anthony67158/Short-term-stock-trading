// 「AI 操作建议」后台生成器：把生成流程从 StockDetail 组件里抽出来，挂在模块级，
// 脱离 React 组件生命周期——关闭弹窗后照样在后台跑完，跑完写入 adviceCache 并记录决策；
// 组件只需订阅本 runner + adviceCache，就能看到「后台生成中」的实时进度或直接拿到结果。
import { callAIStream } from './ai'
import { saveAdvice } from './adviceCache'
import { planStore } from './planStore'

const running = new Map()  // code -> { phase, startedAt }
const results = new Map()  // code -> { result, advice, meta, news, adviceMissing, truncated, error, cachedAt }
const subs = new Set()

function notify() { subs.forEach((fn) => { try { fn() } catch { /* ignore */ } }) }
// 订阅：后台进度/结果变化时回调（组件用它触发重渲染）
export function subscribeRunner(fn) { subs.add(fn); return () => subs.delete(fn) }
export function isRunning(code) { return code ? running.has(code) : false }
export function getRunning(code) { return (code && running.get(code)) || null }
// 取本次会话内刚跑完的结果（含 error/adviceMissing/truncated 等瞬时态；跨刷新则读 adviceCache）
export function getResult(code) { return (code && results.get(code)) || null }
// 组件消费完瞬时结果后可清掉，避免旧结果盖住后续从缓存恢复的值（可选）
export function clearResult(code) { if (code) { results.delete(code); } }

// spec: {
//   code, mode('buy_advice'|'hold_advice'), name, myHold(bool),
//   aiPayload(对象), quantUrl(字符串), priceHint(数字|null)
// }
export function startAdvice(spec) {
  const code = spec && spec.code
  if (!code) return Promise.resolve()
  if (running.has(code)) return running.get(code).promise || Promise.resolve()  // 已在后台跑 → 幂等，复用同一 promise
  results.delete(code)           // 清掉上次的瞬时结果，UI 立即进入 loading
  const rec = { phase: '正在准备分析…', startedAt: Date.now(), sources: [], reasoning: '', quant: null }
  running.set(code, rec)
  notify()
  const p = run(spec).finally(() => { running.delete(code); notify() })
  rec.promise = p                // 挂到运行记录上：批量生成器据此 await 完成
  return p
}

async function run(spec) {
  const { code, mode, name, myHold, aiPayload, quantUrl, priceHint } = spec
  const onPhase = (p) => {
    const r = running.get(code)
    if (r && p && p.text) { r.phase = p.text; notify() }
  }
  // 细粒度事件:source(数据源勾选清单) / reasoning(模型思维链增量)
  const onEvent = (event, data) => {
    const r = running.get(code)
    if (!r) return
    if (event === 'source' && data && data.label) {
      r.sources = [...(r.sources || []), { label: data.label, ok: !!data.ok }]
      notify()
    } else if (event === 'reasoning' && data && data.text) {
      r.reasoning = (r.reasoning || '') + data.text
      notify()
    } else if (event === 'quant' && data) {
      r.quant = data
      notify()
    }
  }
  try {
    // 量化服务（走势预测/多因子分）与 LLM 操作建议（带具体价位）并发
    const quantP = fetch(quantUrl).then((r) => r.json()).catch(() => null)
    const adviceP = callAIStream(mode, aiPayload, onPhase, undefined, onEvent)
      .then((r) => (r && r.ok ? { advice: r.result, meta: r.meta, news: r.news, truncated: r.truncated } : null))
      .catch(() => null)
    const [j, adviceResp] = await Promise.all([quantP, adviceP])

    const advice = adviceResp && adviceResp.advice
    const meta = adviceResp && adviceResp.meta
    const news = adviceResp && adviceResp.news
    const truncated = !!(adviceResp && (adviceResp.truncated || (advice && advice.truncated)))
    const adviceMissing = !myHold && !advice
    const result = (j && j.quant) ? j.quant : null

    if (result || advice) {
      const cachedAt = Date.now()
      results.set(code, { result, advice, meta, news, adviceMissing, truncated, cachedAt })
      saveAdvice(code, { result, advice, meta, news, truncated }) // 持久化：关闭再进/刷新仍可见
      // 行动点预警自动同步:把最新建议里的补仓价/减仓价转成到价预警,价一到就通知「现在该补/减仓了」。
      // 挂在这个唯一出口 → 手动/每日/批量/盘中自动刷新(含页面已关的后台生成)全都覆盖。
      if (advice) {
        try { planStore.syncActionAlerts(code) } catch { /* ignore */ }
      }
      // 生成AI操作建议时量化服务也跑了一次 → 把最新量化得分写回自选/持仓专用字段(排序/展示同源)
      if (result && result.score != null && !isNaN(result.score)) {
        try { planStore.setQuantScore(code, { qScore: Number(result.score), qBias: result.bias || '' }) } catch { /* ignore */ }
      }
      // 决策记录：把这条建议落库，供事后回测算真实胜率
      if (advice) {
        try {
          const px = (result && result.price) || priceHint || null
          planStore.logAdvice({
            code, name,
            mode: mode,
            action: advice.action || advice.stance || '',
            tone: advice.tone,
            entryPrice: advice.buyPrice ?? advice.addPrice ?? null,
            stop: advice.stopPrice ?? null, target: advice.targetPrice ?? null,
            trust: meta && meta.trustScore ? meta.trustScore.score : null,
            resonance: meta && meta.resonance ? meta.resonance.score : null,
            priceAtAdvice: px,
            theoryNote: advice.theoryNote || '',
          })
        } catch { /* ignore */ }
      }
    } else {
      results.set(code, { error: '量化服务暂不可用（可能冷启动，请稍后重试）' })
    }
  } catch (e) {
    results.set(code, { error: '获取失败：' + String((e && e.message) || e) })
  }
  notify()
}
