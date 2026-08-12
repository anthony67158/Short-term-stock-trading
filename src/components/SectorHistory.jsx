import ReactECharts from 'echarts-for-react'
import { usePolling } from '../hooks'

export default function SectorHistory({ sector }) {
  const { data } = usePolling(
    sector ? `/api/sector_history?code=${sector.code}&days=10` : null,
    600000,
    [sector && sector.code]
  )
  const series = (data && data.series) || []
  if (!sector || series.length === 0) return null

  const dates = series.map((s) => s.date.slice(5))
  const inflows = series.map((s) => +(s.mainInflow / 1e8).toFixed(2))

  const option = {
    grid: { top: 28, right: 12, bottom: 24, left: 44 },
    tooltip: { trigger: 'axis', formatter: (p) => `${p[0].axisValue}<br/>主力净流入: ${p[0].data} 亿` },
    xAxis: { type: 'category', data: dates, axisLabel: { color: '#7a8394', fontSize: 10 }, axisLine: { lineStyle: { color: '#232838' } } },
    yAxis: { type: 'value', axisLabel: { color: '#7a8394', fontSize: 10, formatter: '{value}亿' }, splitLine: { lineStyle: { color: '#1a1f2e' } } },
    series: [{
      type: 'bar',
      data: inflows.map((v) => ({ value: v, itemStyle: { color: v >= 0 ? '#ff4d4f' : '#22c55e' } })),
      barWidth: '55%',
    }],
  }

  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <div className="panel-head">
        <div role="heading" aria-level="2" className="panel-title">{sector.name} · 近10日主力资金流</div>
        <div className="legend">复盘用：连续净流入=资金持续做多</div>
      </div>
      <div style={{ padding: 8 }}>
        <ReactECharts option={option} style={{ height: 220 }} notMerge />
      </div>
    </div>
  )
}
