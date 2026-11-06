// Estados de una orden de taller. `chip` = clase de color: la misma en la
// tabla y en la cinta de la ventana (mismo estado = mismo color).
export const ORDEN_ESTADOS = {
  cotizacion: { label: 'Cotización', chip: 'cotizacion' },
  orden: { label: 'Orden de trabajo', chip: 'orden' },
  cerrada: { label: 'Cerrada', chip: 'cerrada' },
  rechazada: { label: 'Rechazada', chip: 'rechazada' },
  anulada: { label: 'Anulada', chip: 'anulada' },
}

export const ESTADO_FILTROS = [
  { key: '', label: 'Todas' },
  { key: 'cotizacion', label: 'Cotizaciones' },
  { key: 'orden', label: 'Órdenes de trabajo' },
  { key: 'cerrada', label: 'Cerradas' },
  { key: 'rechazada,anulada', label: 'Rechazadas / anuladas' },
]

// Pasos de la orden, como los de Importaciones. Rechazada/anulada no son un
// paso: se muestran con su chip sobre el paso donde quedo la orden.
export const ORDEN_PASOS = [
  { key: 'cotizacion', label: 'Cotización' },
  { key: 'orden', label: 'Orden de trabajo' },
  { key: 'cerrada', label: 'Cerrada' },
]

export const LINEA_TIPOS = {
  repuesto: { label: 'Repuesto', short: 'Repuesto' },
  sin_codigo: { label: 'Repuesto sin código', short: 'Sin código' },
  insumo: { label: 'Insumo', short: 'Insumo' },
  mano_obra: { label: 'Mano de obra', short: 'Mano de obra' },
}

export const estadoInfo = (estado) => ORDEN_ESTADOS[estado] || { label: estado || '-', chip: 'cotizacion' }

export const formatMoney = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return '$0.00'
  return `$${number.toFixed(2)}`
}

export const formatOrdenNumero = (numero) => (numero ? `#${String(numero).padStart(5, '0')}` : '')

export const parseApiError = async (response, fallback) => {
  try {
    const data = await response.json()
    if (typeof data?.detail === 'string') return data.detail
    if (Array.isArray(data?.detail)) return data.detail.join(' ')
    if (data && typeof data === 'object') {
      const first = Object.values(data).flat().find((value) => typeof value === 'string')
      if (first) return first
    }
  } catch {
    // sin cuerpo
  }
  return fallback
}
