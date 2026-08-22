import { useEffect, useState } from 'react'
import Icon from './Icon'
import {
  adviceGenerationSteps,
  adviceJobState,
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
      label: canceling ? '正在取消生成' : (running?.phase || 'AI 操作建议生成中'),
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
  return adviceJobState(getBatchState(), code)
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
        || '正在准备本次建议',
    }
    const sources = visibleAiSources(searchEnabled, view.sources)
    const steps = adviceGenerationSteps(view)
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
              <b>{view.deepMode ? '深度研判进行中' : '快速建议生成中'}</b>
              <span>{view.phase}</span>
            </div>
          </div>
          {generation?.cancelable && (
            <button
              type="button"
              className="generation-cancel"
              onClick={cancel}
              aria-label={`停止${code}的 AI 操作建议生成`}
              title="停止本次生成"
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
            <span>下方为上次已保存结果，新版本完成前不会替换。</span>
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
              查看实时研判摘要
            </summary>
            <div>{view.reasoning}</div>
          </details>
        )}
      </section>
    )
  }

  return (
    <button type="button" className={`advice-generation-status ${variant}`} onClick={generation.cancelable ? cancel : undefined}
      disabled={!generation.cancelable}
      aria-label={`取消${code}的 AI 操作建议生成`} title="点击取消本次生成">
      <Icon name="refresh" size={12} className="spin" />
      <span>{generation.label}</span>
      {generation.cloud && <em>云端持续运行</em>}
      <b>{generation.cancelable ? '取消生成' : '取消中'}</b>
    </button>
  )
}
