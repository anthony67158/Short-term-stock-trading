import { sendJson } from './_lib.js';
import { fetchClsTelegraph, fetchSinaFlash, fetchNews } from './_market_data.js';

// ============ 盘面研究·外部宏观快讯聚合 ============
// GET /api/news
// 把原先散落的"日报/快讯"集中到盘面研究：一处输出全市场外部宏观经济要闻 + 7×24 快讯。
// 数据源：财联社系/金十/东财聚合(fetchClsTelegraph) + 新浪财经7×24(fetchSinaFlash) + 东财宏观要闻检索(fetchNews)。
// 全部公开免费接口，海外/延迟诚实标注；供前端展示，也供 AI 各流程复用为"外部消息面"。
export default async function handler(req, res) {
  try {
    const [cls, sina, macro] = await Promise.all([
      fetchClsTelegraph(20).catch(() => []),
      fetchSinaFlash(16).catch(() => []),
      fetchNews('宏观 政策 央行 A股 美联储 关税 市场', 10).catch(() => []),
    ]);

    // 7×24 快讯：财联社系 + 新浪合并、按时间去重（标题前 24 字判重）
    const seen = new Set();
    const flashes = [...(cls || []), ...(sina || [])]
      .filter((n) => {
        const k = (n.title || '').slice(0, 24);
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((n) => ({ title: n.title, src: n.src || '快讯', date: n.date || '', url: n.url || '', level: n.level }))
      .slice(0, 30);

    // 宏观要闻：带链接的深度稿件
    const macroList = (macro || [])
      .map((n) => ({ title: n.title, date: n.date || '', url: n.url || '' }))
      .filter((n) => n.title)
      .slice(0, 10);

    sendJson(res, { ok: true, macro: macroList, flashes, updatedAt: Date.now() }, { cache: 60 });
  } catch (e) {
    sendJson(res, { ok: false, error: String(e.message || e), macro: [], flashes: [] }, { cache: 0 });
  }
}
