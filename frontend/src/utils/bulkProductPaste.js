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

export function parseBulkProductPasteText(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const entries = []

  for (const line of lines) {
    if (!line.trim()) continue
    const cells = line.split('\t')
    const codigo = String(cells[CODIGO_COLUMN] ?? '').trim()
    if (!codigo) continue

    const cantidadRaw = String(cells[CANTIDAD_COLUMN] ?? '').trim().replace(',', '.')
    const cantidad = Math.trunc(Number(cantidadRaw))
    if (!Number.isFinite(cantidad) || cantidad <= 0) continue

    entries.push({ codigo, cantidad })
  }

  return entries
}
