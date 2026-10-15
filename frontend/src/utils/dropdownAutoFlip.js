// Los desplegables del sistema (.create-user__dropdown-panel) se abren hacia
// abajo. Cerca del borde inferior de la pantalla, o de un contenedor con
// scroll, quedaban cortados. Este observador revisa cada panel que se abre y,
// si abajo no cabe y arriba hay mas espacio, lo abre hacia arriba; ademas
// limita su alto al espacio disponible para que nunca se salga.

const PANEL_SELECTOR = '.create-user__dropdown-panel'
const UP_CLASS = 'create-user__dropdown-panel--up'
const GAP = 6
const MARGIN = 8
const MAX_HEIGHT = 360
const MIN_HEIGHT = 120

const isClipping = (element) => {
  const style = window.getComputedStyle(element)
  return /(auto|scroll|hidden|clip)/.test(`${style.overflowY}${style.overflow}`)
}

// Zona visible para el panel: la pantalla recortada por los ancestros que
// cortan su contenido (modales y tablas con scroll).
const visibleBounds = (element) => {
  let top = MARGIN
  let bottom = window.innerHeight - MARGIN
  let node = element.parentElement
  while (node && node !== document.body) {
    if (isClipping(node)) {
      const rect = node.getBoundingClientRect()
      top = Math.max(top, rect.top)
      bottom = Math.min(bottom, rect.bottom)
    }
    node = node.parentElement
  }
  return { top, bottom }
}

const naturalHeight = (panel) => Math.min(MAX_HEIGHT, panel.scrollHeight)

// Panel absoluto, debajo de su disparador (el contenedor posicionado).
const adjustInlinePanel = (panel) => {
  const anchor = panel.offsetParent
  if (!anchor) return
  const anchorRect = anchor.getBoundingClientRect()
  const bounds = visibleBounds(anchor)
  const below = bounds.bottom - anchorRect.bottom - GAP
  const above = anchorRect.top - bounds.top - GAP
  const height = naturalHeight(panel)
  const goUp = panel.classList.contains(UP_CLASS) || (height > below && above > below)
  panel.classList.toggle(UP_CLASS, goUp)
  const room = goUp ? above : below
  panel.style.maxHeight = `${Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, room))}px`
}

// Panel flotante (position:fixed, colocado justo debajo del disparador).
const adjustFloatingPanel = (panel) => {
  if (panel.dataset.autoFlipped === '1') return
  const rect = panel.getBoundingClientRect()
  if (rect.bottom <= window.innerHeight - MARGIN) return
  if (panel.style.bottom && panel.style.bottom !== 'auto') return // ya se abrio hacia arriba
  // El disparador esta justo encima del panel.
  const probe = document.elementFromPoint(rect.left + 12, rect.top - GAP - 2)
  const trigger = probe?.closest?.('button, input, .create-user__dropdown, .create-user__dropdown-trigger')
  const triggerTop = trigger ? trigger.getBoundingClientRect().top : rect.top - GAP
  const above = triggerTop - MARGIN - GAP
  const below = window.innerHeight - rect.top - MARGIN
  if (above <= below) {
    panel.style.maxHeight = `${Math.max(MIN_HEIGHT, below)}px`
    return
  }
  panel.dataset.autoFlipped = '1'
  panel.style.top = 'auto'
  panel.style.bottom = `${window.innerHeight - triggerTop + GAP}px`
  panel.style.maxHeight = `${Math.min(MAX_HEIGHT, above)}px`
}

const adjust = (panel) => {
  if (!panel.isConnected) return
  if (window.getComputedStyle(panel).position === 'fixed') adjustFloatingPanel(panel)
  else adjustInlinePanel(panel)
}

export const startDropdownAutoFlip = () => {
  if (typeof window === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  const watched = new WeakSet()
  const resizeObserver = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver((entries) => entries.forEach((entry) => adjust(entry.target)))
    : null

  const watch = (panel) => {
    if (watched.has(panel)) return
    watched.add(panel)
    window.requestAnimationFrame(() => adjust(panel))
    // Los resultados llegan despues (busquedas): se vuelve a medir.
    resizeObserver?.observe(panel)
  }

  const scan = (node) => {
    if (!(node instanceof Element)) return
    if (node.matches(PANEL_SELECTOR)) watch(node)
    node.querySelectorAll?.(PANEL_SELECTOR).forEach(watch)
  }

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => mutation.addedNodes.forEach(scan))
  })
  observer.observe(document.body, { childList: true, subtree: true })
  document.querySelectorAll(PANEL_SELECTOR).forEach(watch)

  return () => {
    observer.disconnect()
    resizeObserver?.disconnect()
  }
}
