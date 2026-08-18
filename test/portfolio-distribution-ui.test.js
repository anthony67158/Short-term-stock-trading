import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  nextPortfolioHeatmapCode,
} from '../shared/portfolioHeatmapInteraction.js'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const account = read('src/components/AccountTab.jsx')
const heatmap = read('src/components/PortfolioHeatmap.jsx')
const styles = read('src/styles/precision.css')

test('账户页使用概念分层持仓热力图替代线性持仓条', () => {
  assert.match(account, /import PortfolioHeatmap from '\.\/PortfolioHeatmap'/)
  assert.match(account, /<PortfolioHeatmap/)
  assert.match(account, /buildPortfolioDistribution\(\s*portfolio,\s*stockTags,\s*\{\},\s*quote,\s*\)/s)
  assert.doesNotMatch(account, /className="acc-holdlist"/)
})

test('热力图支持悬停数值与点击个股详情侧栏', () => {
  assert.match(heatmap, /type: 'treemap'/)
  assert.match(heatmap, /tooltip:/)
  assert.match(heatmap, /账户占比/)
  assert.match(heatmap, /持仓内占比/)
  assert.match(heatmap, /openStockDetail\(/)
  assert.match(heatmap, /onEvents=/)
})

test('持仓热力图用面积表达仓位并以红涨绿跌表达当日幅度', () => {
  assert.match(heatmap, /portfolioChangeColor/)
  assert.match(heatmap, /useTheme\(\)/)
  assert.doesNotMatch(heatmap, /const HUES/)
  assert.doesNotMatch(heatmap, /hsl\(/)
  assert.doesNotMatch(heatmap, /stock\.intensity/)
  assert.match(heatmap, /stock\.dayPct/)
  assert.match(heatmap, /今/)
  assert.match(heatmap, /面积 = 账户仓位/)
  assert.match(heatmap, /红涨绿跌/)
  assert.match(heatmap, /portfolio-change-scale/)
  assert.match(heatmap, /top: 2, left: 2, right: 2, bottom: 2/)
  assert.match(heatmap, /borderRadius: 4/)
  assert.match(heatmap, /portfolio-heatmap-legend/)
  assert.doesNotMatch(heatmap, /portfolio-heatmap-stocklist/)
})

test('热力图根节点不渲染虚假的仓位和涨跌占位符', () => {
  assert.match(
    heatmap,
    /if \(!params\?\.name \|\| !Number\.isFinite\(weight\)\) return ''/,
  )
  assert.match(
    heatmap,
    /levels:\s*\[\s*\{\s*upperLabel:\s*\{\s*show:\s*false\s*\}/s,
  )
})

test('持仓热力图关闭浮动Tooltip并保持图表实例稳定', () => {
  assert.match(heatmap, /tooltip:\s*{\s*show:\s*false/s)
  assert.doesNotMatch(heatmap, /alwaysShowContent/)
  assert.doesNotMatch(heatmap, /triggerOn:\s*'mousemove/)
  assert.match(heatmap, /notMerge=\{false\}/)
})

test('最近悬浮个股进入常驻详情条且概念事件不会覆盖', () => {
  assert.match(heatmap, /mouseover/)
  assert.match(heatmap, /nextPortfolioHeatmapCode/)
  assert.match(heatmap, /portfolio-heatmap-detail/)
  assert.match(heatmap, /aria-live="polite"/)
  assert.match(heatmap, /activeCode\s*\|\|\s*stocks\[0\]\?\.code/)
  assert.doesNotMatch(heatmap, /globalout[^}]*setActiveItem\(null\)/s)

  const stockParams = {
    data: {
      stock: {
        code: '600519',
      },
    },
  }
  const groupParams = {
    data: {
      name: '白酒',
    },
    name: '白酒',
  }
  assert.equal(nextPortfolioHeatmapCode('', stockParams), '600519')
  assert.equal(
    nextPortfolioHeatmapCode('600519', stockParams),
    '600519',
  )
  assert.equal(
    nextPortfolioHeatmapCode('600519', groupParams),
    '600519',
  )
})

test('持仓详情条使用高对比字体并严格红涨绿跌', () => {
  assert.match(heatmap, /const pnlTone = Number\(value\.floatPnl\) > 0 \? 'red'[\s\S]*< 0 \? 'green'/)
  assert.match(heatmap, /const dayTone = Number\(value\.dayPct\) > 0 \? 'red'[\s\S]*< 0 \? 'green'/)
  assert.match(heatmap, /<span>今日涨跌<\/span>/)
  assert.match(heatmap, /portfolio-heatmap-detail-change/)
  assert.match(styles, /\.portfolio-heatmap-detail b\.red\s*{\s*color:\s*var\(--color-up\)/s)
  assert.match(styles, /\.portfolio-heatmap-detail b\.green\s*{\s*color:\s*var\(--color-down\)/s)
  assert.match(styles, /\.portfolio-heatmap-detail b\s*{[\s\S]*font-size:\s*var\(--text-sm\)/)
  assert.match(styles, /\.portfolio-heatmap-detail span,[\s\S]*color:\s*var\(--color-ink-2\)/)
  assert.match(styles, /\.portfolio-heatmap-detail-change\s*{[^}]*display:\s*flex[^}]*overflow:\s*visible/s)
  assert.match(styles, /\.portfolio-change-scale i\s*{[\s\S]*linear-gradient\([\s\S]*var\(--portfolio-fall\)[\s\S]*var\(--portfolio-flat\)[\s\S]*var\(--portfolio-rise\)/)
})

test('热力图具有稳定桌面和移动端尺寸', () => {
  assert.match(styles, /\.portfolio-heatmap-chart\s*{[^}]*height:/s)
  assert.match(styles, /\.portfolio-heatmap-legend\s*{/)
  assert.match(
    styles,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.portfolio-heatmap-chart\s*{[^}]*height:/s,
  )
})
