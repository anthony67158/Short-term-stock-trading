import { assertSafeRemoteUrl } from './_safe_remote_url.js'

const TRUSTED_SOURCES = Object.freeze([
  { host: 'pbc.gov.cn', source: '中国人民银行', authority: 'very_high' },
  { host: 'csrc.gov.cn', source: '证监会', authority: 'very_high' },
  { host: 'sse.com.cn', source: '上海证券交易所', authority: 'very_high' },
  { host: 'szse.cn', source: '深圳证券交易所', authority: 'very_high' },
  { host: 'cninfo.com.cn', source: '巨潮资讯', authority: 'very_high' },
  { host: 'gov.cn', source: '中国政府网', authority: 'very_high' },
  { host: 'eastmoney.com', source: '东方财富', authority: 'high' },
  { host: 'cls.cn', source: '财联社', authority: 'high' },
  { host: 'stcn.com', source: '证券时报', authority: 'high' },
  { host: 'cnstock.com', source: '中国证券网', authority: 'high' },
  { host: 'wallstreetcn.com', source: '华尔街见闻', authority: 'high' },
  { host: '10jqka.com.cn', source: '同花顺', authority: 'high' },
  { host: 'reuters.com', source: 'Reuters', authority: 'high' },
  { host: 'bloomberg.com', source: 'Bloomberg', authority: 'high' },
  { host: 'investing.com', source: 'Investing.com', authority: 'high' },
  { host: 'sina.com.cn', source: '新浪财经', authority: 'high' },
])

function cleanText(value, limit = 320) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

function safeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ''))
    return ['http:', 'https:'].includes(parsed.protocol)
      ? parsed.toString()
      : ''
  } catch {
    return ''
  }
}

function trustedSource(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return TRUSTED_SOURCES.find(({ host }) =>
      hostname === host || hostname.endsWith(`.${host}`)
    ) || null
  } catch {
    return null
  }
}

function publishedAt(item) {
  const raw = item?.publishedAt
    || item?.publishedDate
    || item?.published_date
    || item?.date
  if (!raw) return ''
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime())
    ? cleanText(raw, 32)
    : parsed.toISOString()
}

export function searxngSearchEnabled(env = process.env) {
  const enabled = String(env.SEARXNG_ENABLED || '').toLowerCase() === 'true'
  const baseUrl = String(env.SEARXNG_BASE_URL || '').trim()
  return enabled && /^https:\/\/[^/?#]+/i.test(baseUrl)
}

export function normalizeSearxngResults(payload, {
  limit = 8,
} = {}) {
  const seen = new Set()
  const items = []
  for (const item of payload?.results || []) {
    const url = safeHttpUrl(item?.url)
    const source = trustedSource(url)
    const title = cleanText(item?.title, 180)
    if (!source || !title) continue
    const key = title.toLowerCase()
      .replace(/[\s，。、“”‘’：:；;！!？?（）()《》【】\-_]/g, '')
      .slice(0, 100)
    if (!key || seen.has(key)) continue
    seen.add(key)
    items.push({
      title,
      summary: cleanText(item?.content || item?.summary, 360),
      date: publishedAt(item).slice(0, 10),
      publishedAt: publishedAt(item),
      url,
      src: source.source,
      kind: 'web_search',
      authority: source.authority,
      trusted: false,
      searchEngine: cleanText(
        item?.engine || item?.engines?.join(','),
        60,
      ),
    })
    if (items.length >= Math.max(1, Math.min(12, Number(limit) || 8))) break
  }
  return items
}

export async function fetchSearxngNews(query, {
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 7000,
  limit = 8,
  validateUrl = assertSafeRemoteUrl,
} = {}) {
  if (!searxngSearchEnabled(env)) {
    return {
      provider: 'searxng',
      status: 'disabled',
      items: [],
    }
  }
  try {
    const baseUrl = await validateUrl(env.SEARXNG_BASE_URL)
    const url = new URL(`${baseUrl}/search`)
    url.search = new URLSearchParams({
      q: cleanText(query, 180),
      format: 'json',
      categories: 'news',
      language: 'zh-CN',
      safesearch: '1',
      time_range: 'month',
    }).toString()
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, {
        signal: ctrl.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'stock-dashboard-daily-report/1.0',
        },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      return {
        provider: 'searxng',
        status: 'ok',
        fetchedAt: new Date().toISOString(),
        items: normalizeSearxngResults(payload, { limit }),
      }
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    return {
      provider: 'searxng',
      status: 'unavailable',
      error: cleanText(error?.message || error, 120),
      items: [],
    }
  }
}
