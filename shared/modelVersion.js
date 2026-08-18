export const QUANT_MODEL_DEFAULT = 'default'
export const QUANT_MODEL_V2 = 'v2'
export const QUANT_MODEL_V21 = 'v2.1'
export const V2_HIGH_CONFIDENCE_GATE_PCT = 65
export const V21_EXPERIMENTAL_RELIABILITY = Object.freeze({
  productionGatePassed: false,
  thresholdPct: 58,
  balancedAccuracyPct: Object.freeze({
    next30m: 53.92,
    sessionClose: 54.58,
  }),
})

export function normalizeQuantModelVersion(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === QUANT_MODEL_V2) return QUANT_MODEL_V2
  if (normalized === QUANT_MODEL_V21 || normalized === 'v21') {
    return QUANT_MODEL_V21
  }
  return QUANT_MODEL_DEFAULT
}

export function quantModelLabel(value) {
  const normalized = normalizeQuantModelVersion(value)
  if (normalized === QUANT_MODEL_V21) {
    return '分钟 Transformer V2.1（盘中实验）'
  }
  if (normalized === QUANT_MODEL_V2) return '分钟 Transformer V2.0'
  return '当前生产模型'
}

export function isQuantResultForVersion(response, selectedVersion) {
  if (!response?.ok || !response.quant) return false
  const expected = normalizeQuantModelVersion(selectedVersion)
  const actual = normalizeQuantModelVersion(
    response.quantModelVersion ?? response.quant.modelVersion,
  )
  return actual === expected
}

export function syncControlSelection(control, setSetting) {
  if (!control || typeof setSetting !== 'function') return null
  const selected = normalizeQuantModelVersion(control.selected)
  setSetting('quantModelVersion', selected)
  return selected
}

function round(value, digits = 2) {
  return +Number(value).toFixed(digits)
}

function probability(value, name) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error(`V2 ${name}概率无效`)
  }
  return number
}

function directionLabel(direction) {
  if (direction === 'bullish') return '看涨'
  if (direction === 'bearish') return '看跌'
  return '震荡'
}

function biasLabel(direction) {
  if (direction === 'bullish') return '偏多'
  if (direction === 'bearish') return '偏空'
  return '中性'
}

function adaptV21Head(head, name) {
  if (!head || typeof head !== 'object') {
    throw new Error(`V2.1 ${name}预测头缺失`)
  }
  const stopLoss = probability(head.probabilities?.stopLoss, `${name}止损`)
  const timeout = probability(head.probabilities?.timeout, `${name}超时`)
  const takeProfit = probability(head.probabilities?.takeProfit, `${name}止盈`)
  if (Math.abs(stopLoss + timeout + takeProfit - 1) > 1e-5) {
    throw new Error(`V2.1 ${name}概率之和必须为1`)
  }
  const fallbackExpected = takeProfit - stopLoss * 0.6
  const direction = head.outlook?.direction || (
    fallbackExpected > 0.08
      ? 'bullish'
      : fallbackExpected < -0.08 ? 'bearish' : 'neutral'
  )
  const confidence = Number.isFinite(Number(head.outlook?.confidencePct))
    ? Number(head.outlook.confidencePct)
    : Math.max(stopLoss, timeout, takeProfit) * 100
  const expectedReturn = Number.isFinite(
    Number(head.outlook?.expectedBarrierReturnPct),
  )
    ? Number(head.outlook.expectedBarrierReturnPct)
    : fallbackExpected
  return {
    horizon: String(head.horizon || ''),
    predictedClass: String(head.predictedClass || ''),
    probabilities: { stopLoss, timeout, takeProfit },
    outlook: {
      ...(head.outlook || {}),
      direction,
      confidencePct: round(confidence),
      expectedBarrierReturnPct: round(expectedReturn, 3),
      directionScore: Number.isFinite(Number(head.outlook?.directionScore))
        ? Number(head.outlook.directionScore)
        : Math.round((takeProfit - stopLoss + 1) * 50),
    },
    targetDefinition: head.targetDefinition || null,
  }
}

export function adaptV21Prediction(
  prediction,
  {
    price = null,
    activeHead = 'next30m',
  } = {},
) {
  if (!prediction || typeof prediction !== 'object') {
    throw new Error('V2.1预测结果无效')
  }
  const heads = {
    next30m: adaptV21Head(prediction.heads?.next30m, '未来30分钟'),
    sessionClose: adaptV21Head(
      prediction.heads?.sessionClose,
      '截至收盘',
    ),
  }
  const selectedName = activeHead === 'sessionClose'
    ? 'sessionClose'
    : 'next30m'
  const selected = heads[selectedName]
  const probabilities = selected.probabilities
  const outlook = selected.outlook
  const refs = prediction.priceReferences
    && typeof prediction.priceReferences === 'object'
    ? prediction.priceReferences
    : null
  const anchor = Number(refs?.anchorPrice)
  const support = Number(refs?.supportPrice)
  const resistance = Number(refs?.resistancePrice)
  const definition = selected.targetDefinition || {}
  const target = Number.isFinite(anchor)
    && Number.isFinite(Number(definition.takeProfitPct))
    ? round(anchor * (1 + Number(definition.takeProfitPct) / 100), 3)
    : null
  const stop = Number.isFinite(anchor)
    && Number.isFinite(Number(definition.stopLossPct))
    ? round(anchor * (1 - Number(definition.stopLossPct) / 100), 3)
    : null
  const score = Math.max(
    0,
    Math.min(100, Math.round(outlook.directionScore)),
  )
  return {
    ok: true,
    modelVersion: QUANT_MODEL_V21,
    selectedModelVersion: QUANT_MODEL_V21,
    runtimeModelVersion: 'v2.1-intraday',
    modelLabel: quantModelLabel(QUANT_MODEL_V21),
    experimental: true,
    reliability: V21_EXPERIMENTAL_RELIABILITY,
    price: Number.isFinite(Number(price)) ? Number(price) : null,
    score,
    bias: biasLabel(outlook.direction),
    tDir: directionLabel(outlook.direction),
    forecast: {
      upProb: round(probabilities.takeProfit * 100),
      downProb: round(probabilities.stopLoss * 100),
      timeoutProb: round(probabilities.timeout * 100),
      expRet: round(outlook.expectedBarrierReturnPct, 3),
      direction: directionLabel(outlook.direction),
      confidence: round(outlook.confidencePct),
      horizon: selected.horizon,
      targetLow: Number.isFinite(support) ? support : null,
      targetMid: Number.isFinite(anchor) ? anchor : null,
      targetHigh: target ?? (Number.isFinite(resistance) ? resistance : null),
    },
    highConfSignal: {
      fired: false,
      credibility: round(outlook.confidencePct),
      gate: 0.65,
      buyPrice: Number.isFinite(anchor) ? anchor : null,
      takeProfit: target,
      stopLoss: stop,
      label: `V2.1${selected.horizon}实验预测（非高把握信号）`,
    },
    reads: [
      `${heads.next30m.horizon}止盈概率${round(heads.next30m.probabilities.takeProfit * 100)}%，止损概率${round(heads.next30m.probabilities.stopLoss * 100)}%`,
      `${heads.sessionClose.horizon}止盈概率${round(heads.sessionClose.probabilities.takeProfit * 100)}%，止损概率${round(heads.sessionClose.probabilities.stopLoss * 100)}%`,
      `当前采用${selected.horizon}预测头，方向${directionLabel(outlook.direction)}，期望${round(outlook.expectedBarrierReturnPct, 3)}%`,
      refs
        ? `盘中锚点${refs.anchorPrice}，支撑${refs.supportPrice}，压力${refs.resistancePrice}`
        : '',
    ].filter(Boolean),
    asOf: prediction.asOf || null,
    model: prediction.model || null,
    v21: {
      session: prediction.session || null,
      activeHead: selectedName,
      heads,
      marketContext: prediction.marketContext || null,
      priceReferences: refs,
    },
  }
}

export function adaptV2Prediction(prediction, { price = null } = {}) {
  if (!prediction || typeof prediction !== 'object') {
    throw new Error('V2预测结果无效')
  }
  const stopLoss = probability(prediction.probabilities?.stopLoss, '止损')
  const timeout = probability(prediction.probabilities?.timeout, '超时')
  const takeProfit = probability(prediction.probabilities?.takeProfit, '止盈')
  if (Math.abs(stopLoss + timeout + takeProfit - 1) > 1e-5) {
    throw new Error('V2概率之和必须为1')
  }

  const fallbackExpected = takeProfit - stopLoss * 0.6
  const fallbackScore = Math.round((takeProfit - stopLoss + 1) * 50)
  const fallbackConfidencePct = round(
    Math.max(stopLoss, timeout, takeProfit) * 100,
  )
  const sortedProbabilities = [stopLoss, timeout, takeProfit]
    .sort((a, b) => b - a)
  const fallbackMarginPct = round(
    (sortedProbabilities[0] - sortedProbabilities[1]) * 100,
  )
  const fallbackEntropy = round(
    -[stopLoss, timeout, takeProfit]
      .filter((value) => value > 0)
      .reduce((sum, value) => sum + value * Math.log(value), 0)
      / Math.log(3),
    4,
  )
  const confidencePct = Number.isFinite(Number(prediction.outlook?.confidencePct))
    ? Number(prediction.outlook.confidencePct)
    : fallbackConfidencePct
  const probabilityMarginPct = Number.isFinite(Number(prediction.outlook?.probabilityMarginPct))
    ? Number(prediction.outlook.probabilityMarginPct)
    : fallbackMarginPct
  const normalizedEntropy = Number.isFinite(Number(prediction.outlook?.normalizedEntropy))
    ? Number(prediction.outlook.normalizedEntropy)
    : fallbackEntropy
  const outlook = {
    direction: prediction.outlook?.direction || (
      fallbackExpected > 0.15 ? 'bullish' : fallbackExpected < -0.15 ? 'bearish' : 'neutral'
    ),
    confidencePct,
    probabilityMarginPct,
    probabilityEdgePct: Number.isFinite(Number(prediction.outlook?.probabilityEdgePct))
      ? Number(prediction.outlook.probabilityEdgePct)
      : round((takeProfit - stopLoss) * 100),
    favorableToAdverseOdds: Number.isFinite(Number(prediction.outlook?.favorableToAdverseOdds))
      ? Number(prediction.outlook.favorableToAdverseOdds)
      : (stopLoss > 0 ? round(takeProfit / stopLoss, 3) : null),
    normalizedEntropy,
    uncertaintyLevel: prediction.outlook?.uncertaintyLevel || (
      normalizedEntropy <= 0.55
        ? 'low'
        : normalizedEntropy <= 0.8 ? 'medium' : 'high'
    ),
    convictionScore: Number.isFinite(Number(prediction.outlook?.convictionScore))
      ? Number(prediction.outlook.convictionScore)
      : Math.round(Math.max(0, Math.min(
        100,
        confidencePct * (1 - normalizedEntropy) + probabilityMarginPct,
      ))),
    expectedBarrierReturnPct: Number.isFinite(Number(prediction.outlook?.expectedBarrierReturnPct))
      ? Number(prediction.outlook.expectedBarrierReturnPct)
      : round(fallbackExpected, 3),
    directionScore: Number.isFinite(Number(prediction.outlook?.directionScore))
      ? Number(prediction.outlook.directionScore)
      : fallbackScore,
    riskLevel: prediction.outlook?.riskLevel || (stopLoss >= 0.45 ? 'high' : stopLoss >= 0.2 ? 'medium' : 'low'),
    signalStrength: prediction.outlook?.signalStrength || 'weak',
  }
  const predictedClass = String(prediction.predictedClass || '')
  const marketContext = prediction.marketContext && typeof prediction.marketContext === 'object'
    ? prediction.marketContext
    : null
  const priceReferences = prediction.priceReferences && typeof prediction.priceReferences === 'object'
    ? prediction.priceReferences
    : null
  const anchorPrice = Number(priceReferences?.anchorPrice)
  const supportPrice = Number(priceReferences?.supportPrice)
  const resistancePrice = Number(priceReferences?.resistancePrice)
  const takeProfitPrice = Number(priceReferences?.indicativeTakeProfitPrice)
  const stopLossPrice = Number(priceReferences?.indicativeStopLossPrice)
  const confidence = round(outlook.confidencePct)
  const margin = Number(outlook.probabilityMarginPct)
  const fired = predictedClass === 'TAKE_PROFIT'
    && confidence >= V2_HIGH_CONFIDENCE_GATE_PCT
    && Number.isFinite(margin)
    && margin >= 20
    && outlook.expectedBarrierReturnPct > 0.2

  return {
    ok: true,
    modelVersion: QUANT_MODEL_V2,
    selectedModelVersion: QUANT_MODEL_V2,
    runtimeModelVersion: 'v2.0-daily',
    modelLabel: quantModelLabel(QUANT_MODEL_V2),
    price: Number.isFinite(Number(price)) ? Number(price) : null,
    score: Math.max(0, Math.min(100, Math.round(outlook.directionScore))),
    bias: biasLabel(outlook.direction),
    tDir: directionLabel(outlook.direction),
    forecast: {
      upProb: round(takeProfit * 100),
      downProb: round(stopLoss * 100),
      timeoutProb: round(timeout * 100),
      expRet: round(outlook.expectedBarrierReturnPct, 3),
      direction: directionLabel(outlook.direction),
      confidence,
      horizon: '下一交易日',
      targetLow: Number.isFinite(supportPrice) ? supportPrice : null,
      targetMid: Number.isFinite(anchorPrice) ? anchorPrice : null,
      targetHigh: Number.isFinite(takeProfitPrice)
        ? takeProfitPrice
        : Number.isFinite(resistancePrice) ? resistancePrice : null,
    },
    highConfSignal: {
      fired,
      credibility: confidence,
      gate: V2_HIGH_CONFIDENCE_GATE_PCT,
      buyPrice: Number.isFinite(anchorPrice) ? anchorPrice : null,
      takeProfit: Number.isFinite(takeProfitPrice) ? takeProfitPrice : null,
      stopLoss: Number.isFinite(stopLossPrice) ? stopLossPrice : null,
      label: fired ? 'V2分钟模型高置信止盈类' : 'V2分钟模型观察',
    },
    reads: [
      `下一交易日止盈触发概率${round(takeProfit * 100)}%，止损触发概率${round(stopLoss * 100)}%`,
      `方向分${Math.round(outlook.directionScore)}，障碍期望收益${round(outlook.expectedBarrierReturnPct, 3)}%`,
      `置信度${confidence}%${Number.isFinite(margin) ? `，前两类概率差${round(margin)}%` : ''}`,
      marketContext
        ? `5分钟动量${round(marketContext.momentum30mPct)}%，实现波动${round(marketContext.realizedVolPct)}%`
        : '',
      marketContext
        ? `收盘位置${round(marketContext.closeLocationPct)}%，量能比${round(marketContext.volumeRatio20)}`
        : '',
      priceReferences
        ? `价格锚点${priceReferences.anchorPrice}，支撑${priceReferences.supportPrice}，压力${priceReferences.resistancePrice}`
        : '',
      priceReferences
        ? `参考止盈${priceReferences.indicativeTakeProfitPrice}，参考止损${priceReferences.indicativeStopLossPrice}，次日开盘后需重算`
        : '',
    ].filter(Boolean),
    asOf: prediction.asOf || null,
    model: prediction.model || null,
    v2: {
      predictedClass,
      probabilities: { stopLoss, timeout, takeProfit },
      outlook,
      marketContext,
      priceReferences,
      targetDefinition: prediction.targetDefinition || null,
    },
  }
}
