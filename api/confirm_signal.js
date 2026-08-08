// ============ /api/confirm_signal：智能交易确认闸门(前端调用入口)============
// 前端 alertStore 在某条 AI 价位预警进入「观察确认中(watching)」后,轮询调用本端点,
// 让【服务端】跑确定性信号 + LLM Judge(role:'judge'),判定真正交易时机是否到。
//   为什么放服务端:LLM 调用与密钥必须留在后端(合规),前端只拿结论(decision/reason)。
//
// 入参(POST JSON):{ alert:{code,name,type,op,value,note,actKind?,opQty?,timing?,phase?},
//                    advice?:{...AI建议对象,含 exitTiming/invalidation}, quote?:{price,pct,...} }
// 出参:{ ok, decision:'confirm'|'wait'|'invalid', confidence, reason, side, source }
//
// 无鉴权(与 /api/quote 等只读端点同级);只读公开行情 + LLM,不写任何账号数据。

import { applyCors, preflight } from './_lib.js';
import { ensureConfig } from './_llm_config.js';
import { judgeConfirmation } from './_confirm.js';

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  applyCors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    body = body || {};
    const alert = body.alert;
    if (!alert || !alert.code) {
      return res.status(200).send(JSON.stringify({ ok: false, error: '缺少 alert' }));
    }
    try { await ensureConfig({ maxAgeMs: 20000 }); } catch { /* 回退确定性信号 */ }
    const v = await judgeConfirmation({
      alert,
      name: alert.name,
      advice: body.advice,
      quote: body.quote,
    });
    return res.status(200).send(JSON.stringify({ ok: true, ...v }));
  } catch (e) {
    // 出错时保守返回 wait,避免前端误发强提示
    return res.status(200).send(JSON.stringify({ ok: false, decision: 'wait', error: String(e && e.message || e) }));
  }
}
