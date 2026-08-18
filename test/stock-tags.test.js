import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildStockTagProfile,
  normalizeStockConceptName,
} from '../shared/stockTags.js'
import {
  stockTagProfileFromCoreConception,
  stockTagProfileFromEastmoney,
  stockTagProfileFromSources,
} from '../api/stock_tags.js'

test('细分题材优先于泛化概念并同时保留真实行业', () => {
  const profile = buildStockTagProfile({
    code: '300476',
    name: '胜宏科技',
    industry: '元件',
    concepts: '物联网,特斯拉概念,5G概念,小米概念,PCB,新能源车,机器人概念,英伟达概念',
  })

  assert.equal(profile.primaryTopic, 'PCB')
  assert.deepEqual(profile.displayTags, [
    { name: 'PCB', kind: 'concept' },
    { name: '元件', kind: 'industry' },
  ])
  assert.ok(profile.concepts.includes('英伟达概念'))
})

test('CPO与MLCC概念名称压缩为卡片可扫读标签', () => {
  assert.equal(normalizeStockConceptName('CPO概念'), 'CPO')
  assert.equal(normalizeStockConceptName('MLCC'), 'MLCC')

  const cpo = buildStockTagProfile({
    code: '600487',
    industry: '通信设备',
    concepts: '物联网,5G概念,F5G概念,机器人概念,CPO概念,光通信模块,液冷概念',
  })
  const mlcc = buildStockTagProfile({
    code: '300408',
    industry: '元件',
    concepts: '新材料,智能穿戴,5G概念,MLCC,被动元件概念',
  })

  assert.equal(cpo.primaryTopic, 'CPO')
  assert.equal(mlcc.primaryTopic, 'MLCC')
})

test('无有效概念时只回退行业且不伪造题材', () => {
  const profile = buildStockTagProfile({
    code: '600000',
    industry: '化学制药',
    concepts: '-',
  })

  assert.equal(profile.primaryTopic, null)
  assert.deepEqual(profile.concepts, [])
  assert.deepEqual(profile.displayTags, [
    { name: '化学制药', kind: 'industry' },
  ])
})

test('个股详情字段只按东方财富真实口径映射行业和概念', () => {
  const profile = stockTagProfileFromEastmoney({
    f57: '600487',
    f58: '亨通光电',
    f127: '通信设备',
    f129: '物联网,5G概念,CPO概念,光通信模块',
  }, '600487')

  assert.equal(profile.code, '600487')
  assert.equal(profile.industry, '通信设备')
  assert.equal(profile.primaryTopic, 'CPO')
  assert.equal(profile.source, '东方财富个股资料')
})

test('F10核心题材只用精确概念且行业回退到行业层级而非风格板块', () => {
  const profile = stockTagProfileFromCoreConception({
    ssbk: [
      { SECURITY_CODE: '300476', SECURITY_NAME_ABBR: '胜宏科技', BOARD_NAME: '电子', IS_PRECISE: null, BOARD_RANK: 1 },
      { SECURITY_CODE: '300476', SECURITY_NAME_ABBR: '胜宏科技', BOARD_NAME: '元件', IS_PRECISE: null, BOARD_RANK: 2 },
      { SECURITY_CODE: '300476', SECURITY_NAME_ABBR: '胜宏科技', BOARD_NAME: '印制电路板', IS_PRECISE: null, BOARD_RANK: 3 },
      { SECURITY_CODE: '300476', SECURITY_NAME_ABBR: '胜宏科技', BOARD_NAME: '广东板块', IS_PRECISE: '0', BOARD_RANK: 4 },
      { SECURITY_CODE: '300476', SECURITY_NAME_ABBR: '胜宏科技', BOARD_NAME: '沪股通', IS_PRECISE: '0', BOARD_RANK: 8 },
      { SECURITY_CODE: '300476', SECURITY_NAME_ABBR: '胜宏科技', BOARD_NAME: 'PCB', BOARD_CODE: '877', IS_PRECISE: '1', BOARD_RANK: 27 },
    ],
  }, '300476')

  assert.equal(profile.industry, '元件')
  assert.deepEqual(profile.concepts, ['PCB'])
  assert.deepEqual(profile.conceptBoards, [
    { code: 'BK0877', name: 'PCB', rank: 27 },
  ])
  assert.equal(profile.conceptVerified, true)
  assert.equal(profile.primaryTopic, 'PCB')
  assert.equal(profile.source, '东方财富F10核心题材')
})

test('个股资料行业覆盖F10风格标签且保留F10核心题材', () => {
  const profile = stockTagProfileFromSources({
    f57: '603859',
    f58: '能科科技',
    f127: 'IT服务Ⅱ',
    f129: '军工,商业航天,AI应用',
  }, {
    ssbk: [
      { SECURITY_CODE: '603859', SECURITY_NAME_ABBR: '能科科技', BOARD_NAME: '计算机', IS_PRECISE: null, BOARD_RANK: 1 },
      { SECURITY_CODE: '603859', SECURITY_NAME_ABBR: '能科科技', BOARD_NAME: 'IT服务Ⅱ', IS_PRECISE: null, BOARD_RANK: 2 },
      { SECURITY_CODE: '603859', SECURITY_NAME_ABBR: '能科科技', BOARD_NAME: 'IT服务Ⅲ', IS_PRECISE: null, BOARD_RANK: 3 },
      { SECURITY_CODE: '603859', SECURITY_NAME_ABBR: '能科科技', BOARD_NAME: '沪股通', IS_PRECISE: '0', BOARD_RANK: 6 },
      { SECURITY_CODE: '603859', SECURITY_NAME_ABBR: '能科科技', BOARD_NAME: '商业航天', BOARD_CODE: '1099', IS_PRECISE: '1', BOARD_RANK: 13 },
    ],
  }, '603859')

  assert.equal(profile.industry, 'IT服务Ⅱ')
  assert.equal(profile.primaryTopic, '商业航天')
  assert.deepEqual(profile.displayTags, [
    { name: '商业航天', kind: 'concept' },
    { name: 'IT服务Ⅱ', kind: 'industry' },
  ])
  assert.deepEqual(profile.conceptBoards, [
    { code: 'BK1099', name: '商业航天', rank: 13 },
  ])
  assert.equal(profile.conceptVerified, true)
})

test('交易属性和热度属性永远不能作为行业显示', () => {
  for (const industry of ['沪股通', '深股通', '东方财富热股']) {
    const profile = buildStockTagProfile({
      code: '000938',
      industry,
      concepts: 'CPO概念',
    })
    assert.equal(profile.industry, null)
    assert.deepEqual(profile.displayTags, [
      { name: 'CPO', kind: 'concept' },
    ])
  }
})

test('多个精确题材只展示一个核心概念但完整保留概念证据', () => {
  const profile = stockTagProfileFromCoreConception({
    ssbk: [
      { SECURITY_CODE: '600276', SECURITY_NAME_ABBR: '恒瑞医药', BOARD_NAME: '化学制药', IS_PRECISE: null, BOARD_RANK: 2 },
      { SECURITY_CODE: '600276', SECURITY_NAME_ABBR: '恒瑞医药', BOARD_NAME: '融资融券', BOARD_CODE: '596', IS_PRECISE: '0', BOARD_RANK: 20 },
      { SECURITY_CODE: '600276', SECURITY_NAME_ABBR: '恒瑞医药', BOARD_NAME: '减肥药', BOARD_CODE: '1146', IS_PRECISE: '1', BOARD_RANK: 23 },
      { SECURITY_CODE: '600276', SECURITY_NAME_ABBR: '恒瑞医药', BOARD_NAME: '创新药', BOARD_CODE: '1106', IS_PRECISE: '1', BOARD_RANK: 24 },
    ],
  }, '600276')

  assert.deepEqual(profile.concepts, ['减肥药', '创新药'])
  assert.deepEqual(profile.displayTags, [
    { name: '减肥药', kind: 'concept' },
    { name: '化学制药', kind: 'industry' },
  ])
  assert.deepEqual(profile.conceptBoards, [
    { code: 'BK1146', name: '减肥药', rank: 23 },
    { code: 'BK1106', name: '创新药', rank: 24 },
  ])
})
