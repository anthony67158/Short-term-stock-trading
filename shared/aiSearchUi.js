function finite(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

export function normalizeAiSearchPublicConfig(input = {}) {
  const policy = input.cachePolicy && typeof input.cachePolicy === 'object'
    ? input.cachePolicy
    : {}
  return {
    enabled: input.enabled === true,
    hasKey: input.hasKey === true,
    apiKeyMask: String(input.apiKeyMask || '').slice(0, 40),
    updatedAt: Math.max(0, finite(input.updatedAt)),
    cachePolicy: {
      stockMinutes: Math.max(1, finite(policy.stockMinutes, 30)),
      industryMinutes: Math.max(1, finite(policy.industryMinutes, 60)),
      scheduledCacheOnly: policy.scheduledCacheOnly !== false,
    },
  }
}

export function visibleSearchReference(enabled, reference) {
  if (
    enabled !== true
    || !reference
    || reference.dimension !== 'search'
    || !Array.isArray(reference.sources)
    || !reference.sources.length
  ) return null
  return reference
}

export function visibleAiSources(enabled, sources) {
  const list = Array.isArray(sources) ? sources : []
  if (enabled === true) return list
  return list.filter((item) =>
    item?.key !== 'aiSearch'
    && !/AI联网搜索|AI Search/i.test(String(item?.label || ''))
  )
}
