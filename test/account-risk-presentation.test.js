import test from 'node:test'
import assert from 'node:assert/strict'

import {
  formatAccountRiskBlocker,
} from '../shared/accountRiskPresentation.js'

test('账户风险阈值明确显示百分比单位', () => {
  assert.equal(formatAccountRiskBlocker({
    code: 'INDUSTRY_CONCENTRATION',
    message: '行业合并暴露达到上限',
    value: 39.7,
    limit: 30,
  }), '行业合并暴露达到上限（当前39.7%，上限30%）')
  assert.equal(formatAccountRiskBlocker({
    code: 'OPEN_RISK_BUDGET',
    message: '持仓与未完成买入占满账户风险预算',
    value: 18.74,
    limit: 3,
  }), '持仓与未完成买入占满账户风险预算（当前18.74%，上限3%）')
})
