import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const SENSITIVE_KEY = /(?:api.?key|password|passwd|secret|token|credential|nick)/i
const SECRET_VALUE = /\b(?:sk|ak)-[A-Za-z0-9_-]{8,}\b/gi

function safeText(value) {
  return String(value ?? '')
    .replace(SECRET_VALUE, '[REDACTED]')
    .replace(/\r?\n/g, ' ')
    .slice(0, 500)
}

export function sanitizeHarnessValue(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeHarnessValue)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        SENSITIVE_KEY.test(key)
          ? '[REDACTED]'
          : sanitizeHarnessValue(nested),
      ]),
    )
  }
  return typeof value === 'string'
    ? value.replace(SECRET_VALUE, '[REDACTED]')
    : value
}

export function renderHarnessMarkdown(run) {
  const safe = sanitizeHarnessValue(run)
  const lines = [
    '# Harness Report',
    '',
    `- Schema: \`${safe.schemaVersion || 'harness-run.v1'}\``,
    `- Run: \`${safe.runId || '-'}\``,
    `- Suite: \`${safe.suiteId || '-'}\``,
    `- Result: **${safe.ok ? 'PASS' : 'FAIL'}**`,
    `- Cases: ${safe.summary?.passed || 0}/${safe.summary?.total || 0}`,
    `- Overall: ${Number(safe.summary?.overall || 0).toFixed(4)}`,
    '',
    '## Episodes',
    '',
    '| Case | Status | Overall | Duration | Failures |',
    '|---|---|---:|---:|---|',
  ]
  for (const episode of safe.episodes || []) {
    const failureText = (episode.failures || [])
      .map((failure) => failure.code)
      .join(', ')
    lines.push(
      `| ${safeText(episode.caseId)} | ${episode.status} | ${Number(episode.scores?.overall || 0).toFixed(4)} | ${Number(episode.metrics?.durationMs || 0)}ms | ${safeText(failureText || '-')} |`,
    )
  }
  lines.push('', '## Dimension Scores', '')
  lines.push('| Dimension | Score |', '|---|---:|')
  for (const [dimension, score] of Object.entries(
    safe.summary?.dimensions || {},
  )) {
    lines.push(`| ${dimension} | ${Number(score || 0).toFixed(4)} |`)
  }
  if (safe.baseline) {
    lines.push('', '## Baseline', '')
    if (safe.baseline.skipped) {
      lines.push(`- Skipped: ${safeText(safe.baseline.reason)}`)
    } else {
      lines.push(
        `- Result: **${safe.baseline.passed ? 'PASS' : 'FAIL'}**`,
        `- Reference: \`${safeText(safe.baseline.path)}\``,
      )
      for (const regression of safe.baseline.regressions || []) {
        lines.push(
          `- ${safeText(regression.suiteId)}.${safeText(regression.metric)}: ${regression.current} vs ${regression.baseline} (tolerance ${regression.tolerance})`,
        )
      }
    }
  }
  if (safe.versions) {
    lines.push('', '## Versions', '')
    lines.push(
      `- App: \`${safeText(safe.versions.app)}\``,
      `- Git: \`${safeText(safe.versions.git)}\``,
      `- Node: \`${safeText(safe.versions.node)}\``,
      `- Adapters: ${(safe.versions.adapters || []).map(safeText).join(', ')}`,
    )
  }
  const failures = (safe.episodes || []).flatMap(
    (episode) => (episode.failures || []).map((failure) => ({
      caseId: episode.caseId,
      ...failure,
    })),
  )
  if (failures.length) {
    lines.push('', '## Failure Attribution', '')
    for (const failure of failures) {
      lines.push(
        `- \`${safeText(failure.caseId)}\` / \`${safeText(failure.dimension)}\` / \`${safeText(failure.code)}\`: ${safeText(failure.message)}`,
      )
    }
  }
  return `${lines.join('\n')}\n`
}

export async function writeHarnessReports(
  run,
  {
    outputDir = 'harness-artifacts',
  } = {},
) {
  const resolved = path.resolve(process.cwd(), outputDir)
  await mkdir(resolved, { recursive: true })
  const safe = sanitizeHarnessValue(run)
  const jsonPath = path.join(resolved, 'latest.json')
  const markdownPath = path.join(resolved, 'latest.md')
  const historyPath = path.join(resolved, 'history.jsonl')
  const historyRecord = {
    schemaVersion: 'harness-history.v1',
    runId: safe.runId,
    generatedAt: safe.generatedAt,
    suiteId: safe.suiteId,
    ok: safe.ok,
    summary: safe.summary,
    baseline: safe.baseline,
    versions: safe.versions,
  }
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(safe, null, 2)}\n`),
    writeFile(markdownPath, renderHarnessMarkdown(safe)),
    appendFile(historyPath, `${JSON.stringify(historyRecord)}\n`),
  ])
  return { jsonPath, markdownPath, historyPath }
}
