import { useEffect } from 'react'

// Entrada de las pildoras del dock (Por ubicar, Envios en camino, Envios
// pendientes): entran de una en una. Cuando aparece una nueva, las que ya
// estaban se deslizan para hacerle espacio y luego la nueva baja desde fuera
// de la pantalla. Si se quita una, las demas se deslizan a cerrar el hueco.
const PILL_SELECTOR = '.quick-actions__pending-shipments'
const COUNT_SELECTOR = '.quick-actions__pending-shipments-count'
const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)'
const SLIDE_MS = 380
const DROP_MS = 560
// Tras deslizar las demas, la nueva baja cuando ya casi hay espacio.
const DROP_AFTER_SLIDE_MS = 200
// La siguiente de la cola entra antes de que la anterior termine de asentarse.
const NEXT_GAP_MS = 420

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export default function useDockEntrance(dockRef) {
  useEffect(() => {
    const dock = dockRef.current
    if (!dock || typeof MutationObserver === 'undefined') return undefined

    const positions = new Map()
    const queue = []
    let timer = 0
    let busy = false

    const visibleChildren = () => Array.from(dock.children).filter((el) => el.style.display !== 'none')
    // Posicion de layout en pantalla (offsetLeft ignora los deslizamientos en
    // curso; el dock crece hacia la izquierda, por eso se suma su borde).
    const measure = () => {
      const next = new Map()
      const dockLeft = dock.getBoundingClientRect().left
      visibleChildren().forEach((el) => next.set(el, dockLeft + el.offsetLeft))
      return next
    }
    const remember = () => {
      positions.clear()
      measure().forEach((left, el) => positions.set(el, left))
    }

    // FLIP: cada elemento que cambio de sitio parte de donde estaba y se
    // desliza al nuevo. Devuelve si alguno se movio.
    const slideFrom = (before) => {
      const after = measure()
      let moved = false
      after.forEach((left, el) => {
        const previous = before.get(el)
        if (previous === undefined) return
        const dx = previous - left
        if (Math.abs(dx) < 1) return
        moved = true
        el.animate([{ translate: `${dx}px 0` }, { translate: '0 0' }], { duration: SLIDE_MS, easing: EASE })
      })
      return moved
    }

    const revealNext = () => {
      timer = 0
      const el = queue.shift()
      if (!el) {
        busy = false
        return
      }
      if (!el.isConnected) {
        revealNext()
        return
      }
      busy = true
      const before = measure()
      el.style.display = ''
      if (prefersReducedMotion()) {
        remember()
        revealNext()
        return
      }
      const delay = slideFrom(before) ? DROP_AFTER_SLIDE_MS : 0
      el.animate(
        [{ transform: 'translateY(-140px)' }, { transform: 'none' }],
        { duration: DROP_MS, easing: EASE, delay, fill: 'backwards' }
      )
      el.querySelector(COUNT_SELECTOR)?.animate(
        [{ opacity: 0, transform: 'scale(0.4)' }, { opacity: 1, transform: 'scale(1)' }],
        { duration: 260, easing: EASE, delay: delay + 360, fill: 'backwards' }
      )
      remember()
      timer = window.setTimeout(revealNext, delay + NEXT_GAP_MS)
    }

    const enqueue = (el) => {
      // Oculta antes de pintarse: entra cuando le toque en la cola.
      el.style.display = 'none'
      queue.push(el)
      if (!busy) revealNext()
    }

    Array.from(dock.children).filter((el) => el.matches(PILL_SELECTOR)).forEach(enqueue)

    const mutationObserver = new MutationObserver((records) => {
      let removed = false
      records.forEach((record) => {
        record.addedNodes.forEach((node) => {
          if (node.nodeType === 1 && node.matches(PILL_SELECTOR)) enqueue(node)
        })
        if (record.removedNodes.length) removed = true
      })
      if (removed && !prefersReducedMotion()) slideFrom(positions)
      remember()
    })
    mutationObserver.observe(dock, { childList: true })

    // El ancho de una pildora cambia (contador "..." -> "9"): se actualizan las
    // posiciones guardadas para que el proximo deslizamiento parta bien.
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(remember) : null
    resizeObserver?.observe(dock)

    return () => {
      window.clearTimeout(timer)
      mutationObserver.disconnect()
      resizeObserver?.disconnect()
      queue.forEach((el) => { el.style.display = '' })
    }
  }, [dockRef])
}
