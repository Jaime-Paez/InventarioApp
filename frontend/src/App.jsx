import { useEffect, useMemo, useState } from 'react'
import './App.css'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

function App() {
  const [mode, setMode] = useState('register')
  const [statusMessage, setStatusMessage] = useState('')
  const [authError, setAuthError] = useState('')
  const [loading, setLoading] = useState(false)

  const [registerData, setRegisterData] = useState({
    first_name: '',
    last_name: '',
    email: '',
    password: '',
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

  const headers = useMemo(() => {
    const baseHeaders = { 'Content-Type': 'application/json' }
    if (token) {
      baseHeaders['Authorization'] = `Token ${token}`
    }
    return baseHeaders
  }, [token])

  const handleRegister = async (event) => {
    event.preventDefault()
    setLoading(true)
    setAuthError('')
    setStatusMessage('')
    try {
      const response = await fetch(`${API_URL}/auth/register/`, {
        method: 'POST',
        headers,
        body: JSON.stringify(registerData),
      })
      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        setAuthError(data.detail || 'No se pudo crear la cuenta. Verifica los datos.')
        return
      }

      setToken(data.token)
      setUser(data.usuario)
      setStatusMessage('Cuenta creada y sesión iniciada correctamente.')
      setRegisterData({ first_name: '', last_name: '', email: '', password: '' })
    } catch (error) {
      setAuthError('No se pudo contactar al servidor. Intenta de nuevo.')
    } finally {
      setLoading(false)
    }
  }

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

  const checkProtectedArea = async () => {
    if (!token) {
      setAuthError('Debes iniciar sesión para entrar a la zona protegida.')
      return
    }

    setLoading(true)
    setAuthError('')
    setStatusMessage('')
    try {
      const response = await fetch(`${API_URL}/auth/me/`, {
        headers,
      })
      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        setAuthError('Tu sesión expiró, vuelve a iniciar sesión.')
        return
      }

      setUser(data.usuario)
      setStatusMessage('Accediste correctamente al contenido protegido.')
    } catch (error) {
      setAuthError('No se pudo contactar al servidor. Intenta de nuevo.')
    } finally {
      setLoading(false)
    }
  }

  const logout = () => {
    setToken('')
    setUser(null)
    setStatusMessage('Sesión cerrada.')
  }

  return (
    <div className="app">
      <header className="header">
        <div>
          <p className="eyebrow">InventarioApp</p>
          <h1>Autenticación básica</h1>
          <p className="subtitle">
            Crea una cuenta, inicia sesión y prueba el acceso a una pantalla protegida
            desde el frontend.
          </p>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className={mode === 'register' ? 'primary' : 'ghost'}
            onClick={() => setMode('register')}
          >
            Crear cuenta
          </button>
          <button
            type="button"
            className={mode === 'login' ? 'primary' : 'ghost'}
            onClick={() => setMode('login')}
          >
            Iniciar sesión
          </button>
          {token && (
            <button type="button" className="ghost" onClick={logout}>
              Cerrar sesión
            </button>
          )}
        </div>
      </header>

      <div className="panels">
        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">API REST</p>
              <h2>{mode === 'register' ? 'Crear nueva cuenta' : 'Iniciar sesión'}</h2>
              <p className="subtitle">
                Completa el formulario y la aplicación consumirá la API del backend.
              </p>
            </div>
          </div>

          {mode === 'register' ? (
            <form className="form" onSubmit={handleRegister}>
              <div className="form-row">
                <label htmlFor="first_name">Nombres</label>
                <input
                  id="first_name"
                  name="first_name"
                  value={registerData.first_name}
                  onChange={(e) =>
                    setRegisterData({ ...registerData, first_name: e.target.value })
                  }
                  placeholder="Andrea Paola"
                  required
                />
              </div>
              <div className="form-row">
                <label htmlFor="last_name">Apellidos</label>
                <input
                  id="last_name"
                  name="last_name"
                  value={registerData.last_name}
                  onChange={(e) =>
                    setRegisterData({ ...registerData, last_name: e.target.value })
                  }
                  placeholder="Martínez López"
                  required
                />
              </div>
              <div className="form-row">
                <label htmlFor="email">Correo</label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  value={registerData.email}
                  onChange={(e) =>
                    setRegisterData({ ...registerData, email: e.target.value })
                  }
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
                  minLength={8}
                  value={registerData.password}
                  onChange={(e) =>
                    setRegisterData({ ...registerData, password: e.target.value })
                  }
                  placeholder="Mínimo 8 caracteres"
                  required
                />
              </div>
              <button type="submit" className="primary" disabled={loading}>
                {loading ? 'Creando cuenta...' : 'Crear cuenta y entrar'}
              </button>
            </form>
          ) : (
            <form className="form" onSubmit={handleLogin}>
              <div className="form-row">
                <label htmlFor="email-login">Correo</label>
                <input
                  id="email-login"
                  name="email"
                  type="email"
                  value={loginData.email}
                  onChange={(e) => setLoginData({ ...loginData, email: e.target.value })}
                  placeholder="usuario@correo.com"
                  required
                />
              </div>
              <div className="form-row">
                <label htmlFor="password-login">Contraseña</label>
                <input
                  id="password-login"
                  name="password"
                  type="password"
                  value={loginData.password}
                  onChange={(e) => setLoginData({ ...loginData, password: e.target.value })}
                  placeholder="Tu contraseña"
                  required
                />
              </div>
              <button type="submit" className="primary" disabled={loading}>
                {loading ? 'Validando...' : 'Entrar'}
              </button>
            </form>
          )}

          {statusMessage && <p className="status success">{statusMessage}</p>}
          {authError && <p className="status error">{authError}</p>}
        </section>

        <section className="panel protected">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Pantalla protegida</p>
              <h2>Solo usuarios autenticados</h2>
              <p className="subtitle">
                Esta sección llama al endpoint /auth/me/. Si hay un token válido,
                verás los datos básicos del usuario.
              </p>
            </div>
          </div>

          {user ? (
            <div className="user-card">
              <div className="avatar" aria-hidden>
                {user.first_name?.[0]?.toUpperCase() || user.username?.[0]?.toUpperCase()}
              </div>
              <div>
                <p className="user-name">
                  {user.first_name} {user.last_name}
                </p>
                <p className="user-email">{user.email}</p>
              </div>
            </div>
          ) : (
            <p className="muted">No hay ninguna sesión activa.</p>
          )}

          <button
            type="button"
            className="primary full-width"
            onClick={checkProtectedArea}
            disabled={loading}
          >
            {loading ? 'Comprobando...' : 'Entrar a la zona protegida'}
          </button>
        </section>
      </div>
    </div>
  )
}

export default App
