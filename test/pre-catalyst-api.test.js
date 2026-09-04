import test from 'node:test'
import assert from 'node:assert/strict'

import {
  collectPreCatalystSnapshot,
  fetchCninfoAnnouncements,
} from '../api/_pre_catalyst_data.js'
import {
  createPreCatalystStore,
  PRE_CATALYST_PREFIX,
} from '../api/_pre_catalyst_store.js'

const now = Date.parse('2026-09-04T19:00:00+08:00')

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
      list: universe,
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
