import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeSearxngResults,
  searxngSearchEnabled,
} from '../api/_searxng_search.js'

test('SearXNG 默认关闭，仅显式配置 HTTPS 自托管地址时启用', () => {
  assert.equal(searxngSearchEnabled({}), false)
  assert.equal(searxngSearchEnabled({
    SEARXNG_ENABLED: 'true',
    SEARXNG_BASE_URL: 'http://127.0.0.1:8080',
  }), false)
  assert.equal(searxngSearchEnabled({
    SEARXNG_ENABLED: 'true',
    SEARXNG_BASE_URL: 'https://search.example.com',
  }), true)
})

test('SearXNG 只保留可核验财经来源并保留来源时间', () => {
  const result = normalizeSearxngResults({
    results: [
      {
        title: '主管部门发布资本市场政策',
        url: 'https://www.csrc.gov.cn/csrc/c100028/test.shtml',
        content: '政策原文摘要。',
        publishedDate: '2026-08-24T01:02:03Z',
        engine: 'bing news',
      },
      {
        title: '市场传言某板块将暴涨',
        url: 'https://random-blog.example/post',
        content: '无法核验。',
        publishedDate: '2026-08-24',
        engine: 'google',
      },
    ],
  }, { limit: 8 })

  assert.equal(result.length, 1)
  assert.equal(result[0].src, '证监会')
  assert.equal(result[0].kind, 'web_search')
  assert.equal(result[0].publishedAt, '2026-08-24T01:02:03.000Z')
  assert.equal(result[0].authority, 'very_high')
})
