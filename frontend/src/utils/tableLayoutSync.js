import { API_URL, authFetch, resolveAuthToken } from './api'

const TABLE_LAYOUTS_ENDPOINT = `${API_URL}/usuarios/preferencias/table-layouts/`
const TABLE_LAYOUT_KEY_PATTERN = /-table-(?:columns|state)/i
const SYNC_INTERVAL_MS = 2000

const STORAGE_BY_SCOPE = {
  local: () => (typeof window === 'undefined' ? null : window.localStorage),
  session: () => (typeof window === 'undefined' ? null : window.sessionStorage),
}

const isTableLayoutKey = (key) => TABLE_LAYOUT_KEY_PATTERN.test(String(key || ''))

const collectScopeSnapshot = (scope) => {
  const resolveStorage = STORAGE_BY_SCOPE[scope]
  const storage = typeof resolveStorage === 'function' ? resolveStorage() : null
  if (!storage) return {}

  const keys = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (!isTableLayoutKey(key)) continue
    keys.push(String(key))
  }

  keys.sort()
  const snapshot = {}
  keys.forEach((key) => {
    const value = storage.getItem(key)
    if (typeof value !== 'string') return
    snapshot[key] = value
  })

  return snapshot
}

const collectTableLayoutSnapshot = () => ({
  local: collectScopeSnapshot('local'),
  session: collectScopeSnapshot('session'),
})

const clearTableLayoutKeysFromStorage = () => {
  Object.keys(STORAGE_BY_SCOPE).forEach((scope) => {
    const resolveStorage = STORAGE_BY_SCOPE[scope]
    const storage = typeof resolveStorage === 'function' ? resolveStorage() : null
    if (!storage) return

    const keys = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (!isTableLayoutKey(key)) continue
      keys.push(String(key))
    }

    keys.forEach((key) => {
      storage.removeItem(key)
    })
  })
}

const normalizeRemoteLayouts = (payload) => {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload.layouts
    : null

  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { local: {}, session: {} }
  }

  const snapshot = { local: {}, session: {} }
  Object.entries(source).forEach(([rawCompositeKey, rawValue]) => {
    const compositeKey = String(rawCompositeKey || '').trim()
    const separatorIndex = compositeKey.indexOf(':')
    if (separatorIndex <= 0) return

    const scope = compositeKey.slice(0, separatorIndex).trim().toLowerCase()
    const key = compositeKey.slice(separatorIndex + 1).trim()
    if (!Object.prototype.hasOwnProperty.call(STORAGE_BY_SCOPE, scope)) return
    if (!isTableLayoutKey(key)) return
    if (typeof rawValue !== 'string') return

    snapshot[scope][key] = rawValue
  })

  return snapshot
}

const applySnapshotToStorage = (snapshot) => {
  Object.keys(STORAGE_BY_SCOPE).forEach((scope) => {
    const resolveStorage = STORAGE_BY_SCOPE[scope]
    const storage = typeof resolveStorage === 'function' ? resolveStorage() : null
    if (!storage) return

    const values = snapshot?.[scope]
    if (!values || typeof values !== 'object' || Array.isArray(values)) return

    Object.entries(values).forEach(([key, value]) => {
      if (!isTableLayoutKey(key)) return
      if (typeof value !== 'string') return
      storage.setItem(key, value)
    })
  })
}

const buildLayoutsPayload = (snapshot) => {
  const layouts = {}
  Object.keys(STORAGE_BY_SCOPE).forEach((scope) => {
    const values = snapshot?.[scope]
    if (!values || typeof values !== 'object' || Array.isArray(values)) return

    Object.entries(values).forEach(([key, value]) => {
      if (!isTableLayoutKey(key)) return
      if (typeof value !== 'string') return
      layouts[`${scope}:${key}`] = value
    })
  })
  return { layouts }
}

const buildSnapshotHash = (snapshot) => JSON.stringify(snapshot || { local: {}, session: {} })

const fetchUserTableLayouts = async (token) => {
  const response = await authFetch(TABLE_LAYOUTS_ENDPOINT, {}, token)
  if (!response.ok) {
    throw new Error('No se pudieron cargar los layouts de tablas.')
  }
  const payload = await response.json().catch(() => ({}))
  return normalizeRemoteLayouts(payload)
}

const pushUserTableLayouts = async (snapshot, token) => {
  const payload = buildLayoutsPayload(snapshot)
  const response = await authFetch(
    TABLE_LAYOUTS_ENDPOINT,
    {
      method: 'PUT',
      body: JSON.stringify(payload),
    },
    token
  )
  if (!response.ok) {
    throw new Error('No se pudieron guardar los layouts de tablas.')
  }
}

export const startTableLayoutSync = ({ token }) => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {}
  }

  const effectiveToken = resolveAuthToken(token)
  if (!effectiveToken) {
    return () => {}
  }

  let stopped = false
  let syncTimer = null
  let syncInFlight = false
  let lastSyncedHash = ''

  const syncSnapshot = async () => {
    if (stopped || syncInFlight) return
    const snapshot = collectTableLayoutSnapshot()
    const snapshotHash = buildSnapshotHash(snapshot)
    if (snapshotHash === lastSyncedHash) return

    syncInFlight = true
    try {
      await pushUserTableLayouts(snapshot, effectiveToken)
      lastSyncedHash = snapshotHash
    } catch {
      // Ignore transient sync failures and retry on next cycle.
    } finally {
      syncInFlight = false
    }
  }

  const bootstrap = async () => {
    try {
      const remoteSnapshot = await fetchUserTableLayouts(effectiveToken)
      if (stopped) return
      clearTableLayoutKeysFromStorage()
      applySnapshotToStorage(remoteSnapshot)
      lastSyncedHash = buildSnapshotHash(collectTableLayoutSnapshot())
    } catch {
      // Keep local snapshot if bootstrap fetch fails.
      lastSyncedHash = buildSnapshotHash(collectTableLayoutSnapshot())
    }

    if (stopped) return

    syncTimer = window.setInterval(() => {
      void syncSnapshot()
    }, SYNC_INTERVAL_MS)
  }

  void bootstrap()

  const handleVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      void syncSnapshot()
    }
  }

  const handleBeforeUnload = () => {
    void syncSnapshot()
  }

  document.addEventListener('visibilitychange', handleVisibilityChange)
  window.addEventListener('beforeunload', handleBeforeUnload)

  return () => {
    stopped = true
    if (syncTimer) {
      window.clearInterval(syncTimer)
      syncTimer = null
    }
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    window.removeEventListener('beforeunload', handleBeforeUnload)
  }
}
