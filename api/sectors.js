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

export async function fetchSectorList({
  type = 'industry',
  sort = 'main',
  order = '1',
} = {}) {
  const normalizedType = type === 'concept' ? 'concept' : 'industry';
  const fs = normalizedType === 'concept' ? 'm:90+t:3' : 'm:90+t:2';
  const fid = sort === 'pct' ? 'f3' : 'f62';
  const po = order === '0' ? '0' : '1';
  const fields =
    'f12,f14,f2,f3,f62,f184,f66,f72,f78,f84,f128,f140,f136,f8,f6';
  const fetchPage = (page) => {
    const path =
      `/api/qt/clist/get?pn=${page}&pz=100&po=${po}&np=1&fltt=2&invt=2` +
      `&fid=${fid}&fs=${encodeURIComponent(fs)}&fields=${fields}`;
    return emGetOne(path, { hostIndex: 2, maxAttempts: 3 });
  };
  const diff = await collectSectorRows(fetchPage);
  return {
    ok: true,
    type: normalizedType,
    updatedAt: Date.now(),
    list: diff.map(mapSectorRow),
  };
}

// 板块资金流向排行
// query: type=industry|concept   sort=main(主力净流入)|pct(涨跌幅)
export default async function handler(req, res) {
  try {
    const result = await fetchSectorList({
      type: req.query.type,
      sort: req.query.sort,
      order: req.query.po,
    });
    sendJson(res, result, { cache: 30 });
  } catch (e) {
    sendError(res, e);
  }
}
