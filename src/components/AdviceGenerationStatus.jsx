import { useEffect, useState } from 'react'
import Icon from './Icon'
import { adviceJobState } from '../../shared/adviceUiState.js'
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
      label: canceling ? '正在取消生成' : (running?.phase || 'AI 操作建议生成中'),
      cancelable: !canceling,
      cloud: false,
    }
  }
  return adviceJobState(getBatchState(), code)
}

export default function AdviceGenerationStatus({ code, variant = 'card' }) {
  const generation = useAdviceGeneration(code)
  if (!generation?.active) return null

  const cancel = (event) => {
    event.stopPropagation()
    cancelAdvice(code)
    cancelOne(code)
  }

  return (
    <button type="button" className={`advice-generation-status ${variant}`} onClick={generation.cancelable ? cancel : undefined}
      disabled={!generation.cancelable}
      aria-label={`取消${code}的 AI 操作建议生成`} title="点击取消本次生成">
      <Icon name="refresh" size={12} className="spin" />
      <span>{generation.label}</span>
      <b>{generation.cancelable ? '取消生成' : '取消中'}</b>
    </button>
  )
}
