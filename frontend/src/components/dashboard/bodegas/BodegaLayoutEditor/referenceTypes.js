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

export const isReferenceType = (tipo) => REFERENCE_KEYS.has(String(tipo ?? '').trim().toLowerCase())
