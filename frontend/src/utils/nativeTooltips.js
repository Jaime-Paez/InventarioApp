// El tooltip nativo del navegador (el cuadro oscuro que sale al dejar el mouse
// sobre un elemento con atributo title) no se usa en ningun lado del sistema.
// Cada title se pasa a data-title -- de ahi lo leen los hovers propios, como
// la tarjeta blanca de la importacion -- y, si el elemento no tiene texto (un
// boton de solo icono), tambien a aria-label para que conserve su nombre
// accesible. Un MutationObserver lo hace con todo lo que React monte o
// actualice despues.

const ARIA_FLAG = 'data-title-aria'

const moveTitle = (el) => {
  if (el.tagName === 'IFRAME') return
  const text = el.getAttribute('title')
  el.removeAttribute('title')
  if (!text) return
  el.setAttribute('data-title', text)
  // Solo se pisa el aria-label si lo puso este mismo modulo.
  if (el.hasAttribute(ARIA_FLAG) || (!el.hasAttribute('aria-label') && !el.textContent.trim())) {
    el.setAttribute('aria-label', text)
    el.setAttribute(ARIA_FLAG, '')
  }
}

const sweep = (root) => {
  if (root.nodeType !== Node.ELEMENT_NODE) return
  if (root.hasAttribute('title')) moveTitle(root)
  root.querySelectorAll('[title]').forEach(moveTitle)
}

export const startNativeTooltipBlocker = () => {
  if (typeof document === 'undefined' || !document.body) return
  sweep(document.body)
  new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === 'attributes') {
        if (mutation.target.hasAttribute('title')) moveTitle(mutation.target)
        return
      }
      mutation.addedNodes.forEach(sweep)
    })
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] })
}
