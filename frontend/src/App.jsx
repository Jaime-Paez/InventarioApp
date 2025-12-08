import { useEffect, useMemo, useState } from 'react'
import './App.css'
import wallpaper from './assets/login/login_wallpaper.webp'
import jpaezDark from './assets/login/jpaez(dark).png'
import jpaezLight from './assets/login/jpaez(light).png'
import kavaDark from './assets/login/kava(dark).png'
import kavaLight from './assets/login/kava(light).png'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

function App() {
  const [statusMessage, setStatusMessage] = useState('')
  const [authError, setAuthError] = useState('')
  const [loading, setLoading] = useState(false)
  const [darkMode, setDarkMode] = useState(false)

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
      <section className="login-panel">
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

        <div>
          <h1>Iniciar sesión</h1>
          <p className="description">Accede a tu cuenta para continuar.</p>
        </div>

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

        <div className="helper-row">
          <button type="button" className="link-button">
            Olvidaste tu contraseña
          </button>
          <button
            type="button"
            className="theme-toggle"
            onClick={() => setDarkMode((value) => !value)}
          >
            {darkMode ? 'Modo claro' : 'Modo oscuro'}
          </button>
        </div>
      </section>

      <section className="login-hero" aria-hidden>
        <img src={wallpaper} alt="Fondo" />
        <div className="hero-overlay" />
      </section>
    </div>
  )
}

export default App
