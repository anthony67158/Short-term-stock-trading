import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  isTextOverflowing,
} from '../src/useTextOverflow.js'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const hook = read('src/useTextOverflow.js')
const planTab = read('src/components/PlanTab.jsx')
const stockNote = read('src/components/StockNote.jsx')
const styles = read('src/styles/precision.css')

test('文字完整显示时不判定为溢出', () => {
  assert.equal(isTextOverflowing({
    clientWidth: 240,
    scrollWidth: 240,
    clientHeight: 24,
    scrollHeight: 24,
  }), false)
})

test('横向或纵向被裁切时判定为溢出', () => {
  assert.equal(isTextOverflowing({
    clientWidth: 240,
    scrollWidth: 280,
    clientHeight: 24,
    scrollHeight: 24,
  }), true)
  assert.equal(isTextOverflowing({
    clientWidth: 240,
    scrollWidth: 240,
    clientHeight: 24,
    scrollHeight: 48,
  }), true)
})

test('溢出检测监听容器尺寸和字体加载变化', () => {
  assert.match(hook, /ResizeObserver/)
  assert.match(hook, /document\.fonts\?\.ready/)
  assert.match(hook, /window\.addEventListener\('resize'/)
})

test('操作建议只有省略时才渲染完整预览', () => {
  assert.match(
    planTab,
    /useTextOverflow\(instruction\)/,
  )
  assert.match(
    planTab,
    /ref=\{instructionRef\}[\s\S]*?\{isInstructionTruncated && \([\s\S]*?完整操作建议/,
  )
  assert.match(
    planTab,
    /'action-command'[\s\S]*?has-preview/,
  )
})

test('个人备注只有省略时才渲染完整预览', () => {
  assert.match(
    stockNote,
    /useTextOverflow\(text\)/,
  )
  assert.match(
    stockNote,
    /ref=\{noteRef\}[\s\S]*?\{isNoteTruncated && \([\s\S]*?完整备注/,
  )
  assert.match(
    stockNote,
    /'stock-note-summary'[\s\S]*?has-preview/,
  )
  assert.match(
    styles,
    /\.action-command\.has-preview:hover \.action-command-preview/,
  )
  assert.match(
    styles,
    /\.stock-note-summary\.has-preview:hover \.action-command-preview/,
  )
})
