import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DashboardLayout from './components/dashboard/DashboardLayout/DashboardLayout'
import Login from './components/login/Login/Login'
import 'primereact/resources/primereact.min.css';
import 'primeicons/primeicons.css';

// un theme (elige uno)
import 'primereact/resources/themes/lara-light-cyan/theme.css';

// opcional (si usas utilidades)
import 'primeflex/primeflex.css';
import { authFetch } from './utils/api'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'
const LOGIN_EXIT_ANIMATION_MS = 900
const DASHBOARD_EXIT_ANIMATION_MS = 3500
const LOGIN_ENTER_ANIMATION_MS = LOGIN_EXIT_ANIMATION_MS


const getSystemThemePreference = () =>
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false

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
