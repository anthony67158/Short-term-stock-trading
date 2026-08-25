const EDGE_BACK_MAX_START_PX = 28
const EDGE_BACK_DISTANCE_PX = 72
const EDGE_BACK_FLICK_DISTANCE_PX = 44
const EDGE_BACK_FLICK_SPEED_PX_PER_MS = 0.32
const EDGE_BACK_PROGRESS_DISTANCE_PX = 96

export function isIOSStandalonePWA(view) {
  const target = view || (
    typeof window === 'undefined' ? null : window
  )
  const navigator = target?.navigator || {}
  const userAgent = String(navigator.userAgent || '')
  const isIOS = /iPad|iPhone|iPod/.test(userAgent)
    || (
      navigator.platform === 'MacIntel'
      && Number(navigator.maxTouchPoints) > 1
    )
  const standalone = navigator.standalone === true
    || target?.matchMedia?.('(display-mode: standalone)')?.matches === true
  return isIOS && standalone
}

export function isMobileEdgeBackStart({
  startX,
  pointerType,
  viewportWidth,
} = {}) {
  if (pointerType !== 'touch' && pointerType !== 'pen') return false
  const width = Math.max(1, Number(viewportWidth) || 0)
  const edgeLimit = Math.min(
    EDGE_BACK_MAX_START_PX,
    Math.max(20, width * 0.08),
  )
  return Number.isFinite(startX) && startX >= 0 && startX <= edgeLimit
}

export function edgeBackProgress(startX, currentX) {
  const distance = Math.max(0, Number(currentX) - Number(startX))
  return Math.min(1, distance / EDGE_BACK_PROGRESS_DISTANCE_PX)
}

export function shouldCommitMobileEdgeBack({
  startX,
  startY,
  currentX,
  currentY,
  elapsedMs,
  pointerType,
  viewportWidth,
} = {}) {
  if (!isMobileEdgeBackStart({
    startX,
    pointerType,
    viewportWidth,
  })) {
    return false
  }

  const dx = Number(currentX) - startX
  const dy = Math.abs(Number(currentY) - Number(startY))
  if (!Number.isFinite(dx) || dx <= 0) return false
  if (dy > Math.max(24, dx * 0.65)) return false

  const elapsed = Math.max(1, Number(elapsedMs) || 1)
  const velocity = dx / elapsed
  return (
    dx >= EDGE_BACK_DISTANCE_PX
    || (
      dx >= EDGE_BACK_FLICK_DISTANCE_PX
      && velocity >= EDGE_BACK_FLICK_SPEED_PX_PER_MS
    )
  )
}
