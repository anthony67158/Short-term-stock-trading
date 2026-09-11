export const STRATEGY_PATTERN_CONFIRMATION_VERSION =
  'strategy-pattern-confirmation.v1'

const PATTERN_IDS = new Set([
  'PLATFORM_BREAKOUT',
  'SUPPORT_PULLBACK',
  'VOLUME_PRICE_SURGE',
  'LOWER_SHADOW_REVERSAL',
  'LOW_VOL_TREND',
])

const ROUTES = new Set(['IMMEDIATE', 'PULLBACK', 'BREAKOUT'])

const SIGNALS = Object.freeze({
  OBSERVATION_WINDOW: {
    label: '持续观察满60秒',
    passes: (value) => Number(value.observationAgeMs) >= 60 * 1000,
  },
  ABOVE_VWAP: {
    label: '站在分时均价线上方',
    passes: (value) => value.aboveVwap === true,
  },
  HIGHER_LOWS: {
    label: '分时低点抬高',
    passes: (value) => value.higherLows === true,
  },
  POSITIVE_MOMENTUM: {
    label: '近5分钟企稳回升',
    passes: (value) => Number(value.mom5Pct) >= 0.2,
  },
  VOLUME_SURGE: {
    label: '量能明显放大',
    passes: (value) => value.volSurge === true,
  },
  VOLUME_SHRINK: {
    label: '回踩量能收缩',
    passes: (value) => value.volShrink === true,
  },
  HOLDS_TRIGGER: {
    label: '价格未有效跌回触发位',
    passes: (value) => Number(value.keyDistancePct) >= -0.2,
  },
  BOUNCE_FROM_LOW: {
    label: '较观察窗口低点反弹',
    passes: (value) => Number(value.bounceFromLowPct) >= 0.3,
  },
  TOUCH_RECOVERY: {
    label: '触价后重新回升',
    passes: (value) => Number(value.sinceTouchPct) >= 0.15,
  },
  CONTROLLED_VOLUME: {
    label: '量能未异常放大',
    passes: (value) => value.volSurge === false,
  },
})

function text(value, maximum = 80) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum)
}

function groupsFor(patternId, route) {
  const routeGroups = {
    IMMEDIATE: [
      ['ABOVE_VWAP'],
      ['HIGHER_LOWS', 'POSITIVE_MOMENTUM'],
    ],
    PULLBACK: [
      ['HIGHER_LOWS'],
      ['ABOVE_VWAP', 'POSITIVE_MOMENTUM'],
      ['BOUNCE_FROM_LOW', 'TOUCH_RECOVERY'],
    ],
    BREAKOUT: [
      ['HOLDS_TRIGGER'],
      ['ABOVE_VWAP'],
      ['VOLUME_SURGE', 'POSITIVE_MOMENTUM'],
    ],
  }[route] || []
  const patternGroups = {
    PLATFORM_BREAKOUT: [['HOLDS_TRIGGER']],
    SUPPORT_PULLBACK: [['VOLUME_SHRINK', 'HIGHER_LOWS']],
    VOLUME_PRICE_SURGE: [['VOLUME_SURGE', 'POSITIVE_MOMENTUM']],
    LOWER_SHADOW_REVERSAL: [['BOUNCE_FROM_LOW'], ['HIGHER_LOWS']],
    LOW_VOL_TREND: [['CONTROLLED_VOLUME', 'HIGHER_LOWS']],
  }[patternId] || []
  const identities = new Set()
  return [['OBSERVATION_WINDOW'], ...routeGroups, ...patternGroups]
    .filter((anyOf) => {
      const identity = anyOf.slice().sort().join('|')
      if (identities.has(identity)) return false
      identities.add(identity)
      return true
    })
    .map((anyOf) => ({
      anyOf,
      label: anyOf.map((key) => SIGNALS[key].label).join('或'),
    }))
}

export function buildStrategyPatternConfirmation({
  pattern,
  route,
} = {}) {
  const patternId = String(pattern?.id || '')
  const normalizedRoute = String(route || '').toUpperCase()
  if (
    !PATTERN_IDS.has(patternId)
    || !ROUTES.has(normalizedRoute)
    || !(Number(pattern?.score) >= 70)
  ) return null
  const groups = groupsFor(patternId, normalizedRoute)
  if (!groups.length) return null
  return {
    schemaVersion: STRATEGY_PATTERN_CONFIRMATION_VERSION,
    patternId,
    patternLabel: text(pattern.label, 40),
    patternScore: +Number(pattern.score).toFixed(1),
    route: normalizedRoute,
    groups,
    summary: groups.map((group) => group.label).join('；'),
  }
}

export function sanitizeStrategyPatternConfirmation(value) {
  if (
    value?.schemaVersion !== STRATEGY_PATTERN_CONFIRMATION_VERSION
    || !PATTERN_IDS.has(String(value.patternId || ''))
    || !ROUTES.has(String(value.route || '').toUpperCase())
  ) return null
  return buildStrategyPatternConfirmation({
    pattern: {
      id: value.patternId,
      label: text(value.patternLabel, 40),
      score: Number(value.patternScore),
    },
    route: value.route,
  })
}

export function evaluateStrategyPatternConfirmation(
  primitives = {},
  rawProfile = null,
) {
  const profile = sanitizeStrategyPatternConfirmation(rawProfile)
  if (!profile) return null
  const groups = profile.groups.map((group) => {
    const matched = group.anyOf.filter((key) =>
      SIGNALS[key].passes(primitives)
    )
    return {
      ...group,
      passed: matched.length > 0,
      matched: matched.map((key) => SIGNALS[key].label),
    }
  })
  const passed = groups.every((group) => group.passed)
  return {
    schemaVersion: STRATEGY_PATTERN_CONFIRMATION_VERSION,
    patternId: profile.patternId,
    patternLabel: profile.patternLabel,
    route: profile.route,
    passed,
    passedGroups: groups.filter((group) => group.passed).length,
    totalGroups: groups.length,
    hits: groups.flatMap((group) => group.matched),
    missing: groups
      .filter((group) => !group.passed)
      .map((group) => group.label),
  }
}

export function applyStrategyPatternConfirmationGuard(
  deterministic,
  primitives,
  profile,
) {
  if (deterministic?.decision !== 'confirm') return deterministic
  const result = evaluateStrategyPatternConfirmation(primitives, profile)
  if (!result) return deterministic
  if (!result.passed) {
    return {
      ...deterministic,
      decision: 'wait',
      hits: [
        ...(deterministic.hits || []),
        `形态确认未完成：${result.missing.join('、')}`,
      ],
      strategyPatternConfirmation: result,
    }
  }
  return {
    ...deterministic,
    hits: [
      ...(deterministic.hits || []),
      `形态确认通过：${result.hits.join('、')}`,
    ],
    strategyPatternConfirmation: result,
  }
}
