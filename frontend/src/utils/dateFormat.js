// Formato de fecha único para todo el sistema: dd/mm/aaaa (y dd/mm/aaaa, HH:mm para fecha+hora).
// Acepta fechas ISO ("YYYY-MM-DD" o "YYYY-MM-DDTHH:mm:ss...") o cualquier valor parseable por Date.
const toDateParts = (value) => {
  const raw = String(value ?? '').trim()
  if (!raw) return null

  // Con hora y zona ("...T21:11:08Z" o "...T16:11:08-05:00") se pasa a la
  // hora local: el historial de traslados se guarda en UTC y salia 21:11
  // en vez de 16:11. Sin zona (o solo fecha) se usa tal cual viene.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const parsedWithZone = new Date(raw)
    if (!Number.isNaN(parsedWithZone.getTime())) {
      return {
        year: parsedWithZone.getFullYear(),
        month: parsedWithZone.getMonth() + 1,
        day: parsedWithZone.getDate(),
        hours: parsedWithZone.getHours(),
        minutes: parsedWithZone.getMinutes(),
      }
    }
  }

  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (isoMatch) {
    const [, year, month, day] = isoMatch
    const timeMatch = raw.match(/T(\d{2}):(\d{2})/)
    return {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hours: timeMatch ? Number(timeMatch[1]) : null,
      minutes: timeMatch ? Number(timeMatch[2]) : null,
    }
  }

  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return null
  return {
    year: parsed.getFullYear(),
    month: parsed.getMonth() + 1,
    day: parsed.getDate(),
    hours: parsed.getHours(),
    minutes: parsed.getMinutes(),
  }
}

const pad2 = (n) => String(n).padStart(2, '0')

export const formatDate = (value, fallback = '-') => {
  const parts = toDateParts(value)
  if (!parts) return fallback
  return `${pad2(parts.day)}/${pad2(parts.month)}/${parts.year}`
}

export const formatDateTime = (value, fallback = '-') => {
  const parts = toDateParts(value)
  if (!parts) return fallback
  const datePart = `${pad2(parts.day)}/${pad2(parts.month)}/${parts.year}`
  if (parts.hours == null || parts.minutes == null) return datePart
  return `${datePart}, ${pad2(parts.hours)}:${pad2(parts.minutes)}`
}
