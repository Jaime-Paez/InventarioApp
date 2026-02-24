const normalizeMatchMode = (matchMode, fallback = 'contains') => {
  const parsed = String(matchMode || '').trim()
  return parsed || fallback
}

const normalizeConstraintValue = (value) => {
  if (value == null) return null

  if (Array.isArray(value)) {
    const list = value
      .map((item) => {
        if (item == null) return null
        if (typeof item === 'string') {
          const trimmed = item.trim()
          return trimmed || null
        }
        return item
      })
      .filter((item) => item != null)
    return list.length ? list : null
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed || null
  }

  return value
}

const extractConstraints = (meta, fallbackMatchMode = 'contains') => {
  if (!meta || typeof meta !== 'object') return []

  if (Array.isArray(meta.constraints)) {
    return meta.constraints
      .map((constraint) => {
        if (!constraint || typeof constraint !== 'object') return null
        const value = normalizeConstraintValue(constraint.value)
        if (value == null) return null
        return {
          value,
          matchMode: normalizeMatchMode(constraint.matchMode, fallbackMatchMode),
        }
      })
      .filter(Boolean)
  }

  const value = normalizeConstraintValue(meta.value)
  if (value == null) return []
  return [
    {
      value,
      matchMode: normalizeMatchMode(meta.matchMode, fallbackMatchMode),
    },
  ]
}

export const getPrimeGlobalFilterValue = (filters) => {
  const value = normalizeConstraintValue(filters?.global?.value)
  if (value == null) return ''
  if (Array.isArray(value)) return value.join(' ').trim()
  return String(value).trim()
}

export const buildPrimeColumnFiltersPayload = (filters, options = {}) => {
  if (!filters || typeof filters !== 'object') return null

  const allowedFields = Array.isArray(options?.allowedFields) ? options.allowedFields : []
  const defaultMatchModes = options?.defaultMatchModes || {}
  const result = {}

  allowedFields.forEach((field) => {
    const meta = filters[field]
    const fallbackMatchMode = normalizeMatchMode(defaultMatchModes[field], 'contains')
    const constraints = extractConstraints(meta, fallbackMatchMode)
    if (!constraints.length) return
    const operator = String(meta?.operator || 'AND').toUpperCase()
    result[field] = {
      operator: operator === 'OR' ? 'OR' : 'AND',
      constraints,
    }
  })

  return Object.keys(result).length ? result : null
}

export const buildPrimeOrdering = (sortField, sortOrder, fieldMap = {}) => {
  const normalizedOrder = Number(sortOrder)
  if (!sortField || (normalizedOrder !== 1 && normalizedOrder !== -1)) return ''

  const backendField = fieldMap?.[sortField] || sortField
  if (!backendField) return ''

  return normalizedOrder === -1 ? `-${backendField}` : backendField
}
