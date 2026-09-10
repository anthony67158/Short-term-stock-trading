import { useEffect, useState } from 'react'
import Icon from './Icon'
import {
  adviceJobState,
  adviceReviewCardState,
} from '../../shared/adviceUiState.js'
import { visibleAiSources } from '../../shared/aiSearchUi.js'
import { cancelAdvice, getRunning, isRunning, subscribeRunner } from '../adviceRunner'
import { cancelOne, getBatchState, subscribeBatch } from '../adviceBatch'

export function useAdviceGeneration(code) {
  const [, forceRender] = useState(0)
  useEffect(() => {
    const update = () => forceRender((value) => value + 1)
    const stopRunner = subscribeRunner(update)
    const stopBatch = subscribeBatch(update)
    return () => { stopRunner(); stopBatch() }
  }, [code])

  if (!code) return null
  if (isRunning(code)) {
    const running = getRunning(code)
    const canceling = !!running?.cancelRequested
    return {
      active: true,
      status: canceling ? 'canceling' : 'running',
      stage: String(running?.stage || ''),
      label: canceling ? '正在取消评估' : (running?.phase || 'V3决策更新中'),
      cancelable: !canceling,
      cloud: false,
      deepMode: running?.deepMode === true,
      sources: Array.isArray(running?.sources) ? running.sources : [],
      reasoning: String(running?.reasoning || ''),
      quant: running?.quant || null,
      model: String(running?.model || ''),
      endpoint: String(running?.endpoint || ''),
    }
  }
  const batch = getBatchState()
  return adviceJobState(batch, code)
    || adviceJobState(batch, code, { role: 'review' })
}

export function useAdviceReviewCardState(
  code,
  alerts = [],
  { adviceAt = 0 } = {},
) {
  const [, forceRender] = useState(0)
  useEffect(() => {
    const update = () => forceRender((value) => value + 1)
    return subscribeBatch(update)
  }, [code])

  const state = adviceReviewCardState(
    getBatchState(),
    code,
    { alerts, adviceAt },
  )

  useEffect(() => {
    if (!['done', 'failed', 'stopped'].includes(state?.kind)) return undefined
    const timer = window.setTimeout(
      () => forceRender((value) => value + 1),
      2 * 60 * 1000,
    )
    return () => window.clearTimeout(timer)
  }, [state?.kind])

  return state
}

export default function AdviceGenerationStatus({
  code,
  variant = 'card',
  detailState = null,
  searchEnabled = false,
}) {
  const generation = useAdviceGeneration(code)
  const active = generation?.active || detailState?.loading
  if (!active) return null
  const reviewing = generation?.role === 'review'
  if (generation?.silent && variant !== 'detail') return null

  const cancel = (event) => {
    event.stopPropagation()
    if (!generation?.cancelable) return
    if (generation.cloud) {
      void cancelOne(code)
    } else {
      cancelAdvice(code)
      void cancelOne(code)
    }
  }

  if (variant === 'detail') {
    const view = {
      ...(detailState || {}),
      ...(generation || {}),
      phase:
        generation?.label
        || detailState?.phase
        || '正在准备V3评估',
    }
    const sources = visibleAiSources(searchEnabled, view.sources)
    const ordered = [
      { key: 'collect', label: '读取行情' },
      { key: 'quant', label: 'V3评估' },
      { key: 'finalize', label: '核定并保存' },
    ]
    const activeIndex = Math.max(0, ordered.findIndex((step) => step.key === view.stage))
    const steps = ordered.map((step, index) => ({
      ...step, state: index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'pending',
    }))
    return (
      <section
        className={
          'advice-generation-flow'
          + (view.deepMode ? ' deep' : ' quick')
        }
        aria-live="polite"
        aria-busy="true"
      >
        <div className="generation-flow-head">
          <div className="generation-flow-title">
            <span className="generation-live-dot" aria-hidden="true" />
            <div>
              <b>
                {reviewing
                  ? generation?.silent
                    ? '后台数据检查中'
                    : '到价确认进行中'
                  : 'V3决策更新中'}
              </b>
              <span>{view.phase}</span>
            </div>
          </div>
          {generation?.cancelable && (
            <button
              type="button"
              className="generation-cancel"
              onClick={cancel}
              aria-label={`停止${code}的V3评估`}
              title="停止本次评估"
            >
              <Icon name="close" size={13} />
              <span>停止</span>
            </button>
          )}
        </div>
        <ol className="generation-flow-steps">
          {steps.map((step, index) => (
            <li key={step.key} data-state={step.state}>
              <span aria-hidden="true">
                {step.state === 'done'
                  ? <Icon name="check" size={11} />
                  : index + 1}
              </span>
              <b>{step.label}</b>
            </li>
          ))}
        </ol>
        {view.showingPrevious && (
          <div className="generation-previous-note">
            <Icon name="history" size={12} />
            <span>下方是上次结论，不是本轮结果；本轮只在最终完成后一次性替换。</span>
          </div>
        )}
        {!!sources.length && (
          <div className="generation-flow-sources">
            {sources.map((source, index) => (
              <span
                data-state={source.ok ? 'ready' : 'missing'}
                key={`${source.label}-${index}`}
              >
                <Icon name={source.ok ? 'check' : 'close'} size={10} />
                {source.label}
              </span>
            ))}
          </div>
        )}
        {view.warning && (
          <div className="generation-flow-warning">
            <Icon name="info" size={12} />
            <span>{view.warning}</span>
          </div>
        )}
        {view.quant && (
          <div className="generation-flow-result">
            <Icon name="activity" size={13} />
            <span>{view.quant.summary || '量化校验已完成'}</span>
          </div>
        )}
        {view.reasoning && (
          <details className="generation-flow-reasoning">
            <summary>
              <Icon name="brain" size={12} />
              查看可见分析进度
            </summary>
            <div>{view.reasoning}</div>
            {view.reasoningTruncated && (
              <small>内容较长，当前仅保留首尾关键片段。</small>
            )}
          </details>
        )}
      </section>
    )
  }

  return (
    <button type="button" className={`advice-generation-status ${variant}`} onClick={generation.cancelable ? cancel : undefined}
      disabled={!generation.cancelable}
      aria-label={reviewing
        ? `${code}正在到价确认`
        : `取消${code}的V3评估`}
      title={reviewing ? '到价后由V3重新评估' : '点击取消本次评估'}>
      <Icon name="refresh" size={12} className="spin" />
      <span>{generation.label}</span>
      {generation.cloud && <em>云端持续运行</em>}
      <b>
        {reviewing
          ? '到价确认'
          : generation.cancelable ? '取消评估' : '取消中'}
      </b>
    </button>
  )
}
