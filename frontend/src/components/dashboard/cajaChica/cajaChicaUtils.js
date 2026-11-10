export const formatMoney = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return '$0.00'
  const sign = number < 0 ? '-' : ''
  return `${sign}$${Math.abs(number).toFixed(2)}`
}

export const parseApiError = async (response, fallback) => {
  try {
    const data = await response.json()
    if (typeof data?.detail === 'string') return data.detail
    if (data && typeof data === 'object') {
      const first = Object.values(data).flat().find((value) => typeof value === 'string')
      if (first) return first
    }
  } catch {
    // sin cuerpo
  }
  return fallback
}

export const TIPO_LABELS = {
  apertura: 'Apertura',
  gasto: 'Gasto',
  anticipo: 'Anticipo / vale',
  ingreso: 'Ingreso',
  reposicion: 'Reposición',
  vuelto: 'Vuelto de anticipo',
}

export const ESTADO_CHIP = {
  aprobado: 'orden',
  pendiente: 'pendiente',
  rechazado: 'anulada',
}

export const COMPROBANTES = [
  { key: 'factura', label: 'Factura' },
  { key: 'nota_venta', label: 'Nota de venta' },
  { key: 'recibo', label: 'Recibo' },
  { key: 'sin', label: 'Sin comprobante' },
]

export const DENOMINACIONES = [
  { key: '100', label: '$100', tipo: 'Billetes' },
  { key: '50', label: '$50', tipo: 'Billetes' },
  { key: '20', label: '$20', tipo: 'Billetes' },
  { key: '10', label: '$10', tipo: 'Billetes' },
  { key: '5', label: '$5', tipo: 'Billetes' },
  { key: '2', label: '$2', tipo: 'Billetes' },
  { key: '1', label: '$1', tipo: 'Monedas' },
  { key: '0.50', label: '50¢', tipo: 'Monedas' },
  { key: '0.25', label: '25¢', tipo: 'Monedas' },
  { key: '0.10', label: '10¢', tipo: 'Monedas' },
  { key: '0.05', label: '5¢', tipo: 'Monedas' },
  { key: '0.01', label: '1¢', tipo: 'Monedas' },
]

export const todayIso = () => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

// Mes del filtro de movimientos: { anio, mes } con mes 0-11.
export const currentMonth = () => {
  const now = new Date()
  return { anio: now.getFullYear(), mes: now.getMonth() }
}

export const shiftMonth = ({ anio, mes }, delta) => {
  const d = new Date(anio, mes + delta, 1)
  return { anio: d.getFullYear(), mes: d.getMonth() }
}

// Primer y ultimo dia del mes, en formato ISO (desde / hasta del API).
export const monthRange = ({ anio, mes }) => {
  const mm = String(mes + 1).padStart(2, '0')
  const ultimo = new Date(anio, mes + 1, 0).getDate()
  return { desde: `${anio}-${mm}-01`, hasta: `${anio}-${mm}-${String(ultimo).padStart(2, '0')}` }
}

// "Noviembre 2026"
export const monthLabel = ({ anio, mes }) => {
  const nombre = new Date(anio, mes, 1).toLocaleDateString('es-EC', { month: 'long' })
  return `${nombre.charAt(0).toUpperCase()}${nombre.slice(1)} ${anio}`
}

// Foto del comprobante: se reduce en el navegador (JPEG, max 1400px) para no
// guardar imagenes de varios MB.
export const fileToReducedDataUrl = (file, maxSide = 1400, quality = 0.75) =>
  new Promise((resolve, reject) => {
    if (!file || !String(file.type || '').startsWith('image/')) {
      reject(new Error('El archivo no es una imagen.'))
      return
    }
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('No se pudo leer la imagen.'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('No se pudo leer la imagen.'))
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height))
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(img.width * scale)
        canvas.height = Math.round(img.height * scale)
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/jpeg', quality))
      }
      img.src = reader.result
    }
    reader.readAsDataURL(file)
  })
