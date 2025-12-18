import { useEffect, useMemo, useState } from 'react'
import DashboardLayout from './components/dashboard/DashboardLayout/DashboardLayout'
import Login from './components/login/Login/Login'
import 'primereact/resources/primereact.min.css';
import 'primeicons/primeicons.css';

// un theme (elige uno)
import 'primereact/resources/themes/lara-light-cyan/theme.css';

// opcional (si usas utilidades)
import 'primeflex/primeflex.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'


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

  useEffect(() => {
    const fetchProfile = async () => {
      if (!token) {
        setUser(null)
        setShowApp(false)
        return
      }

      try {
        const response = await fetch(`${API_URL}/auth/me/`, {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Token ${token}`,
          },
        })

        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data?.detail || 'No se pudo obtener el perfil.')

        const userData = {
          ...data.usuario,
          permisos: Array.isArray(data.permisos) ? data.permisos : null,
          usuarioInternoId: data.usuario_interno_id,
        }

        setUser(userData)
        setShowApp(true)
      } catch (err) {
        setUser(null)
        setShowApp(false)
        setToken('')
        localStorage.removeItem('token')
      }
    }

    fetchProfile()
  }, [token])

  const handleLoginSuccess = (incomingUser, incomingToken, incomingPermissions = null, usuarioInternoId = null) => {
    const userWithPermissions = {
      ...incomingUser,
      permisos: incomingPermissions,
      usuarioInternoId,
    }

    setUser(userWithPermissions)
    setToken(incomingToken)
    setLoginTransitioning(true)

    setTimeout(() => setShowApp(true), 850)
    setTimeout(() => setLoginTransitioning(false), 1400)
  }

  const handleLogout = () => {
    setToken('')
    setUser(null)
    setShowApp(false)
  }

  const appClassName = useMemo(
    () => `app-shell ${darkMode ? 'theme-dark' : 'theme-light'}`,
    [darkMode]
  )

  return (
    <div className={appClassName}>
      {(!showApp || loginTransitioning) && (
        <Login
          darkMode={darkMode}
          onToggleTheme={() => setDarkMode((value) => !value)}
          onLoginSuccess={handleLoginSuccess}
          isCollapsing={loginTransitioning}
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
        />
      )}
    </div>
  )
}

export default App
