import { useEffect, useRef, useState } from 'react'

const DEFAULT_MODAL_ANIMATION_MS = 180

function useModalAnimation(open, duration = DEFAULT_MODAL_ANIMATION_MS) {
  const [shouldRender, setShouldRender] = useState(Boolean(open))
  const closeTimerRef = useRef(null)

  useEffect(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }

    if (open) {
      setShouldRender(true)
      return undefined
    }

    if (!shouldRender) {
      return undefined
    }

    closeTimerRef.current = setTimeout(() => {
      setShouldRender(false)
      closeTimerRef.current = null
    }, duration)

    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
      }
    }
  }, [open, shouldRender, duration])

  useEffect(
    () => () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current)
      }
    },
    []
  )

  return {
    shouldRender,
    isClosing: shouldRender && !open,
  }
}

export default useModalAnimation
