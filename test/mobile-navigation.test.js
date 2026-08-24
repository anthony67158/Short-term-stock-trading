import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  edgeBackProgress,
  shouldCommitMobileEdgeBack,
} from '../shared/mobileEdgeBack.js'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

test('左缘右滑达到距离阈值或快速轻扫时返回', () => {
  assert.equal(shouldCommitMobileEdgeBack({
    startX: 12,
    startY: 260,
    currentX: 92,
    currentY: 268,
    elapsedMs: 420,
    pointerType: 'touch',
    viewportWidth: 390,
  }), true)
  assert.equal(shouldCommitMobileEdgeBack({
    startX: 10,
    startY: 260,
    currentX: 58,
    currentY: 264,
    elapsedMs: 120,
    pointerType: 'touch',
    viewportWidth: 390,
  }), true)
  assert.equal(edgeBackProgress(12, 60), 0.5)
})

test('非边缘起手、纵向滚动和鼠标拖动不能误触返回', () => {
  assert.equal(shouldCommitMobileEdgeBack({
    startX: 42,
    startY: 200,
    currentX: 150,
    currentY: 204,
    elapsedMs: 220,
    pointerType: 'touch',
    viewportWidth: 390,
  }), false)
  assert.equal(shouldCommitMobileEdgeBack({
    startX: 12,
    startY: 120,
    currentX: 92,
    currentY: 220,
    elapsedMs: 260,
    pointerType: 'touch',
    viewportWidth: 390,
  }), false)
  assert.equal(shouldCommitMobileEdgeBack({
    startX: 12,
    startY: 120,
    currentX: 120,
    currentY: 124,
    elapsedMs: 260,
    pointerType: 'mouse',
    viewportWidth: 390,
  }), false)
})

test('应用统一接管边缘返回、弹层关闭和背景滚动锁定', () => {
  const app = read('src/App.jsx')
  const accountHub = read('src/components/AccountHub.jsx')
  const navigation = read('src/mobileNavigation.js')
  const styles = read('src/styles/precision.css')

  assert.match(app, /useMobileEdgeBack/)
  assert.match(app, /navigateToTab/)
  assert.match(app, /tabHistoryRef/)
  assert.match(app, /closeTopmostOverlay/)
  assert.match(accountHub, /onSubChange/)
  assert.match(navigation, /MutationObserver/)
  assert.match(navigation, /overlay-scroll-locked/)
  assert.match(
    styles,
    /body\.overlay-scroll-locked\s*{[^}]*position:\s*fixed[^}]*overflow:\s*hidden/s,
  )
  assert.match(
    styles,
    /\[aria-modal="true"\]\s*{[^}]*overscroll-behavior:\s*contain/s,
  )
  assert.match(
    styles,
    /\.detail-scroll,[\s\S]*?\.holding-plan-body[\s\S]*?{[^}]*overscroll-behavior:\s*contain[^}]*touch-action:\s*pan-y/s,
  )
})
