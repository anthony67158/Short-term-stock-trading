import { Readable } from 'node:stream'
import FCModule, {
  InvokeFunctionHeaders,
  InvokeFunctionRequest,
} from '@alicloud/fc20230330'
import { $OpenApiUtil } from '@alicloud/openapi-core'
import { RuntimeOptions } from '@darabonba/typescript'

const FCClient = FCModule.default || FCModule
const WORKER_SOURCE = 'stock-dashboard.advice-worker'
const DAILY_REPORT_WORKER_SOURCE = 'stock-dashboard.daily-report-worker'

export function buildAdviceWorkerEvent(nick, cronKey) {
  nick = String(nick || '').trim()
  cronKey = String(cronKey || '')
  if (!nick) throw new Error('缺少建议任务账号')
  if (!cronKey) throw new Error('内部调度密钥未配置')
  return {
    source: WORKER_SOURCE,
    key: cronKey,
    nick,
  }
}

export function buildDailyReportWorkerEvent({
  nick,
  session,
  runKey,
}, cronKey) {
  const account = String(nick || '').trim()
  const reportSession = String(session || '').trim()
  const key = String(runKey || '').trim()
  const secret = String(cronKey || '')
  if (!account) throw new Error('缺少日报任务账号')
  if (!['morning', 'noon', 'evening'].includes(reportSession)) {
    throw new Error('日报场次无效')
  }
  if (!/^\d{4}-\d{2}-\d{2}:(morning|noon|evening)$/.test(key)) {
    throw new Error('日报任务标识无效')
  }
  if (!secret) throw new Error('内部调度密钥未配置')
  return {
    source: DAILY_REPORT_WORKER_SOURCE,
    key: secret,
    nick: account,
    session: reportSession,
    runKey: key,
  }
}

function fcClient(env) {
  const accessKeyId = env.FC_ACCESS_KEY_ID || env.OSS_ACCESS_KEY_ID
  const accessKeySecret = env.FC_ACCESS_KEY_SECRET || env.OSS_ACCESS_KEY_SECRET
  if (!accessKeyId || !accessKeySecret) throw new Error('FC异步调用凭证未配置')
  return new FCClient(new $OpenApiUtil.Config({
    accessKeyId,
    accessKeySecret,
    regionId: env.ADVICE_FC_REGION || 'cn-hangzhou',
    connectTimeout: 10000,
    readTimeout: 10000,
  }))
}

async function invokeFC({
  functionName,
  qualifier,
  event,
}, env) {
  const client = fcClient(env)
  const response = await client.invokeFunctionWithOptions(
    functionName,
    new InvokeFunctionRequest({
      qualifier,
      body: Readable.from(Buffer.from(JSON.stringify(event), 'utf8')),
    }),
    new InvokeFunctionHeaders({
      xFcInvocationType: 'Async',
      xFcLogType: 'None',
    }),
    new RuntimeOptions({}),
  )
  if (response?.body && Symbol.asyncIterator in response.body) {
    for await (const _chunk of response.body) {
      // Async invocation returns no business payload; drain the SDK stream.
    }
  }
  return {
    requestId: String(
      response?.headers?.['x-fc-request-id']
      || response?.headers?.['x-fc-requestid']
      || '',
    ),
  }
}

export async function dispatchAdviceWorker(
  nick,
  {
    env = process.env,
    invoke = invokeFC,
  } = {},
) {
  return dispatchFcEvent(
    buildAdviceWorkerEvent(nick, env.CRON_KEY),
    { env, invoke },
  )
}

export async function dispatchDailyReportWorker(
  task,
  {
    env = process.env,
    invoke = invokeFC,
  } = {},
) {
  return dispatchFcEvent(
    buildDailyReportWorkerEvent(task, env.CRON_KEY),
    { env, invoke },
  )
}

export async function dispatchFcEvent(
  event,
  {
    env = process.env,
    invoke = invokeFC,
  } = {},
) {
  const region = String(env.ADVICE_FC_REGION || 'cn-hangzhou')
  const functionName = String(env.ADVICE_FC_FUNCTION_NAME || 'stock-dashboard')
  const result = await invoke({
    functionName,
    region,
    qualifier: 'LATEST',
    invocationType: 'Async',
    event,
  }, env)
  return {
    accepted: true,
    requestId: String(result?.requestId || ''),
  }
}
