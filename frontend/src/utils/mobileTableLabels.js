// En el telefono las tablas de las ventanas (productos de una salida/entrada,
// etc.) se muestran como tarjetas, una celda debajo de otra. Para que cada
// dato conserve su nombre, cada celda recibe data-label con el texto de su
// columna en la fila de encabezado. Las celdas que ya traen data-label propio
// no se tocan. Las filas con otra cantidad de celdas (totales) se omiten.

const TABLE_SELECTOR = '.create-user__locations-table'
const HEAD_SELECTOR = ':scope > .create-user__locations-row--head'
const ROW_SELECTOR = ':scope > .create-user__locations-row:not(.create-user__locations-row--head)'

const labelTable = (table) => {
  const head = table.querySelector(HEAD_SELECTOR)
  if (!head) return
  const labels = [...head.children].map((cell) => String(cell.textContent || '').replace(/\s+/g, ' ').trim())
  table.querySelectorAll(ROW_SELECTOR).forEach((row) => {
    const cells = [...row.children]
    if (cells.length !== labels.length) return
    cells.forEach((cell, index) => {
      if (cell.hasAttribute('data-label') && !cell.hasAttribute('data-auto-label')) return
      const label = labels[index]
      if (!label) return
      if (cell.getAttribute('data-label') === label) return
      cell.setAttribute('data-label', label)
      cell.setAttribute('data-auto-label', '')
    })
  })
}

export const startMobileTableLabels = () => {
  if (typeof window === 'undefined' || typeof MutationObserver === 'undefined') return () => {}

  let frame = null
  const run = () => {
    frame = null
    document.querySelectorAll(TABLE_SELECTOR).forEach(labelTable)
  }
  const schedule = () => {
    if (frame === null) frame = window.requestAnimationFrame(run)
  }

  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true })
  schedule()

  return () => {
    observer.disconnect()
    if (frame !== null) window.cancelAnimationFrame(frame)
  }
}
