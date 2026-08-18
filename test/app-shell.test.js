import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  APP_SECTIONS,
  resolveAppShortcut,
} from '../shared/appShell.js'

test('工作台固定四个核心入口并为每页提供任务描述', () => {
  assert.deepEqual(
    APP_SECTIONS.map((section) => section.key),
    ['today', 'plan', 'hub', 'research'],
  )
  for (const section of APP_SECTIONS) {
    assert.ok(section.label)
    assert.ok(section.description)
    assert.ok(section.icon)
  }
})

test('工作台支持数字键和命令快捷键且不干扰输入', () => {
  assert.deepEqual(
    resolveAppShortcut({ key: '2' }),
    { type: 'tab', tab: 'plan' },
  )
  assert.deepEqual(
    resolveAppShortcut({ key: 'k', metaKey: true }),
    { type: 'assistant' },
  )
  assert.deepEqual(
    resolveAppShortcut({ key: 'k', ctrlKey: true }),
    { type: 'assistant' },
  )
  assert.deepEqual(
    resolveAppShortcut({ key: '/' }),
    { type: 'assistant' },
  )
  assert.equal(
    resolveAppShortcut({ key: '/', typing: true }),
    null,
  )
  assert.deepEqual(
    resolveAppShortcut({ key: 'Escape', typing: true }),
    { type: 'escape' },
  )
})

test('Precision tokens 固化主题、字体、间距和动效契约', () => {
  const css = readFileSync(
    new URL('../tokens.css', import.meta.url),
    'utf8',
  )

  for (const token of [
    '--color-paper',
    '--color-paper-2',
    '--color-ink',
    '--color-rule',
    '--color-accent',
    '--color-accent-ink',
    '--font-display',
    '--font-body',
    '--font-mono',
    '--space-md',
    '--radius-card',
    '--ease-out',
    '--dur-short',
  ]) {
    assert.match(css, new RegExp(`${token}:`))
  }
  assert.match(css, /Hallmark · genre: modern-minimal/)
  assert.match(css, /oklch\(/)
})
