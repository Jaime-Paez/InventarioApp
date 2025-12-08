import { useEffect, useMemo, useState } from 'react'
import '../App.css'
import wallpaperLight from '../assets/login/login_wallpaper(light).png'
import wallpaperDark from '../assets/login/login_wallpaper.webp'
import jpaezDark from '../assets/login/jpaez(dark).png'
import jpaezLight from '../assets/login/jpaez(light).png'
import kavaDark from '../assets/login/kava(dark).png'
import kavaLight from '../assets/login/kava(light).png'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

const SunIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2" />
    <path d="M12 20v2" />
    <path d="m4.93 4.93 1.41 1.41" />
    <path d="m17.66 17.66 1.41 1.41" />
    <path d="M2 12h2" />
    <path d="M20 12h2" />
    <path d="m6.34 17.66-1.41 1.41" />
    <path d="m19.07 4.93-1.41 1.41" />
  </svg>
)

const MoonIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
  </svg>
)

function Login() {
  const [statusMessage, setStatusMessage] = useState('')
  const [authError, setAuthError] = useState('')
  const [loading, setLoading] = useState(false)
  const getSystemThemePreference = () =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false

  const [darkMode, setDarkMode] = useState(() => {
    const savedTheme = localStorage.getItem('theme')
    if (savedTheme === 'dark') return true
    if (savedTheme === 'light') return false
    return getSystemThemePreference()
  })

  const [loginData, setLoginData] = useState({
    email: '',
    password: '',
  })

  const [token, setToken] = useState(() => localStorage.getItem('token') || '')
  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem('user')
    return saved ? JSON.parse(saved) : null
  })

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

  useEffect(() => {
    localStorage.setItem('theme', darkMode ? 'dark' : 'light')
  }, [darkMode])

  const headers = useMemo(() => {
    const baseHeaders = { 'Content-Type': 'application/json' }
    if (token) {
      baseHeaders['Authorization'] = `Token ${token}`
    }
    return baseHeaders
  }, [token])

  const handleLogin = async (event) => {
    event.preventDefault()
    setLoading(true)
    setAuthError('')
    setStatusMessage('')
    try {
      const response = await fetch(`${API_URL}/auth/login/`, {
        method: 'POST',
        headers,
        body: JSON.stringify(loginData),
      })
      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        setAuthError(data.detail || 'Credenciales inválidas.')
        return
      }

      setToken(data.token)
      setUser(data.usuario)
      setStatusMessage('¡Bienvenido de nuevo!')
      setLoginData({ email: '', password: '' })
    } catch (error) {
      setAuthError('No se pudo contactar al servidor. Intenta de nuevo.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={`login-page ${darkMode ? 'dark' : ''}`}>
      <div className="wallpaper-layer" aria-hidden>
        <img
          src={wallpaperLight}
          className={`wallpaper ${darkMode ? '' : 'active'}`}
          alt=""
        />
        <img
          src={wallpaperDark}
          className={`wallpaper ${darkMode ? 'active' : ''}`}
          alt=""
        />
      </div>

      <section className="login-panel">
        <div className="panel-header">
          <div className="brand-row">
            <img
              src={darkMode ? kavaDark : kavaLight}
              alt="Logo Kava"
              className="brand-logo"
            />
            <span className="brand-divider" aria-hidden />
            <img
              src={darkMode ? jpaezDark : jpaezLight}
              alt="Logo JPaez"
              className="brand-logo"
            />
          </div>
        </div>

        <div className="panel-body">
          <h1>Iniciar sesión</h1>

          <form onSubmit={handleLogin}>
            <div className="form-row">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                name="email"
                type="email"
                value={loginData.email}
                onChange={(e) => setLoginData({ ...loginData, email: e.target.value })}
                placeholder="usuario@correo.com"
                required
              />
            </div>
            <div className="form-row">
              <label htmlFor="password">Contraseña</label>
              <input
                id="password"
                name="password"
                type="password"
                value={loginData.password}
                onChange={(e) => setLoginData({ ...loginData, password: e.target.value })}
                placeholder="Tu contraseña"
                required
              />
            </div>
            <button type="submit" className="primary-button" disabled={loading}>
              {loading ? 'Validando...' : 'Iniciar Sesión'}
            </button>
          </form>

          {statusMessage && <p className="status success">{statusMessage}</p>}
          {authError && <p className="status error">{authError}</p>}
        </div>

        <div className="panel-footer">
          <div className="helper-row">
            <button type="button" className="link-button">
              Olvidaste tu contraseña
            </button>
          </div>

          <button
            type="button"
            className="theme-toggle"
            onClick={() => setDarkMode((value) => !value)}
            aria-label="Cambiar tema"
          >
            {darkMode ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
      </section>
    </div>
  )
}

export default Login
