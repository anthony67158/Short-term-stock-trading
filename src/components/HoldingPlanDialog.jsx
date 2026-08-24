import { useEffect } from 'react'
import { fmtRaw } from '../format'
import Icon from './Icon'
import OverlayPortal from './OverlayPortal'

export default function HoldingPlanDialog({
  open,
  holding,
  aiPlan,
  hitTP,
  hitSL,
  play,
  onClose,
  onEdit,
  onClear,
  onFollow,
}) {
  useEffect(() => {
    if (!open) return undefined
    const close = (event) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [open, onClose])

  if (!open) return null
  const trackedFields = [
    holding.tp != null,
    holding.sl != null,
    !!holding.planReason,
  ].filter(Boolean).length
  const manualFields = [
    holding.tp != null && holding.tpManual,
    holding.sl != null && holding.slManual,
    !!holding.planReason && holding.reasonManual,
  ].filter(Boolean).length
  const sourceLabel = manualFields === trackedFields && manualFields > 0
    ? '手动设定'
    : manualFields > 0
      ? '部分手动调整'
      : aiPlan
        ? '随军师建议更新'
        : '规则计划'
  const titleId = `holding-plan-title-${holding.id}`

  return (
    <OverlayPortal>
      <div className="modal-mask holding-plan-mask" onClick={onClose}>
        <section
          className="holding-plan-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onClick={(event) => event.stopPropagation()}
        >
          <header className="holding-plan-head">
            <div>
              <div className="holding-plan-title" id={titleId}>
                <Icon name="target" size={16} />
                交易计划
              </div>
              <span>{holding.name} · {holding.code} · {sourceLabel}</span>
            </div>
            <button
              type="button"
              className="modal-close"
              aria-label="关闭交易计划"
              onClick={onClose}
            >
              <Icon name="close" size={16} />
            </button>
          </header>

          <div className="holding-plan-body">
            <div className="holding-plan-boundaries">
              <section data-state={hitTP ? 'hit' : 'ready'}>
                <span><Icon name="target" size={13} />止盈目标</span>
                <strong className="red">
                  {holding.tp != null ? fmtRaw(holding.tp) : '--'}
                </strong>
                <small>{hitTP ? '已触及，按纪律处理' : '价格上沿'}</small>
              </section>
              <section data-state={hitSL ? 'hit' : 'ready'}>
                <span><Icon name="shield" size={13} />止损底线</span>
                <strong className="green">
                  {holding.sl != null ? fmtRaw(holding.sl) : '--'}
                </strong>
                <small>{hitSL ? '已触及，优先控制风险' : '风险下沿'}</small>
              </section>
            </div>

            {holding.planReason && (
              <section className="holding-plan-reason">
                <span>执行纪律</span>
                <p>{holding.planReason}</p>
              </section>
            )}

            {play && (
              <section
                className="holding-plan-session"
                data-tone={play.tone}
              >
                <span>{play.when} · {play.tag}</span>
                <p>{play.tip}</p>
              </section>
            )}
          </div>

          <footer className="holding-plan-footer">
            {aiPlan && manualFields > 0 && (
              <button
                type="button"
                className="holding-plan-follow"
                onClick={onFollow}
              >
                <Icon name="spark" size={12} />
                恢复自动跟随
              </button>
            )}
            <div className="holding-plan-footer-actions">
              <button
                type="button"
                className="icon-btn holding-plan-delete"
                aria-label="删除交易计划"
                title="删除交易计划"
                onClick={onClear}
              >
                <Icon name="trash" size={14} />
              </button>
              <button
                type="button"
                className="btn btn-primary holding-plan-edit"
                onClick={onEdit}
              >
                <Icon name="edit" size={13} />
                修改计划
              </button>
            </div>
          </footer>
        </section>
      </div>
    </OverlayPortal>
  )
}
