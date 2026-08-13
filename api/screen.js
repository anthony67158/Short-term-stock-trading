import { applyCors, preflight, sendError, sendJson } from './_lib.js';
import { screenMarketCandidates } from './_screen.js';

// GET /api/screen?limit=30
// 全市场可交易性过滤 + 确定性横截面排序，供前端再做量化复排。
export default async function handler(req, res) {
  if (preflight(req, res)) return;
  applyCors(res);
  if (req.method !== 'GET') {
    return sendJson(res, { ok: false, error: 'GET only' }, { cache: 0 });
  }
  try {
    const limit = Math.max(1, Math.min(50, Number(req.query && req.query.limit) || 30));
    const ranked = await screenMarketCandidates({ limit });
    return sendJson(res, {
      ok: true,
      updatedAt: Date.now(),
      strategyId: ranked.strategyId,
      specVersion: ranked.specVersion,
      universeCount: ranked.universeCount,
      scannedCount: ranked.scannedCount,
      isComplete: ranked.scannedCount >= ranked.universeCount * 0.98,
      eligibleCount: ranked.eligibleCount,
      list: ranked.list,
    }, { cache: 20 });
  } catch (error) {
    return sendError(res, error);
  }
}
