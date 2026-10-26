import { useEffect } from 'react'

// En el telefono, el boton que abre el menu lateral se ancla a la esquina
// inferior izquierda de la tabla visible (su paginacion), en vez de quedar
// fijo a la pantalla, donde caia encima de la tabla o lejos de ella segun
// su altura. Sin tabla visible vuelve a su lugar fijo del CSS.
const MOBILE_QUERY = '(max-width: 900px)'
const PAGINATOR_SELECTOR = '.workspace__tab-panel.active .p-paginator'
const INSET = 6

const isVisible = (element) => {
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

export default function useMobileMenuButtonAnchor(buttonRef, enabled) {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || !window.matchMedia) return undefined
    const media = window.matchMedia(MOBILE_QUERY)
    let frame = 0

    const reset = (button) => {
      button.style.top = ''
      button.style.left = ''
      button.style.bottom = ''
    }

    const update = () => {
      frame = 0
      const button = buttonRef.current
      if (!button) return
      if (!media.matches) {
        reset(button)
        return
      }
      const paginator = Array.from(document.querySelectorAll(PAGINATOR_SELECTOR)).find(isVisible)
      if (!paginator) {
        reset(button)
        return
      }
      const rect = paginator.getBoundingClientRect()
      const size = button.offsetHeight || 42
      const top = Math.min(rect.top + (rect.height - size) / 2, window.innerHeight - size - INSET)
      button.style.top = `${Math.max(INSET, Math.round(top))}px`
      button.style.left = `${Math.round(rect.left + INSET)}px`
      button.style.bottom = 'auto'
    }

    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update)
    }

    const workspace = document.querySelector('.workspace') || document.body
    const observer = new MutationObserver(schedule)
    observer.observe(workspace, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'] })
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    media.addEventListener?.('change', schedule)
    schedule()

    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      media.removeEventListener?.('change', schedule)
      if (buttonRef.current) reset(buttonRef.current)
    }
  }, [buttonRef, enabled])
}
