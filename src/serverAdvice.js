// 「服务端按需生成 AI 操作建议」触发器(fire-and-forget)。
// 为什么存在:原先建议生成 100% 在浏览器里跑(callAIStream 走 SSE,无重试)——
//   手机上一旦切到后台/锁屏,iOS 会冻结页面并掐断在途网络连接 → SSE 断流 → "生成失败"。
// 这里把生成搬到服务端:向 /api/cron_advice 的【按需分支】发一个带账号密码的 POST,
//   FC(600s 超时,脱离浏览器)在后台把这些 code 逐只生成完,并把结果+进度写回云端。
//   请求用 keepalive:true —— 即使随后页面被切后台/关闭,请求也已送达服务端并继续跑完;
//   我们【不等它的响应】,结果与进度都靠 authStore.pull 轮询云端拿回(手机/电脑都能看到)。
import { api } from './apiBase'
import { authStore } from './authStore'

// 触发服务端生成。codes=要生成的股票代码数组;成功发出返回 true,无登录态/空列表返回 false。
export function triggerServerAdvice(codes, { scope = 'all', force = true } = {}) {
  let creds = null
  try { creds = authStore.getCreds && authStore.getCreds() } catch { creds = null }
  if (!creds || !creds.nick) return false
  const list = [...new Set((codes || []).filter(Boolean).map(String))]
  if (!list.length) return false
  try {
    fetch(api('/api/cron_advice'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ondemand: true, codes: list, nick: creds.nick, pw: creds.pw, scope, force }),
      keepalive: true,   // 页面切后台/关闭也已送达服务端,服务端照跑完
    }).catch(() => { /* 结果靠云端轮询,忽略网络层错误 */ })
    return true
  } catch { return false }
}

// 是否具备服务端生成条件(已登录云端账号)。前端据此决定走服务端还是本地兜底。
export function canServerAdvice() {
  try { const c = authStore.getCreds && authStore.getCreds(); return !!(c && c.nick) } catch { return false }
}

// 取消服务端任务:codes 为空/未传 → 取消全部(op:'cancelAll'),否则取消指定 codes(op:'cancel')。
// fire-and-forget + keepalive:即使随后切后台/关页面也已送达 FC;取消结果经 authStore.pull 轮询云端回灌。
// 返回 true=已发出,false=无登录态。
export function cancelServerAdvice(codes) {
  let creds = null
  try { creds = authStore.getCreds && authStore.getCreds() } catch { creds = null }
  if (!creds || !creds.nick) return false
  const list = [...new Set((codes || []).filter(Boolean).map(String))]
  const op = list.length ? 'cancel' : 'cancelAll'
  try {
    fetch(api('/api/cron_advice'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, codes: list, nick: creds.nick, pw: creds.pw }),
      keepalive: true,
    }).catch(() => { /* 取消结果靠云端轮询,忽略网络层错误 */ })
    return true
  } catch { return false }
}
