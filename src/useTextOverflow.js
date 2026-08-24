import { useEffect, useRef, useState } from 'react'

export function isTextOverflowing(element, tolerance = 1) {
  if (!element) return false
  return (
    Number(element.scrollWidth) - Number(element.clientWidth) > tolerance
    || Number(element.scrollHeight) - Number(element.clientHeight) > tolerance
  )
}

export function useTextOverflow(value) {
  const elementRef = useRef(null)
  const [overflowing, setOverflowing] = useState(false)

  useEffect(() => {
    const element = elementRef.current
    if (!element) {
      setOverflowing(false)
      return undefined
    }

    let disposed = false
    let frame = 0
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (disposed) return
        const next = isTextOverflowing(element)
        setOverflowing((current) => current === next ? current : next)
      })
    }

    measure()
    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver(measure)
      : null
    observer?.observe(element)
    window.addEventListener('resize', measure)
    document.fonts?.ready.then(measure).catch(() => {})

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [value])

  return [elementRef, overflowing]
}
