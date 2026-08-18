import { useMemo, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import { openStockDetail } from '../detailStore'
import { useTheme } from '../themeStore'
import {
  nextPortfolioHeatmapCode,
} from '../../shared/portfolioHeatmapInteraction'

function money(value) {
  const amount = Math.abs(Number(value) || 0)
  const sign = Number(value) < 0 ? '-' : ''
  if (amount >= 1e8) return `${sign}${(amount / 1e8).toFixed(2)}亿`
  if (amount >= 1e4) return `${sign}${(amount / 1e4).toFixed(2)}万`
  return `${sign}${amount.toFixed(0)}`
}

function signedPct(value) {
  if (value === null || value === undefined || value === '') return '--'
  const number = Number(value)
  if (!Number.isFinite(number)) return '--'
  return `${number >= 0 ? '+' : ''}${number.toFixed(2)}%`
}

function portfolioChangeColor(value, theme) {
  const pct = Number(value)
  if (!Number.isFinite(pct) || Math.abs(pct) < 0.005) {
    return theme === 'light'
      ? 'oklch(91% 0.008 255)'
      : 'oklch(24% 0.012 255)'
  }
  const normalized = Math.min(Math.abs(pct) / 5, 1)
  const lightness = theme === 'light'
    ? 87 - normalized * 41
    : 38 - normalized * 9
  const chroma = 0.035 + normalized * 0.165
  const hue = pct > 0 ? 25 : 145
  return `oklch(${lightness.toFixed(1)}% ${chroma.toFixed(3)} ${hue})`
}

function shouldUseDarkHeatLabel(value, theme) {
  const pct = Number(value)
  if (theme !== 'light') return false
  if (!Number.isFinite(pct)) return true
  return Math.min(Math.abs(pct) / 5, 1) < 0.58
}

function ChangeValue({ amount, pct, tone }) {
  if (pct == null) {
    return <b className={`portfolio-heatmap-detail-change ${tone}`}>--</b>
  }
  return (
    <b className={`portfolio-heatmap-detail-change ${tone}`}>
      <span>{amount >= 0 ? '+' : ''}{money(amount)}</span>
      <small>{signedPct(pct)}</small>
    </b>
  )
}

function PersistentDetails({ item }) {
  if (!item) return null
  const value = item
  const pnlTone = Number(value.floatPnl) > 0 ? 'red'
    : Number(value.floatPnl) < 0 ? 'green' : 'flat'
  const dayTone = Number(value.dayPct) > 0 ? 'red'
    : Number(value.dayPct) < 0 ? 'green' : 'flat'
  return (
    <div className="portfolio-heatmap-detail" aria-live="polite">
      <div className="portfolio-heatmap-detail-identity">
        <small>{value.concept}</small>
        <b>{value.name}</b>
        <span>{value.code} · {value.category}</span>
      </div>
      <div>
        <span>账户占比</span>
        <b>{value.accountWeightPct.toFixed(2)}%</b>
      </div>
      <div>
        <span>持仓内占比</span>
        <b>{value.holdingWeightPct.toFixed(2)}%</b>
      </div>
      <div>
        <span>持仓市值</span>
        <b>{money(value.marketValue)}</b>
      </div>
      <div>
        <span>今日涨跌</span>
        <ChangeValue
          amount={value.dayPnl}
          pct={value.dayPct}
          tone={dayTone}
        />
      </div>
      <div>
        <span>浮动盈亏</span>
        <ChangeValue
          amount={value.floatPnl}
          pct={value.floatPct}
          tone={pnlTone}
        />
      </div>
    </div>
  )
}

export default function PortfolioHeatmap({ distribution }) {
  const theme = useTheme()
  const groups = distribution?.groups || []
  const stocks = distribution?.stocks || []
  const [activeCode, setActiveCode] = useState('')
  const activeView = useMemo(() => {
    const requestedCode = activeCode || stocks[0]?.code
    return stocks.find((item) => item.code === requestedCode)
      || stocks[0]
      || null
  }, [activeCode, stocks])
  const chartBorder = theme === 'light'
    ? 'oklch(98% 0.004 255)'
    : 'oklch(12% 0.01 255)'
  const groupSurface = theme === 'light'
    ? 'oklch(92% 0.01 255)'
    : 'oklch(22% 0.014 255)'
  const groupInk = theme === 'light'
    ? 'oklch(26% 0.018 255)'
    : 'oklch(92% 0.008 255)'
  const groupMutedInk = theme === 'light'
    ? 'oklch(48% 0.018 255)'
    : 'oklch(70% 0.012 255)'
  const riseInk = theme === 'light'
    ? 'oklch(52% 0.19 25)'
    : 'oklch(74% 0.16 25)'
  const fallInk = theme === 'light'
    ? 'oklch(48% 0.15 145)'
    : 'oklch(72% 0.14 145)'
  const option = useMemo(() => ({
    animation: false,
    aria: {
      enabled: true,
      description: `持仓分布热力图，共${stocks.length}只个股、${groups.length}个核心概念。面积表示账户仓位，颜色表示当日涨跌，红涨绿跌且幅度越大颜色越深。`,
    },
    tooltip: {
      show: false,
      triggerOn: 'none',
    },
    series: [{
      id: 'portfolio-distribution',
      type: 'treemap',
      roam: false,
      nodeClick: false,
      breadcrumb: { show: false },
      animation: false,
      animationDurationUpdate: 0,
      emphasis: {
        disabled: true,
      },
      width: '100%',
      height: '100%',
      top: 2, left: 2, right: 2, bottom: 2,
      squareRatio: 1,
      visibleMin: 12,
      upperLabel: {
        show: true,
        height: 28,
        color: groupInk,
        fontSize: 11,
        fontWeight: 650,
        padding: [4, 8],
        formatter(params) {
          const weight = Number(params?.data?.accountWeightPct)
          if (!params?.name || !Number.isFinite(weight)) return ''
          const dayPct = params?.data?.dayPct
          const dayStyle = dayPct > 0 ? 'groupRise'
            : dayPct < 0 ? 'groupFall' : 'groupFlat'
          const weightText = `仓 ${weight.toFixed(1)}%`
          return `{groupName|${params.name}}  {groupWeight|${weightText}}  {${dayStyle}|${signedPct(dayPct)}}`
        },
        rich: {
          groupName: {
            color: groupInk,
            fontSize: 11,
            fontWeight: 700,
          },
          groupWeight: {
            color: groupMutedInk,
            fontSize: 10,
            fontWeight: 600,
          },
          groupRise: {
            color: riseInk,
            fontSize: 11,
            fontWeight: 750,
          },
          groupFall: {
            color: fallInk,
            fontSize: 11,
            fontWeight: 750,
          },
          groupFlat: {
            color: groupMutedInk,
            fontSize: 11,
            fontWeight: 650,
          },
        },
      },
      label: {
        show: true,
        formatter(params) {
          const stock = params?.data?.stock
          if (!stock) return params.name
          const darkLabel = shouldUseDarkHeatLabel(stock.dayPct, theme)
          const nameStyle = darkLabel ? 'nameDark' : 'nameLight'
          const weightStyle = darkLabel ? 'weightDark' : 'weightLight'
          const dayStyle = darkLabel ? 'dayDark' : 'dayLight'
          return `{${nameStyle}|${stock.name}}\n{${weightStyle}|仓 ${stock.accountWeightPct.toFixed(1)}%}\n{${dayStyle}|今 ${signedPct(stock.dayPct)}}`
        },
        rich: {
          nameLight: {
            color: 'oklch(97% 0.006 255)',
            fontSize: 12,
            fontWeight: 650,
            lineHeight: 18,
          },
          weightLight: {
            color: 'oklch(90% 0.012 255)',
            fontSize: 11,
            fontWeight: 600,
            lineHeight: 15,
          },
          dayLight: {
            color: 'oklch(98% 0.006 255)',
            fontSize: 12,
            fontWeight: 750,
            lineHeight: 17,
          },
          nameDark: {
            color: 'oklch(22% 0.018 255)',
            fontSize: 12,
            fontWeight: 650,
            lineHeight: 18,
          },
          weightDark: {
            color: 'oklch(34% 0.018 255)',
            fontSize: 11,
            fontWeight: 650,
            lineHeight: 15,
          },
          dayDark: {
            color: 'oklch(24% 0.018 255)',
            fontSize: 12,
            fontWeight: 750,
            lineHeight: 17,
          },
        },
      },
      itemStyle: {
        borderColor: chartBorder,
        borderWidth: 2,
        gapWidth: 2,
        borderRadius: 4,
      },
      levels: [
        {
          upperLabel: { show: false },
          itemStyle: {
            borderWidth: 0,
            gapWidth: 2,
          },
        },
        {
          upperLabel: { show: true },
          itemStyle: {
            borderColor: chartBorder,
            borderWidth: 2,
            gapWidth: 3,
            borderRadius: 4,
          },
        },
        {
          itemStyle: {
            borderColor: chartBorder,
            borderWidth: 2,
            gapWidth: 2,
            borderRadius: 4,
          },
        },
      ],
      data: groups.map((group) => ({
        name: group.name,
        value: group.marketValue,
        accountWeightPct: group.accountWeightPct,
        dayPct: group.dayPct,
        itemStyle: { color: groupSurface },
        children: group.children.map((stock) => ({
          name: stock.name,
          value: stock.marketValue,
          code: stock.code,
          stock,
          itemStyle: {
            color: portfolioChangeColor(stock.dayPct, theme),
          },
        })),
      })),
    }],
  }), [
    chartBorder,
    fallInk,
    groupInk,
    groupMutedInk,
    groupSurface,
    groups,
    riseInk,
    stocks.length,
    theme,
  ])

  const onEvents = useMemo(() => ({
    mouseover(params) {
      setActiveCode((current) =>
        nextPortfolioHeatmapCode(current, params)
      )
    },
    click(params) {
      setActiveCode((current) =>
        nextPortfolioHeatmapCode(current, params)
      )
      const stock = params?.data?.stock
      if (stock?.code) openStockDetail(stock.code, stock.name)
    },
  }), [])

  const totalDayTone = Number(distribution?.dayPct) > 0 ? 'red'
    : Number(distribution?.dayPct) < 0 ? 'green' : 'flat'

  return (
    <div className="portfolio-heatmap">
      <div className="portfolio-heatmap-meta">
        <span>持仓市值 <b>{money(distribution?.investedValue)}</b></span>
        <span>
          今日涨跌
          <b className={totalDayTone}>
            {distribution?.dayPct == null
              ? '--'
              : `${distribution.dayPnl >= 0 ? '+' : ''}${money(distribution.dayPnl)} · ${signedPct(distribution.dayPct)}`}
          </b>
        </span>
        <span>总仓位 <b>{Number(distribution?.positionPct || 0).toFixed(1)}%</b></span>
        <span>现金预留 <b>{Number(distribution?.cashReservePct || 0).toFixed(1)}%</b></span>
        <span>核心概念 <b>{groups.length}</b></span>
      </div>
      <div className="portfolio-heatmap-canvas">
        <ReactECharts
          option={option}
          className="portfolio-heatmap-chart"
          notMerge={false}
          lazyUpdate
          onEvents={onEvents}
        />
      </div>
      <PersistentDetails item={activeView} />
      <div className="portfolio-heatmap-legend">
        <span>面积 = 账户仓位</span>
        <span className="portfolio-change-scale">
          <small>跌 -5%</small><i aria-hidden="true" /><small>涨 +5%</small>
        </span>
        <span>颜色 = 当日涨跌 · 红涨绿跌，越深幅度越大 · 悬停看明细，点击进详情</span>
      </div>
    </div>
  )
}
