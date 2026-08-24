import { useEffect, useRef, useState } from 'react'
import { fetchDailyReport } from '../ai'
import { useAiSearchConfig } from '../aiSearchConfigStore'
import { humanizeAdviceTextFields } from '../../shared/userFacingLanguage.js'
import DailyReportSchedule from './DailyReportSchedule'
import Icon from './Icon'
import Md from './Md'
import SearchReference from './SearchReference'
import StockName from './StockName'

const SESSIONS = [
  { key: 'morning', label: '盘前早报' },
  { key: 'noon', label: '盘中午报' },
  { key: 'evening', label: '盘后晚报' },
]

function nowBJ() {
  const now = new Date()
  return new Date(
    now.getTime() + (now.getTimezoneOffset() + 480) * 60000,
  )
}

function autoSession() {
  const now = nowBJ()
  const minutes = now.getHours() * 60 + now.getMinutes()
  if (minutes < 690) return 'morning'
  if (minutes < 900) return 'noon'
  return 'evening'
}

function finite(value) {
  if (value == null || value === '' || value === '-') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function signed(value, suffix = '') {
  const parsed = finite(value)
  if (parsed == null) return '-'
  return `${parsed >= 0 ? '+' : ''}${parsed}${suffix}`
}

function marketTone(value) {
  const parsed = finite(value)
  if (parsed == null) return 'muted'
  return parsed >= 0 ? 'red' : 'green'
}

function price(value) {
  const parsed = finite(value)
  return parsed == null ? '-' : parsed.toFixed(2)
}

function yiFromYuan(value) {
  const parsed = finite(value)
  return parsed == null ? '-' : `${(parsed / 1e8).toFixed(2)}亿`
}

function evidenceTime(item) {
  return item?.publishedAt || item?.date || ''
}

function EvidenceIds({ ids }) {
  if (!Array.isArray(ids) || !ids.length) return null
  return (
    <span
      className="dr-evidence-ids"
      aria-label={`证据 ${ids.join('、')}`}
    >
      {ids.slice(0, 4).join(' · ')}
    </span>
  )
}

const DATA_REF_LABELS = {
  'sector-forecast': '板块前瞻',
  'technical-indicators': '日线技术指标',
  'overseas-market': '海外行情',
  'sector-flow': '板块资金',
  'eastmoney-movers': '东财异动榜',
  'morning-review': '早报验证',
  'daily-report-history': '日报历史',
  'closing-market': '收盘行情',
  'web-evidence': '网页证据',
}

function DataRefs({ refs }) {
  if (!Array.isArray(refs) || !refs.length) return null
  return (
    <span className="dr-v3-data-refs">
      数据：{refs.map((item) => DATA_REF_LABELS[item] || item).join(' · ')}
    </span>
  )
}

function FactSource({ source, at }) {
  return (
    <div className="dr-v3-fact-source">
      <span>来源：{source}</span>
      <time>截止：{at || '时间待核验'}</time>
    </div>
  )
}

function ReportSection({
  title,
  icon = 'clipboard',
  kind = 'analysis',
  label,
  children,
}) {
  const kicker = label || (
    kind === 'facts'
      ? '客观数据'
      : kind === 'action'
        ? '执行方案'
        : kind === 'risk' ? '边界' : '分析师观点'
  )
  return (
    <section className={`dr-v3-section dr-v3-kind-${kind}`}>
      <div className="dr-v3-section-head">
        <span className="dr-v3-kicker">{kicker}</span>
        <h3><Icon name={icon} size={14} />{title}</h3>
      </div>
      {children}
    </section>
  )
}

function MarketSnapshot({ data }) {
  const rows = [
    ...(data?.aIndices || []).map((item) => ({
      label: item.name,
      value: signed(item.pct, '%'),
      tone: marketTone(item.pct),
    })),
    ...(data?.overseas || []).map((item) => ({
      label: item.label,
      value: signed(item.pct, '%'),
      tone: marketTone(item.pct),
    })),
    ...(data?.commodities || []).map((item) => ({
      label: item.label,
      value: signed(item.pct, '%'),
      tone: marketTone(item.pct),
    })),
  ]
  if (!rows.length) return null
  return (
    <div className="dr-v3-tape" aria-label="市场快照">
      {rows.map((item, index) => (
        <span className="dr-v3-tape-item" key={`${item.label}-${index}`}>
          <span>{item.label}</span>
          <b className={item.tone}>{item.value}</b>
        </span>
      ))}
    </div>
  )
}

function EvidenceList({ rows }) {
  if (!Array.isArray(rows) || !rows.length) return null
  return (
    <div className="dr-v3-list">
      {rows.map((item, index) => (
        <article className="dr-v3-row" key={`${item.title}-${index}`}>
          <div className="dr-v3-row-head">
            <strong>{item.title}</strong>
            <EvidenceIds ids={item.evidenceIds} />
          </div>
          {item.summary && <p>{item.summary}</p>}
          <div className="dr-v3-source">
            <span>{item.source || '公开信息'}</span>
            <time>{evidenceTime(item) || '时间待核验'}</time>
          </div>
        </article>
      ))}
    </div>
  )
}

function PricePlan({ pricePlan }) {
  if (!pricePlan) return null
  const rows = [
    pricePlan.buyZone && {
      label: '关注区',
      value: `${price(pricePlan.buyZone.low)}-${price(pricePlan.buyZone.high)}`,
    },
    {
      label: '止损',
      value: price(pricePlan.stopLoss),
      tone: 'green',
    },
    pricePlan.sellZone && {
      label: '压力区',
      value: `${price(pricePlan.sellZone.low)}-${price(pricePlan.sellZone.high)}`,
    },
    {
      label: '止盈参考',
      value: price(pricePlan.takeProfit),
      tone: 'red',
    },
  ].filter((item) => item && item.value !== '-')
  if (!rows.length) return null
  return (
    <div className="dr-v3-price-grid">
      {rows.map((item) => (
        <span key={item.label}>
          <small>{item.label}</small>
          <b className={item.tone || ''}>{item.value}</b>
        </span>
      ))}
    </div>
  )
}

export function MorningReport({ rep, data }) {
  const analysis = rep.analysis || {}
  return (
    <>
      <ReportSection title="隔夜市场" icon="chart" kind="facts">
        <MarketSnapshot data={data} />
        <FactSource
          source="腾讯行情 / 东方财富行情"
          at={rep.hardData?.asOf}
        />
      </ReportSection>

      <ReportSection title="隔夜传导" icon="compass">
        <div className="dr-v3-list">
          {(analysis.transmission || []).map((item, index) => (
            <article className="dr-v3-row" key={`${item.signal}-${index}`}>
              <div className="dr-v3-row-head">
                <strong>{item.signal}</strong>
                <EvidenceIds ids={item.evidenceIds} />
              </div>
              <p>{item.reasoning}</p>
              <div className="dr-v3-action">{item.action}</div>
              <DataRefs refs={item.dataRefs} />
            </article>
          ))}
        </div>
      </ReportSection>

      <ReportSection title="政策与产业催化" icon="bolt">
        <EvidenceList rows={analysis.catalysts} />
      </ReportSection>

      {!!analysis.institutionFocus?.length && (
        <ReportSection title="机构观点与资金预期" icon="building">
          <EvidenceList rows={analysis.institutionFocus} />
        </ReportSection>
      )}

      <ReportSection title="今日板块池" icon="layers">
        <div className="dr-v3-list">
          {(analysis.sectorPool || []).map((item, index) => (
            <article className="dr-v3-row" key={`${item.name}-${index}`}>
              <div className="dr-v3-row-head">
                <strong>{item.rank ? `${item.rank}. ` : ''}{item.name}</strong>
                {finite(item.nextProbability) != null && (
                  <span className="dr-v3-metric">
                    次日 {item.nextProbability}%
                  </span>
                )}
                <EvidenceIds ids={item.evidenceIds} />
              </div>
              <p>{item.logic}</p>
              <div className="dr-v3-action">{item.action}</div>
              <DataRefs refs={item.dataRefs} />
            </article>
          ))}
        </div>
      </ReportSection>

      <ReportSection title="今日个股池" icon="target">
        <div className="dr-v3-list">
          {(analysis.stockPool || []).map((h, index) => (
            <article className="dr-v3-row dr-v3-stock" key={h.code || index}>
              <div className="dr-v3-row-head">
                <StockName code={h.code} name={h.name} />
                <span className="dr-v3-metric">{h.sector}</span>
                <EvidenceIds ids={h.evidenceIds} />
              </div>
              <p>{h.logic}</p>
              <PricePlan pricePlan={h.pricePlan} />
              {h.priceBasis && (
                <div className="dr-v3-price-basis">{h.priceBasis}</div>
              )}
              <div className="dr-v3-action">{h.action}</div>
              <DataRefs refs={h.dataRefs} />
            </article>
          ))}
        </div>
      </ReportSection>

      {analysis.openingPlan && (
        <ReportSection title="开盘执行顺序" icon="checkSquare">
          <p className="dr-v3-prose">{analysis.openingPlan}</p>
        </ReportSection>
      )}
    </>
  )
}

function MarketFacts({ hardData }) {
  const market = hardData?.market || {}
  const rows = [
    ['两市成交额', finite(market.amountYi) == null ? '-' : `${market.amountYi}亿`],
    finite(market.volVsAvg5) == null
      ? null
      : ['较5日均量', signed(market.volVsAvg5, '%')],
    ['量能', market.volLevel || '-'],
    ['上涨 / 下跌', finite(market.up) == null ? '-' : `${market.up} / ${market.down}`],
    ['涨停 / 跌停', finite(market.limitUp) == null ? '-' : `${market.limitUp} / ${market.limitDown}`],
  ].filter(Boolean)
  return (
    <div className="dr-v3-facts">
      {rows.map(([label, value]) => (
        <span key={label}><small>{label}</small><b>{value}</b></span>
      ))}
    </div>
  )
}

function SectorFlow({ rows }) {
  return (
    <div className="dr-v3-flow">
      {(rows || []).map((item, index) => (
        <div className="dr-v3-flow-row" key={`${item.name}-${index}`}>
          <span className="dr-v3-rank">{index + 1}</span>
          <strong>{item.name}</strong>
          <span className={finite(item.pct) >= 0 ? 'red' : 'green'}>
            {signed(item.pct, '%')}
          </span>
          <b className={finite(item.inflowYi) >= 0 ? 'red' : 'green'}>
            {signed(item.inflowYi, '亿')}
          </b>
        </div>
      ))}
    </div>
  )
}

function ReviewRows({ rows }) {
  const labels = {
    confirmed: '已验证',
    invalidated: '已证伪',
    pending: '待确认',
  }
  return (
    <div className="dr-v3-list">
      {(rows || []).map((item, index) => (
        <article
          className={`dr-v3-row status-${item.status || 'pending'}`}
          key={`${item.key || item.subject}-${index}`}
        >
          <div className="dr-v3-row-head">
            <strong>{item.subject}</strong>
            <span className="dr-v3-status">
              {labels[item.status] || labels.pending}
            </span>
          </div>
          <p>{item.actual}</p>
          <div className="dr-v3-reason">{item.reasoning}</div>
          <DataRefs refs={item.dataRefs} />
        </article>
      ))}
    </div>
  )
}

function ActionRows({ rows }) {
  return (
    <div className="dr-v3-list">
      {(rows || []).map((item, index) => (
        <article className="dr-v3-row" key={`${item.target}-${index}`}>
          <div className="dr-v3-row-head">
            <strong>{item.target}</strong>
            <span className={`dr-v3-action-tag action-${item.action}`}>
              {item.action}
            </span>
            <EvidenceIds ids={item.evidenceIds} />
          </div>
          <p>{item.condition || item.action}</p>
          {item.invalidation && (
            <div className="dr-v3-invalidation">
              取消条件：{item.invalidation}
            </div>
          )}
          <DataRefs refs={item.dataRefs} />
        </article>
      ))}
    </div>
  )
}

function Movers({ rows }) {
  if (!Array.isArray(rows) || !rows.length) return null
  return (
    <div className="dr-v3-movers">
      {rows.map((h, index) => (
        <div className="dr-v3-mover" key={h.code || index}>
          <StockName code={h.code} name={h.name} />
          <span className={finite(h.pct) >= 0 ? 'red' : 'green'}>
            {signed(h.pct, '%')}
          </span>
          <b>{yiFromYuan(h.mainInflow)}</b>
        </div>
      ))}
    </div>
  )
}

export function NoonReport({ rep }) {
  const hardData = rep.hardData || {}
  const analysis = rep.analysis || {}
  return (
    <>
      <ReportSection title="上午量能与资金" icon="chart" kind="facts">
        <MarketFacts hardData={hardData} />
        <SectorFlow rows={hardData.sectorFlowTop5} />
        <FactSource source="东方财富行情与板块资金" at={hardData.asOf} />
      </ReportSection>

      <ReportSection title="上午异动个股" icon="bolt" kind="facts">
        <Movers rows={hardData.movers} />
        <FactSource source="东方财富异动榜" at={hardData.asOf} />
      </ReportSection>

      <ReportSection title="早报验证" icon="checkSquare">
        <ReviewRows rows={analysis.morningReview} />
      </ReportSection>

      <ReportSection title="下午加 / 减 / 观望" icon="target">
        <ActionRows rows={analysis.afternoonActions} />
      </ReportSection>
    </>
  )
}

function LhbFacts({ data }) {
  const lhb = data || {}
  if (!lhb.stocks?.length && !lhb.seats?.length) {
    return <p className="dr-v3-empty">当日龙虎榜数据暂未发布。</p>
  }
  return (
    <div className="dr-v3-list">
      {(lhb.stocks || []).map((h, index) => (
        <article className="dr-v3-row dr-v3-lhb" key={h.code || index}>
          <div className="dr-v3-row-head">
            <StockName code={h.code} name={h.name} />
            <b className={finite(h.net) >= 0 ? 'red' : 'green'}>
              净额 {yiFromYuan(h.net)}
            </b>
          </div>
          <p>{h.reason || '上榜原因待披露'}</p>
        </article>
      ))}
      {!!lhb.seats?.length && (
        <div className="dr-v3-seat-line">
          活跃席位：
          {lhb.seats.slice(0, 5).map((item) =>
            `${item.alias || item.name} ${yiFromYuan(item.net)}`
          ).join(' · ')}
        </div>
      )}
    </div>
  )
}

function NorthboundFacts({ data }) {
  const north = data || {}
  return (
    <>
      <div className="dr-v3-facts">
        <span>
          <small>北向成交总额</small>
          <b>{finite(north.totalTurnoverYi) == null ? '-' : `${north.totalTurnoverYi}亿`}</b>
        </span>
        <span>
          <small>沪股通</small>
          <b>{finite(north.shTurnoverYi) == null ? '-' : `${north.shTurnoverYi}亿`}</b>
        </span>
        <span>
          <small>深股通</small>
          <b>{finite(north.szTurnoverYi) == null ? '-' : `${north.szTurnoverYi}亿`}</b>
        </span>
        <span>
          <small>净买额</small>
          <b>{north.netBuyDisclosure || '未披露'}</b>
        </span>
        {finite(north.dealCount) != null && (
          <span>
            <small>成交笔数</small>
            <b>{Number(north.dealCount).toLocaleString('zh-CN')}</b>
          </span>
        )}
      </div>
      {!!north.topStocks?.length && (
        <div className="dr-v3-flow">
          {north.topStocks.map((h, index) => (
            <div className="dr-v3-flow-row" key={h.code || index}>
              <span className="dr-v3-rank">{h.rank || index + 1}</span>
              <StockName code={h.code} name={h.name} />
              <span>{h.market}</span>
              <b>{finite(h.turnoverYi) == null ? '-' : `${h.turnoverYi}亿`}</b>
            </div>
          ))}
        </div>
      )}
      <p className="dr-v3-note">
        {north.note || '北向净买额按现行规则未披露，不以0代替。'}
      </p>
    </>
  )
}

export function EveningReport({ rep }) {
  const hardData = rep.hardData || {}
  const analysis = rep.analysis || {}
  return (
    <>
      <ReportSection title="全天量能与主线" icon="chart" kind="facts">
        <MarketFacts hardData={hardData} />
        <SectorFlow rows={hardData.sectorFlowTop5} />
        <FactSource source="东方财富行情与板块资金" at={hardData.asOf} />
      </ReportSection>

      <ReportSection title="龙虎榜" icon="trophy" kind="facts">
        <LhbFacts data={hardData.lhb} />
        <FactSource
          source={hardData.lhb?.source || '东方财富龙虎榜'}
          at={hardData.lhb?.date || hardData.asOf}
        />
      </ReportSection>

      <ReportSection title="北向成交" icon="coins" kind="facts">
        <NorthboundFacts data={hardData.northbound} />
        <FactSource
          source={hardData.northbound?.source || '互联互通公开数据'}
          at={hardData.northbound?.date || hardData.asOf}
        />
      </ReportSection>

      <ReportSection title="早报验证" icon="checkSquare">
        <ReviewRows rows={analysis.morningReview} />
      </ReportSection>

      {!!analysis.mainlines?.length && (
        <ReportSection title="收盘主线判断" icon="layers">
          <div className="dr-v3-list">
            {analysis.mainlines.map((item, index) => (
              <article className="dr-v3-row" key={`${item.name}-${index}`}>
                <div className="dr-v3-row-head">
                  <strong>{item.name}</strong>
                  <span className={finite(item.pct) >= 0 ? 'red' : 'green'}>
                    {signed(item.pct, '%')}
                  </span>
                  <b className={finite(item.inflowYi) >= 0 ? 'red' : 'green'}>
                    {signed(item.inflowYi, '亿')}
                  </b>
                </div>
                <p>{item.conclusion}</p>
                <DataRefs refs={item.dataRefs} />
              </article>
            ))}
          </div>
        </ReportSection>
      )}

      <ReportSection title="次日执行预案" icon="target" kind="action">
        <ActionRows rows={analysis.nextDayPlan} />
      </ReportSection>

      {!!analysis.overseasWatch?.length && (
        <ReportSection title="下一交易日海外观察" icon="compass">
          <div className="dr-v3-list">
            {analysis.overseasWatch.map((item, index) => (
              <article className="dr-v3-row" key={`${item.event}-${index}`}>
                <div className="dr-v3-row-head">
                  <strong>{item.event}</strong>
                  <EvidenceIds ids={item.evidenceIds} />
                </div>
                <p>{item.watch}</p>
              </article>
            ))}
          </div>
        </ReportSection>
      )}
    </>
  )
}

export function ReportFooter({ rep, result, newsRefs }) {
  return (
    <>
      <ReportSection title="执行结论" icon="target" kind="action">
        <div className="dr-v3-prose"><Md text={rep.strategy} /></div>
      </ReportSection>

      {!!rep.risks?.length && (
        <ReportSection title="风险提示" icon="shield" kind="risk">
          <div className="dr-v3-risks">
            {rep.risks.map((item, index) => (
              <p key={`${item}-${index}`}>{item}</p>
            ))}
          </div>
        </ReportSection>
      )}

      <SearchReference
        reference={result.searchReference}
        enabled={result.searchEnabled || result.searxngEnabled}
      />

      {!!newsRefs.length && (
        <section className="dr-v3-sources">
          <h3>来源与时间</h3>
          {newsRefs.map((item, index) => (
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              key={`${item.url}-${index}`}
            >
              <span>{item.id} · {item.src || '公开信息'}</span>
              <strong>{item.title}</strong>
              <time>{evidenceTime(item) || '时间待核验'}</time>
            </a>
          ))}
        </section>
      )}

      <div className="dr-disclaimer">
        {rep.disclaimer
          || '本报告不构成投资建议；数据以交易所及官方最终披露为准。'}
      </div>
    </>
  )
}

export default function DailyReport({ onClose }) {
  const [session, setSession] = useState(autoSession)
  const [state, setState] = useState({})
  const cacheRef = useRef({})
  const abortRef = useRef(null)
  const loadSeqRef = useRef(0)
  const searchConfig = useAiSearchConfig()
  const [scheduleOpen, setScheduleOpen] = useState(false)

  const load = async (selected, refresh) => {
    if (!refresh && cacheRef.current[selected]) {
      setState({ data: cacheRef.current[selected] })
      return
    }
    if (abortRef.current) abortRef.current.abort()
    const sequence = ++loadSeqRef.current
    setState({ loading: true, phase: '正在准备日报…' })
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const result = await fetchDailyReport({
      session: selected,
      refresh,
      signal: ctrl.signal,
      onPhase: (event) => {
        if (sequence === loadSeqRef.current) {
          setState((current) =>
            current.loading
              ? { ...current, phase: event.text }
              : current
          )
        }
      },
    })
    if (sequence !== loadSeqRef.current) return
    if (result?.ok) {
      cacheRef.current[selected] = result
      setState({ data: result })
    } else {
      setState({ error: result?.error || '生成失败' })
    }
  }

  useEffect(() => {
    cacheRef.current = {}
    load(session)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, searchConfig.enabled, searchConfig.updatedAt])

  useEffect(
    () => () => {
      if (abortRef.current) abortRef.current.abort()
    },
    [],
  )

  const result = state.data
  const rep = result?.report
    ? humanizeAdviceTextFields(result.report)
    : null
  const newsRefs = (result?.newsRefs || [])
    .filter((item) => item?.kind !== 'doubao_search')
    .filter((item) => item?.kind !== 'web_search')

  return (
    <div className="modal-mask mask-drawer" onClick={onClose}>
      <div
        className="dr-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="全市场投资策略日报"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dr-head">
          <div className="dr-title">
            <Icon name="clipboard" size={17} />
            全市场投资策略日报
          </div>
          <div className="dr-head-actions">
            {result && (
              <button
                className="icon-btn"
                title="刷新本场次"
                onClick={() => load(session, true)}
              >
                <Icon name="refresh" size={15} />
              </button>
            )}
            <button
              type="button"
              className={`icon-btn dr-auto-trigger${scheduleOpen ? ' active' : ''}`}
              aria-label="设置日报自动生成时间"
              aria-expanded={scheduleOpen}
              title="自动生成设置"
              onClick={() => setScheduleOpen((open) => !open)}
            >
              <Icon name="clock" size={15} />
            </button>
            <button
              type="button"
              className="modal-close"
              aria-label="关闭策略日报"
              onClick={onClose}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        </div>

        <div className="dr-sessions">
          {SESSIONS.map((item) => (
            <button
              type="button"
              key={item.key}
              className={`dr-sess-tab${session === item.key ? ' on' : ''}`}
              onClick={() => setSession(item.key)}
            >
              {item.label}
            </button>
          ))}
          {result && (
            <span className="dr-meta">
              {result.day} · {result.cached ? '已缓存' : '最新生成'}
              {result.degraded ? ' · 规则降级版' : ''}
            </span>
          )}
        </div>

        {scheduleOpen && <DailyReportSchedule />}

        <div className="dr-body">
          {state.loading && (
            <div className="dr-loading">
              <Icon name="refresh" size={14} className="spin" />
              {state.phase || '生成中…'}
            </div>
          )}
          {state.error && (
            <div className="dr-error">
              {state.error}
              <button
                type="button"
                className="expand-btn"
                onClick={() => load(session, true)}
              >
                重试
              </button>
            </div>
          )}

          {rep && (
            <>
              <div className="dr-v3-intro">
                <span>{rep.objective}</span>
                <div><Md text={rep.overview} /></div>
              </div>

              {session === 'morning' && (
                <MorningReport rep={rep} data={result.data} />
              )}
              {session === 'noon' && <NoonReport rep={rep} />}
              {session === 'evening' && <EveningReport rep={rep} />}

              <ReportFooter
                rep={rep}
                result={result}
                newsRefs={newsRefs}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
