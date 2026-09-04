import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  collectPreCatalystSnapshot,
  fetchCninfoAnnouncements,
} from '../api/_pre_catalyst_data.js'
import {
  createPreCatalystStore,
  PRE_CATALYST_PREFIX,
} from '../api/_pre_catalyst_store.js'
import {
  runPreCatalystScan,
} from '../api/pre_catalyst.js'

const now = Date.parse('2026-09-04T19:00:00+08:00')
const routeSource = readFileSync(
  new URL('../api/pre_catalyst.js', import.meta.url),
  'utf8',
)

function candles(base = 10) {
  return Array.from({ length: 24 }, (_, index) => ({
    date: `2026-08-${String(index + 7).padStart(2, '0')}`,
    open: base - 0.2 + index * 0.005,
    high: base + 0.1 + index * 0.005,
    low: base - 0.3 + index * 0.005,
    close: base - 0.1 + index * 0.005,
  }))
}

test('巨潮公告采集按页读取并过滤非法外部字段', async () => {
  const calls = []
  const rows = await fetchCninfoAnnouncements({
    now,
    pageSize: 2,
    pageLimit: 3,
    fetchImpl: async (_url, options) => {
      const params = new URLSearchParams(options.body)
      calls.push(Number(params.get('pageNum')))
      const page = Number(params.get('pageNum'))
      return {
        ok: true,
        json: async () => ({
          totalAnnouncement: 3,
          announcements: page === 1
            ? [{
                announcementId: '1225000001',
                secCode: '300001',
                secName: '测试科技',
                announcementTitle: '关于签订重大合同的公告',
                announcementTime: now - 1000,
                adjunctUrl:
                  'finalpage/2026-09-04/1225000001.PDF',
              }, {
                announcementId: 'bad',
                secCode: '<script>',
                announcementTitle: '<script>alert(1)</script>',
                announcementTime: now,
                adjunctUrl: 'https://evil.example/a.pdf',
              }]
            : [{
                announcementId: '1225000002',
                secCode: '300002',
                secName: '例行股份',
                announcementTitle: '第六届董事会第十次会议决议公告',
                announcementTime: now - 2000,
                adjunctUrl:
                  'finalpage/2026-09-04/1225000002.PDF',
              }],
        }),
      }
    },
  })

  assert.deepEqual(calls, [1, 2])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].sourceAuthority, 'OFFICIAL')
  assert.ok(rows.every((item) =>
    item.sourceUrl.startsWith('https://static.cninfo.com.cn/'),
  ))
})

test('预催化扫描从公告主体扩展到同题材低拥挤股票', async () => {
  const universe = [
    {
      code: '300001',
      name: '测试科技',
      price: 10,
      pct: 0.5,
      amount: 180_000_000,
      turnover: 2,
      volumeRatio: 1.1,
      mainInflow: 12_000_000,
      mainRatio: 3,
      tradeDate: '2026-09-04',
    },
    {
      code: '300003',
      name: '关联设备',
      price: 15,
      pct: 0.2,
      amount: 120_000_000,
      turnover: 1.8,
      volumeRatio: 1.05,
      mainInflow: 5_000_000,
      mainRatio: 1.5,
      tradeDate: '2026-09-04',
    },
    {
      code: '300004',
      name: '热门跟风',
      price: 20,
      pct: 9.5,
      amount: 1_200_000_000,
      turnover: 19,
      volumeRatio: 4,
      mainInflow: 80_000_000,
      mainRatio: 10,
      tradeDate: '2026-09-04',
    },
  ]
  const snapshot = await collectPreCatalystSnapshot({
    now,
    fetchAnnouncements: async () => [{
      announcementId: '1225000001',
      secCode: '300001',
      secName: '测试科技',
      announcementTitle: '关于签订重大销售合同的公告',
      announcementTime: now - 60_000,
      adjunctUrl: 'finalpage/2026-09-04/1225000001.PDF',
    }, {
      announcementId: '1225000002',
      secCode: '300002',
      secName: '例行股份',
      announcementTitle: '第六届董事会第十次会议决议公告',
      announcementTime: now - 120_000,
      adjunctUrl: 'finalpage/2026-09-04/1225000002.PDF',
    }],
    fetchUniverse: async () => ({
      total: universe.length,
      inspectedCount: universe.length,
      allList: universe,
      list: [universe[0]],
    }),
    fetchTags: async (code) => code === '300001'
      ? {
          industry: '专用设备',
          concepts: ['工业自动化'],
          conceptBoards: [{
            code: 'BK1001',
            name: '工业自动化',
            rank: 1,
          }],
        }
      : {
          industry: '专用设备',
          concepts: ['工业自动化'],
          conceptBoards: [],
        },
    fetchSectorMembers: async () => [
      universe[0],
      universe[1],
      universe[2],
    ],
    fetchKline: async (code) => ({
      candles: candles(code === '300003' ? 15 : 10),
    }),
    readRelations: async () => ({ edges: [] }),
  })

  assert.equal(snapshot.schemaVersion, 'pre-catalyst.v1')
  assert.equal(snapshot.counts.announcements, 2)
  assert.equal(snapshot.counts.relevantEvents, 1)
  assert.deepEqual(
    snapshot.candidates.map((item) => item.code).sort(),
    ['300001', '300003'],
  )
  assert.ok(snapshot.candidates.every((item) =>
    item.state === 'WAIT_TRIGGER'
    && item.forecast.state === 'CALIBRATING',
  ))
  assert.equal(
    snapshot.candidates.find((item) => item.code === '300003')
      .relation.type,
    'CONCEPT_PEER',
  )
})

test('机构调研只有近期频次显著异常时才进入事件候选', async () => {
  const quote = {
    code: '300010',
    name: '调研科技',
    price: 10,
    pct: 0.3,
    amount: 100_000_000,
    turnover: 1.8,
    volumeRatio: 1.1,
    mainInflow: 4_000_000,
    mainRatio: 1.2,
    tradeDate: '2026-09-04',
  }
  const visit = (id, daysAgo) => ({
    announcementId: id,
    secCode: quote.code,
    secName: quote.name,
    announcementTitle: '投资者关系活动记录表',
    announcementTime: now - daysAgo * 86400000,
    adjunctUrl: `finalpage/2026-09-04/${id}.PDF`,
  })
  const snapshot = await collectPreCatalystSnapshot({
    now,
    fetchAnnouncements: async () => [],
    fetchInstitutionVisits: async () => [
      visit('1225000010', 2),
      visit('1225000011', 7),
      visit('1225000012', 55),
    ],
    fetchUniverse: async () => ({
      total: 1,
      inspectedCount: 1,
      list: [quote],
    }),
    fetchTags: async () => ({
      industry: '软件开发',
      concepts: [],
      conceptBoards: [],
    }),
    fetchSectorMembers: async () => [],
    fetchKline: async () => ({ candles: candles(10) }),
    readRelations: async () => ({ edges: [] }),
  })

  assert.equal(snapshot.counts.institutionalSignals, 1)
  assert.equal(snapshot.counts.relevantEvents, 1)
  assert.equal(
    snapshot.candidates[0].event.eventType,
    'INSTITUTION_VISIT',
  )
})

test('联网新闻只保存待核验线索且不能直接生成候选', async () => {
  const quote = {
    code: '300020',
    name: '线索股份',
    price: 12,
    pct: 0.1,
    amount: 80_000_000,
    turnover: 1.5,
    volumeRatio: 1,
    mainInflow: 0,
    mainRatio: 0,
    tradeDate: '2026-09-04',
  }
  const snapshot = await collectPreCatalystSnapshot({
    now,
    fetchAnnouncements: async () => [],
    fetchInstitutionVisits: async () => [],
    fetchDiscoverySearch: async () => ({
      enabled: true,
      items: [{
        title: '线索股份获得重要订单',
        summary: '市场消息称公司可能获得订单',
        url: 'https://news.example.com/a',
        src: '联网检索',
        date: '2026-09-04',
      }],
    }),
    fetchUniverse: async () => ({
      total: 1,
      inspectedCount: 1,
      list: [quote],
    }),
    readRelations: async () => ({ edges: [] }),
  })

  assert.equal(snapshot.leads.length, 1)
  assert.equal(snapshot.leads[0].verified, false)
  assert.equal(
    snapshot.leads[0].status,
    'PENDING_OFFICIAL_CONFIRMATION',
  )
  assert.equal(snapshot.candidates.length, 0)
})

test('预催化快照在OSS保存最新版本和不可变运行记录', async () => {
  const objects = new Map()
  const storage = {
    hasStorage: () => true,
    put: async (path, body) => {
      objects.set(path, String(body))
      return { pathname: path }
    },
    readJson: async (path) => {
      const raw = objects.get(path)
      return raw ? JSON.parse(raw) : null
    },
    list: async ({ prefix }) => ({
      blobs: [...objects.keys()]
        .filter((path) => path.startsWith(prefix))
        .map((pathname) => ({ pathname })),
    }),
  }
  const store = createPreCatalystStore(storage)
  const snapshot = {
    schemaVersion: 'pre-catalyst.v1',
    tradeDate: '2026-09-04',
    generatedAt: now,
    candidates: [],
  }

  await store.saveSnapshot(snapshot)

  assert.deepEqual(await store.readLatest(), snapshot)
  assert.ok(objects.has(`${PRE_CATALYST_PREFIX}latest.json`))
  assert.ok(
    [...objects.keys()].some((path) =>
      path.startsWith(`${PRE_CATALYST_PREFIX}runs/2026-09-04/`),
    ),
  )
})

test('预催化扫描先写运行态并在完成后发布快照', async () => {
  const progress = []
  let saved = null
  let released = false
  const snapshot = {
    schemaVersion: 'pre-catalyst.v1',
    tradeDate: '2026-09-04',
    generatedAt: now,
    candidates: [{ code: '300001' }],
  }
  const result = await runPreCatalystScan({
    now: () => now,
    store: {
      readLatest: async () => null,
      readEvaluation: async () => null,
      readRelations: async () => ({ edges: [] }),
      claimRun: async () => ({
        acquired: true,
        owner: 'owner-1',
      }),
      releaseRun: async () => { released = true },
      saveProgress: async (value) => { progress.push(value) },
      saveSnapshot: async (value) => { saved = value },
    },
    collect: async ({ previous, readRelations }) => {
      assert.equal(previous, null)
      assert.deepEqual(await readRelations(), { edges: [] })
      return snapshot
    },
  })

  assert.equal(result.ok, true)
  assert.equal(saved, snapshot)
  assert.equal(progress[0].status, 'RUNNING')
  assert.equal(progress.at(-1).status, 'DONE')
  assert.equal(released, true)
})

test('预催化接口区分账号请求和内部定时鉴权', () => {
  assert.match(routeSource, /authenticateAccountRequest/)
  assert.match(routeSource, /authorizePaidRequest/)
  assert.match(routeSource, /process\.env\.CRON_KEY/)
  assert.match(routeSource, /errorCode: 'PRE_CATALYST_SOURCE_UNAVAILABLE'/)
  assert.doesNotMatch(routeSource, /apiKey/)
})
