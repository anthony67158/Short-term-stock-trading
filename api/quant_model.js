import { applyCors, preflight } from './_lib.js'
import {
  applyModelSelection,
  canControlV2Service,
  getProductionModelMetrics,
  getV2ServiceStatus,
  modelControlView,
  resolveV2ServiceStatus,
  setV2ServiceEnabled,
} from './_quant_model_control.js'
import {
  isAccountActive,
  readAccount,
  sha,
  writeAccount,
} from './account.js'
import { loadV2Accuracy } from './_v2_accuracy_store.js'
import { loadV21Accuracy } from './_v21_accuracy_store.js'
import { loadProductionAccuracy } from './_production_accuracy_store.js'

function reply(res, body, status = 200) {
  applyCors(res)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.statusCode = status
  return res.end(JSON.stringify(body))
}

async function authenticate(body) {
  const nick = String(body?.nick || '').trim()
  const pw = body?.pw != null ? String(body.pw) : ''
  if (!nick || !pw) return { error: '请先登录' }
  const account = await readAccount(nick)
  if (!account || !isAccountActive(account) || account.pwHash !== sha(pw)) {
    return { error: '账号鉴权失败' }
  }
  return { account }
}

export default async function handler(req, res) {
  if (preflight(req, res)) return
  if (req.method !== 'POST') return reply(res, { ok: false, error: 'POST only' }, 405)
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
    const auth = await authenticate(body)
    if (auth.error) return reply(res, { ok: false, error: auth.error }, 401)
    const action = String(body.action || 'get')
    let transitionStatus = ''
    if (action === 'select') {
      applyModelSelection(auth.account.data || (auth.account.data = {}), body.version)
      await writeAccount(auth.account)
    } else if (action === 'startV2' || action === 'stopV2') {
      if (!canControlV2Service(auth.account)) {
        return reply(res, {
          ok: false,
          error: '当前账号无权启停共享V2服务',
        }, 403)
      }
      const transition = await setV2ServiceEnabled(action === 'startV2')
      transitionStatus = transition.status
    } else if (action !== 'get') {
      return reply(res, { ok: false, error: '未知操作' }, 422)
    }
    const [
      status,
      productionModel,
      productionAccuracy,
      accuracy,
      v21Accuracy,
    ] = await Promise.all([
      transitionStatus
        ? resolveV2ServiceStatus(transitionStatus)
        : getV2ServiceStatus(),
      getProductionModelMetrics(),
      loadProductionAccuracy().catch(() => null),
      loadV2Accuracy().catch(() => null),
      loadV21Accuracy().catch(() => null),
    ])
    return reply(res, {
      ok: true,
      control: modelControlView(auth.account.data || {}, {
        v2Status: status,
        canControlV2: canControlV2Service(auth.account),
      }),
      productionModel,
      productionAccuracy,
      accuracy,
      v21Accuracy,
    })
  } catch (error) {
    console.error('[quant_model] operation failed', error?.code || error?.name || error?.message)
    return reply(res, { ok: false, error: '模型控制暂不可用，请稍后重试' }, 503)
  }
}
