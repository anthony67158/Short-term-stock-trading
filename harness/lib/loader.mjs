import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MANIFEST_SCHEMA = 'harness-manifest.v1'
const CASE_SCHEMA = 'harness-case.v1'
const DIMENSIONS = [
  'contract',
  'groundedness',
  'feasibility',
  'actionability',
  'consistency',
]
const SENSITIVE_KEY = /(?:api.?key|password|passwd|secret|token|credential|nick)/i
const SECRET_VALUE = /\b(?:sk|ak)-[A-Za-z0-9_-]{8,}\b/i

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}必须是对象`)
  }
}

function assertSafeValue(value, pathLabel = 'root') {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertSafeValue(item, `${pathLabel}[${index}]`)
    )
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) {
        throw new Error(`Harness场景包含敏感字段: ${pathLabel}.${key}`)
      }
      assertSafeValue(nested, `${pathLabel}.${key}`)
    }
    return
  }
  if (typeof value === 'string' && SECRET_VALUE.test(value)) {
    throw new Error(`Harness场景包含疑似密钥: ${pathLabel}`)
  }
}

export function validateHarnessManifest(manifest) {
  assertObject(manifest, 'Harness manifest')
  if (manifest.schemaVersion !== MANIFEST_SCHEMA) {
    throw new Error(`Harness manifest schema必须为${MANIFEST_SCHEMA}`)
  }
  assertObject(manifest.dimensions, 'Harness dimensions')
  const keys = Object.keys(manifest.dimensions).sort()
  if (JSON.stringify(keys) !== JSON.stringify(DIMENSIONS.slice().sort())) {
    throw new Error(`Harness dimensions必须完整包含${DIMENSIONS.join(',')}`)
  }
  const total = DIMENSIONS.reduce((sum, key) => {
    const weight = Number(manifest.dimensions[key])
    if (!(weight > 0 && weight <= 1)) {
      throw new Error(`Harness维度${key}权重无效`)
    }
    return sum + weight
  }, 0)
  if (Math.abs(total - 1) > 1e-9) {
    throw new Error('Harness维度权重之和必须为1')
  }
  assertObject(manifest.suites, 'Harness suites')
  if (!Object.keys(manifest.suites).length) {
    throw new Error('Harness至少需要一个suite')
  }
  for (const [suiteId, suite] of Object.entries(manifest.suites)) {
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(suiteId)) {
      throw new Error(`Harness suite id无效: ${suiteId}`)
    }
    assertObject(suite, `Harness suite ${suiteId}`)
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(String(suite.adapter || ''))) {
      throw new Error(`Harness suite ${suiteId}缺少合法adapter`)
    }
    if (!String(suite.caseFile || '').endsWith('.json')) {
      throw new Error(`Harness suite ${suiteId}缺少JSON caseFile`)
    }
    const minOverall = Number(
      suite.minOverall ?? manifest.defaults?.minOverall,
    )
    if (!(minOverall >= 0 && minOverall <= 1)) {
      throw new Error(`Harness suite ${suiteId}门槛无效`)
    }
  }
  return manifest
}

export function validateHarnessCase(testCase) {
  assertObject(testCase, 'Harness case')
  if (testCase.schemaVersion !== CASE_SCHEMA) {
    throw new Error(`Harness case schema必须为${CASE_SCHEMA}`)
  }
  if (!/^[a-z][a-z0-9-]{2,80}$/.test(String(testCase.id || ''))) {
    throw new Error('Harness case id无效')
  }
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(String(testCase.adapter || ''))) {
    throw new Error(`Harness case ${testCase.id} adapter无效`)
  }
  assertObject(testCase.input, `Harness case ${testCase.id} input`)
  assertObject(testCase.expect, `Harness case ${testCase.id} expect`)
  assertSafeValue(testCase.input, `case.${testCase.id}.input`)
  assertSafeValue(testCase.expect, `case.${testCase.id}.expect`)
  assertSafeValue(testCase.tags || [], `case.${testCase.id}.tags`)
  const minOverall = Number(testCase.expect.minOverall)
  if (!(minOverall >= 0 && minOverall <= 1)) {
    throw new Error(`Harness case ${testCase.id} minOverall无效`)
  }
  return testCase
}

function harnessRoot() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  )
}

function safeHarnessPath(relativePath) {
  const root = harnessRoot()
  const resolved = path.resolve(root, relativePath)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('Harness路径越界')
  }
  return resolved
}

export async function loadHarnessManifest(
  manifestPath = 'manifest.json',
) {
  const raw = await readFile(
    safeHarnessPath(manifestPath),
    'utf8',
  )
  return validateHarnessManifest(JSON.parse(raw))
}

export async function loadHarnessCases(caseFile) {
  const raw = await readFile(safeHarnessPath(caseFile), 'utf8')
  const parsed = JSON.parse(raw)
  const cases = Array.isArray(parsed) ? parsed : parsed?.cases
  if (!Array.isArray(cases) || !cases.length) {
    throw new Error(`Harness case文件${caseFile}没有场景`)
  }
  return cases.map(validateHarnessCase)
}
