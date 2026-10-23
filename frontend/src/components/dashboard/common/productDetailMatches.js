const normalizeSearch = (value) =>
  String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

// Buscador rapido de productos dentro de un movimiento (entradas y salidas):
// por codigo, descripcion y referencia; varias palabras = todas deben estar.
export const productDetailMatches = (detail, query) => {
  const terms = normalizeSearch(query).split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const text = normalizeSearch([
    detail?.productoCodigo, detail?.productoNombre, detail?.productoReferencia,
    detail?.producto_codigo, detail?.producto_nombre, detail?.producto,
  ].join(' '))
  return terms.every((term) => text.includes(term))
}
