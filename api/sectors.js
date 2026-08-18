import { emGetOne, sendJson, sendError, num } from './_lib.js';

export async function collectSectorRows(
  fetchPage,
  { pageSize = 100, maxPages = 8 } = {},
) {
  const first = await fetchPage(1);
  const firstRows = first?.data?.diff || [];
  const total = Math.max(firstRows.length, Number(first?.data?.total) || 0);
  const pageCount = Math.max(
    1,
    Math.min(maxPages, Math.ceil(total / pageSize)),
  );
  const rest = await Promise.all(
    Array.from(
      { length: Math.max(0, pageCount - 1) },
      (_, index) => fetchPage(index + 2),
    ),
  );
  const pages = [first, ...rest];
  const rows = [];
  const seen = new Set();
  for (const payload of pages) {
    for (const row of payload?.data?.diff || []) {
      const code = String(row?.f12 || '');
      if (!code || seen.has(code)) continue;
      seen.add(code);
      rows.push(row);
    }
  }
  return rows;
}

function nullableNum(value) {
  if (value === '-' || value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function mapSectorRow(d = {}) {
  return {
    code: d.f12,
    name: d.f14,
    price: num(d.f2),
    pct: num(d.f3),
    mainInflow: num(d.f62),
    mainRatio: num(d.f184),
    superInflow: num(d.f66),
    turnover: num(d.f8),
    amount: num(d.f6),
    leadName: d.f128 && d.f128 !== '-' ? d.f128 : null,
    leadCode: d.f140 && d.f140 !== '-' ? String(d.f140) : null,
    leadPct: nullableNum(d.f136),
  };
}

// 板块资金流向排行
// query: type=industry|concept   sort=main(主力净流入)|pct(涨跌幅)
export default async function handler(req, res) {
  try {
    const type = (req.query.type || 'industry') === 'concept' ? 'concept' : 'industry';
    const fs = type === 'concept' ? 'm:90+t:3' : 'm:90+t:2';
    const fid = req.query.sort === 'pct' ? 'f3' : 'f62'; // f62=主力净流入
    // po=1 降序（默认）；分页拉全量板块，确保流入/流出两端都覆盖
    const po = req.query.po === '0' ? '0' : '1';

    // f128/f140/f136 才是领涨股名/代码/涨幅；f206 是市场标识(沪1深0)。
    const fields =
      'f12,f14,f2,f3,f62,f184,f66,f72,f78,f84,f128,f140,f136,f8,f6';
    // 东方财富实际单页上限为100，即便 pz=500 也只回100条；概念约300+，必须分页。
    const fetchPage = (page) => {
      const path =
        `/api/qt/clist/get?pn=${page}&pz=100&po=${po}&np=1&fltt=2&invt=2` +
        `&fid=${fid}&fs=${encodeURIComponent(fs)}&fields=${fields}`;
      return emGetOne(path, { hostIndex: 2, maxAttempts: 3 });
    };
    const diff = await collectSectorRows(fetchPage);
    const list = diff.map(mapSectorRow);

    sendJson(res, { ok: true, type, updatedAt: Date.now(), list }, { cache: 30 });
  } catch (e) {
    sendError(res, e);
  }
}
