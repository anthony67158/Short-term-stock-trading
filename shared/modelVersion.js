export const QUANT_MODEL_DEFAULT = 'default'
export const QUANT_MODEL_V2 = 'v2'

export function normalizeQuantModelVersion(value) {
  return String(value || '').toLowerCase() === QUANT_MODEL_V2
    ? QUANT_MODEL_V2
    : QUANT_MODEL_DEFAULT
}

export function quantModelLabel(value) {
  return normalizeQuantModelVersion(value) === QUANT_MODEL_V2
    ? '分钟 Transformer V2'
    : '当前生产模型'
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
    && confidence >= 65
    && Number.isFinite(margin)
    && margin >= 20
    && outlook.expectedBarrierReturnPct > 0.2

  return {
    ok: true,
    modelVersion: QUANT_MODEL_V2,
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
      gate: 0.65,
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
