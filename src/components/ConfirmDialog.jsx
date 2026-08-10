import Icon from './Icon'
import OverlayPortal from './OverlayPortal'

// 通用二次确认弹窗
export default function ConfirmDialog({
  title,
  body,
  confirmText = '确认删除',
  confirmIcon = 'trash',
  danger = true,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}) {
  return (
    <OverlayPortal>
      <div className="modal-mask confirm-mask" onClick={onCancel}>
        <div
          className="confirm-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={title}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="confirm-title"><Icon name={confirmIcon} size={18} /> {title}</div>
          <div className="confirm-body">{body}</div>
          <div className="confirm-actions">
            <button className="btn" onClick={onCancel}>取消</button>
            <button
              className={'btn ' + (danger ? 'btn-danger' : 'btn-primary')}
              disabled={confirmDisabled}
              onClick={onConfirm}
            >
              <Icon name={confirmIcon} size={13} /> {confirmText}
            </button>
          </div>
        </div>
      </div>
    </OverlayPortal>
  )
}
