import { Readable } from 'node:stream'
import FCModule, {
  InvokeFunctionHeaders,
  InvokeFunctionRequest,
} from '@alicloud/fc20230330'
import { $OpenApiUtil } from '@alicloud/openapi-core'
import { RuntimeOptions } from '@darabonba/typescript'

const FCClient = FCModule.default || FCModule
const WORKER_SOURCE = 'stock-dashboard.advice-worker'

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

function fcClient(env) {
  const accessKeyId = env.FC_ACCESS_KEY_ID || env.OSS_ACCESS_KEY_ID
  const accessKeySecret = env.FC_ACCESS_KEY_SECRET || env.OSS_ACCESS_KEY_SECRET
  if (!accessKeyId || !accessKeySecret) throw new Error('FC异步调用凭证未配置')
  return new FCClient(new $OpenApiUtil.Config({
    accessKeyId,
    accessKeySecret,
    regionId: env.FC_REGION || 'cn-hangzhou',
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
  const region = String(env.FC_REGION || 'cn-hangzhou')
  const functionName = String(env.FC_FUNCTION_NAME || 'stock-dashboard')
  const event = buildAdviceWorkerEvent(nick, env.CRON_KEY)
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
