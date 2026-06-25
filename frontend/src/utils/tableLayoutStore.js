import { API_URL, authFetch } from './api'

const TABLE_LAYOUTS_ENDPOINT = `${API_URL}/usuarios/preferencias/table-layouts/`
const TABLE_LAYOUT_KEY_PATTERN = /-table-(?:columns|state)/i
const WRITE_DEBOUNCE_MS = 1500

const _s = {
  map: new Map(),
  token: null,
  ready: false,
  readyCallbacks: [],
  pendingWrites: new Map(),
  writeTimer: null,
  _unloadHandler: null,
  _visibilityHandler: null,
}

function _isValidKey(key) {
  return TABLE_LAYOUT_KEY_PATTERN.test(String(key || ''))
}

function _flush() {
  if (_s.pendingWrites.size === 0 || !_s.token) return
  const layouts = {}
  _s.pendingWrites.forEach((value, key) => {
    layouts[`local:${key}`] = value // null signals deletion to backend
  })
  _s.pendingWrites.clear()
  // keepalive: true allows the request to complete even during page unload
  fetch(TABLE_LAYOUTS_ENDPOINT, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Token ${_s.token}`,
    },
    body: JSON.stringify({ layouts }),
    keepalive: true,
  }).catch(() => {})
}

function _scheduleFlush() {
  if (_s.writeTimer) clearTimeout(_s.writeTimer)
  _s.writeTimer = setTimeout(_flush, WRITE_DEBOUNCE_MS)
}

function _registerUnloadHandlers() {
  if (typeof window === 'undefined') return

  _s._unloadHandler = () => { _flush() }
  _s._visibilityHandler = () => {
    if (document.visibilityState === 'hidden') _flush()
  }

  window.addEventListener('beforeunload', _s._unloadHandler)
  document.addEventListener('visibilitychange', _s._visibilityHandler)
}

function _removeUnloadHandlers() {
  if (typeof window === 'undefined') return
  if (_s._unloadHandler) {
    window.removeEventListener('beforeunload', _s._unloadHandler)
    _s._unloadHandler = null
  }
  if (_s._visibilityHandler) {
    document.removeEventListener('visibilitychange', _s._visibilityHandler)
    _s._visibilityHandler = null
  }
}

export const tableLayoutStore = {
  getItem(key) {
    return _s.map.get(key) ?? null
  },

  setItem(key, value) {
    _s.map.set(key, value)
    if (_s.ready && _isValidKey(key)) {
      _s.pendingWrites.set(key, value)
      _scheduleFlush()
    }
  },

  removeItem(key) {
    _s.map.delete(key)
    if (_s.ready && _isValidKey(key)) {
      _s.pendingWrites.set(key, null)
      _scheduleFlush()
    }
  },

  isReady() {
    return _s.ready
  },

  /**
   * Fetches all table layouts from the DB and populates the in-memory map.
   * Must complete before tables render so customRestoreState reads correct data.
   * Safe to call multiple times: no-op if already ready with same token.
   */
  async init(token) {
    if (_s.ready && _s.token === token) return
    _s.token = token
    _s.ready = false
    _s.map.clear()
    _s.pendingWrites.clear()
    if (_s.writeTimer) { clearTimeout(_s.writeTimer); _s.writeTimer = null }
    _removeUnloadHandlers()

    try {
      const response = await authFetch(TABLE_LAYOUTS_ENDPOINT, {}, token)
      if (response.ok) {
        const payload = await response.json().catch(() => ({}))
        const layouts = payload?.layouts ?? {}
        Object.entries(layouts).forEach(([compositeKey, value]) => {
          const colonIdx = compositeKey.indexOf(':')
          if (colonIdx <= 0) return
          const scope = compositeKey.slice(0, colonIdx)
          const key = compositeKey.slice(colonIdx + 1)
          if (scope === 'local' && typeof value === 'string') {
            _s.map.set(key, value)
          }
        })
      }
    } catch {}

    _s.ready = true
    _registerUnloadHandlers()
    const cbs = [..._s.readyCallbacks]
    _s.readyCallbacks = []
    cbs.forEach(cb => { try { cb() } catch {} })
  },

  reset() {
    // Flush any pending writes before clearing so changes aren't lost on logout
    if (_s.writeTimer) { clearTimeout(_s.writeTimer); _s.writeTimer = null }
    _flush()
    _removeUnloadHandlers()
    _s.map.clear()
    _s.pendingWrites.clear()
    _s.token = null
    _s.ready = false
    _s.readyCallbacks = []
  },
}
