export const QUANT_MODEL_DEFAULT = 'default'

export function normalizeQuantModelVersion() {
  return QUANT_MODEL_DEFAULT
}

export function quantModelLabel() {
  return '36因子日线辅助模型'
}

export function isQuantResultForVersion(response) {
  if (!response?.ok || !response.quant) return false
  const rawVersion = String(
    response.quantModelVersion
      ?? response.quant.selectedModelVersion
      ?? '',
  ).trim().toLowerCase()
  return !rawVersion || rawVersion === QUANT_MODEL_DEFAULT
}
