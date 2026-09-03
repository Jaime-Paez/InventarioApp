// Parses tab-separated product listings copied from external systems (e.g. Koinor)
// and pasted into the "buscar producto" field of a movimiento (entrada/salida).
// Expected shape per line (tab-separated), only columns 0 and 3 are used:
//   codigo \t descripcion \t unidad \t cantidad \t precio \t ...

const CODIGO_COLUMN = 0
const CANTIDAD_COLUMN = 3

export function isBulkProductPasteText(text) {
  const value = String(text ?? '')
  if (!value.includes('\t')) return false
  const nonEmptyLines = value.split(/\r?\n/).filter((line) => line.trim())
  return nonEmptyLines.length >= 1
}

// Ademas de las filas validas, devuelve las lineas con contenido que se
// descartaron (sin codigo en la columna esperada, o con una cantidad no
// numerica/cero) -- asi el caller puede decir exactamente cual linea pegada
// quedo afuera, en vez de solo agregar menos productos de los pegados sin
// ninguna explicacion.
export function parseBulkProductPasteText(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const entries = []
  const invalidLines = []

  lines.forEach((line, index) => {
    if (!line.trim()) return
    const cells = line.split('\t')
    const codigo = String(cells[CODIGO_COLUMN] ?? '').trim()
    if (!codigo) {
      invalidLines.push({ numeroFila: index + 1, codigo: '', motivo: 'sin codigo' })
      return
    }

    const cantidadRaw = String(cells[CANTIDAD_COLUMN] ?? '').trim().replace(',', '.')
    const cantidad = Math.trunc(Number(cantidadRaw))
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      invalidLines.push({ numeroFila: index + 1, codigo, motivo: 'cantidad invalida' })
      return
    }

    entries.push({ codigo, cantidad })
  })

  return { entries, invalidLines }
}

export function formatInvalidBulkPasteLines(invalidLines) {
  return (invalidLines || [])
    .map((item) => (item.codigo ? `${item.codigo} (${item.motivo})` : `fila ${item.numeroFila} (${item.motivo})`))
    .join(', ')
}
