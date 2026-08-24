import { useEffect, useState } from 'react'
import { planStore } from '../planStore'
import { useTextOverflow } from '../useTextOverflow.js'
import {
  STOCK_NOTE_MAX_LENGTH,
  normalizeStockNoteText,
} from '../../shared/stockNotes.js'
import Icon from './Icon'

export function StockNoteSummary({ code, name, text, onEdit }) {
  const [noteRef, isNoteTruncated] = useTextOverflow(text)
  if (!text) return null
  return (
    <button
      type="button"
      className={
        'stock-note-summary'
        + (isNoteTruncated ? ' has-preview' : '')
      }
      aria-label={`查看并编辑${name || code}的个人备注`}
      onClick={onEdit}
    >
      <Icon name="edit" size={12} />
      <span className="stock-note-summary-label">备注</span>
      <span ref={noteRef} className="stock-note-summary-text">{text}</span>
      <Icon name="chevronRight" size={12} />
      {isNoteTruncated && (
        <span
          className="action-command-preview stock-note-preview"
          aria-hidden="true"
        >
          <strong className="action-command-preview-label">完整备注</strong>
          <span className="action-command-preview-text">{text}</span>
        </span>
      )}
    </button>
  )
}

export function StockNoteEditor({
  code,
  note,
  initialEditing = false,
}) {
  const [editing, setEditing] = useState(initialEditing)
  const [draft, setDraft] = useState(note || '')
  const [error, setError] = useState('')

  useEffect(() => {
    setDraft(note || '')
    setEditing(initialEditing)
    setError('')
  }, [code, initialEditing])

  useEffect(() => {
    if (!editing) setDraft(note || '')
  }, [editing, note])

  const save = () => {
    const result = planStore.setStockNote(code, draft)
    if (!result?.ok) {
      setError(result?.error || '备注保存失败')
      return
    }
    setDraft(result.note.text)
    setEditing(false)
    setError('')
  }

  const clear = () => {
    const result = planStore.setStockNote(code, '')
    if (!result?.ok) {
      setError(result?.error || '备注删除失败')
      return
    }
    setDraft('')
    setEditing(false)
    setError('')
  }

  if (editing) {
    const count = Array.from(draft).length
    return (
      <section className="stock-note-detail editing" aria-label="编辑个人备注">
        <div className="stock-note-detail-head">
          <span><Icon name="edit" size={13} />个人备注</span>
          <span className="stock-note-count">
            {count}/{STOCK_NOTE_MAX_LENGTH}
          </span>
        </div>
        <textarea
          className="stock-note-editor"
          value={draft}
          maxLength={STOCK_NOTE_MAX_LENGTH}
          autoFocus
          placeholder="输入个人备注"
          onChange={(event) => {
            setDraft(
              Array.from(event.target.value)
                .slice(0, STOCK_NOTE_MAX_LENGTH)
                .join(''),
            )
            setError('')
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setEditing(false)
          }}
        />
        {error && <span className="stock-note-error" role="alert">{error}</span>}
        <div className="stock-note-editor-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={normalizeStockNoteText(draft) === note}
            onClick={save}
          >
            保存备注
          </button>
          {note && (
            <button type="button" className="btn danger" onClick={clear}>
              删除备注
            </button>
          )}
          <button type="button" className="btn" onClick={() => setEditing(false)}>
            取消
          </button>
        </div>
      </section>
    )
  }

  if (!note) {
    return (
      <button
        type="button"
        className="stock-note-add"
        onClick={() => setEditing(true)}
      >
        <Icon name="edit" size={13} />
        添加个人备注
      </button>
    )
  }

  return (
    <section className="stock-note-detail" aria-label="个人备注">
      <div className="stock-note-detail-head">
        <span><Icon name="edit" size={13} />个人备注</span>
        <button
          type="button"
          className="icon-btn stock-note-detail-edit"
          aria-label="编辑个人备注"
          title="编辑备注"
          onClick={() => setEditing(true)}
        >
          <Icon name="edit" size={12} />
        </button>
      </div>
      <p className="stock-note-detail-text">{note}</p>
    </section>
  )
}
