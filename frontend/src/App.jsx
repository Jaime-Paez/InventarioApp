import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DashboardLayout from './components/dashboard/DashboardLayout/DashboardLayout'
import Login from './components/login/Login/Login'
import 'primereact/resources/primereact.min.css';
import 'primeicons/primeicons.css';

// un theme (elige uno)
import 'primereact/resources/themes/lara-light-cyan/theme.css';

// opcional (si usas utilidades)
import 'primeflex/primeflex.css';
import { API_URL, authFetch } from './utils/api'
import { startTableLayoutSync } from './utils/tableLayoutSync'
const LOGIN_EXIT_ANIMATION_MS = 900
const DASHBOARD_EXIT_ANIMATION_MS = 3500
const LOGIN_ENTER_ANIMATION_MS = LOGIN_EXIT_ANIMATION_MS


const getSystemThemePreference = () =>
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
])

const shouldDisableFieldAutocomplete = (field) => {
  if (!field || field.disabled) return false
  const tag = String(field.tagName || '').toLowerCase()
  if (tag === 'textarea') return true
  if (tag !== 'input') return false
  const type = String(field.getAttribute('type') || 'text').toLowerCase()
  return !NON_TEXT_INPUT_TYPES.has(type)
}

const disableAutocompleteInNode = (node) => {
  if (!node || node.nodeType !== 1) return

  const elements = []
  if (node.matches?.('form, input, textarea')) {
    elements.push(node)
  }
  if (node.querySelectorAll) {
    elements.push(...node.querySelectorAll('form, input, textarea'))
  }

  elements.forEach((element) => {
    const tag = String(element.tagName || '').toLowerCase()
    if (tag === 'form') {
      element.setAttribute('autocomplete', 'off')
      return
    }

    if (!shouldDisableFieldAutocomplete(element)) return

    // Chromium/Brave ignora `off` en algunos casos; `new-password` reduce sugerencias.
    element.setAttribute('autocomplete', 'new-password')
    element.setAttribute('autocorrect', 'off')
    element.setAttribute('autocapitalize', 'off')
    element.setAttribute('spellcheck', 'false')
    element.setAttribute('data-lpignore', 'true')
    element.setAttribute('data-1p-ignore', 'true')
  })
}

function App() {
  const [darkMode, setDarkMode] = useState(() => {
    const savedTheme = localStorage.getItem('theme')
    if (savedTheme === 'dark') return true
    if (savedTheme === 'light') return false
    return getSystemThemePreference()
  })

  const [user, setUser] = useState(null)

  const [token, setToken] = useState(() => localStorage.getItem('token') || '')
  const [showApp, setShowApp] = useState(false)
  const [loginTransitioning, setLoginTransitioning] = useState(false)
  const [logoutTransitioning, setLogoutTransitioning] = useState(false)
  const [loginReturning, setLoginReturning] = useState(false)
  const layoutSyncUserKey = useMemo(
    () => String(user?.usuarioInternoId || user?.id || user?.email || '').trim(),
    [user?.email, user?.id, user?.usuarioInternoId]
  )

  const logoutTimeoutRef = useRef(null)
  const loginReturnTimeoutRef = useRef(null)

  useEffect(() => {
    localStorage.setItem('theme', darkMode ? 'dark' : 'light')
  }, [darkMode])

  useEffect(() => {
    if (token) {
      localStorage.setItem('token', token)
    } else {
      localStorage.removeItem('token')
    }
  }, [token])

  const fetchProfile = useCallback(
    async (overrideToken) => {
      const effectiveToken = overrideToken ?? token
      if (!effectiveToken) {
        setUser(null)
        setShowApp(false)
        return null
      }

      try {
        const response = await authFetch(
          `${API_URL}/auth/me/`,
          {
            headers: {
              Authorization: `Token ${effectiveToken}`,
            },
          },
          effectiveToken
        )

        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data?.detail || 'No se pudo obtener el perfil.')

        const userData = {
          ...data.usuario,
          permisos: Array.isArray(data.permisos) ? data.permisos : null,
          usuarioInternoId: data.usuario_interno_id,
        }

        setUser(userData)
        setShowApp(true)
        return userData
      } catch (err) {
        console.error('Error al obtener el perfil', err)
        setUser(null)
        setShowApp(false)
        setToken('')
        localStorage.removeItem('token')
        return null
      }
    },
    [token]
  )

  useEffect(() => {
    fetchProfile()
  }, [fetchProfile])

  useEffect(() => {
    if (!token || !layoutSyncUserKey) return undefined
    const stopSync = startTableLayoutSync({ token })
    return () => {
      if (typeof stopSync === 'function') stopSync()
    }
  }, [layoutSyncUserKey, token])

  const handleLoginSuccess = async (
    incomingUser,
    incomingToken,
    incomingPermissions = null,
    usuarioInternoId = null
  ) => {
    setLoginTransitioning(true)

    // muestra el dashboard de inmediato mientras se completa el perfil
    setUser({ ...incomingUser, permisos: incomingPermissions, usuarioInternoId })
    setShowApp(true)
    setToken(incomingToken)

    try {
      await fetchProfile(incomingToken)
    } finally {
      window.setTimeout(() => setLoginTransitioning(false), LOGIN_EXIT_ANIMATION_MS)
    }
  }

  const handleLogout = () => {
    window.clearTimeout(logoutTimeoutRef.current)
    window.clearTimeout(loginReturnTimeoutRef.current)

    try { sessionStorage.clear() } catch { /* no-op */ }

    setLogoutTransitioning(true)

    loginReturnTimeoutRef.current = window.setTimeout(() => {
      setLoginReturning(true)
      setToken('')
      setUser(null)
      setShowApp(false)
    }, DASHBOARD_EXIT_ANIMATION_MS)

    logoutTimeoutRef.current = window.setTimeout(() => {
      setLogoutTransitioning(false)
      setLoginReturning(false)
    }, DASHBOARD_EXIT_ANIMATION_MS + LOGIN_ENTER_ANIMATION_MS)
  }

  const appClassName = useMemo(
    () => `app-shell ${darkMode ? 'theme-dark' : 'theme-light'}`,
    [darkMode]
  )

  const loginTransitionState = useMemo(() => {
    if (loginTransitioning) return 'collapse'
    if (loginReturning) return 'expand'
    return null
  }, [loginReturning, loginTransitioning])

  useEffect(
    () => () => {
      window.clearTimeout(logoutTimeoutRef.current)
      window.clearTimeout(loginReturnTimeoutRef.current)
    },
    []
  )

  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    disableAutocompleteInNode(document.body)

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          disableAutocompleteInNode(node)
        })
      })
    })

    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (typeof document === 'undefined') return undefined

    const handleInvalid = (event) => {
      const form = event?.target?.form
      if (!form) return
      if (!form.classList.contains('create-user__form--create')) return
      form.classList.add('create-user__form--submitted')
    }

    document.addEventListener('invalid', handleInvalid, true)
    return () => document.removeEventListener('invalid', handleInvalid, true)
  }, [])

  useEffect(() => {
    if (typeof document === 'undefined') return undefined

    const clearModalInteractionClasses = () => {
      document
        .querySelectorAll('.create-user__modal--resizing, .create-user__modal--moving')
        .forEach((modal) => {
          modal.classList.remove('create-user__modal--resizing')
          modal.classList.remove('create-user__modal--moving')
        })
    }

    const handleResizeStart = (event) => {
      const target = event.target
      const handle = target?.closest?.('.create-user__resize-handle')
      if (!handle) return
      const modal = handle.closest('.create-user__modal')
      if (!modal) return
      modal.classList.add('create-user__modal--resizing')
    }

    const handleDragStart = (event) => {
      const target = event.target
      if (target?.closest?.('.create-user__icon-button')) return
      const header = target?.closest?.('.create-user__header')
      if (!header) return
      const modal = header.closest('.create-user__modal')
      if (!modal) return
      modal.classList.add('create-user__modal--moving')
    }

    document.addEventListener('mousedown', handleResizeStart, true)
    document.addEventListener('mousedown', handleDragStart, true)
    window.addEventListener('mouseup', clearModalInteractionClasses, true)
    window.addEventListener('blur', clearModalInteractionClasses)

    return () => {
      document.removeEventListener('mousedown', handleResizeStart, true)
      document.removeEventListener('mousedown', handleDragStart, true)
      window.removeEventListener('mouseup', clearModalInteractionClasses, true)
      window.removeEventListener('blur', clearModalInteractionClasses)
      clearModalInteractionClasses()
    }
  }, [])

  return (
    <div className={appClassName}>
      {(!showApp || loginTransitioning || loginReturning) && (
        <Login
          darkMode={darkMode}
          onToggleTheme={() => setDarkMode((value) => !value)}
          onLoginSuccess={handleLoginSuccess}
          isCollapsing={loginTransitioning}
          isExpanding={loginTransitionState === 'expand'}
        />
      )}

      {showApp && user && (
        <DashboardLayout
          user={user}
          token={token}
          darkMode={darkMode}
          onLogout={handleLogout}
          onToggleTheme={() => setDarkMode((value) => !value)}
          permissions={user?.permisos ?? null}
          isLeaving={logoutTransitioning}
        />
      )}
    </div>
  )
}

export default App
