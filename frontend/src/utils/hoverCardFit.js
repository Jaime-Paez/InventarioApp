// Tarjetas de hover (las que salen al pasar el mouse sobre una celda, un
// punto, un codigo...): cada pantalla las pone debajo del elemento. Si no
// caben debajo (filas al final de la pantalla), aqui se suben para que se
// abran hacia arriba; y si se salen por la derecha, se corren a la izquierda.
// Funciona con cualquier elemento cuya clase termine en "hover-card"
// (table-cell-hover-card, imp-alternos-hover-card, ...), sin tocar cada tabla.

const MARGIN = 8
const MAX_GAP = 16
const isCardClass = (token) => /hover-card$/.test(token)
const isCard = (el) => el instanceof HTMLElement && Array.from(el.classList).some(isCardClass)

let lastHovered = null
const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.target.isConnected) fit(entry.target)
    else {
      resizeObserver.unobserve(entry.target)
      tracked.delete(entry.target)
    }
  })
}) : null
const tracked = new WeakSet()

// El elemento sobre el que se abrio la tarjeta: el ultimo que tuvo el mouse,
// subiendo hasta el que tenga el borde de abajo justo encima de la tarjeta.
const findAnchor = (card, cardTop) => {
  let el = lastHovered
  if (!el?.isConnected || card.contains(el)) return null
  let best = el
  for (let i = 0; el && i < 6; i += 1, el = el.parentElement) {
    const gap = cardTop - el.getBoundingClientRect().bottom
    if (gap >= 0 && gap <= MAX_GAP) { best = el; break }
  }
  return best
}

function fit(card) {
  if (!card.isConnected) return
  const style = window.getComputedStyle(card)
  if (style.position !== 'fixed' && style.position !== 'absolute') return
  const rect = card.getBoundingClientRect()
  if (!rect.height) return

  // Si la pantalla movio la tarjeta (otra fila), se olvida el ajuste anterior.
  if (card.dataset.hcTop && card.style.top !== card.dataset.hcTop) {
    delete card.dataset.hcTop
    delete card.dataset.hcUp
  }

  const vh = window.innerHeight
  const vw = window.innerWidth
  let dy = 0
  let dx = 0

  if (card.dataset.hcUp && card.dataset.hcAnchorTop) {
    // Ya abierta hacia arriba: si cambia de alto, sigue pegada encima.
    const wanted = Number(card.dataset.hcAnchorTop) - Number(card.dataset.hcGap || 4) - rect.height
    dy = Math.max(MARGIN, wanted) - rect.top
  } else if (rect.bottom > vh - MARGIN) {
    const anchor = findAnchor(card, rect.top)
    const anchorRect = anchor?.getBoundingClientRect()
    if (anchorRect) {
      const gap = Math.min(MAX_GAP, Math.max(4, rect.top - anchorRect.bottom))
      const above = anchorRect.top - gap - rect.height
      if (above >= MARGIN) {
        dy = above - rect.top
        card.dataset.hcUp = '1'
        card.dataset.hcAnchorTop = String(anchorRect.top)
        card.dataset.hcGap = String(gap)
      } else {
        dy = Math.max(MARGIN, vh - MARGIN - rect.height) - rect.top
      }
    } else {
      dy = Math.max(MARGIN, vh - MARGIN - rect.height) - rect.top
    }
  }

  if (rect.right > vw - MARGIN) dx = Math.max(MARGIN, vw - MARGIN - rect.width) - rect.left

  if (Math.abs(dy) >= 1) {
    const top = `${(parseFloat(style.top) || 0) + dy}px`
    card.style.top = top
    card.dataset.hcTop = top
  }
  if (Math.abs(dx) >= 1) {
    card.style.left = `${(parseFloat(style.left) || 0) + dx}px`
  }
}

const track = (card) => {
  if (!tracked.has(card)) {
    tracked.add(card)
    resizeObserver?.observe(card)
  }
  fit(card)
}

export function startHoverCardFit() {
  if (typeof window === 'undefined' || window.__hoverCardFit) return
  window.__hoverCardFit = true

  document.addEventListener('pointerover', (event) => { lastHovered = event.target }, true)

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === 'attributes') {
        if (isCard(mutation.target)) fit(mutation.target)
        return
      }
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return
        if (isCard(node)) track(node)
        node.querySelectorAll?.('[class*="hover-card"]').forEach((el) => { if (isCard(el)) track(el) })
      })
    })
  })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] })
}
