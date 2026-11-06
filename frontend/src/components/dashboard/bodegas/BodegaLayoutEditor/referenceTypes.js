// Tipos de ubicacion del plano que solo sirven para identificar lo que hay en
// la bodega (no guardan productos): no crean division ni piden subdivisiones.
export const REFERENCE_TYPES = ['Puerta', 'Pasillo', 'Columna', 'Pared', 'Escritorio']

// Tonos neutros para distinguirlos de las ubicaciones con productos.
export const REFERENCE_TYPE_COLORS = {
  Puerta: '#a16207',
  Pasillo: '#cbd5e1',
  Columna: '#64748b',
  Pared: '#475569',
  Escritorio: '#a8a29e',
}

const REFERENCE_KEYS = new Set(REFERENCE_TYPES.map((type) => type.toLowerCase()))

// Tipos marcados "solo visual" en el catalogo (Sucursales -> Tipos de
// ubicacion). Se actualiza al cargar el catalogo en el plano.
const catalogReferenceKeys = new Set()
export const setCatalogReferenceTypes = (names) => {
  catalogReferenceKeys.clear()
  ;(names || []).forEach((name) => catalogReferenceKeys.add(String(name ?? '').trim().toLowerCase()))
}

export const isReferenceType = (tipo) => {
  const key = String(tipo ?? '').trim().toLowerCase()
  return REFERENCE_KEYS.has(key) || catalogReferenceKeys.has(key)
}
