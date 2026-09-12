import { useMemo } from 'react'
import Icon from './Icon'
import OpportunityRadar from './OpportunityRadar'
import ErrorBoundary from './ErrorBoundary'
import AccountRiskStrip from './AccountRiskStrip'
import { fmtRaw } from '../format'
import { openStockDetail } from '../detailStore'
import { todayCommandList } from '../planStore'
import { deriveMarketRegime } from '../../shared/marketRegime.js'
import { buildAccountRiskContext } from '../../shared/accountRiskBudget.js'

// ============ 今日决策：先定方向，再核验个股 ============
export default function TodayTab({
  market,
  book,
  quotes = [],
}) {
  const quoteMap = useMemo(
    () => Object.fromEntries(
      quotes.filter((item) => item?.code)
        .map((item) => [item.code, item]),
    ),
    [quotes],
  )
  const risk = useMemo(
    () => buildAccountRiskContext(book, quoteMap),
    [book, quoteMap],
  )
  const regime = useMemo(
    () => deriveMarketRegime(market || {}),
    [market],
  )
  const commands = useMemo(
    () => todayCommandList(
      quoteMap,
      Date.now(),
      {
        currentRisk: risk,
        marketRegime: regime,
      },
    ),
    [book, quoteMap, risk, regime],
  )

  return (
    <div className="today">
      <AccountRiskStrip
        book={book}
        quotes={quoteMap}
        risk={risk}
      />
      <CombatCommandCenter
        commands={commands}
        regime={regime}
        risk={risk}
        onOpen={openStockDetail}
      />
      <ErrorBoundary label="机会雷达">
        <OpportunityRadar />
      </ErrorBoundary>
    </div>
  )
}

const COMMAND_STATE = {
  CONFLICT: {
    label: '先处理冲突',
    tone: 'danger',
    icon: 'shield',
  },
  READY_EXIT: {
    label: '现在退出风险',
    tone: 'sell',
    icon: 'sell',
  },
  READY: {
    label: '现在可执行',
    tone: 'buy',
    icon: 'target',
  },
  RISK_EXIT: {
    label: '持仓风险',
    tone: 'danger',
    icon: 'shield',
  },
  RECORD: {
    label: '待记录实际成交',
    tone: 'warning',
    icon: 'edit',
  },
  RISK_BLOCKED: {
    label: '风险条件变化',
    tone: 'danger',
    icon: 'shield',
  },
  CONFIRMING: {
    label: '到价确认中',
    tone: 'warning',
    icon: 'clock',
  },
  MARKET_CLOSED: {
    label: '下个交易时段',
    tone: 'waiting',
    icon: 'clock',
  },
  WAITING: {
    label: '等待条件',
    tone: 'waiting',
    icon: 'clock',
  },
}

function commandTime(value) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function CommandRow({ command, onOpen }) {
  const state = COMMAND_STATE[command.state]
    || COMMAND_STATE.WAITING
  return (
    <button
      type="button"
      className="combat-command-row"
      data-tone={state.tone}
      onClick={() => onOpen(command.code, command.name)}
    >
      <span className="combat-command-state">
        <Icon name={state.icon} size={14} />
        {state.label}
      </span>
      <span className="combat-command-stock">
        <strong>{command.name}</strong>
        <small>{command.code}</small>
      </span>
      <span className="combat-command-action">
        <strong>{command.actionLabel}</strong>
        {command.quantity && <b>{command.quantity}</b>}
      </span>
      <span className="combat-command-condition">
        {command.keyPrice != null
          ? `关键价 ${fmtRaw(command.keyPrice)}`
          : command.instruction || '查看完整条件'}
      </span>
      <span className="combat-command-risk">
        {command.riskAmount != null && (
          <small>
            计划风险约 {Math.round(command.riskAmount)}元
          </small>
        )}
        {command.validUntil && (
          <small>有效至 {commandTime(command.validUntil)}</small>
        )}
      </span>
      <Icon name="chevronRight" size={15} />
    </button>
  )
}

function CombatCommandCenter({
  commands,
  regime,
  risk,
  onOpen,
}) {
  const urgent = commands.filter((item) =>
    [
      'CONFLICT',
      'RISK_EXIT',
      'READY_EXIT',
      'READY',
      'RECORD',
    ].includes(item.state)
  )
  const waiting = commands.filter((item) =>
    [
      'RISK_BLOCKED',
      'CONFIRMING',
      'MARKET_CLOSED',
      'WAITING',
    ].includes(item.state)
  ).slice(0, 6)
  const allowance = regime.allowRiskIncrease === true
    && risk?.complete
    && risk?.breaker?.allowRiskIncrease === true
    ? '允许在风险预算内执行'
    : commands.some((item) => item.state === 'READY')
      ? '仅按已核定小仓预案执行'
      : '暂停新增风险'
  return (
    <section
      className="panel combat-command-center"
      aria-label="今日作战指令"
    >
      <div className="combat-command-head">
        <div>
          <div className="panel-title">
            <Icon name="flag" size={16} /> 今日作战指令
          </div>
          <p>
            {allowance} · {regime.label || '市场状态待确认'}
          </p>
        </div>
        <div className="combat-command-counts">
          <span>现在处理 <b>{urgent.length}</b></span>
          <span>等待条件 <b>{waiting.length}</b></span>
        </div>
      </div>
      <div className="combat-command-group">
        <h2>现在处理</h2>
        {urgent.length ? urgent.map((command) => (
          <CommandRow
            key={
              `${command.code}-`
              + `${command.executionPlanId || 'advice'}`
            }
            command={command}
            onOpen={onOpen}
          />
        )) : (
          <p className="combat-command-empty">
            当前没有需要立即处理的操作。
          </p>
        )}
      </div>
      {waiting.length > 0 && (
        <div className="combat-command-group waiting">
          <h2>等待条件</h2>
          {waiting.map((command) => (
            <CommandRow
              key={
                `${command.code}-`
                + `${command.executionPlanId || 'advice'}`
              }
              command={command}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </section>
  )
}
