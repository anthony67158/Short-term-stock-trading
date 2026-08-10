const ACTIONS = new Set(['buy', 'add', 'reduce', 'sell'])
const OPS = new Set(['lte', 'gte'])
const text = (value, max) => String(value || '').trim().slice(0, max)
const positive = (value) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

export function sanitizeTradeProposal(input, allowedEvidenceIds = []) {
  if (!input || typeof input !== 'object') return null
  const code = /^\d{6}$/.test(String(input.code || '')) ? String(input.code) : ''
  const action = String(input.action || '').toLowerCase()
  const triggerOp = String(input.triggerOp || '').toLowerCase()
  const entryPrice = positive(input.entryPrice)
  const targetPrice = positive(input.targetPrice)
  const stopPrice = positive(input.stopPrice)
  if (!code || !ACTIONS.has(action) || !OPS.has(triggerOp) || entryPrice == null) return null
  if ((action === 'buy' || action === 'add') && stopPrice != null && stopPrice >= entryPrice) return null
  if ((action === 'buy' || action === 'add') && targetPrice != null && targetPrice <= entryPrice) return null
  if (stopPrice != null && targetPrice != null && stopPrice >= targetPrice) return null
  const allowed = new Set((allowedEvidenceIds || []).map(String))
  const evidenceIds = [...new Set((Array.isArray(input.evidenceIds) ? input.evidenceIds : [])
    .map(String)
    .filter((id) => /^证据\d+$/.test(id) && (!allowed.size || allowed.has(id))))].slice(0, 6)
  const qtyNumber = Number(input.qty)
  const qty = Number.isFinite(qtyNumber) && qtyNumber > 0 ? Math.min(100000, Math.trunc(qtyNumber)) : null
  return {
    id: text(input.id, 80) || `proposal_${code}_${action}_${entryPrice}`,
    code,
    name: text(input.name, 20) || code,
    action,
    entryPrice,
    ...(targetPrice != null ? { targetPrice } : {}),
    ...(stopPrice != null ? { stopPrice } : {}),
    ...(qty != null ? { qty } : {}),
    triggerOp,
    reason: text(input.reason, 240),
    confirmSignal: text(input.confirmSignal, 160),
    evidenceIds,
  }
}

export function proposalAlertSpec(proposal) {
  const item = sanitizeTradeProposal(proposal, proposal?.evidenceIds)
  if (!item) return null
  const labels = { buy: '买入', add: '加仓', reduce: '减仓', sell: '卖出' }
  const isStop = (item.action === 'reduce' || item.action === 'sell') && item.triggerOp === 'lte'
  return {
    code: item.code,
    name: item.name,
    type: 'price',
    op: item.triggerOp,
    value: item.entryPrice,
    note: `助手提案·${isStop ? '止损' : ''}${labels[item.action]}`,
    proposalId: item.id,
    phase: 'armed',
  }
}
