import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseTencentQuoteText,
} from '../api/_market_data.js'

test('腾讯港美股和国际商品使用各自字段格式解析', () => {
  const indexFields = Array(33).fill('0')
  indexFields[0] = '100'
  indexFields[1] = '恒生指数'
  indexFields[2] = 'HSI'
  indexFields[3] = '24954.470'
  indexFields[4] = '25274.960'
  indexFields[32] = '-1.27'
  const parsed = parseTencentQuoteText([
    `v_hkHSI="${indexFields.join('~')}";`,
    'v_hf_XAU="4392.63,-0.21,4392.63,4392.98,4434.26'
      + ',4389.74,17:24:00,4401.73,4404.05,0,0,0'
      + ',2026-09-10,伦敦金（现货黄金）";',
  ].join('\n'))

  assert.equal(parsed.hkHSI.price, 24954.47)
  assert.equal(parsed.hkHSI.pct, -1.27)
  assert.equal(parsed.hf_XAU.name, '伦敦金（现货黄金）')
  assert.equal(parsed.hf_XAU.price, 4392.63)
  assert.equal(parsed.hf_XAU.prevClose, 4401.73)
  assert.equal(parsed.hf_XAU.pct, -0.21)
})
