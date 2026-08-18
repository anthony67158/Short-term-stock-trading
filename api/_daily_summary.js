import { list, readJson, hasStorage } from './_blob.js';

// ============ 日报摘要（供操作建议/复盘复用为"外部市场环境"）============
// 生成一份精简摘要，并提供"读取当天最新日报摘要"给 ai.js 注入。

function nowBJ() { const n = new Date(); return new Date(n.getTime() + (n.getTimezoneOffset() + 480) * 60000); }
function bjDayKey() { const d = nowBJ(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
const PREFIX = 'dailyreport/';

// 从完整日报结构里提炼一段短摘要(给别的 LLM 当外部环境用，控制 token)
export function buildDailySummary(result) {
  if (!result || !result.report) return null;
  const rep = result.report;
  const parts = [];
  parts.push(`【${result.sessionCn || ''}·${result.day || ''}】`);
  if (rep.overview) parts.push('总览:' + String(rep.overview).slice(0, 160));
  if (rep.overseas) parts.push('海外:' + String(rep.overseas).slice(0, 100));
  // 板块只留评级(看多/看空)，省 token
  if (Array.isArray(rep.sectors) && rep.sectors.length) {
    const bull = rep.sectors.filter((s) => String(s.rating).includes('多')).map((s) => s.name);
    const bear = rep.sectors.filter((s) => String(s.rating).includes('空')).map((s) => s.name);
    if (bull.length) parts.push('看多板块:' + bull.join('、'));
    if (bear.length) parts.push('看空板块:' + bear.join('、'));
  }
  if (rep.strategy) parts.push('整体策略:' + String(rep.strategy).slice(0, 120));
  if (Array.isArray(rep.risks) && rep.risks.length) parts.push('风险:' + rep.risks.slice(0, 2).join('；'));
  return {
    day: result.day,
    session: result.session,
    sessionCn: result.sessionCn,
    text: parts.join(' '),
    searchEnabled: result.searchEnabled === true,
    searchConfigUpdatedAt: Number(result.searchConfigUpdatedAt) || 0,
  };
}

// 读取当天最新一份日报的摘要(任意场次，取最近生成的)；无则 null。给 ai.js 调用。
export async function getLatestDailySummary() {
  if (!hasStorage()) return null;
  try {
    const day = bjDayKey();
    const { blobs } = await list({ prefix: `${PREFIX}${day}-`, limit: 20 });
    if (!blobs.length) return null;
    const latest = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
    const cached = await readJson(latest);
    if (!cached) return null;
    // 优先用已存的 summary 字段；否则现场提炼
    if (cached.summary && cached.summary.text) return cached.summary;
    return buildDailySummary(cached);
  } catch { return null; }
}
