import { list, readJson, hasStorage } from './_blob.js';
import { createHash } from 'node:crypto';

// ============ 日报摘要（供操作建议/复盘复用为"外部市场环境"）============
// 生成一份精简摘要，并提供"读取当天最新日报摘要"给 ai.js 注入。

function nowBJ() { const n = new Date(); return new Date(n.getTime() + (n.getTimezoneOffset() + 480) * 60000); }
function bjDayKey() { const d = nowBJ(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
const PREFIX = 'dailyreport/';
const accountHash = (nick) => createHash('sha256')
  .update(`u:${String(nick || '').trim()}`)
  .digest('hex');

export function dailyReportCacheKey(day, session, nick) {
  return `${PREFIX}${accountHash(nick)}/${day}-${session}`;
}

function dailyReportDayPrefix(day, nick) {
  return `${PREFIX}${accountHash(nick)}/${day}-`;
}

export async function getDailyReportSession(
  day,
  session,
  nick,
  storage = { hasStorage, list, readJson },
) {
  if (
    !storage.hasStorage()
    || !String(nick || '').trim()
    || !/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))
    || !['morning', 'noon', 'evening'].includes(session)
  ) return null;
  try {
    const { blobs } = await storage.list({
      prefix: dailyReportCacheKey(day, session, nick),
      limit: 10,
    });
    if (!blobs.length) return null;
    const latest = blobs.sort((left, right) =>
      new Date(right.uploadedAt) - new Date(left.uploadedAt)
    )[0];
    const cached = await storage.readJson(latest);
    return isCompleteDailyReport(cached) ? cached : null;
  } catch {
    return null;
  }
}

function meaningful(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isCompleteDailyReport(result) {
  return !!(
    result
    && result.report
    && typeof result.report === 'object'
    && meaningful(result.report.overview)
    && meaningful(result.report.strategy)
  );
}

// 从完整日报结构里提炼一段短摘要(给别的 LLM 当外部环境用，控制 token)
export function buildDailySummary(result) {
  if (!isCompleteDailyReport(result)) return null;
  const rep = result.report;
  const parts = [];
  const evidenceSuffix = (item) => {
    const ids = Array.isArray(item?.evidenceIds)
      ? item.evidenceIds.filter(Boolean).slice(0, 3)
      : [];
    return ids.length ? `[${ids.join('、')}]` : '';
  };
  parts.push(`【${result.sessionCn || ''}·${result.day || ''}】`);
  if (rep.objective) parts.push('目标:' + String(rep.objective).slice(0, 40));
  if (rep.overview) parts.push('总览:' + String(rep.overview).slice(0, 160));
  if (rep.overseas) parts.push('海外:' + String(rep.overseas).slice(0, 100));
  if (Array.isArray(rep.events) && rep.events.length) {
    parts.push(
      '重大事件:'
      + rep.events.slice(0, 3).map((item) =>
        `${String(item?.title || '').slice(0, 70)}${evidenceSuffix(item)}`
      ).filter(Boolean).join('；'),
    );
  }
  if (Array.isArray(rep.holdings) && rep.holdings.length) {
    parts.push(
      '重点个股:'
      + rep.holdings.slice(0, 5).map((item) => {
        const name = String(item?.name || item?.code || '').slice(0, 30);
        const code = String(item?.code || '').slice(0, 12);
        const impact = String(item?.impact || item?.info || '').slice(0, 80);
        if (!name) return '';
        return `${name}${code ? `(${code})` : ''}:${impact}${evidenceSuffix(item)}`;
      }).filter(Boolean).join('；'),
    );
  }
  // 板块只留评级(看多/看空)，省 token
  if (Array.isArray(rep.sectors) && rep.sectors.length) {
    const bull = rep.sectors.filter((s) => String(s.rating).includes('多')).map((s) => s.name);
    const bear = rep.sectors.filter((s) => String(s.rating).includes('空')).map((s) => s.name);
    if (bull.length) parts.push('看多板块:' + bull.join('、'));
    if (bear.length) parts.push('看空板块:' + bear.join('、'));
  }
  if (Array.isArray(rep.analysis?.sectorPool) && rep.analysis.sectorPool.length) {
    parts.push(
      '板块池:'
      + rep.analysis.sectorPool.slice(0, 4).map((item) =>
        `${String(item?.name || '').slice(0, 24)}:${String(item?.action || '').slice(0, 70)}`
      ).filter(Boolean).join('；'),
    );
  }
  if (Array.isArray(rep.analysis?.stockPool) && rep.analysis.stockPool.length) {
    parts.push(
      '个股池:'
      + rep.analysis.stockPool.slice(0, 6).map((item) =>
        `${String(item?.name || item?.code || '').slice(0, 24)}:${String(item?.action || '').slice(0, 70)}`
      ).filter(Boolean).join('；'),
    );
  }
  if (
    Array.isArray(rep.analysis?.morningReview)
    && rep.analysis.morningReview.length
  ) {
    parts.push(
      '早报验证:'
      + rep.analysis.morningReview.slice(0, 5).map((item) =>
        `${String(item?.subject || '').slice(0, 24)}=${String(item?.status || '').slice(0, 16)}`
      ).filter(Boolean).join('；'),
    );
  }
  const actions = rep.analysis?.afternoonActions
    || rep.analysis?.nextDayPlan;
  if (Array.isArray(actions) && actions.length) {
    parts.push(
      '执行计划:'
      + actions.slice(0, 5).map((item) =>
        `${String(item?.target || '').slice(0, 24)}:${String(item?.action || '').slice(0, 70)}`
      ).filter(Boolean).join('；'),
    );
  }
  if (rep.strategy) parts.push('整体策略:' + String(rep.strategy).slice(0, 120));
  if (Array.isArray(rep.risks) && rep.risks.length) parts.push('风险:' + rep.risks.slice(0, 2).join('；'));
  return {
    day: result.day,
    session: result.session,
    sessionCn: result.sessionCn,
    text: parts.join(' '),
    searchEnabled: result.searchEnabled === true,
    searxngEnabled: result.searxngEnabled === true,
    searchConfigUpdatedAt: Number(result.searchConfigUpdatedAt) || 0,
  };
}

// 读取当天最新一份日报的摘要(任意场次，取最近生成的)；无则 null。给 ai.js 调用。
export async function getLatestDailySummary(nick) {
  if (!hasStorage() || !String(nick || '').trim()) return null;
  try {
    const day = bjDayKey();
    const { blobs } = await list({
      prefix: dailyReportDayPrefix(day, nick),
      limit: 20,
    });
    if (!blobs.length) return null;
    const latest = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
    const cached = await readJson(latest);
    if (!isCompleteDailyReport(cached)) return null;
    // 优先用已存的 summary 字段；否则现场提炼
    if (cached.summary && cached.summary.text) return cached.summary;
    return buildDailySummary(cached);
  } catch { return null; }
}
