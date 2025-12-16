import { useEffect, useMemo, useState } from 'react'
import DashboardLayout from './components/dashboard/DashboardLayout/DashboardLayout'
import Login from './components/login/Login/Login'
import 'primereact/resources/primereact.min.css';
import 'primeicons/primeicons.css';

// un theme (elige uno)
import 'primereact/resources/themes/lara-light-cyan/theme.css';

// opcional (si usas utilidades)
import 'primeflex/primeflex.css';


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

  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem('user')
    return saved ? JSON.parse(saved) : null
  })

  const [token, setToken] = useState(() => localStorage.getItem('token') || '')
  const [showApp, setShowApp] = useState(() => Boolean(token && user))
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
    if (user) {
      localStorage.setItem('user', JSON.stringify(user))
    } else {
      localStorage.removeItem('user')
    }
  }, [user])

  const handleLoginSuccess = (incomingUser, incomingToken) => {
    setUser(incomingUser)
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
        />
      )}
    </div>
  )
}

export default App
