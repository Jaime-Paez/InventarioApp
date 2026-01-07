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
  return fetch(url, {
    ...rest,
    headers: buildAuthHeaders(token, customHeaders),
  })
}

const resolveFallbackApiUrl = () => {
  if (typeof window === 'undefined') {
    return 'http://localhost:8000'
  }

  return `http://${window.location.hostname}:8000`
}

export const API_URL = import.meta.env.VITE_API_URL || resolveFallbackApiUrl()
