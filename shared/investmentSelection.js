export const INVESTMENT_SELECTION_SCHEMA_VERSION = 'investment-selection.v1'

const THEMES = Object.freeze([
  {
    re: /人工智能|算力|数据要素|大模型|云计算|工业软件|信创|网络安全/,
    label: '数字经济与人工智能',
    strategicScore: 90,
    thesis: '数字基础设施、人工智能与关键软件自主可控方向',
  },
  {
    re: /半导体|芯片|光刻|先进封装|存储|第三代半导体|CPO|光模块/,
    label: '半导体与关键硬科技',
    strategicScore: 92,
    thesis: '关键硬科技自主可控与数字产业升级方向',
  },
  {
    re: /工业母机|机器人|高端制造|专精特新|智能制造|机器视觉|减速器/,
    label: '高端制造',
    strategicScore: 88,
    thesis: '高端制造、设备更新与产业链自主可控方向',
  },
  {
    re: /商业航天|卫星|低空经济|航空发动机|军工|北斗/,
    label: '空天与低空产业',
    strategicScore: 86,
    thesis: '空天信息、低空应用与高端装备产业化方向',
  },
  {
    re: /创新药|生物医药|医疗器械|合成生物|基因|细胞治疗/,
    label: '生命科学',
    strategicScore: 84,
    thesis: '人口健康需求、原创药械与生命科学创新方向',
  },
  {
    re: /储能|智能电网|特高压|固态电池|氢能|核聚变|风电|光伏|新能源/,
    label: '能源转型',
    strategicScore: 82,
    thesis: '新型能源体系、电网升级与低碳转型方向',
  },
  {
    re: /新材料|稀土|碳纤维|钛合金|有色金属|化工新材料/,
    label: '先进材料',
    strategicScore: 80,
    thesis: '先进制造上游材料安全与高性能材料升级方向',
  },
  {
    re: /粮食|种业|农业|农机|乡村振兴/,
    label: '粮食与农业科技',
    strategicScore: 78,
    thesis: '粮食安全、种源自主与农业现代化方向',
  },
  {
    re: /养老|银发|消费电子|国产品牌|文旅|服务消费/,
    label: '内需与人口结构',
    strategicScore: 74,
    thesis: '扩大内需、服务消费与人口结构变化方向',
  },
])

const finite = (value, fallback = 0) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

const clamp = (value, minimum = 0, maximum = 100) =>
  Math.max(minimum, Math.min(maximum, finite(value)))

const rounded = (value, digits = 1) => +finite(value).toFixed(digits)

const optionalNumber = (value) => {
  if (value === null || value === undefined || value === '') return NaN
  const number = Number(value)
  return Number.isFinite(number) ? number : NaN
}

function themeOf(name) {
  const text = String(name || '').trim()
  return THEMES.find((item) => item.re.test(text)) || null
}

function flowScore(row) {
  const inflowYi = finite(row?.mainInflow) / 1e8
  const ratio = finite(row?.mainRatio)
  const pct = finite(row?.pct)
  return clamp(
    50
      + Math.max(-20, Math.min(20, inflowYi * 2))
      + Math.max(-15, Math.min(15, ratio * 1.5))
      + Math.max(-10, Math.min(10, pct * 2)),
  )
}

function liquidityScore(amount) {
  const yi = Math.max(0, finite(amount) / 1e8)
  return clamp(Math.log10(yi + 1) / Math.log10(401) * 100)
}

export function rankInvestmentConcepts(rows = [], options = {}) {
  const limit = Math.max(1, Math.min(12, Number(options.limit) || 6))
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const theme = themeOf(row?.name)
      if (
        !theme
        || !/^BK\d+$/.test(String(row?.code || ''))
        || !/^\d{6}$/.test(String(row?.leadCode || ''))
        || finite(row?.amount) <= 0
      ) return null
      const capitalScore = flowScore(row)
      const liquidScore = liquidityScore(row.amount)
      const investmentScore = clamp(
        theme.strategicScore * 0.62
          + capitalScore * 0.28
          + liquidScore * 0.1,
      )
      return {
        ...row,
        investmentTheme: {
          schemaVersion: INVESTMENT_SELECTION_SCHEMA_VERSION,
          label: theme.label,
          strategicScore: theme.strategicScore,
          capitalScore: rounded(capitalScore),
          liquidityScore: rounded(liquidScore),
          investmentScore: rounded(investmentScore),
          fundConfirmed:
            finite(row.mainInflow) > 0 && finite(row.mainRatio) > 0,
          thesis: theme.thesis,
        },
      }
    })
    .filter(Boolean)
    .filter((item) =>
      item.investmentTheme.investmentScore >= 65
      && finite(item.pct) > -5
      && finite(item.mainRatio) > -8
    )
    .sort((left, right) =>
      right.investmentTheme.investmentScore
        - left.investmentTheme.investmentScore
      || finite(right.mainInflow) - finite(left.mainInflow)
      || String(left.code).localeCompare(String(right.code))
    )
    .slice(0, limit)
    .map((item, index) => ({
      ...item,
      investmentRank: index + 1,
    }))
}

function bandScore(value, idealLow, idealHigh, hardHigh) {
  const number = finite(value, NaN)
  if (!Number.isFinite(number) || number <= 0) return 30
  if (number >= idealLow && number <= idealHigh) return 100
  if (number < idealLow) return clamp(65 + number / idealLow * 35)
  if (number >= hardHigh) return 5
  return clamp(100 - (number - idealHigh) / (hardHigh - idealHigh) * 95)
}

export function scoreCompanyInvestmentQuality(row = {}) {
  const pe = optionalNumber(row.pe)
  const pb = optionalNumber(row.pb)
  const marketCap = optionalNumber(row.totalMarketCap)
  const valuationScore = (
    bandScore(pe, 8, 45, 180) * 0.65
      + bandScore(pb, 0.8, 5, 20) * 0.35
  )
  const scaleScore = Number.isFinite(marketCap) && marketCap > 0
    ? clamp(
        Math.log10(marketCap / 1e8 + 1)
          / Math.log10(3001) * 100,
      )
    : 30
  const capitalScore = flowScore(row)
  const stabilityScore = clamp(
    100
      - Math.max(0, Math.abs(finite(row.pct)) - 3) * 8
      - Math.max(0, finite(row.turnover) - 8) * 3,
  )
  const score = clamp(
    valuationScore * 0.3
      + scaleScore * 0.25
      + capitalScore * 0.3
      + stabilityScore * 0.15,
  )
  const evidence = []
  if (Number.isFinite(pe)) evidence.push(`PE ${rounded(pe)}`)
  if (Number.isFinite(pb)) evidence.push(`PB ${rounded(pb)}`)
  if (Number.isFinite(marketCap)) {
    evidence.push(`总市值${rounded(marketCap / 1e8, 0)}亿`)
  }
  if (row.mainInflow != null) {
    evidence.push(`主力${finite(row.mainInflow) >= 0 ? '净流入' : '净流出'}${rounded(Math.abs(finite(row.mainInflow)) / 1e8)}亿`)
  }
  return {
    schemaVersion: INVESTMENT_SELECTION_SCHEMA_VERSION,
    score: rounded(score),
    valuationScore: rounded(valuationScore),
    scaleScore: rounded(scaleScore),
    capitalScore: rounded(capitalScore),
    stabilityScore: rounded(stabilityScore),
    verified:
      Number.isFinite(pe) && pe > 0
      && Number.isFinite(pb) && pb > 0
      && Number.isFinite(marketCap) && marketCap > 0,
    evidence,
  }
}

export function isQualifiedInvestmentCandidate(item) {
  const profile = item?.investmentProfile
  return profile?.schemaVersion === INVESTMENT_SELECTION_SCHEMA_VERSION
    && profile.memberVerified === true
    && profile.companyQualityVerified === true
    && finite(profile.investmentScore) >= 65
}

export function buildInvestmentCandidates(
  concepts = [],
  membersByConcept = new Map(),
  options = {},
) {
  const perConcept = Math.max(
    1,
    Math.min(3, Number(options.perConcept) || 2),
  )
  const limit = Math.max(1, Math.min(20, Number(options.limit) || 12))
  const byCode = new Map()
  for (const concept of Array.isArray(concepts) ? concepts : []) {
    const members = membersByConcept instanceof Map
      ? membersByConcept.get(String(concept.code))
      : membersByConcept?.[concept.code]
    const selected = (Array.isArray(members) ? members : [])
      .filter((row) =>
        /^\d{6}$/.test(String(row?.code || ''))
        && String(row?.name || '')
        && !/(?:\*?ST|退市|退$)/i.test(String(row.name))
        && finite(row.price) > 0
        && finite(row.amount) >= 8e7
      )
      .map((row) => {
        const companyQuality = scoreCompanyInvestmentQuality(row)
        const investmentScore = clamp(
          finite(concept.investmentTheme?.investmentScore) * 0.5
            + companyQuality.score * 0.5,
        )
        return {
          ...row,
          tags: [
            `${concept.name}·产业价值`,
          ],
          investmentProfile: {
            schemaVersion: INVESTMENT_SELECTION_SCHEMA_VERSION,
            conceptCode: String(concept.code),
            conceptName: String(concept.name),
            themeLabel: concept.investmentTheme?.label || '',
            thesis: concept.investmentTheme?.thesis || '',
            strategicScore: finite(
              concept.investmentTheme?.strategicScore,
            ),
            conceptInvestmentScore: finite(
              concept.investmentTheme?.investmentScore,
            ),
            companyQualityScore: companyQuality.score,
            companyQualityVerified: companyQuality.verified,
            investmentScore: rounded(investmentScore),
            fundConfirmed:
              concept.investmentTheme?.fundConfirmed === true,
            memberVerified: true,
            evidence: companyQuality.evidence,
          },
        }
      })
      .filter(isQualifiedInvestmentCandidate)
      .sort((left, right) =>
        right.investmentProfile.investmentScore
          - left.investmentProfile.investmentScore
        || finite(right.mainInflow) - finite(left.mainInflow)
      )
      .slice(0, perConcept)
    for (const candidate of selected) {
      const current = byCode.get(String(candidate.code))
      if (
        !current
        || finite(candidate.investmentProfile.investmentScore)
          > finite(current.investmentProfile.investmentScore)
      ) {
        byCode.set(String(candidate.code), candidate)
      }
    }
  }
  return [...byCode.values()]
    .sort((left, right) =>
      finite(left.investmentProfile?.conceptCode)
        - finite(right.investmentProfile?.conceptCode)
      || right.investmentProfile.investmentScore
        - left.investmentProfile.investmentScore
    )
    .slice(0, limit)
}
