// Ningun desplegable del sistema debe quedar cortado. Cada panel que se abre
// se mide contra el espacio visible (la pantalla y los contenedores con
// scroll que lo recortan, como el cuerpo de un modal):
//   1. si abajo no cabe y arriba hay mas espacio, se abre hacia arriba;
//   2. su alto nunca pasa del espacio disponible (con scroll interno), asi
//      que aunque no quepa entero nunca queda cortado.
// (No se saca del modal con position:fixed: los modales conservan un
// transform de su animacion y recortan a sus hijos fijos igual.)
// Funciona con los paneles absolutos (debajo de su disparador) y con los que
// ya flotan (position: fixed, colocados por JS justo debajo del campo).

const PANEL_SELECTORS = [
  '.create-user__dropdown-panel',
  '.quick-actions__receive-dropdown-panel',
  '.quick-actions__receive-sort-panel',
  '.quick-actions__inspection-search-results',
  '.create-salida__product-panel',
  '.create-salida__cliente-panel',
  '.create-solicitud__cliente-panel',
  '.create-solicitud__inline-panel',
  '.imp-oem-input__panel',
  '.inventario-v2__branch-menu',
  '.bodega-type-select__menu',
  '.workspace__view-branch-panel',
]
const PANEL_SELECTOR = PANEL_SELECTORS.join(',')
const GAP = 6
const MARGIN = 8
const MAX_HEIGHT = 360

const viewportBounds = () => ({ top: MARGIN, bottom: window.innerHeight - MARGIN })

const clipsContent = (element) => {
  const style = window.getComputedStyle(element)
  return /(auto|scroll|hidden|clip)/.test(`${style.overflowY} ${style.overflow}`)
}

// Zona visible: la pantalla recortada por los ancestros que cortan su contenido.
const visibleBounds = (element) => {
  const bounds = viewportBounds()
  let node = element.parentElement
  while (node && node !== document.body && node !== document.documentElement) {
    if (clipsContent(node)) {
      const rect = node.getBoundingClientRect()
      bounds.top = Math.max(bounds.top, rect.top)
      bounds.bottom = Math.min(bounds.bottom, rect.bottom)
    }
    node = node.parentElement
  }
  return bounds
}

const contentHeight = (panel) => {
  // Alto natural del contenido (sin el limite que le pusimos antes).
  const previous = panel.style.maxHeight
  panel.style.maxHeight = 'none'
  const height = panel.scrollHeight
  panel.style.maxHeight = previous
  return Math.min(MAX_HEIGHT, height)
}

// Disparador de un panel flotante: el elemento justo encima de su borde.
const findFloatingTrigger = (panel, rect) => {
  const previous = panel.style.pointerEvents
  panel.style.pointerEvents = 'none'
  const probe = document.elementFromPoint(rect.left + Math.min(16, rect.width / 2), rect.top - GAP - 2)
  panel.style.pointerEvents = previous
  return probe?.closest?.('button, input, select, [role="combobox"], .create-user__dropdown, label') || null
}

const state = new WeakMap()

const resetPanel = (panel) => {
  const saved = state.get(panel)
  if (!saved) return
  panel.style.transform = saved.transform
  panel.style.maxHeight = saved.maxHeight
  panel.style.overflowY = saved.overflowY
  state.delete(panel)
}

const remember = (panel) => {
  if (!state.has(panel)) {
    const s = panel.style
    state.set(panel, { transform: s.transform, maxHeight: s.maxHeight, overflowY: s.overflowY, bottom: s.bottom })
  }
  return state.get(panel)
}

const limitHeight = (panel, room, height) => {
  if (height > room) {
    panel.style.maxHeight = `${Math.max(60, Math.floor(room))}px`
    panel.style.overflowY = 'auto'
  }
}

const adjustInline = (panel) => {
  const anchor = panel.offsetParent
  if (!anchor) return
  const saved = remember(panel)
  panel.style.transform = saved.transform
  panel.style.maxHeight = saved.maxHeight
  const anchorRect = anchor.getBoundingClientRect()
  const panelRect = panel.getBoundingClientRect()
  // Solo paneles que se abren justo debajo de su disparador.
  if (Math.abs(panelRect.top - anchorRect.bottom) > 30) return
  const height = contentHeight(panel)
  const bounds = visibleBounds(anchor)
  const below = bounds.bottom - anchorRect.bottom - GAP
  const above = anchorRect.top - bounds.top - GAP

  if (below >= height) return
  if (above > below) {
    // Hacia arriba: se desplaza el panel por encima del disparador.
    const shift = (panelRect.top - anchorRect.top) + Math.min(height, above) + GAP
    panel.style.transform = `translateY(${-Math.round(shift)}px)`
    limitHeight(panel, above, height)
    return
  }
  limitHeight(panel, below, height)
}

const adjustFloating = (panel) => {
  const saved = remember(panel)
  // Si el propio componente ya lo abrio hacia arriba (usa bottom), no se toca.
  if (saved.bottom && saved.bottom !== 'auto') return
  panel.style.transform = saved.transform
  panel.style.maxHeight = saved.maxHeight
  const rect = panel.getBoundingClientRect()
  // El campo se busca una sola vez (al abrir, el panel esta justo debajo);
  // despues el panel se coloca siempre respecto de el, aunque haya scroll.
  if (!saved.trigger?.isConnected) saved.trigger = findFloatingTrigger(panel, rect)
  const triggerRect = saved.trigger
    ? saved.trigger.getBoundingClientRect()
    : { top: rect.top - GAP, bottom: rect.top - GAP }
  const view = viewportBounds()
  const height = contentHeight(panel)
  const belowTop = triggerRect.bottom + GAP
  const below = view.bottom - belowTop
  const above = triggerRect.top - GAP - view.top
  let top = belowTop
  if (below < height && above > below) {
    top = triggerRect.top - GAP - Math.min(height, above)
    limitHeight(panel, above, height)
  } else {
    limitHeight(panel, below, height)
  }
  const shift = Math.round(top - rect.top)
  if (shift) panel.style.transform = `translateY(${shift}px)`
}

let adjusting = false
const adjust = (panel) => {
  if (adjusting || !panel.isConnected) return
  const rect = panel.getBoundingClientRect()
  if (!rect.width && !rect.height) {
    resetPanel(panel) // cerrado (oculto): vuelve a su estado original
    return
  }
  adjusting = true
  try {
    const isFixed = window.getComputedStyle(panel).position === 'fixed'
    if (isFixed) adjustFloating(panel)
    else adjustInline(panel)
  } finally {
    adjusting = false
  }
}

export const startDropdownAutoFlip = () => {
  if (typeof window === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  const open = new Set()
  const watched = new WeakSet()
  const schedule = (panel) => window.requestAnimationFrame(() => adjust(panel))
  const resizeObserver = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver((entries) => entries.forEach((entry) => schedule(entry.target)))
    : null

  const watch = (panel) => {
    open.add(panel)
    if (watched.has(panel)) return
    watched.add(panel)
    schedule(panel)
    // Los resultados llegan despues (busquedas) o el panel se muestra/oculta.
    resizeObserver?.observe(panel)
  }

  const scan = (node) => {
    if (!(node instanceof Element)) return
    if (node.matches(PANEL_SELECTOR)) watch(node)
    node.querySelectorAll?.(PANEL_SELECTOR).forEach(watch)
  }

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach(scan)
      mutation.removedNodes.forEach((node) => {
        if (node instanceof Element && node.matches?.(PANEL_SELECTOR)) open.delete(node)
      })
    })
  })
  observer.observe(document.body, { childList: true, subtree: true })
  document.querySelectorAll(PANEL_SELECTOR).forEach(watch)

  // Al hacer scroll o cambiar el tamano, los paneles siguen a su campo.
  let frame = 0
  const refresh = () => {
    if (frame) return
    frame = window.requestAnimationFrame(() => {
      frame = 0
      open.forEach((panel) => {
        if (!panel.isConnected) open.delete(panel)
        else adjust(panel)
      })
    })
  }
  window.addEventListener('scroll', refresh, true)
  window.addEventListener('resize', refresh)

  return () => {
    observer.disconnect()
    resizeObserver?.disconnect()
    window.removeEventListener('scroll', refresh, true)
    window.removeEventListener('resize', refresh)
  }
}
