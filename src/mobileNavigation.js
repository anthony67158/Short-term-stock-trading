import {
  useEffect,
  useRef,
} from 'react'
import {
  edgeBackProgress,
  isIOSStandalonePWA,
  isMobileEdgeBackStart,
  shouldCommitMobileEdgeBack,
} from '../shared/mobileEdgeBack.js'

const OVERLAY_SELECTOR = [
  '.busy-modal-mask',
  '.advisor-score-mask',
  '.auto-ref-mask',
  '.modal-mask',
  '.ai-drawer',
  '.acct-mask',
].join(',')

const LOCKING_OVERLAY_SELECTOR = [
  '.busy-modal-mask',
  '.advisor-score-mask',
  '.auto-ref-mask',
  '.modal-mask',
].join(',')

function isVisible(element) {
  if (!element || !element.isConnected) return false
  const style = window.getComputedStyle(element)
  return (
    style.display !== 'none'
    && style.visibility !== 'hidden'
    && Number(style.opacity || 1) > 0
    && element.getClientRects().length > 0
  )
}

function overlayLayer(element) {
  const value = Number.parseInt(
    window.getComputedStyle(element).zIndex,
    10,
  )
  return Number.isFinite(value) ? value : 0
}

export function closeTopmostOverlay() {
  const overlays = Array.from(
    document.querySelectorAll(OVERLAY_SELECTOR),
  ).filter(isVisible)
  if (!overlays.length) return false

  const overlay = overlays
    .map((element, index) => ({
      element,
      index,
      layer: overlayLayer(element),
    }))
    .sort((left, right) =>
      left.layer - right.layer || left.index - right.index
    )
    .at(-1)?.element
  if (!overlay) return false

  if (overlay.matches('button')) {
    overlay.click()
    return true
  }

  const closeButton = overlay.querySelector([
    '[data-overlay-close]',
    'button[aria-label^="关闭"]',
    '.modal-close',
  ].join(','))
  if (closeButton instanceof HTMLElement) {
    closeButton.click()
    return true
  }

  const fallbackButton = Array.from(
    overlay.querySelectorAll('button'),
  ).find((button) =>
    /^(取消|关闭|知道了|暂不|返回)$/.test(
      button.textContent?.trim() || '',
    )
  )
  if (fallbackButton instanceof HTMLElement) {
    fallbackButton.click()
    return true
  }

  overlay.click()
  return true
}

export function useOverlayScrollLock() {
  useEffect(() => {
    const body = document.body
    const root = document.documentElement
    const mobileMedia = window.matchMedia('(max-width: 720px)')
    const iosStandalone = isIOSStandalonePWA(window)
    if (iosStandalone) {
      root.classList.add('ios-standalone')
      root.style.setProperty('--app-height', '100vh')
    }
    let lock = null

    const restore = () => {
      if (!lock) return
      const scrollY = lock.scrollY
      Object.assign(body.style, lock.style)
      root.style.overflow = lock.rootOverflow
      root.style.removeProperty('--overlay-scroll-top')
      body.classList.remove('overlay-scroll-locked')
      lock = null
      window.scrollTo(0, scrollY)
    }

    const sync = () => {
      const modalOpen = !!document.querySelector(
        LOCKING_OVERLAY_SELECTOR,
      )
      const mobileDrawerOpen = mobileMedia.matches
        && !!document.querySelector('.ai-drawer')
      const open = modalOpen || mobileDrawerOpen
      if (open && !lock) {
        const scrollY = window.scrollY
        const scrollbar = Math.max(
          0,
          window.innerWidth - document.documentElement.clientWidth,
        )
        lock = {
          scrollY,
          style: {
            position: body.style.position,
            top: body.style.top,
            left: body.style.left,
            right: body.style.right,
            width: body.style.width,
            overflow: body.style.overflow,
            paddingRight: body.style.paddingRight,
          },
          rootOverflow: root.style.overflow,
        }
        body.classList.add('overlay-scroll-locked')
        if (iosStandalone) {
          root.style.setProperty(
            '--overlay-scroll-top',
            `${scrollY}px`,
          )
          root.style.overflow = 'hidden'
          Object.assign(body.style, {
            overflow: 'hidden',
            paddingRight: scrollbar ? `${scrollbar}px` : '',
          })
        } else {
          Object.assign(body.style, {
            position: 'fixed',
            top: `-${scrollY}px`,
            left: '0',
            right: '0',
            width: '100%',
            overflow: 'hidden',
            paddingRight: scrollbar ? `${scrollbar}px` : '',
          })
        }
      } else if (!open) {
        restore()
      }
    }

    const observer = new MutationObserver(sync)
    observer.observe(body, {
      childList: true,
      subtree: true,
    })
    mobileMedia.addEventListener?.('change', sync)
    sync()
    return () => {
      observer.disconnect()
      mobileMedia.removeEventListener?.('change', sync)
      restore()
    }
  }, [])
}

export function useMobileEdgeBack(onBack) {
  const callbackRef = useRef(onBack)

  useEffect(() => {
    callbackRef.current = onBack
  }, [onBack])

  useEffect(() => {
    const media = window.matchMedia('(max-width: 720px)')
    let gesture = null

    const reset = () => {
      gesture = null
      document.documentElement.classList.remove('edge-back-active')
      document.documentElement.style.removeProperty(
        '--edge-back-progress',
      )
    }

    const onPointerDown = (event) => {
      if (!media.matches || !event.isPrimary) return
      if (!isMobileEdgeBackStart({
        startX: event.clientX,
        pointerType: event.pointerType,
        viewportWidth: window.innerWidth,
      })) return
      gesture = {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        startX: event.clientX,
        startY: event.clientY,
        startedAt: performance.now(),
        intent: 'pending',
      }
    }

    const onPointerMove = (event) => {
      if (!gesture || event.pointerId !== gesture.pointerId) return
      const dx = event.clientX - gesture.startX
      const dy = Math.abs(event.clientY - gesture.startY)
      if (gesture.intent === 'pending' && Math.max(Math.abs(dx), dy) >= 10) {
        gesture.intent = dx > 0 && dx > dy * 1.2
          ? 'horizontal'
          : 'cancelled'
      }
      if (gesture.intent !== 'horizontal') return
      event.preventDefault()
      const progress = edgeBackProgress(
        gesture.startX,
        event.clientX,
      )
      document.documentElement.classList.add('edge-back-active')
      document.documentElement.style.setProperty(
        '--edge-back-progress',
        String(progress),
      )
    }

    const onPointerUp = (event) => {
      if (!gesture || event.pointerId !== gesture.pointerId) return
      const commit = gesture.intent === 'horizontal'
        && shouldCommitMobileEdgeBack({
          startX: gesture.startX,
          startY: gesture.startY,
          currentX: event.clientX,
          currentY: event.clientY,
          elapsedMs: performance.now() - gesture.startedAt,
          pointerType: gesture.pointerType,
          viewportWidth: window.innerWidth,
        })
      reset()
      if (commit) callbackRef.current?.()
    }

    window.addEventListener('pointerdown', onPointerDown, {
      capture: true,
      passive: true,
    })
    window.addEventListener('pointermove', onPointerMove, {
      capture: true,
      passive: false,
    })
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('pointercancel', reset, true)
    return () => {
      reset()
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointermove', onPointerMove, true)
      window.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('pointercancel', reset, true)
    }
  }, [])
}
