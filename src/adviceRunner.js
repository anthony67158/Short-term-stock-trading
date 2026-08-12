// 「AI 操作建议」后台生成器：把生成流程从 StockDetail 组件里抽出来，挂在模块级，
// 脱离 React 组件生命周期——关闭弹窗后照样在后台跑完，跑完写入 adviceCache 并记录决策；
// 组件只需订阅本 runner + adviceCache，就能看到「后台生成中」的实时进度或直接拿到结果。
import { callAIStream } from './ai'
import { getAdvice, saveAdvice } from './adviceCache'
import { planStore } from './planStore'
import { triggerServerAdvice, canServerAdvice } from './serverAdvice'
import { acceptsGenerationResult, generationOptions } from '../shared/adviceBatchPolicy.js'
import { ensureAdviceReasoning } from '../shared/adviceReasoning.js'
import { quantModelHeaders } from './quantModel'
import { compactAdvicePlan } from '../shared/adviceContinuity.js'

const running = new Map()  // code -> { phase, startedAt }
const results = new Map()  // code -> { result, advice, meta, news, adviceMissing, truncated, error, cachedAt }
const subs = new Set()

function notify() { subs.forEach((fn) => { try { fn() } catch { /* ignore */ } }) }
// 订阅：后台进度/结果变化时回调（组件用它触发重渲染）
export function subscribeRunner(fn) { subs.add(fn); return () => subs.delete(fn) }
export function isRunning(code) { return code ? running.has(code) : false }
export function getRunning(code) { return (code && running.get(code)) || null }
// 本地正在生成的清单:[{code, name, startedAt}](供单股触发门控/「端点已满」弹窗展示)
export function getRunningList() {
  return [...running.entries()].map(([code, r]) => ({ code, name: (r && r.name) || code, startedAt: (r && r.startedAt) || 0 }))
}
// 取本次会话内刚跑完的结果（含 error/adviceMissing/truncated 等瞬时态；跨刷新则读 adviceCache）
export function getResult(code) { return (code && results.get(code)) || null }
// 组件消费完瞬时结果后可清掉，避免旧结果盖住后续从缓存恢复的值（可选）
export function clearResult(code) { if (code) { results.delete(code); } }
export function cancelAdvice(code) {
  const record = code && running.get(code)
  if (!record) return false
  record.cancelRequested = true
  try { record.controller.abort() } catch { /* ignore */ }
  try { record.quantController?.abort() } catch { /* ignore */ }
  notify()
  return true
}

// spec: {
//   code, mode('buy_advice'|'hold_advice'), name, myHold(bool),
//   aiPayload(对象), quantUrl(字符串), priceHint(数字|null)
// }
export function startAdvice(spec) {
  const code = spec && spec.code
  if (!code) return Promise.resolve()
  if (running.has(code)) return running.get(code).promise || Promise.resolve()  // 已在后台跑 → 幂等，复用同一 promise
  results.delete(code)           // 清掉上次的瞬时结果，UI 立即进入 loading
  const rec = {
    phase: '正在准备分析…',
    startedAt: Date.now(),
    name: (spec && spec.name) || code,
    sources: [],
    reasoning: '',
    quant: null,
    controller: new AbortController(),
    cancelRequested: false,
  }
  running.set(code, rec)
  notify()
  const p = run(spec, rec).finally(() => { running.delete(code); notify() })
  rec.promise = p                // 挂到运行记录上：批量生成器据此 await 完成
  return p
}

async function run(spec, record) {
  const { code, mode, name, myHold, aiPayload, quantUrl, priceHint } = spec
  const previousAdvice = compactAdvicePlan(getAdvice(code))
  const requestPayload = {
    ...(aiPayload || {}),
    ...(previousAdvice ? { previousAdvice } : {}),
  }
  const generation = generationOptions(!!spec.deepMode)
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
    // ★超时护栏:量化端点冷启动/挂起时,不加超时会让下面的 Promise.all 永久 pending →
    //   running 永不释放 → 该股再也无法重新生成。加 15s AbortController,超时按「不可用」(null)处理,
    //   与原有 .catch(()=>null) 的降级语义完全一致(不改服务端 /predict 打分逻辑)。
    const quantP = (async () => {
      if (!quantUrl) return null
      const ac = new AbortController()
      record.quantController = ac
      const t = setTimeout(() => { try { ac.abort() } catch { /* ignore */ } }, 15000)
      try {
        const r = await fetch(quantUrl, {
          signal: ac.signal,
          headers: quantModelHeaders(requestPayload.quantModelVersion),
        })
        return await r.json()
      } catch { return null } finally { clearTimeout(t) }
    })()
    const adviceP = callAIStream(mode, requestPayload, onPhase, record.controller.signal, onEvent, generation)
      .then((r) => (r && r.ok ? { advice: r.result, meta: r.meta, news: r.news, truncated: r.truncated } : null))
      .catch(() => null)
    const [j, adviceResp] = await Promise.all([quantP, adviceP])
    if (record.cancelRequested) {
      results.delete(code)
      return
    }

    const advice = adviceResp && adviceResp.advice
      ? ensureAdviceReasoning(adviceResp.advice, record.reasoning)
      : null
    const meta = adviceResp && adviceResp.meta
    const news = adviceResp && adviceResp.news
    const truncated = !!(adviceResp && (adviceResp.truncated || (advice && advice.truncated)))
    const adviceMissing = !myHold && !advice
    const result = (j && j.quant) ? j.quant : null

    if (acceptsGenerationResult({ quant: result, advice, truncated }, generation.deepMode)) {
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
            knowledgeActionPlan: advice.knowledgeActionPlan || null,
            knowledgeActionScore: advice.knowledgeActionScore || null,
          })
        } catch { /* ignore */ }
      }
    } else {
      // 本地生成两头都空(军师+量化):很可能是移动端切后台/锁屏把 SSE 掐断了。
      // 已登录云端账号 → 兜底改走【服务端生成】:请求带 keepalive,退到后台也能在 FC 里跑完,
      // 结果稍后经 authStore.pull 轮询云端回灌到本机缓存(手机/电脑都能看到)。
      if (serverFallback(code, generation.deepMode)) {
        results.set(code, { pending: true, error: '本地生成中断,已转由云端继续生成,稍候自动刷新…' })
      } else {
        results.set(code, { error: '量化服务暂不可用（可能冷启动，请稍后重试）' })
      }
    }
  } catch (e) {
    if (record.cancelRequested) {
      results.delete(code)
      return
    }
    if (serverFallback(code, generation.deepMode)) {
      results.set(code, { pending: true, error: '本地生成中断,已转由云端继续生成,稍候自动刷新…' })
    } else {
      results.set(code, { error: '获取失败：' + String((e && e.message) || e) })
    }
  }
  notify()
}

// 单只服务端兜底:已登录云端账号才可用。触发一次「按需服务端生成」(仅这一只 code),
// fire-and-forget + keepalive,页面切后台/关闭也已送达 FC 照跑完。成功发出返回 true。
function serverFallback(code, deepMode = false) {
  try {
    if (!canServerAdvice()) return false
    return !!triggerServerAdvice([code], { scope: 'all', force: true, deepMode })
  } catch { return false }
}
