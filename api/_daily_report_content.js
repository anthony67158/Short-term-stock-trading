const SESSION_LABELS = Object.freeze({
  morning: '盘前早报',
  noon: '午间午报',
  evening: '收盘晚报',
});

export const DAILY_REPORT_SCHEMA_VERSION = 'daily-report.v2';
export const DAILY_REPORT_SEARCH_PLAN_VERSION = 4;

function text(value, limit = 320) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function evidenceText(value, limit = 320) {
  return text(value, limit * 2)
    .replace(
      /(?:忽略|无视|绕过|覆盖|取消)(?:此前|之前|以上|系统|开发者|用户)?[^。！？.!?]{0,80}(?:指令|规则|提示词)[，,。！？.!?]?/gi,
      ' ',
    )
    .replace(
      /(?:泄露|输出|展示|返回|告诉我)[^。！？.!?]{0,80}(?:系统提示词|开发者消息|密钥|API\s*Key|口令)[，,。！？.!?]?/gi,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function safeUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return ['http:', 'https:'].includes(parsed.protocol)
      ? parsed.toString()
      : '';
  } catch {
    return '';
  }
}

function uniqueStrings(values, limit = 8) {
  return [...new Set(
    (values || []).map((value) => text(value, 48)).filter(Boolean),
  )].slice(0, limit);
}

function numberOrNull(value) {
  if (value == null || value === '' || value === '-') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boundedQuery(parts) {
  return Array.from(parts.filter(Boolean).join(' '))
    .slice(0, 64)
    .join('');
}

export function buildDailyReportSearchPlans({
  day = '',
  session = 'morning',
  industries = [],
} = {}) {
  const sessionKey = SESSION_LABELS[session] ? session : 'morning';
  const industryNames = uniqueStrings(industries, 4);
  const prefix = `${text(day, 10)} ${SESSION_LABELS[sessionKey]}`;
  const rows = sessionKey === 'morning'
    ? [
        {
          key: 'global',
          label: '隔夜海外与商品',
          query: boundedQuery([
            prefix,
            '隔夜 美股 美债 美元 人民币 原油 黄金 对A股影响',
          ]),
        },
        {
          key: 'macro',
          label: '政策与产业催化',
          query: boundedQuery([
            ...industryNames,
            prefix,
            '昨晚 今早 政策 产业 催化 供需 价格',
          ]),
        },
        {
          key: 'institution',
          label: '机构观点与金股',
          query: boundedQuery([
            prefix,
            '券商 机构 金股 调研 资金预期',
          ]),
        },
      ]
    : sessionKey === 'noon'
      ? [
          {
            key: 'market',
            label: '上午盘面',
            query: boundedQuery([
              prefix,
              'A股 上午 收盘 主线 异动 成交额',
            ]),
          },
          {
            key: 'macro',
            label: '盘中政策与突发',
            query: boundedQuery([
              prefix,
              '盘中 政策 突发 财联社 证券时报',
            ]),
          },
        ]
      : [
          {
            key: 'market',
            label: '收盘复盘',
            query: boundedQuery([
              prefix,
              'A股 收盘 主线 轮动 龙虎榜',
            ]),
          },
          {
            key: 'macro',
            label: '盘后政策与产业',
            query: boundedQuery([
              prefix,
              '盘后 政策 产业 公告 催化 风险',
            ]),
          },
          {
            key: 'global',
            label: '次日海外事件',
            query: boundedQuery([
              prefix,
              '今晚 明日 海外 财经日历 美联储 商品 风险事件',
            ]),
          },
        ];
  return rows.map((row) => ({
    ...row,
    cacheScope: `daily-${row.key}`,
    cacheKey: `${day}-${sessionKey}-${row.key}-v${DAILY_REPORT_SEARCH_PLAN_VERSION}:${row.query}`,
    cacheMinutes: 60,
    topK: 8,
    version: DAILY_REPORT_SEARCH_PLAN_VERSION,
  }));
}

function sourceWeight(item) {
  if (item.kind === 'announcement') return 120;
  if (item.kind === 'policy') return 110;
  if (item.kind === 'market') return 100;
  if (item.authority === 'very_high') return 92;
  if (item.authority === 'high') return 82;
  if (item.kind === 'flash') return 74;
  if (item.kind === 'research') return 62;
  if (item.kind === 'web_search') return 56;
  if (item.kind === 'doubao_search') return 52;
  return 58;
}

function evidenceLevel(item) {
  if (
    item.kind === 'doubao_search'
    || item.kind === 'web_search'
  ) return 'search-lead';
  if (item.kind === 'announcement' || item.kind === 'policy') {
    return 'primary';
  }
  if (
    item.kind === 'market'
    || item.kind === 'flash'
    || item.authority === 'very_high'
    || item.authority === 'high'
  ) return 'corroborated';
  return 'secondary';
}

function evidenceKey(item) {
  return text(item.title, 200)
    .toLowerCase()
    .replace(/[\s，。、“”‘’：:；;！!？?（）()《》【】\-_]/g, '')
    .slice(0, 100);
}

function highQualitySearchLead(item) {
  if (!['doubao_search', 'web_search'].includes(item?.kind)) return true;
  if (['very_high', 'high'].includes(String(item.authority || ''))) {
    return true;
  }
  const source = `${item.src || ''} ${item.url || ''}`.toLowerCase();
  return [
    'gov.cn',
    'pbc.gov.cn',
    'csrc.gov.cn',
    'sse.com.cn',
    'szse.cn',
    'cninfo.com.cn',
    '新华社',
    '中国政府网',
    '证监会',
    '证券交易所',
  ].some((marker) => source.includes(marker.toLowerCase()));
}

function normalizedEvidence(item, defaults = {}) {
  const title = evidenceText(item?.title, 180);
  if (!title) return null;
  const kind = text(item?.kind || defaults.kind || 'media', 32);
  return {
    title,
    summary: evidenceText(item?.summary, 360),
    date: text(item?.date, 20),
    publishedAt: text(item?.publishedAt || item?.date, 32),
    url: safeUrl(item?.url),
    src: text(item?.src || defaults.src || '公开信息', 60),
    kind,
    category: text(defaults.category || item?.category || 'market', 32),
    categoryLabel: text(
      defaults.categoryLabel || item?.categoryLabel || '市场信息',
      40,
    ),
    stockCode: text(defaults.stockCode || item?.stockCode, 12),
    stockName: text(defaults.stockName || item?.stockName, 40),
    sector: text(defaults.sector || item?.sector, 40),
    authority: text(item?.authority, 24),
    trusted: item?.trusted === true || [
      'announcement',
      'policy',
      'market',
    ].includes(kind),
  };
}

function marketEvidence(data = {}) {
  const items = [];
  for (const index of data.aIndices || []) {
    const pct = numberOrNull(index?.pct);
    if (!index?.name || pct == null) continue;
    items.push({
      title: `${index.name}${pct >= 0 ? '+' : ''}${pct}%`,
      summary: `指数涨跌幅${pct >= 0 ? '+' : ''}${pct}%`,
      src: '东方财富行情',
      kind: 'market',
      category: 'market',
      categoryLabel: 'A股行情',
    });
  }
  for (const [direction, rows] of [
    ['净流入', data.sectorFlow?.top],
    ['净流出', data.sectorFlow?.bottom],
  ]) {
    for (const sector of (rows || []).slice(0, 4)) {
      const inflow = numberOrNull(sector?.inflowYi);
      const pct = numberOrNull(sector?.pct);
      if (!sector?.name || inflow == null) continue;
      items.push({
        title: `${sector.name}主力${direction}${Math.abs(inflow)}亿元`,
        summary: `${pct == null
          ? '板块涨跌数据缺失'
          : `板块涨跌${pct >= 0 ? '+' : ''}${pct}%`
        }${sector.lead ? `，领涨${sector.lead}` : ''}`,
        src: '东方财富板块资金',
        kind: 'market',
        category: 'industry',
        categoryLabel: '行业资金',
        sector: sector.name,
      });
    }
  }
  const limitUpCount = numberOrNull(data.limitUpCount);
  if (limitUpCount != null) {
    items.push({
      title: `涨停股${limitUpCount}只`,
      summary: '全市场涨停数量，仅用于判断短线情绪。',
      src: '东方财富行情',
      kind: 'market',
      category: 'market',
      categoryLabel: '市场情绪',
    });
  }
  return items;
}

export function buildDailyEvidenceBundle({
  data = {},
  stockNews = [],
  macroNews = [],
  marketFlashes = [],
  sectorNews = [],
  searchResults = [],
  now = Date.now(),
  limit = 40,
} = {}) {
  const candidates = marketEvidence(data);
  for (const item of macroNews || []) {
    candidates.push(normalizedEvidence(item, {
      category: 'macro',
      categoryLabel: '国内宏观',
    }));
  }
  for (const item of marketFlashes || []) {
    candidates.push(normalizedEvidence(item, {
      category: 'global',
      categoryLabel: '重大事件',
    }));
  }
  for (const group of sectorNews || []) {
    const keywords = uniqueStrings([
      ...(group?.keywords || []),
      group?.name,
    ], 12).map((value) => value.toLowerCase());
    for (const item of group?.news || []) {
      const searchable = `${item?.title || ''} ${item?.summary || ''}`
        .toLowerCase();
      if (
        keywords.length
        && !keywords.some((keyword) => searchable.includes(keyword))
      ) continue;
      candidates.push(normalizedEvidence(item, {
        category: 'industry',
        categoryLabel: '行业舆情',
        sector: group.name,
      }));
    }
  }
  for (const stock of stockNews || []) {
    for (const item of stock?.news || []) {
      candidates.push(normalizedEvidence(item, {
        category: 'company',
        categoryLabel: stock.scope === 'holding'
          ? '持仓公告'
          : '重点个股',
        stockCode: stock.code,
        stockName: stock.name,
      }));
    }
  }
  for (const search of searchResults || []) {
    for (const item of search?.result?.items || []) {
      if (!highQualitySearchLead(item)) continue;
      candidates.push(normalizedEvidence(item, {
        category: search.key,
        categoryLabel: search.label,
      }));
    }
  }

  const selected = new Map();
  for (const candidate of candidates.filter(Boolean)) {
    const key = evidenceKey(candidate);
    if (!key) continue;
    const current = selected.get(key);
    if (!current || sourceWeight(candidate) > sourceWeight(current)) {
      selected.set(key, candidate);
    }
  }

  const timestamp = Number(now) || Date.now();
  const scored = [...selected.values()]
    .map((item) => {
      const publishedAt = item.date
        ? Date.parse(`${item.date.slice(0, 10)}T00:00:00Z`)
        : NaN;
      const recency = Number.isFinite(publishedAt)
        ? Math.max(0, 14 - Math.floor((timestamp - publishedAt) / 86400000))
        : 0;
      return { ...item, _score: sourceWeight(item) + recency };
    })
    .sort((left, right) =>
      right._score - left._score
      || String(right.date).localeCompare(String(left.date))
    );
  const boundedLimit = Math.max(1, Math.min(60, Number(limit) || 40));
  const searchReserve = Math.min(
    12,
    scored.filter((item) =>
      ['doubao_search', 'web_search'].includes(item.kind)
    ).length,
  );
  const picked = [
    ...scored
      .filter((item) =>
        !['doubao_search', 'web_search'].includes(item.kind)
      )
      .slice(0, boundedLimit - searchReserve),
    ...scored
      .filter((item) =>
        ['doubao_search', 'web_search'].includes(item.kind)
      )
      .slice(0, searchReserve),
  ].sort((left, right) =>
    right._score - left._score
    || String(right.date).localeCompare(String(left.date))
  );
  const items = picked
    .map(({ _score, ...item }, index) => ({
      id: `E${String(index + 1).padStart(2, '0')}`,
      ...item,
      evidenceLevel: evidenceLevel(item),
    }));

  const byStock = {};
  const bySector = {};
  for (const item of items) {
    if (item.stockCode) {
      byStock[item.stockCode] ||= [];
      byStock[item.stockCode].push(item.id);
    }
    if (item.sector) {
      bySector[item.sector] ||= [];
      bySector[item.sector].push(item.id);
    }
  }
  return {
    schemaVersion: 'daily-evidence.v1',
    generatedAt: timestamp,
    items,
    byStock,
    bySector,
    stats: {
      total: items.length,
      announcements: items.filter((item) =>
        item.kind === 'announcement').length,
      primary: items.filter((item) =>
        item.evidenceLevel === 'primary').length,
      corroborated: items.filter((item) =>
        item.evidenceLevel === 'corroborated').length,
      searchLeads: items.filter((item) =>
        item.evidenceLevel === 'search-lead').length,
    },
  };
}

function generatedCoreComplete(draft) {
  return !!(
    text(draft?.overview)
    && text(draft?.strategy)
    && (
      Array.isArray(draft?.events)
      || Array.isArray(draft?.sectors)
      || Array.isArray(draft?.holdings)
      || Array.isArray(draft?.risks)
    )
  );
}

function collectSourceNumbers(value, target = new Set()) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    target.add(String(value));
  } else if (typeof value === 'string') {
    const cleaned = value
      .replace(/E\d{2}/g, '')
      .replace(/\d{4}-\d{2}-\d{2}/g, '')
      .replace(/^\d{6}$/, '');
    for (const match of cleaned.matchAll(/-?\d+(?:\.\d+)?/g)) {
      target.add(String(Number(match[0])));
    }
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectSourceNumbers(item, target));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) =>
      collectSourceNumbers(item, target)
    );
  }
  return target;
}

export function dailyReportGroundingIssues(draft, source = {}) {
  if (!draft || typeof draft !== 'object') return ['missing-draft'];
  const availableEvidence = new Set(
    (source.evidence || []).map((item) => String(item?.id || '')),
  );
  const raw = JSON.stringify(draft);
  const issues = [];
  for (const id of new Set(raw.match(/E\d{2}/g) || [])) {
    if (!availableEvidence.has(id)) issues.push(`unknown-evidence:${id}`);
  }
  const sourceNumbers = collectSourceNumbers(source);
  const withoutEvidenceIds = raw.replace(/E\d{2}/g, '');
  for (const match of withoutEvidenceIds.matchAll(
    /-?\d+(?:\.\d+)?\s*(?:%|亿元|万元|亿|万|元|点|只|手|成|小时|分钟)/g,
  )) {
    const number = match[0].match(/-?\d+(?:\.\d+)?/)?.[0];
    if (!number || sourceNumbers.has(String(Number(number)))) continue;
    const issue = `unsupported-number:${match[0]
      .replace(/\s+/g, '')
      .replace(/^-/, '')}`;
    if (!issues.includes(issue)) issues.push(issue);
  }
  return issues;
}

export function sanitizeDailyReportDraft(draft, source = {}) {
  const availableEvidence = new Set(
    (source.evidence || []).map((item) => String(item?.id || '')),
  );
  const sourceNumbers = collectSourceNumbers(source);
  const sanitizeString = (value) => String(value || '')
    .replace(/\[?(E\d{2})\]?/g, (match, id) =>
      availableEvidence.has(id) ? match : ''
    )
    .replace(
      /-?\d+(?:\.\d+)?\s*(?:%|亿元|万元|亿|万|元|点|只|手|成|小时|分钟)/g,
      (match) => {
        const number = match.match(/-?\d+(?:\.\d+)?/)?.[0];
        return number && sourceNumbers.has(String(Number(number)))
          ? match
          : '未核验数值';
      },
    )
    .replace(/\s+/g, ' ')
    .trim();
  const visit = (value) => {
    if (typeof value === 'string') return sanitizeString(value);
    if (Array.isArray(value)) {
      return value.map(visit).filter((item) => item !== '');
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, visit(item)]),
      );
    }
    return value;
  };
  return visit(draft);
}

function draftScore(draft) {
  if (!draft || typeof draft !== 'object') return -1;
  return [
    text(draft.overview),
    text(draft.strategy),
    text(draft.overseas),
  ].filter(Boolean).length
    + ['events', 'sectors', 'holdings', 'risks']
      .reduce((sum, key) =>
        sum + Math.min(3, Array.isArray(draft[key]) ? draft[key].length : 0)
      , 0);
}

export async function generateDailyReportDraft(produce, {
  maxAttempts = 2,
  validate,
} = {}) {
  let best = null;
  const diagnostics = [];
  const attempts = Math.max(1, Math.min(2, Number(maxAttempts) || 2));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const candidate = await produce(attempt, best);
      if (draftScore(candidate) > draftScore(best)) best = candidate;
      const validation = typeof validate === 'function'
        ? validate(candidate)
        : generatedCoreComplete(candidate);
      const complete = validation === true || validation?.ok === true;
      diagnostics.push({
        attempt,
        parsed: !!candidate,
        complete,
        issues: Array.isArray(validation?.issues)
          ? validation.issues.slice(0, 12)
          : [],
        fields: candidate && typeof candidate === 'object'
          ? Object.keys(candidate).slice(0, 16)
          : [],
      });
      if (complete) {
        return { draft: candidate, complete: true, attempts: attempt, diagnostics };
      }
    } catch (error) {
      diagnostics.push({
        attempt,
        parsed: false,
        complete: false,
        error: text(error?.message || error, 120),
      });
    }
  }
  return { draft: best, complete: false, attempts, diagnostics };
}

function validEvidenceIds(values, evidence) {
  const available = new Set((evidence?.items || []).map((item) => item.id));
  return uniqueStrings(values, 8).filter((id) => available.has(id));
}

function marketOverview(data, evidence) {
  const indices = (data?.aIndices || [])
    .filter((item) =>
      item?.name && numberOrNull(item.pct) != null)
    .slice(0, 3)
    .map((item) => {
      const pct = numberOrNull(item.pct);
      return `${item.name}${pct >= 0 ? '+' : ''}${pct}%`;
    });
  const inflow = data?.sectorFlow?.top?.[0];
  const outflow = data?.sectorFlow?.bottom?.[0];
  const facts = [];
  if (indices.length) facts.push(indices.join('、'));
  if (inflow?.name && numberOrNull(inflow.inflowYi) != null) {
    facts.push(
      `${inflow.name}主力净流入${numberOrNull(inflow.inflowYi)}亿元`,
    );
  }
  if (outflow?.name && numberOrNull(outflow.inflowYi) != null) {
    facts.push(
      `${outflow.name}主力净流出${Math.abs(numberOrNull(outflow.inflowYi))}亿元`,
    );
  }
  if (numberOrNull(data?.limitUpCount) != null) {
    facts.push(`涨停${numberOrNull(data.limitUpCount)}只`);
  }
  if (!facts.length) {
    return `本轮取得${evidence?.stats?.total || 0}条公开信息，但核心行情数据不足，暂不提高风险敞口。`;
  }
  return `${facts.join('；')}。本轮共核对${evidence?.stats?.total || 0}条公开证据。`;
}

function sessionStrategy(session, data) {
  const leader = data?.sectorFlow?.top?.[0]?.name;
  const laggard = data?.sectorFlow?.bottom?.[0]?.name;
  const focus = leader ? `优先跟踪${leader}的量价确认` : '优先等待主线与量价确认';
  const avoid = laggard ? `，回避${laggard}的弱势反抽` : '';
  if (session === 'noon') {
    return `午后先核验上午资金是否延续，${focus}${avoid}；未形成多源共振前控制新增仓位。`;
  }
  if (session === 'evening') {
    return `下一交易日只执行有公告、行业与资金共同支持的计划，${focus}${avoid}；开盘偏离计划价时不追单。`;
  }
  return `开盘前先核验隔夜事件与竞价反馈，${focus}${avoid}；未通过确认条件时保持现金。`;
}

function fallbackSectors(data, evidence) {
  const rows = [
    ...(data?.sectorFlow?.top || []).slice(0, 4).map((item) => ({
      ...item,
      rating: Number(item.inflowYi) > 0 ? '看多' : '中性',
    })),
    ...(data?.sectorFlow?.bottom || []).slice(0, 3).map((item) => ({
      ...item,
      rating: Number(item.inflowYi) < 0 ? '看空' : '中性',
    })),
  ];
  const seen = new Set();
  const sectors = rows.filter((item) => {
    const name = text(item?.name, 40);
    if (!name || seen.has(name)) return false;
    seen.add(name);
    return true;
  }).map((item) => ({
    name: text(item.name, 40),
    rating: item.rating,
    view: `主力${numberOrNull(item.inflowYi) >= 0 ? '净流入' : '净流出'}${Math.abs(numberOrNull(item.inflowYi))}亿元，${numberOrNull(item.pct) == null ? '板块涨跌数据缺失' : `板块涨跌${numberOrNull(item.pct) >= 0 ? '+' : ''}${numberOrNull(item.pct)}%`}。`,
    strategy: numberOrNull(item.inflowYi) > 0
      ? '观察资金延续与龙头扩散，确认后再行动。'
      : '等待资金止流出与价格企稳，不抢反弹。',
    risk: '单日资金仅作线索，需结合后续成交与公告复核。',
    evidenceIds: validEvidenceIds(evidence?.bySector?.[item.name], evidence),
  }));
  const byId = new Map(
    (evidence?.items || []).map((item) => [item.id, item]),
  );
  for (const [name, rawIds] of Object.entries(evidence?.bySector || {})) {
    if (seen.has(name) || sectors.length >= 10) continue;
    const evidenceIds = validEvidenceIds(rawIds, evidence);
    const items = evidenceIds.map((id) => byId.get(id)).filter(Boolean);
    if (!items.length) continue;
    seen.add(name);
    sectors.push({
      name,
      rating: '中性',
      view: items.slice(0, 2).map((item) => item.title).join('；'),
      strategy: '等待行业信息与实时资金形成交叉确认。',
      risk: '当前只有信息线索，不能单独推动交易。',
      evidenceIds,
    });
  }
  return sectors;
}

function fallbackHoldings(focusStocks, evidence) {
  const byId = new Map((evidence?.items || []).map((item) => [item.id, item]));
  return (focusStocks || []).map((stock) => {
    const evidenceIds = validEvidenceIds(
      evidence?.byStock?.[String(stock.code)] || [],
      evidence,
    );
    const items = evidenceIds.map((id) => byId.get(id)).filter(Boolean);
    return {
      code: text(stock.code, 12),
      name: text(stock.name || stock.code, 40),
      scope: stock.scope === 'watchlist' ? 'watchlist' : 'holding',
      info: items.length
        ? items.slice(0, 2).map((item) =>
            `${item.src}${item.date ? ` ${item.date}` : ''}：${item.title}`
          ).join('；')
        : '本轮未检索到新的公司公告或重要新闻。',
      impact: items.length
        ? '先核对公告原文，再结合价格、资金和量化信号判断影响。'
        : '信息不足，不因缺少消息单独改变原计划。',
      evidenceIds,
    };
  });
}

function balancedEventEvidence(items, limit = 8) {
  const source = (items || []).filter((item) => item.kind !== 'market');
  const groups = ['company', 'industry', 'macro', 'global']
    .map((category) => source.filter((item) => item.category === category));
  const picked = [];
  const seen = new Set();
  let offset = 0;
  while (
    picked.length < limit
    && groups.some((group) => offset < group.length)
  ) {
    for (const group of groups) {
      const item = group[offset];
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      picked.push(item);
      if (picked.length >= limit) break;
    }
    offset++;
  }
  for (const item of source) {
    if (picked.length >= limit) break;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    picked.push(item);
  }
  return picked;
}

function normalizedRows(rows, evidence, limit, fields) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      if (!row || typeof row !== 'object') return null;
      const normalized = {};
      for (const [field, max] of Object.entries(fields)) {
        normalized[field] = text(row[field], max);
      }
      normalized.evidenceIds = validEvidenceIds(row.evidenceIds, evidence);
      return Object.values(normalized).some(Boolean) ? normalized : null;
    })
    .filter(Boolean)
    .slice(0, limit);
}

export function composeDailyReport({
  day = '',
  session = 'morning',
  sessionCn = SESSION_LABELS[session] || SESSION_LABELS.morning,
  data = {},
  evidence = { items: [], stats: {}, byStock: {}, bySector: {} },
  focusStocks = [],
  draft = null,
  generation = {},
} = {}) {
  const generatedComplete = generatedCoreComplete(draft);
  const generatedEvents = normalizedRows(draft?.events, evidence, 8, {
    title: 160,
    category: 24,
    impact: 240,
  });
  const generatedHoldings = normalizedRows(draft?.holdings, evidence, 12, {
    code: 12,
    name: 40,
    scope: 20,
    info: 280,
    impact: 240,
  });
  const generatedSectors = normalizedRows(draft?.sectors, evidence, 10, {
    name: 40,
    rating: 16,
    view: 240,
    strategy: 180,
    risk: 180,
  });
  const fallbackFocus = fallbackHoldings(focusStocks, evidence);
  const holdingByCode = new Map(
    generatedHoldings.map((item) => [String(item.code), item]),
  );
  const holdings = fallbackFocus.map((fallback) => {
    const generated = holdingByCode.get(String(fallback.code));
    if (!generated) return fallback;
    return {
      ...fallback,
      ...generated,
      code: fallback.code,
      name: generated.name || fallback.name,
      scope: fallback.scope,
      evidenceIds: generated.evidenceIds.length
        ? generated.evidenceIds
        : fallback.evidenceIds,
    };
  });
  const fallbackEvents = balancedEventEvidence(evidence.items, 8)
    .map((item) => ({
      title: item.title,
      category: item.categoryLabel,
      impact: item.summary || '作为待核验证据，需结合行情与资金判断影响。',
      evidenceIds: [item.id],
    }));
  const report = {
    overview: text(draft?.overview, 700) || marketOverview(data, evidence),
    overseas: text(draft?.overseas, 420),
    events: generatedEvents.length ? generatedEvents : fallbackEvents,
    holdings,
    sectors: generatedSectors.length
      ? generatedSectors
      : fallbackSectors(data, evidence),
    strategy: text(draft?.strategy, 700) || sessionStrategy(session, data),
    risks: uniqueStrings(draft?.risks, 6).length
      ? uniqueStrings(draft.risks, 6)
      : [
          '搜索摘要仅用于发现线索，关键结论必须回看公告原文。',
          '盘前与盘后数据不能冒充盘中实时成交。',
        ],
  };
  return {
    schemaVersion: DAILY_REPORT_SCHEMA_VERSION,
    day,
    session,
    sessionCn,
    report,
    evidence,
    degraded: generation.complete === false || !generatedComplete,
    generation: {
      attempts: Number(generation.attempts) || 0,
      complete: generatedComplete,
      diagnostics: Array.isArray(generation.diagnostics)
        ? generation.diagnostics
        : [],
    },
  };
}

export function isValuableDailyReport(result) {
  const report = result?.report;
  return !!(
    text(report?.overview)
    && text(report?.strategy)
    && Number(result?.evidence?.stats?.total) > 0
    && (
      report?.events?.length
      || report?.holdings?.length
      || report?.sectors?.length
    )
  );
}
