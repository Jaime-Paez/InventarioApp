const groupThousands = (digits) => String(digits || '').replace(/\B(?=(\d{3})+(?!\d))/g, ',')

export const formatMoneyInput = (value, { decimals = 2 } = {}) => {
  const raw = String(value ?? '').replace(/\s+/g, '')
  if (!raw) return ''

  const precision = Math.max(0, Number(decimals) || 0)
  const digitsOnly = raw.replace(/\D/g, '')
  if (!digitsOnly) return ''

  if (precision === 0) {
    const integerOnly = digitsOnly.replace(/^0+(?=\d)/, '') || '0'
    return groupThousands(integerOnly)
  }

  const normalizedDigits = digitsOnly.replace(/^0+(?=\d)/, '') || '0'
  const minimumLength = precision + 1
  const padded = normalizedDigits.padStart(minimumLength, '0')
  const integerDigits = padded.slice(0, -precision)
  const decimalDigits = padded.slice(-precision)

  return `${groupThousands(integerDigits)}.${decimalDigits}`
}

export const parseMoneyInput = (value) => {
  const cleaned = String(value ?? '').trim().replace(/,/g, '')
  if (!cleaned || cleaned === '.') return null
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

export const formatMoneyFromValue = (value, { decimals = 2 } = {}) => {
  if (value == null || value === '') return ''
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return ''
  return parsed.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}
