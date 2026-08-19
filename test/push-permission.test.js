import test from 'node:test'
import assert from 'node:assert/strict'

import { requestPushPermission } from '../shared/pushPermission.js'

test('浏览器已授权通知时不重复请求权限', async () => {
  let requests = 0
  const permission = await requestPushPermission({
    permission: 'granted',
    async requestPermission() {
      requests++
      return 'denied'
    },
  })

  assert.equal(permission, 'granted')
  assert.equal(requests, 0)
})
