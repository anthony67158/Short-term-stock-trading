import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateHarnessCase } from './loader.mjs'

const SENSITIVE_KEY = /(?:api.?key|access.?key|password|passwd|nick|token|secret|credential|authorization|cookie|prompt|reasoning|chain.?of.?thought)/i
const SECRET_VALUE = /\b(?:sk|ak)-[A-Za-z0-9_-]{8,}\b/gi

function cleanValue(value, depth = 0) {
  if (depth > 16) return null
  if (Array.isArray(value)) {
    return value.slice(0, 200).map(
      (item) => cleanValue(item, depth + 1),
    )
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SENSITIVE_KEY.test(key))
        .map(([key, nested]) => [
          key,
          cleanValue(nested, depth + 1),
        ]),
    )
  }
  if (typeof value === 'string') {
    return value.replace(SECRET_VALUE, '[REDACTED]').slice(0, 10000)
  }
  if (
    value == null
    || typeof value === 'boolean'
    || typeof value === 'number'
  ) return value
  return String(value).slice(0, 1000)
}

export function createRegressionCase({
  caseId,
  adapter,
  tags = [],
  input,
  expect,
} = {}) {
  const testCase = {
    schemaVersion: 'harness-case.v1',
    id: String(caseId || ''),
    adapter: String(adapter || ''),
    tags: [
      ...new Set([
        'production-regression',
        ...(Array.isArray(tags) ? tags : []),
      ].map((item) => String(item).slice(0, 40))),
    ].slice(0, 12),
    input: cleanValue(input || {}),
    expect: cleanValue(expect || {}),
  }
  return validateHarnessCase(testCase)
}

export function serializeRegressionCaseSet(cases) {
  const validated = (Array.isArray(cases) ? cases : [])
    .map(validateHarnessCase)
  if (!validated.length) {
    throw new Error('至少需要一个可导出的Harness case')
  }
  return `${JSON.stringify({
    schemaVersion: 'harness-case-set.v1',
    cases: validated,
  }, null, 2)}\n`
}

function regressionRoot() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'cases',
    'regressions',
  )
}

export async function writeRegressionCase(testCase) {
  const validated = validateHarnessCase(testCase)
  const root = regressionRoot()
  const fileName = `${validated.id}.json`
  const outputPath = path.join(root, fileName)
  await mkdir(root, { recursive: true })
  await writeFile(
    outputPath,
    serializeRegressionCaseSet([validated]),
  )
  return outputPath
}

export function sanitizeProductionFailure(value) {
  return cleanValue(value)
}
