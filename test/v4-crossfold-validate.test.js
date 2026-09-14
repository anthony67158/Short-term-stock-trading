import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 端到端小样本：构造 y 与特征强线性相关，跨折验证脚本应给出高IC与单调deciles。
test('跨折验证脚本在强信号小样本上产出高IC与单调分档', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v4cf-'))
  const file = path.join(dir, 'samples.jsonl')
  const lines = []
  let seed = 42
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  for (let fold = 1; fold <= 3; fold += 1) {
    for (let i = 0; i < 400; i += 1) {
      const pct = rand()
      // netR 与 pct 正相关 + 噪声
      const y = (pct - 0.5) * 2 + (rand() - 0.5) * 0.5
      lines.push(JSON.stringify({
        fold,
        alphaFeatures: {
          alphaScorePctRank: pct,
          alphaScoreZ: (pct - 0.5) * 2,
          alphaScoreMomentum5: (rand() - 0.5) * 0.2,
        },
        netR: { HOLD_TO_HORIZON: y },
      }))
    }
  }
  fs.writeFileSync(file, lines.join('\n'))
  const out = execFileSync('node', [
    path.join(process.cwd(), 'scripts/validate-v4-model-crossfold.mjs'),
    '--input', file,
  ], { encoding: 'utf8' })
  const report = JSON.parse(out)
  assert.equal(report.testFold, 3)
  assert.ok(report.testIC > 0.5, `IC应显著为正, got ${report.testIC}`)
  assert.ok(report.testRankIC > 0.5)
  // 强信号下应高度单调
  assert.ok(
    Number(report.monotonicSteps.split('/')[0]) >= 7,
    `单调档数应≥7, got ${report.monotonicSteps}`,
  )
  assert.ok(report.topBottomSpread > 0)
  fs.rmSync(dir, { recursive: true, force: true })
})
