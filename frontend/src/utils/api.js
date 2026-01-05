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
    credentials: 'include',
    ...rest,
    headers: buildAuthHeaders(token, customHeaders),
  })
}
