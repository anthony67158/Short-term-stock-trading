import Icon from './Icon'

// 通用二次确认弹窗
export default function ConfirmDialog({ title, body, confirmText = '确认删除', danger = true, onConfirm, onCancel }) {
  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-title"><Icon name="trash" size={18} /> {title}</div>
        <div className="confirm-body">{body}</div>
        <div className="confirm-actions">
          <button className="btn" onClick={onCancel}>取消</button>
          <button className={'btn ' + (danger ? 'btn-danger' : 'btn-primary')} onClick={onConfirm}>
            <Icon name="trash" size={13} /> {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
