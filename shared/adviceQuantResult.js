export function quantResultFromAdviceMeta(meta, priceHint = null) {
  const quant = meta?.quantResult
  if (!quant || typeof quant !== 'object') return null
  return {
    ...quant,
    price: Number(quant.price) > 0
      ? Number(quant.price)
      : Number(priceHint) > 0 ? Number(priceHint) : null,
  }
}
