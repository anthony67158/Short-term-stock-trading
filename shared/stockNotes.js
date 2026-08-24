export const STOCK_NOTE_MAX_LENGTH = 500
export const STOCK_NOTE_LIMIT = 500

function validCode(value) {
  const code = String(value || '').trim()
  return /^\d{6}$/.test(code) ? code : ''
}

export function normalizeStockNoteText(value) {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
  return Array.from(text).slice(0, STOCK_NOTE_MAX_LENGTH).join('')
}

function normalizeStockNote(code, value) {
  const normalizedCode = validCode(code)
  if (!normalizedCode || !value || typeof value !== 'object') return null
  const updatedAt = Number(value.updatedAt)
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null
  return [
    normalizedCode,
    {
      text: normalizeStockNoteText(value.text),
      updatedAt,
    },
  ]
}

export function normalizeStockNotes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .map(([code, note]) => normalizeStockNote(code, note))
      .filter(Boolean)
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, STOCK_NOTE_LIMIT),
  )
}

export function mergeStockNotesByTimestamp(primary = {}, secondary = {}) {
  const merged = normalizeStockNotes(secondary)
  for (const [code, note] of Object.entries(normalizeStockNotes(primary))) {
    const current = merged[code]
    if (!current || note.updatedAt >= current.updatedAt) {
      merged[code] = note
    }
  }
  return normalizeStockNotes(merged)
}

export function stockNotesAfter(notes = {}, since = 0) {
  const after = Number(since) || 0
  return Object.fromEntries(
    Object.entries(normalizeStockNotes(notes))
      .filter(([, note]) => note.updatedAt > after),
  )
}

export function stockNoteText(notes, code) {
  const normalizedCode = validCode(code)
  if (!normalizedCode) return ''
  return normalizeStockNoteText(notes?.[normalizedCode]?.text)
}
