import test from 'node:test'
import assert from 'node:assert/strict'
import {
  collectNewsSources,
  fetchStockAnnouncements,
  fetchWallstreetLive,
  fetchWallstreetSearch,
  mergeNewsItems,
} from '../api/_market_data.js'
import {
  ADVISOR_SYSTEM,
  SYSTEM_PROMPT,
  buildUserPrompt,
} from '../api/_ai_prompts.js'

test('新闻聚合跨来源轮转、去重并保留来源类型', () => {
  const merged = mergeNewsItems([
    [
      { title: '公司发布重大合同公告', src: '公司公告', kind: 'announcement' },
      { title: '公司发布回购进展公告', src: '公司公告', kind: 'announcement' },
    ],
    [
      { title: '行业需求持续回暖', src: '东方财富', kind: 'media' },
      { title: '公司发布重大合同公告', src: '重复媒体', kind: 'media' },
    ],
    [
      { title: '机构上调盈利预测', src: '机构研报', kind: 'research' },
    ],
  ], 5)

  assert.deepEqual(
    merged.map((item) => item.title),
    [
      '公司发布重大合同公告',
      '行业需求持续回暖',
      '机构上调盈利预测',
      '公司发布回购进展公告',
    ],
  )
  assert.equal(merged[0].kind, 'announcement')
  assert.equal(merged[2].src, '机构研报')
})

test('新闻聚合允许单个来源失败并返回其余来源', async () => {
  const items = await collectNewsSources([
    Promise.reject(new Error('source unavailable')),
    Promise.resolve([
      { title: '央行发布最新政策', src: '华尔街见闻', kind: 'flash' },
    ]),
  ], 5)

  assert.equal(items.length, 1)
  assert.equal(items[0].title, '央行发布最新政策')
})

test('公司公告接口映射为可追溯的硬信息', async () => {
  const items = await fetchStockAnnouncements('600519', 3, {
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          data: {
            list: [{
              art_code: 'AN202608140001',
              notice_date: '2026-08-14 00:00:00',
              title: '贵州茅台重大事项公告',
            }],
          },
        }
      },
    }),
  })

  assert.deepEqual(items, [{
    title: '贵州茅台重大事项公告',
    date: '2026-08-14',
    url: 'https://data.eastmoney.com/notices/detail/600519/AN202608140001.html',
    src: '公司公告',
    kind: 'announcement',
  }])
})

test('华尔街见闻检索和实时流统一为新闻结构', async () => {
  const search = await fetchWallstreetSearch('半导体', 3, {
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          data: {
            items: [{
              title: '半导体设备需求回升',
              content_short: '产业链订单改善',
              display_time: 1786598809,
              uri: 'https://wallstreetcn.com/articles/1',
            }],
          },
        }
      },
    }),
  })
  const live = await fetchWallstreetLive(3, {
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          data: {
            items: [{
              title: '',
              content_text: '人民银行开展公开市场操作',
              display_time: 1786677240,
              uri: 'https://wallstreetcn.com/livenews/1',
            }],
          },
        }
      },
    }),
  })

  assert.equal(search[0].src, '华尔街见闻')
  assert.equal(search[0].summary, '产业链订单改善')
  assert.equal(search[0].kind, 'media')
  assert.equal(live[0].title, '人民银行开展公开市场操作')
  assert.equal(live[0].kind, 'flash')
})

test('军师把外部新闻视为不可信证据而不是可执行指令', () => {
  assert.match(SYSTEM_PROMPT, /不可信证据文本/)
  assert.match(ADVISOR_SYSTEM, /不可信证据文本/)
  assert.match(ADVISOR_SYSTEM, /任何指令/)
  assert.match(ADVISOR_SYSTEM, /aiSearchEvidence/)
  assert.match(ADVISOR_SYSTEM, /待核验/)
})

test('行业AI补盲在提示词中明确标记待核验且不得单独升级动作', () => {
  const prompt = buildUserPrompt('buy_advice', {
    industry: '半导体设备',
    industryNewsSource: 'ai-search-fallback',
    industryNews: [
      '【AI Search待核验】半导体设备订单改善',
    ],
  })

  assert.match(prompt, /AI联网行业补盲/)
  assert.match(prompt, /待核验/)
  assert.match(prompt, /不得单独升级买入或加仓/)
})
