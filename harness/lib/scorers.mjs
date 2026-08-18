const DIMENSIONS = [
  'contract',
  'groundedness',
  'feasibility',
  'actionability',
  'consistency',
]

function round(value) {
  return +Number(value || 0).toFixed(4)
}

function failureCode(check) {
  return String(check.code || check.id || 'HARNESS_CHECK_FAILED')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
}

export function scoreHarnessChecks(
  checks = [],
  {
    weights = {},
    minOverall = 0.85,
  } = {},
) {
  const normalizedChecks = (Array.isArray(checks) ? checks : [])
    .filter((check) =>
      check
      && DIMENSIONS.includes(check.dimension)
      && check.id
    )
    .map((check) => ({
      id: String(check.id),
      code: failureCode(check),
      dimension: check.dimension,
      passed: check.passed === true,
      hard: check.hard === true,
      message: String(check.message || ''),
      details: check.details ?? null,
    }))
  const scores = {}
  const failures = []
  for (const dimension of DIMENSIONS) {
    const dimensionChecks = normalizedChecks.filter(
      (check) => check.dimension === dimension,
    )
    scores[dimension] = dimensionChecks.length
      ? round(
          dimensionChecks.filter((check) => check.passed).length
          / dimensionChecks.length,
        )
      : 0
    if (!dimensionChecks.length) {
      failures.push({
        code: `DIMENSION_${dimension.toUpperCase()}_UNSCORED`,
        dimension,
        message: `维度${dimension}没有评分检查`,
        hard: true,
        details: null,
      })
    }
  }
  for (const check of normalizedChecks) {
    if (check.passed) continue
    failures.push({
      code: check.code,
      dimension: check.dimension,
      message: check.message || `${check.id}未通过`,
      hard: check.hard,
      details: check.details,
    })
  }
  const overall = round(
    DIMENSIONS.reduce(
      (sum, dimension) =>
        sum + scores[dimension] * Number(weights[dimension] || 0),
      0,
    ),
  )
  const hardFailures = failures.filter((failure) => failure.hard)
  return {
    ...scores,
    overall,
    minOverall: round(minOverall),
    passed: overall >= minOverall && hardFailures.length === 0,
    failures,
    hardFailures,
    checks: normalizedChecks,
  }
}

export const HARNESS_SCORE_DIMENSIONS = Object.freeze(
  DIMENSIONS.slice(),
)
