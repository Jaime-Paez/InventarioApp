// Como se escribe un monto en los campos de dinero (ver MoneyInput):
//   1, 5, "."   -> $15.00     3, "."  -> $3.00     3, ".", 5 -> $3.50
// El estado es { int, dot, dec }: parte entera, si ya se puso el punto y los
// centavos escritos (0 a 2 digitos, se rellenan con 0 al mostrarlos).

export const MAX_INTEGER_DIGITS = 9
export const EMPTY_MONEY_STATE = Object.freeze({ int: '', dot: false, dec: '' })

const groupThousands = (digits) => String(digits || '').replace(/\B(?=(\d{3})+(?!\d))/g, ',')

export const toMoneyNumber = (value) => {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(String(value).replace(/[$,\s]/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

export const moneyStateFromNumber = (value) => {
  const number = toMoneyNumber(value)
  if (number === null) return { ...EMPTY_MONEY_STATE }
  const [int, dec = ''] = Math.abs(number).toFixed(2).split('.')
  return { int, dot: true, dec }
}

export const moneyStateToNumber = (state) => {
  if (!state.int && !state.dot) return null
  const int = state.int || '0'
  const dec = state.dot ? (state.dec || '').padEnd(2, '0') : '00'
  return Number(`${int}.${dec}`)
}

export const formatMoneyState = (state, { editing = false } = {}) => {
  if (!state.int && !state.dot) return ''
  const int = groupThousands(state.int || '0')
  if (state.dot) return `$${int}.${(state.dec || '').padEnd(2, '0')}`
  return editing ? `$${int}` : `$${int}.00`
}

export const formatMoneyValue = (value) => formatMoneyState(moneyStateFromNumber(value))

// Una tecla. `fresh`: es lo primero que se escribe al entrar al campo, asi que
// reemplaza lo que habia.
export const applyMoneyInsert = (state, char, fresh = false) => {
  const base = fresh ? { ...EMPTY_MONEY_STATE } : state
  if (char === '.' || char === ',') {
    if (base.dot) return base
    return { ...base, int: base.int || '0', dot: true, dec: '' }
  }
  if (!/^\d$/.test(char)) return base
  if (base.dot) {
    if ((base.dec || '').length >= 2) return base
    return { ...base, dec: `${base.dec || ''}${char}` }
  }
  const int = `${base.int === '0' ? '' : base.int}${char}`
  if (int.length > MAX_INTEGER_DIGITS) return base
  return { ...base, int }
}

export const applyMoneyDelete = (state, fresh = false) => {
  if (fresh) return { ...EMPTY_MONEY_STATE }
  if (state.dot && state.dec) return { ...state, dec: state.dec.slice(0, -1) }
  if (state.dot) return { ...state, dot: false }
  return { ...state, int: state.int.slice(0, -1) }
}

// Texto pegado o escrito de golpe ("$1,234.5", "15", "3.", "3,5") -> estado.
export const moneyStateFromText = (text) => {
  const cleaned = String(text || '').replace(/[$\s]/g, '')
  if (!cleaned) return { ...EMPTY_MONEY_STATE }
  const normalized = !cleaned.includes('.') && /,\d{1,2}$/.test(cleaned)
    ? cleaned.replace(',', '.')
    : cleaned.replace(/,/g, '')
  const [intRaw, ...rest] = normalized.split('.')
  const int = intRaw.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, MAX_INTEGER_DIGITS)
  if (!rest.length) return { int, dot: false, dec: '' }
  return { int: int || '0', dot: true, dec: rest.join('').replace(/\D/g, '').slice(0, 2) }
}
