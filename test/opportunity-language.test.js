import test from 'node:test'
import assert from 'node:assert/strict'

import {
  explainOpportunityBlockers,
  opportunityBlockerDetails,
} from '../shared/opportunityLanguage.js'

test('机会卡优先展示具体限制并去除重复笼统文案', () => {
  assert.equal(explainOpportunityBlockers([
    '当前盘面不允许新增风险',
    '市场进入防守：炸板率42.9%超过40%',
    '指数与市场广度未确认：深证成指低于20日线；上涨1886家、下跌3595家（涨跌比0.52，需至少1.05）',
    '当前市场环境不支持新增风险',
  ]), (
    '市场进入防守：炸板率42.9%超过40%；'
    + '指数与市场广度未确认：深证成指低于20日线；'
    + '上涨1886家、下跌3595家（涨跌比0.52，需至少1.05）'
  ))
})

test('只有笼统原因时仍返回可理解的安全说明', () => {
  assert.equal(
    explainOpportunityBlockers(['当前市场环境不支持新增风险']),
    '市场风险条件未通过，暂停新增仓位；已有持仓仍按止损和退出计划处理',
  )
  assert.equal(
    explainOpportunityBlockers([]),
    '当前证据不足，暂不新增仓位；条件变化后重新扫描',
  )
})

test('旧快照里的内部短句在展开详情时转换为完整中文', () => {
  assert.deepEqual(opportunityBlockerDetails([
    '板块方向需要重新确认',
    '买卖价格合同不完整',
    '公式结果已过期',
  ]), [
    '板块快照不是当前交易时段最新结果，重新扫描后再判断',
    '缺少入场价、止损价、目标价或有效时限，不能形成完整交易计划',
    '公式结果不属于当前交易日，重新扫描前不作为买入依据',
  ])
})
