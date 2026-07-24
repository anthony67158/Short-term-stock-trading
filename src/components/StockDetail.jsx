import { useState, useMemo, useEffect, useRef } from 'react'
import ReactECharts from 'echarts-for-react'
import Icon from './Icon'
import { usePolling } from '../hooks'
import { fmtPct, pctClass } from '../format'
import { aiStore } from '../aiStore'

// 个股详情弹窗：代码 + 主营业务 + K线图
export default function StockDetail({ stock, onClose }) {
  const [klt, setKlt] = useState('101') // 101日 102周 103月
  const [chartType, setChartType] = useState('candle') // candle | line
  const { data, loading, error, reload } = usePolling(
    stock ? `/api/stock_detail?code=${stock.code}&klt=${klt}&lmt=120` : null,
    600000, // 详情不需要频繁刷新
    [stock && stock.code, klt]
  )

  const profile = data && data.profile
  const candles = (data && data.candles) || []

  // K线为空时自动重试（东财偶发空响应）：最多重试 2 次，间隔递增
  const retryRef = useRef(0)
  useEffect(() => {
    retryRef.current = 0 // 换股/换周期时重置
  }, [stock && stock.code, klt])
  useEffect(() => {
    if (!stock) return
    // 加载完成、无错误，但 candles 为空 → 说明数据源瞬时空，自动重试
    if (!loading && data && candles.length === 0 && retryRef.current < 2) {
      retryRef.current += 1
      const t = setTimeout(() => reload(), 500 * retryRef.current)
      return () => clearTimeout(t)
    }
    // eslint-disable-next-line
  }, [loading, data, candles.length])

  const retrying = !loading && data && candles.length === 0 && retryRef.current < 2

  // 计算 N 日均线
  const ma = (arr, n) =>
    arr.map((_, i) => {
      if (i < n - 1) return '-'
      let sum = 0
      for (let j = 0; j < n; j++) sum += arr[i - j].close
      return +(sum / n).toFixed(2)
    })

  const option = useMemo(() => {
    if (!candles.length) return null
    const dates = candles.map((c) => c.date)
    const ohlc = candles.map((c) => [c.open, c.close, c.low, c.high])
    const closes = candles.map((c) => c.close)
    const ma5 = ma(candles, 5)
    const ma10 = ma(candles, 10)
    const ma20 = ma(candles, 20)
    const vols = candles.map((c) => ({
      value: c.volume,
      itemStyle: { color: c.close >= c.open ? 'rgba(244,97,78,.55)' : 'rgba(63,185,80,.55)' },
    }))

    const isLine = chartType === 'line'
    const priceSeries = isLine
      ? [
          {
            name: '收盘价', type: 'line', data: closes,
            smooth: true, symbol: 'none',
            lineStyle: { color: '#5b8def', width: 2 },
            areaStyle: {
              color: {
                type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                colorStops: [
                  { offset: 0, color: 'rgba(91,141,239,.28)' },
                  { offset: 1, color: 'rgba(91,141,239,.02)' },
                ],
              },
            },
          },
        ]
      : [
          {
            name: 'K线', type: 'candlestick', data: ohlc,
            itemStyle: { color: '#f4614e', color0: '#3fb950', borderColor: '#f4614e', borderColor0: '#3fb950' },
          },
        ]

    // 均线（两种模式都叠加）
    const maSeries = [
      { name: 'MA5', type: 'line', data: ma5, smooth: true, symbol: 'none', lineStyle: { color: '#e3b341', width: 1 } },
      { name: 'MA10', type: 'line', data: ma10, smooth: true, symbol: 'none', lineStyle: { color: '#7c6bf5', width: 1 } },
      { name: 'MA20', type: 'line', data: ma20, smooth: true, symbol: 'none', lineStyle: { color: '#3fb950', width: 1 } },
    ]

    return {
      animation: false,
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      legend: {
        data: isLine ? ['收盘价', 'MA5', 'MA10', 'MA20'] : ['MA5', 'MA10', 'MA20'],
        top: 0, right: 8, textStyle: { color: '#767881', fontSize: 10 },
        itemWidth: 14, itemHeight: 8,
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#16181f', borderColor: '#23252d',
        textStyle: { color: '#e6e7ea', fontSize: 12 },
        formatter: (ps) => {
          const k = candles[ps[0].dataIndex]
          if (!k) return ''
          return `${k.date}<br/>开 ${k.open} 收 ${k.close}<br/>高 ${k.high} 低 ${k.low}<br/>涨跌 ${fmtPct(k.pct)}`
        },
      },
      grid: [
        { left: 52, right: 16, top: 24, height: '58%' },
        { left: 52, right: 16, top: '74%', height: '18%' },
      ],
      xAxis: [
        { type: 'category', data: dates, boundaryGap: true, axisLabel: { color: '#767881', fontSize: 10 }, axisLine: { lineStyle: { color: '#23252d' } }, splitLine: { show: false } },
        { type: 'category', gridIndex: 1, data: dates, axisLabel: { show: false }, axisLine: { lineStyle: { color: '#23252d' } } },
      ],
      yAxis: [
        { scale: true, axisLabel: { color: '#767881', fontSize: 10 }, splitLine: { lineStyle: { color: '#16181f' } } },
        { scale: true, gridIndex: 1, axisLabel: { show: false }, splitLine: { show: false } },
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1], start: 55, end: 100 },
        { type: 'slider', xAxisIndex: [0, 1], bottom: 4, height: 14, start: 55, end: 100, borderColor: '#23252d', textStyle: { color: '#767881', fontSize: 9 }, fillerColor: 'rgba(124,107,245,.15)' },
      ],
      series: [
        ...priceSeries,
        ...maSeries,
        { name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: vols },
      ],
    }
  }, [candles, chartType])

  if (!stock) return null

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="detail-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-bar">
          <div className="modal-title">
            {(profile && profile.name) || stock.name}
            <span className="detail-code">{stock.code}</span>
            {profile && profile.market && <span className="detail-market">{profile.market}</span>}
          </div>
          <div className="modal-close" onClick={onClose}><Icon name="close" size={16} /></div>
        </div>

        <div className="detail-scroll">
          {/* 公司信息 */}
          {profile && (
            <div className="detail-info">
              {profile.fullName && <div className="detail-full">{profile.fullName}</div>}
              <div className="detail-meta">
                {profile.industry && <span className="detail-chip"><Icon name="building" size={12} /> {profile.industry}</span>}
                {profile.website && <span className="detail-chip"><Icon name="compass" size={12} /> {profile.website}</span>}
              </div>
              {profile.business && (
                <div className="detail-block">
                  <div className="detail-label">主营业务</div>
                  <div className="detail-text">{profile.business}</div>
                </div>
              )}
              {profile.intro && (
                <div className="detail-block">
                  <div className="detail-label">公司简介</div>
                  <div className="detail-text detail-intro">{profile.intro}</div>
                </div>
              )}
            </div>
          )}

          {/* K线 */}
          <div className="detail-kline">
            <div className="detail-kline-head">
              <div className="detail-label" style={{ margin: 0 }}>K 线图</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <div className="tabs">
                  <div className={'tab' + (chartType === 'candle' ? ' active' : '')} onClick={() => setChartType('candle')}>蜡烛图</div>
                  <div className={'tab' + (chartType === 'line' ? ' active' : '')} onClick={() => setChartType('line')}>折线图</div>
                </div>
                <div className="tabs">
                  {[['101', '日K'], ['102', '周K'], ['103', '月K']].map(([v, t]) => (
                    <div key={v} className={'tab' + (klt === v ? ' active' : '')} onClick={() => setKlt(v)}>{t}</div>
                  ))}
                </div>
              </div>
            </div>
            {(loading && !data) || retrying ? (
              <div className="loading">{retrying ? '数据源繁忙，正在重试加载 K 线…' : '加载 K 线中…'}</div>
            ) : option ? (
              <ReactECharts
                key={`${stock.code}-${klt}-${chartType}-${candles.length}`}
                option={option}
                style={{ height: 340, width: '100%' }}
                notMerge lazyUpdate={false}
                opts={{ renderer: 'canvas' }}
                onChartReady={(chart) => { setTimeout(() => chart.resize(), 60) }}
              />
            ) : (
              <div className="empty">
                {error ? 'K 线数据暂不可用' : '未获取到 K 线数据'}
                <button className="btn" style={{ marginLeft: 10 }} onClick={() => { retryRef.current = 0; reload() }}>
                  <Icon name="refresh" size={13} /> 重试
                </button>
              </div>
            )}
          </div>

          {/* 在统一 AI 助手中分析该股 */}
          <div style={{ padding: '12px 4px 4px', textAlign: 'center' }}>
            <button
              className="btn btn-primary"
              onClick={() => { aiStore.focusStock({ code: stock.code, name: (profile && profile.name) || stock.name }); onClose() }}
            >
              <Icon name="spark" size={14} /> 在 AI 助手中分析 / 提问这只票
            </button>
          </div>

          <div className="ai-disclaimer" style={{ padding: '10px 4px 0' }}>
            数据来源：东方财富公开接口 · 仅供研究参考，非投资建议
          </div>
        </div>
      </div>
    </div>
  )
}
