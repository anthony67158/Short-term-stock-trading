import ReactECharts from 'echarts-for-react'
import { usePolling } from '../hooks'
import {
  buildSectorFlowView,
  formatSectorFlowTooltip,
} from '../../shared/sectorFlowHistory.js'
import { fmtInflow, pctClass } from '../format'
import Icon from './Icon'

const EMPTY_SERIES = []

export default function SectorHistory({ sector }) {
  const { data, loading, error } = usePolling(
    sector ? `/api/sector_history?code=${sector.code}&days=10` : null,
    600000,
    [sector && sector.code]
  )
  if (!sector) return null

  const matchesSector = data?.code === sector.code
  const series = matchesSector && Array.isArray(data?.series) ? data.series : EMPTY_SERIES
  const view = buildSectorFlowView(series)
  const waiting = !matchesSector && !error
  const streakLabel = view.streak > 0
    ? `连续流入 ${view.streak}日`
    : view.streak < 0
      ? `连续流出 ${Math.abs(view.streak)}日`
      : '暂无连续方向'
  const relationTone = ['价资共振', '逆势承接'].includes(view.relation)
    ? 'red'
    : ['上涨流出', '同步走弱'].includes(view.relation)
      ? 'green'
      : ''

  const option = {
    animationDuration: 240,
    grid: { top: 30, right: 46, bottom: 28, left: 46 },
    tooltip: {
      trigger: 'axis',
      formatter: formatSectorFlowTooltip,
      backgroundColor: '#16181f',
      borderColor: '#30333d',
      textStyle: { color: '#f3f4f6', fontSize: 12 },
    },
    xAxis: {
      type: 'category',
      data: view.dates,
      axisLabel: { color: '#7a8394', fontSize: 10 },
      axisLine: { lineStyle: { color: '#c7ccd6' } },
      axisTick: { show: false },
    },
    yAxis: [
      {
        type: 'value',
        name: '净占比',
        nameTextStyle: { color: '#7a8394', fontSize: 10 },
        axisLabel: { color: '#7a8394', fontSize: 10, formatter: '{value}%' },
        splitLine: { lineStyle: { color: 'rgba(122,131,148,.18)' } },
      },
      {
        type: 'value',
        name: '涨跌',
        nameTextStyle: { color: '#7a8394', fontSize: 10 },
        axisLabel: { color: '#7a8394', fontSize: 10, formatter: '{value}%' },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '主力净占比',
        type: 'bar',
        data: series.map((item) => ({
          value: item.mainRatio,
          mainInflow: item.mainInflow,
          pct: item.pct,
          itemStyle: { color: item.mainRatio >= 0 ? '#f4614e' : '#3fb950' },
        })),
        barMaxWidth: 30,
      },
      {
        name: '板块涨跌',
        type: 'line',
        yAxisIndex: 1,
        data: view.pcts,
        connectNulls: false,
        symbol: 'circle',
        symbolSize: 5,
        lineStyle: { color: '#d99a2b', width: 2 },
        itemStyle: { color: '#d99a2b' },
      },
    ],
  }

  return (
    <div className="panel sector-flow-panel">
      <div className="panel-head">
        <div role="heading" aria-level="2" className="panel-title"><Icon name="history" size={16} />{sector.name} · 近10日资金强度</div>
        <div className="sector-flow-legend" aria-label="图表图例">
          <span><i className="sector-flow-key flow" />主力净占比</span>
          <span><i className="sector-flow-key price" />板块涨跌</span>
        </div>
      </div>
      {(loading || waiting) && <div className="loading">正在加载板块历史数据…</div>}
      {!loading && error && series.length === 0 && (
        <div className="empty err">历史数据源暂时不可用，稍后自动重试</div>
      )}
      {!loading && !waiting && !error && series.length === 0 && (
        <div className="empty">该板块暂无可用的历史资金样本</div>
      )}
      {series.length > 0 && (
        <>
          <div className="sector-flow-summary" aria-label={`近${view.sampleDays}日资金摘要`}>
            <div>
              <span>流入天数</span>
              <b>{view.inflowDays}/{view.sampleDays}日</b>
            </div>
            <div>
              <span>当前连续</span>
              <b className={pctClass(view.streak)}>{streakLabel}</b>
            </div>
            <div>
              <span>近5日净额</span>
              <b className={pctClass(view.fiveDayNetYi)}>
                {view.fiveDayNetYi == null ? '--' : fmtInflow(view.fiveDayNetYi * 1e8)}
              </b>
            </div>
            <div>
              <span>当日价资</span>
              <b className={relationTone}>{view.relation}</b>
            </div>
          </div>
          <div className="sector-flow-chart">
            <ReactECharts option={option} className="sector-flow-echart" notMerge />
          </div>
        </>
      )}
    </div>
  )
}
