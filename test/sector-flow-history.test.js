import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSectorFlowView,
  formatSectorFlowTooltip,
  parseSectorFlowRows,
  selectLongestKlines,
} from '../shared/sectorFlowHistory.js'

const rows = [
  '2026-08-11,-50575344,77003968,-32626048,-29586352,-20988992,-1.61,2.45,-1.04,-0.94,-0.67,4159.35,-0.55,0,0',
  '2026-08-12,132748337,-12466672,-55610560,49340784,83407553,4.26,-0.40,-1.78,1.58,2.67,4254.60,2.29,0,0',
  '2026-08-13,-54453163,30651904,22223536,-47460416,-6992747,-1.48,0.83,0.60,-1.29,-0.19,4227.26,-0.64,0,0',
  '2026-08-14,177760420,-177193104,-4533072,94983520,82776900,4.66,-4.65,-0.12,2.49,2.17,4216.56,-0.25,0,0',
]

test('板块历史优先采用样本更多的历史集群响应', () => {
  const live = { data: { klines: [rows.at(-1)] } }
  const history = { data: { klines: rows } }

  assert.deepEqual(selectLongestKlines([live, history]), rows)
})

test('板块资金行保留净占比、净额和板块涨跌字段', () => {
  const series = parseSectorFlowRows(rows, 3)

  assert.deepEqual(series, [
    { date: '2026-08-12', mainInflow: 132748337, mainRatio: 4.26, close: 4254.6, pct: 2.29 },
    { date: '2026-08-13', mainInflow: -54453163, mainRatio: -1.48, close: 4227.26, pct: -0.64 },
    { date: '2026-08-14', mainInflow: 177760420, mainRatio: 4.66, close: 4216.56, pct: -0.25 },
  ])
})

test('资金强度视图给出连续性、五日净额和价资关系', () => {
  const view = buildSectorFlowView(parseSectorFlowRows(rows, 10))

  assert.equal(view.sampleDays, 4)
  assert.equal(view.inflowDays, 2)
  assert.equal(view.streak, 1)
  assert.equal(view.fiveDayNetYi, 2.05)
  assert.equal(view.relation, '逆势承接')
  assert.deepEqual(view.ratios, [-1.61, 4.26, -1.48, 4.66])
  assert.deepEqual(view.pcts, [-0.55, 2.29, -0.64, -0.25])
})

test('缺失的板块涨跌字段保留为空，不伪装成零涨跌', () => {
  const partial = parseSectorFlowRows([
    '2026-08-14,177760420,-177193104,-4533072,94983520,82776900,4.66,-4.65,-0.12,2.49,2.17',
  ])
  const view = buildSectorFlowView(partial)

  assert.equal(partial[0].pct, null)
  assert.deepEqual(view.pcts, [null])
  assert.equal(view.relation, '方向分化')
})

test('缺失的主力净额不参与五日累计，也不伪装成零净额', () => {
  const partial = parseSectorFlowRows([
    '2026-08-14,-,-177193104,-4533072,94983520,82776900,4.66,-4.65,-0.12,2.49,2.17,4216.56,-0.25,0,0',
  ])

  assert.equal(partial[0].mainInflow, null)
  assert.equal(buildSectorFlowView(partial).fiveDayNetYi, null)
})

test('tooltip 从图表对象中读取数值，不输出 object Object', () => {
  const text = formatSectorFlowTooltip([{
    axisValue: '08-14',
    data: {
      value: 4.66,
      mainInflow: 177760420,
      pct: -0.25,
    },
  }])

  assert.match(text, /主力净占比: \+4\.66%/)
  assert.match(text, /主力净额: \+1\.78亿/)
  assert.match(text, /板块涨跌: -0\.25%/)
  assert.doesNotMatch(text, /\[object Object\]/)
})
