#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import path from 'node:path'

import {
  createRegressionCase,
  writeRegressionCase,
} from './lib/exporter.mjs'

function parseArgs(argv) {
  const options = { input: '' }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--input') {
      options.input = argv[++index] || ''
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`未知Harness export参数: ${arg}`)
    }
  }
  return options
}

export async function exportHarnessFailure(
  argv = process.argv.slice(2),
) {
  const options = parseArgs(argv)
  if (options.help) {
    return {
      output: 'Usage: node harness/export.mjs --input <failure.json>\n',
      exitCode: 0,
    }
  }
  if (!options.input) {
    throw new Error('请通过--input指定生产失败JSON')
  }
  const inputPath = path.resolve(process.cwd(), options.input)
  const raw = JSON.parse(await readFile(inputPath, 'utf8'))
  const testCase = createRegressionCase(raw)
  const outputPath = await writeRegressionCase(testCase)
  return {
    output: `Harness regression case: ${path.relative(process.cwd(), outputPath)}\n`,
    exitCode: 0,
    testCase,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = await exportHarnessFailure()
    process.stdout.write(result.output)
    process.exitCode = result.exitCode
  } catch (error) {
    process.stderr.write(
      `Harness export ERROR: ${String(error?.message || error)}\n`,
    )
    process.exitCode = 1
  }
}
