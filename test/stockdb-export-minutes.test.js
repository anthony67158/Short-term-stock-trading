import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const SCRIPT = path.resolve('scripts/stockdb_export_minutes.py')

async function withManifest(payload, callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'stockdb-manifest-'))
  const file = path.join(directory, 'manifest.json')
  try {
    await writeFile(file, JSON.stringify(payload), 'utf8')
    return await callback(file)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('StockDB分钟导出器在加载SDK前验证清单', async () => {
  await withManifest({
    dates: [{
      date: '20260908',
      codes: ['000001', '600519', '920001'],
    }],
  }, async (manifest) => {
    const { stdout } = await execFileAsync('python3', [
      SCRIPT,
      '--manifest',
      manifest,
      '--dry-run',
    ])
    assert.deepEqual(JSON.parse(stdout), {
      ok: true,
      dates: 1,
      maximumCodes: 3,
    })
  })
})

test('StockDB分钟导出器拒绝重复和畸形股票代码', async () => {
  await withManifest({
    dates: [{
      date: '20260908',
      codes: ['600519', '600519'],
    }],
  }, async (manifest) => {
    await assert.rejects(
      () => execFileAsync('python3', [
        SCRIPT,
        '--manifest',
        manifest,
        '--dry-run',
      ]),
      /股票代码无效/,
    )
  })
})
