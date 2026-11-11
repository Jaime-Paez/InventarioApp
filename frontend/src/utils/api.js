export const resolveAuthToken = (token) => {
  if (token) return token
  try {
    return localStorage.getItem('token') || ''
  } catch {
    return ''
  }
}

export const buildAuthHeaders = (token, extraHeaders = {}) => {
  const effectiveToken = resolveAuthToken(token)
  return {
    'Content-Type': 'application/json',
    ...(effectiveToken ? { Authorization: `Token ${effectiveToken}` } : {}),
    ...extraHeaders,
  }
}

export const authFetch = (url, options = {}, token) => {
  const { headers: customHeaders, ...rest } = options || {}
  const normalizeLocalRequestUrl = (value) => {
    const raw = String(value || '').trim()
    if (!raw) return raw
    try {
      const parsed = new URL(raw)
      const host = String(parsed.hostname || '').trim().toLowerCase()
      const isLocalHost =
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '0.0.0.0'
      if (!isLocalHost) return raw

      if (host === 'localhost' || host === '0.0.0.0') {
        parsed.hostname = '127.0.0.1'
      }
      if (parsed.protocol === 'https:') {
        parsed.protocol = 'http:'
      }
      return parsed.toString()
    } catch {
      // Keep original URL if parsing fails.
    }
    return raw
  }

  return fetchConMensaje(normalizeLocalRequestUrl(url), {
    ...rest,
    headers: buildAuthHeaders(token, customHeaders),
  })
}

// Cuando la peticion no llega al servidor el navegador da "Failed to fetch"
// (Chrome), "NetworkError when attempting to fetch resource" (Firefox) o
// "Load failed" (Safari). Al usuario se le muestra un mensaje claro.
export const MENSAJE_ERROR_CONEXION = 'Error de conexión, revisa tu conexión a internet.'

export const esErrorDeConexion = (error) => {
  if (!error || error?.name === 'AbortError') return false
  const message = String(error?.message || '').toLowerCase()
  return error instanceof TypeError && (
    message.includes('failed to fetch') ||
    message.includes('networkerror') ||
    message.includes('load failed') ||
    message.includes('network request failed')
  )
}

export const fetchConMensaje = async (url, options) => {
  try {
    return await fetch(url, options)
  } catch (error) {
    if (esErrorDeConexion(error)) {
      const conexion = new Error(MENSAJE_ERROR_CONEXION)
      conexion.name = 'ConnectionError'
      conexion.cause = error
      throw conexion
    }
    throw error
  }
}

const normalizeLocalHostname = (host) => {
  const normalizedHost = String(host || '').trim().toLowerCase()
  if (!normalizedHost || normalizedHost === 'localhost' || normalizedHost === '0.0.0.0') {
    return '127.0.0.1'
  }
  return normalizedHost
}

const resolveFallbackApiUrl = () => {
  if (typeof window === 'undefined') {
    return 'http://127.0.0.1:8000'
  }
  const currentHost = normalizeLocalHostname(window.location.hostname)
  if (currentHost === '127.0.0.1') {
    return 'http://127.0.0.1:8000'
  }
  return `http://${currentHost}:8000`
}

const normalizeApiUrl = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''

  const normalized = raw.replace(/\/+$/, '')
  if (/^https?:\/\//i.test(normalized)) {
    try {
      const parsed = new URL(normalized)
      const host = String(parsed.hostname || '').trim().toLowerCase()
      const isLocalHost =
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '0.0.0.0'

      if (!isLocalHost) return normalized

      if (host === 'localhost' || host === '0.0.0.0') {
        parsed.hostname = '127.0.0.1'
      }
      if (parsed.protocol === 'https:') {
        parsed.protocol = 'http:'
      }
      return parsed.toString().replace(/\/+$/, '')
    } catch {
      // Keep original URL if parsing fails.
    }
    return normalized
  }

  if (typeof window === 'undefined') return normalized

  if (normalized.startsWith(':')) {
    const host = normalizeLocalHostname(window.location.hostname)
    return `http://${host}${normalized}`
  }
  if (/^\d+$/.test(normalized)) {
    const host = normalizeLocalHostname(window.location.hostname)
    return `http://${host}:${normalized}`
  }
  if (/^[a-z0-9.-]+:\d+$/i.test(normalized)) {
    const [host, port] = normalized.split(':')
    return `http://${normalizeLocalHostname(host)}:${port}`
  }

  return normalized
}

const ENV_API_URL = normalizeApiUrl(import.meta.env.VITE_API_URL)

export const API_URL = ENV_API_URL || resolveFallbackApiUrl()
