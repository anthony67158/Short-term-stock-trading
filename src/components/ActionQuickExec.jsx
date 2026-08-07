import { useState, useRef, useEffect } from 'react'
import Icon from './Icon'
import { planStore } from '../planStore'

// B-6 补仓/减仓快捷执行:
//   对「补仓点/减仓点」行动预警(actKind add/reduce),按目标价记录一笔【模拟操作】(默认1手)。
//   —— 这是本地持仓台账的「记录/模拟执行」,不对接任何券商真实下单;
//   —— 两段式防误触(先点亮→再确认),执行后走 planStore snapshot,可在顶部「撤销」。
export default function ActionQuickExec({ alert, holding, onDone }) {
  const [armed, setArmed] = useState(false)
  const [done, setDone] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  if (!alert || !alert.actKind) return null
  const h = (holding || []).find((x) => x.code === alert.actCode)
  if (!h) return null // 无对应持仓(如已清仓)→ 无从记录

  const isAdd = alert.actKind === 'add'
  const price = Number(alert.value)
  if (!(price > 0)) return null

  const reset = () => { setArmed(false) }
  const onClick = (e) => {
    e.stopPropagation()
    if (done) return
    if (!armed) {
      setArmed(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(reset, 3200) // 3.2s 内不确认则自动收起,防误触
      return
    }
    // 确认 → 记录模拟操作
    if (timer.current) clearTimeout(timer.current)
    if (isAdd) planStore.addToHolding(h.id, price, 1)
    else planStore.sell(h.id, price, 1)
    setArmed(false)
    setDone(true)
    timer.current = setTimeout(() => setDone(false), 2600)
    onDone && onDone()
  }

  const label = done
    ? '已记录'
    : armed
      ? (isAdd ? '确认补1手' : '确认减1手')
      : (isAdd ? '记录补1手' : '记录减1手')

  return (
    <button
      className={'chip-btn quick-exec ' + (isAdd ? 'act-add' : 'act-reduce') + (armed ? ' solid' : '') + (done ? ' is-done' : '')}
      title={`按目标价 ${price} 记录一笔模拟${isAdd ? '补仓' : '减仓'}(1手·本地台账,非真实下单),执行后可在顶部「撤销」`}
      onClick={onClick}
    >
      <Icon name={done ? 'check' : armed ? 'shield' : (isAdd ? 'cart' : 'sell')} size={12} />
      {label}
    </button>
  )
}
