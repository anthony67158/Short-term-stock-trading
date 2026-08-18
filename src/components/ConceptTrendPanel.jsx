import { useMemo, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import Icon from './Icon'
import { usePolling } from '../hooks'
import { fmtInflow, fmtPct, fmtRaw, pctClass } from '../format'
import {
  filterConceptSectors,
  formatConceptCloseHistoryTooltip,
  formatConceptKlineTooltip,
  formatConceptTrendTooltip,
} from '../../shared/conceptTrend.js'

const KEY_TIMES = new Set(['09:30', '11:30', '13:00', '15:00'])

function compactAmount(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '--'
  if (Math.abs(number) >= 1e8) return `${(number / 1e8).toFixed(1)}亿`
  if (Math.abs(number) >= 1e4) return `${(number / 1e4).toFixed(0)}万`
  return String(Math.round(number))
}

function intradayOption(points, lineTone, areaTone) {
  const times = points.map((point) => point.time)
  const values = points.flatMap((point) => [point.pct, point.avgPct])
    .filter((value) => Number.isFinite(Number(value)))
    .map((value) => Math.abs(Number(value)))
  const bound = Math.max(
    1,
    Math.ceil((Math.max(0, ...values) + 0.1) * 10) / 10,
  )
  return {
    animation: false,
    grid: [
      { top: 18, left: 48, right: 48, height: '60%' },
      { left: 48, right: 48, top: '76%', bottom: 24 },
    ],
    tooltip: {
      trigger: 'axis',
      formatter: formatConceptTrendTooltip,
      backgroundColor: '#16181f',
      borderColor: '#30333d',
      textStyle: { color: '#f3f4f6', fontSize: 12 },
    },
    axisPointer: { link: [{ xAxisIndex: [0, 1] }] },
    xAxis: [
      {
        type: 'category',
        data: times,
        boundaryGap: false,
        axisLine: { lineStyle: { color: '#c7ccd6' } },
        axisTick: { show: false },
        axisLabel: { show: false },
      },
      {
        type: 'category',
        gridIndex: 1,
        data: times,
        boundaryGap: true,
        axisLine: { lineStyle: { color: '#c7ccd6' } },
        axisTick: { show: false },
        axisLabel: {
          color: '#7a8394',
          fontSize: 10,
          formatter: (value) => KEY_TIMES.has(value) ? value : '',
        },
      },
    ],
    yAxis: [
      {
        type: 'value',
        min: -bound,
        max: bound,
        axisLabel: {
          color: '#7a8394',
          fontSize: 10,
          formatter: (value) =>
            `${value > 0 ? '+' : ''}${value.toFixed(1)}%`,
        },
        splitLine: { lineStyle: { color: 'rgba(122,131,148,.18)' } },
      },
      {
        type: 'value',
        gridIndex: 1,
        axisLabel: { show: false },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '概念涨跌',
        type: 'line',
        data: points.map((point) => ({
          value: point.pct,
          price: point.price,
          avg: point.avg,
          volume: point.volume,
          amount: point.amount,
        })),
        showSymbol: false,
        sampling: 'lttb',
        lineStyle: { color: lineTone, width: 2 },
        itemStyle: { color: lineTone },
        areaStyle: { color: areaTone, opacity: 1 },
        markLine: {
          silent: true,
          symbol: 'none',
          label: { show: false },
          lineStyle: { color: '#9aa2b1', type: 'dashed', width: 1 },
          data: [{ yAxis: 0 }],
        },
      },
      {
        name: '分时均价',
        type: 'line',
        data: points.map((point) => point.avgPct),
        showSymbol: false,
        lineStyle: { color: '#b7841a', width: 1.2, type: 'dashed' },
        itemStyle: { color: '#b7841a' },
      },
      {
        name: '成交量',
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: points.map((point, index) => ({
          value: point.volume,
          itemStyle: {
            color: index === 0 || point.price >= points[index - 1].price
              ? 'rgba(224,67,47,.58)'
              : 'rgba(31,157,67,.58)',
          },
        })),
        barMaxWidth: 5,
      },
    ],
  }
}

function klineOption(points) {
  const dates = points.map((point) => point.date)
  const visibleCount = Math.min(points.length, 60)
  const start = points.length > visibleCount
    ? Math.max(0, 100 - visibleCount / points.length * 100)
    : 0
  return {
    animation: false,
    grid: [
      { top: 18, left: 56, right: 30, height: '58%' },
      { left: 56, right: 30, top: '73%', bottom: 36 },
    ],
    tooltip: {
      trigger: 'axis',
      formatter: formatConceptKlineTooltip,
      backgroundColor: '#16181f',
      borderColor: '#30333d',
      textStyle: { color: '#f3f4f6', fontSize: 12 },
    },
    axisPointer: { link: [{ xAxisIndex: [0, 1] }] },
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1], start, end: 100 },
      {
        type: 'slider',
        xAxisIndex: [0, 1],
        start,
        end: 100,
        bottom: 4,
        height: 16,
        borderColor: 'transparent',
        backgroundColor: 'rgba(122,131,148,.08)',
        fillerColor: 'rgba(45,125,246,.12)',
        handleStyle: { color: '#2d7df6' },
        textStyle: { color: '#7a8394', fontSize: 9 },
      },
    ],
    xAxis: [
      {
        type: 'category',
        data: dates,
        boundaryGap: true,
        axisLine: { lineStyle: { color: '#c7ccd6' } },
        axisTick: { show: false },
        axisLabel: { show: false },
      },
      {
        type: 'category',
        gridIndex: 1,
        data: dates,
        boundaryGap: true,
        axisLine: { lineStyle: { color: '#c7ccd6' } },
        axisTick: { show: false },
        axisLabel: {
          color: '#7a8394',
          fontSize: 10,
          formatter: (value) => value.slice(5),
        },
      },
    ],
    yAxis: [
      {
        scale: true,
        axisLabel: { color: '#7a8394', fontSize: 10 },
        splitLine: { lineStyle: { color: 'rgba(122,131,148,.18)' } },
      },
      {
        type: 'value',
        gridIndex: 1,
        axisLabel: { show: false },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '概念K线',
        type: 'candlestick',
        data: points.map((point) => ({
          value: [point.open, point.close, point.low, point.high],
          ...point,
        })),
        itemStyle: {
          color: '#e0432f',
          color0: '#1f9d43',
          borderColor: '#e0432f',
          borderColor0: '#1f9d43',
        },
      },
      {
        name: '成交量',
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: points.map((point) => ({
          value: point.volume,
          itemStyle: {
            color: point.close >= point.open
              ? 'rgba(224,67,47,.58)'
              : 'rgba(31,157,67,.58)',
          },
        })),
        barMaxWidth: 8,
      },
    ],
  }
}

function closeHistoryOption(points) {
  const dates = points.map((point) => point.date)
  return {
    animation: false,
    grid: [
      { top: 18, left: 56, right: 30, height: '58%' },
      { left: 56, right: 30, top: '73%', bottom: 36 },
    ],
    tooltip: {
      trigger: 'axis',
      formatter: formatConceptCloseHistoryTooltip,
      backgroundColor: '#16181f',
      borderColor: '#30333d',
      textStyle: { color: '#f3f4f6', fontSize: 12 },
    },
    axisPointer: { link: [{ xAxisIndex: [0, 1] }] },
    xAxis: [
      {
        type: 'category',
        data: dates,
        boundaryGap: false,
        axisLine: { lineStyle: { color: '#c7ccd6' } },
        axisTick: { show: false },
        axisLabel: { show: false },
      },
      {
        type: 'category',
        gridIndex: 1,
        data: dates,
        boundaryGap: true,
        axisLine: { lineStyle: { color: '#c7ccd6' } },
        axisTick: { show: false },
        axisLabel: {
          color: '#7a8394',
          fontSize: 10,
          formatter: (value) => value.slice(5),
        },
      },
    ],
    yAxis: [
      {
        scale: true,
        axisLabel: { color: '#7a8394', fontSize: 10 },
        splitLine: { lineStyle: { color: 'rgba(122,131,148,.18)' } },
      },
      {
        type: 'value',
        gridIndex: 1,
        axisLabel: {
          color: '#7a8394',
          fontSize: 9,
          formatter: (value) => `${value > 0 ? '+' : ''}${value}%`,
        },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '历史收盘',
        type: 'line',
        data: points.map((point) => ({
          value: point.close,
          ...point,
        })),
        showSymbol: false,
        lineStyle: { color: '#2d7df6', width: 2 },
        itemStyle: { color: '#2d7df6' },
        areaStyle: { color: 'rgba(45,125,246,.10)' },
      },
      {
        name: '主力净占比',
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: points.map((point) => ({
          value: point.mainRatio,
          itemStyle: {
            color: Number(point.mainRatio) >= 0
              ? 'rgba(224,67,47,.58)'
              : 'rgba(31,157,67,.58)',
          },
        })),
        barMaxWidth: 8,
      },
    ],
  }
}

export default function ConceptTrendPanel({ interval, onInspect }) {
  const [rankMode, setRankMode] = useState('main')
  const [selectedCode, setSelectedCode] = useState('')
  const [query, setQuery] = useState('')
  const [chartMode, setChartMode] = useState('intraday')
  const sectors = usePolling(
    `/api/sectors?type=concept&sort=${rankMode}`,
    interval,
    [rankMode],
  )
  const allSectors = useMemo(
    () => filterConceptSectors(sectors.data?.list || '')
      .map((item, index) => ({ ...item, rank: index + 1 })),
    [sectors.data],
  )
  const ranked = useMemo(
    () => filterConceptSectors(allSectors, query),
    [allSectors, query],
  )
  const selected = allSectors.find((item) => item.code === selectedCode)
    || allSectors[0]
    || null
  const trendUrl = selected
    ? chartMode === 'intraday'
      ? `/api/sector_history?code=${selected.code}&mode=intraday`
      : `/api/sector_history?code=${selected.code}&mode=kline&period=${chartMode}&v=15`
    : null
  const trend = usePolling(
    trendUrl,
    interval,
    [selected?.code, chartMode],
  )
  const matches = trend.data?.code === selected?.code
    && (
      chartMode === 'intraday'
        ? trend.data?.mode === 'intraday'
        : trend.data?.mode === 'kline' && trend.data?.period === chartMode
    )
  const points = matches && Array.isArray(trend.data?.points)
    ? trend.data.points
    : []
  const summary = matches ? trend.data?.summary : null
  const historyFormat = matches ? trend.data?.format : null
  const lineTone = (summary?.pct || 0) >= 0 ? '#e0432f' : '#1f9d43'
  const areaTone = (summary?.pct || 0) >= 0
    ? 'rgba(224,67,47,.10)'
    : 'rgba(31,157,67,.10)'

  const option = useMemo(
    () => {
      if (chartMode === 'intraday') {
        return intradayOption(points, lineTone, areaTone)
      }
      return historyFormat === 'close-line'
        ? closeHistoryOption(points)
        : klineOption(points)
    },
    [areaTone, chartMode, historyFormat, lineTone, points],
  )

  return (
    <section className="panel concept-trend-panel">
      <div className="panel-head">
        <div role="heading" aria-level="2" className="panel-title">
          <Icon name="activity" size={16} /> 概念走势
          <span className="sub-name">全量概念 · 分时与历史K线</span>
        </div>
        <div className="tabs" role="group" aria-label="概念排行方式">
          <button type="button" className={'tab' + (rankMode === 'main' ? ' active' : '')}
            aria-pressed={rankMode === 'main'} onClick={() => setRankMode('main')}>资金</button>
          <button type="button" className={'tab' + (rankMode === 'pct' ? ' active' : '')}
            aria-pressed={rankMode === 'pct'} onClick={() => setRankMode('pct')}>涨幅</button>
        </div>
      </div>

      {sectors.loading && !sectors.data ? (
        <div className="loading">正在加载概念板块…</div>
      ) : sectors.error && allSectors.length === 0 ? (
        <div className="empty err">概念排行暂时不可用，稍后自动重试</div>
      ) : (
        <div className="concept-trend-layout">
          <div className="concept-rank-pane">
            <div className="concept-rank-tools">
              <label className="concept-search">
                <Icon name="search" size={13} />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索全部概念"
                  aria-label="搜索概念名称或代码"
                />
              </label>
              <span>共 {allSectors.length} 个概念</span>
            </div>
            <div className="concept-rank" role="listbox" aria-label="概念板块排行">
              {ranked.map((item) => (
                <button type="button" key={item.code}
                  className={'concept-rank-item' + (selected?.code === item.code ? ' active' : '')}
                  aria-selected={selected?.code === item.code}
                  onClick={() => setSelectedCode(item.code)}>
                  <span className="concept-rank-no">{item.rank}</span>
                  <span className="concept-rank-name">{item.name}</span>
                  <b className={pctClass(item.pct)}>{fmtPct(item.pct)}</b>
                  <span className={pctClass(item.mainInflow)}>{fmtInflow(item.mainInflow)}</span>
                </button>
              ))}
              {ranked.length === 0 && (
                <div className="empty small">没有匹配的概念</div>
              )}
            </div>
          </div>

          <div className="concept-trend-main">
            <div className="concept-chart-toolbar">
              <div className="tabs" role="group" aria-label="概念走势周期">
                <button type="button" className={'tab' + (chartMode === 'intraday' ? ' active' : '')}
                  aria-pressed={chartMode === 'intraday'} onClick={() => setChartMode('intraday')}>分时</button>
                <button type="button" className={'tab' + (chartMode === 'day' ? ' active' : '')}
                  aria-pressed={chartMode === 'day'} onClick={() => setChartMode('day')}>日K</button>
                <button type="button" className={'tab' + (chartMode === 'week' ? ' active' : '')}
                  aria-pressed={chartMode === 'week'} onClick={() => setChartMode('week')}>周K</button>
                <button type="button" className={'tab' + (chartMode === 'month' ? ' active' : '')}
                  aria-pressed={chartMode === 'month'} onClick={() => setChartMode('month')}>月K</button>
              </div>
              {chartMode !== 'intraday' && historyFormat === 'close-line' && (
                <span className="concept-format-note">真实收盘趋势</span>
              )}
            </div>
            {selected && (
              <div className="concept-trend-summary">
                <div className="concept-trend-identity">
                  <div>
                    <b>{selected.name}</b>
                    <span>{selected.code}</span>
                  </div>
                  <strong className={pctClass(summary?.pct ?? selected.pct)}>
                    {fmtPct(summary?.pct ?? selected.pct)}
                  </strong>
                </div>
                <div className="concept-trend-metrics">
                  <span>指数 <b>{fmtRaw(summary?.latest ?? selected.price)}</b></span>
                  {historyFormat === 'close-line' ? (
                    <>
                      <span>周期涨跌 <b className={pctClass(summary?.pct)}>{fmtPct(summary?.pct)}</b></span>
                      <span>样本 <b>{summary?.sampleCount || '--'} 期</b></span>
                      <span>主力净占 <b className={pctClass(summary?.mainRatio)}>{summary?.mainRatio == null ? '--' : `${summary.mainRatio > 0 ? '+' : ''}${summary.mainRatio.toFixed(2)}%`}</b></span>
                    </>
                  ) : (
                    <>
                      <span>振幅 <b>{summary?.amplitude == null ? '--' : `${summary.amplitude.toFixed(2)}%`}</b></span>
                      <span>成交额 <b>{compactAmount(summary?.amount)}</b></span>
                      <span>主力 <b className={pctClass(selected.mainInflow)}>{fmtInflow(selected.mainInflow)}</b></span>
                    </>
                  )}
                </div>
              </div>
            )}

            {(trend.loading || !matches) && (
              <div className="loading concept-trend-loading">
                正在加载{chartMode === 'intraday' ? '概念分时' : '历史K线'}…
              </div>
            )}
            {!trend.loading && trend.error && points.length === 0 && (
              <div className="empty err">
                该概念{chartMode === 'intraday' ? '分时' : '历史K线'}暂时不可用
              </div>
            )}
            {!trend.loading && matches && !trend.error && points.length === 0 && (
              <div className="empty">
                该概念暂无可用{chartMode === 'intraday' ? '分时' : '历史K线'}数据
              </div>
            )}
            {points.length > 0 && (
              <div className="concept-trend-chart">
                <ReactECharts option={option} className="concept-trend-echart" notMerge lazyUpdate />
              </div>
            )}

            <div className="concept-trend-foot">
              <span>
                数据日 {
                  chartMode === 'intraday'
                    ? trend.data?.tradingDate || '--'
                    : trend.data?.summary?.lastDate || '--'
                }
                {chartMode === 'intraday' && trend.data?.summary?.lastTime
                  ? ` ${trend.data.summary.lastTime}`
                  : ''}
                {' · '}
                {trend.data?.source || (
                  chartMode === 'intraday'
                    ? '东方财富概念板块行情'
                    : '东方财富概念板块历史行情'
                )}
              </span>
              {selected && (
                <button type="button" className="row-btn" onClick={() => onInspect?.(selected)}>
                  看成分股 <Icon name="chevronRight" size={12} />
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
