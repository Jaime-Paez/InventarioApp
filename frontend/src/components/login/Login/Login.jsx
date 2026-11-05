import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './Login.css'
import wallpaperLight from '../../../assets/login/login_wallpaper(light).png'
import wallpaperDark from '../../../assets/login/login_wallpaper(dark).png'
import jpaezDark from '../../../assets/login/jpaez(dark).png'
import jpaezLight from '../../../assets/login/jpaez(light).png'
import kavaDark from '../../../assets/login/kava(dark).png'
import kavaLight from '../../../assets/login/kava(light).png'
import { API_URL, authFetch } from '../../../utils/api'
import useServerStatus, { RETRY_SECONDS } from './useServerStatus'

const LOGIN_TIMEOUT_MS = 25000
// Respuestas que significan "el servidor no esta" (no credenciales malas).
const SERVER_DOWN_STATUSES = new Set([502, 503, 504])

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

function Login({ darkMode, onToggleTheme, onLoginSuccess, isCollapsing, isExpanding }) {
  const [statusMessage, setStatusMessage] = useState('')
  const [authError, setAuthError] = useState('')
  const [loading, setLoading] = useState(false)

  const [isTogglingTheme, setIsTogglingTheme] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  const [loginData, setLoginData] = useState({
    email: '',
    password: '',
  })

  const headers = useMemo(() => ({ 'Content-Type': 'application/json' }), [])
  const server = useServerStatus()
  const { status: serverStatus, markDown } = server
  // Login enviado mientras el servidor no respondia: se manda solo al volver.
  const [pendingLogin, setPendingLogin] = useState(false)
  const loginDataRef = useRef(loginData)
  loginDataRef.current = loginData

  const doLogin = useCallback(async () => {
    setLoading(true)
    setAuthError('')
    setStatusMessage('')
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS)
    try {
      const response = await authFetch(
        `${API_URL}/auth/login/`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(loginDataRef.current),
          signal: controller.signal,
        },
        null
      )
      if (SERVER_DOWN_STATUSES.has(response.status)) {
        markDown()
        setPendingLogin(true)
        return
      }
      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        setAuthError(data.detail || 'Credenciales inválidas.')
        return
      }

      const permisos = Array.isArray(data.permisos) ? data.permisos : null
      onLoginSuccess(data.usuario, data.token, permisos, data.usuario_interno_id)
      setStatusMessage('¡Bienvenido de nuevo!')
      setLoginData({ email: '', password: '' })
      setShowPassword(false)
    } catch (error) {
      // Sin respuesta o tardo demasiado: el servidor esta caido o reiniciando.
      console.error('Error al iniciar sesión:', error)
      markDown()
      setPendingLogin(true)
    } finally {
      window.clearTimeout(timer)
      setLoading(false)
    }
  }, [headers, markDown, onLoginSuccess])

  const handleLogin = async (event) => {
    event.preventDefault()
    if (serverStatus === 'down') {
      setAuthError('')
      setPendingLogin(true)
      return
    }
    await doLogin()
  }

  // Volvio el servidor: enviar el login que quedo esperando.
  useEffect(() => {
    if (serverStatus !== 'up' || !pendingLogin || loading) return
    setPendingLogin(false)
    void doLogin()
  }, [serverStatus, pendingLogin, loading, doLogin])

  const handleToggleTheme = () => {
    // “splash” liquid del botón
    setIsTogglingTheme(true)
    onToggleTheme?.()
    window.setTimeout(() => setIsTogglingTheme(false), 360)
  }

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined
    const mediaQuery = window.matchMedia('(max-width: 960px)')
    const handleMediaChange = (event) => setIsMobile(event.matches)

    setIsMobile(mediaQuery.matches)

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', handleMediaChange)
    } else {
      mediaQuery.addListener(handleMediaChange)
    }

    return () => {
      if (mediaQuery.removeEventListener) {
        mediaQuery.removeEventListener('change', handleMediaChange)
      } else {
        mediaQuery.removeListener(handleMediaChange)
      }
    }
  }, [])

  const pageClassName = useMemo(
    () =>
      `login-page ${darkMode ? 'dark' : ''} ${isCollapsing ? 'collapse' : ''} ${
        isExpanding ? 'expand' : ''
      }`,
    [darkMode, isCollapsing, isExpanding]
  )

  return (
    <div className={pageClassName}>
      {!isMobile && (
        <div className="wallpaper-layer" aria-hidden>
          <img src={wallpaperLight} className={`wallpaper ${darkMode ? '' : 'active'}`} alt="" />
          <img src={wallpaperDark} className={`wallpaper ${darkMode ? 'active' : ''}`} alt="" />
        </div>
      )}
      <section className="login-panel">
        <div className="panel-header">
          <div className="brand-row">
            <img src={darkMode ? kavaDark : kavaLight} alt="Logo Kava" className="kava-logo" />
            <span className="brand-divider" aria-hidden />
            <img src={darkMode ? jpaezDark : jpaezLight} alt="Logo JPaez" className="brand-logo" />
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
                placeholder="Email"
                required
              />
            </div>

            <div className="form-row">
              <label htmlFor="password">Contraseña</label>
              <div className="password-input">
                <input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  value={loginData.password}
                  onChange={(e) => setLoginData({ ...loginData, password: e.target.value })}
                  placeholder="Contraseña"
                  required
                />
                <button
                  type="button"
                  className="password-toggle"
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                >
                  <i className={`pi ${showPassword ? 'pi-eye-slash' : 'pi-eye'}`} aria-hidden="true" />
                </button>
              </div>
            </div>

            <button type="submit" className="primary-button" disabled={loading || pendingLogin}>
              {loading ? 'Validando...' : pendingLogin ? 'Esperando al servidor...' : 'Iniciar Sesión'}
            </button>
          </form>

          {serverStatus === 'slow' && (
            <div className="server-status server-status--slow" role="status">
              <span className="server-status__spinner" aria-hidden />
              <span>Conectando con el servidor… puede tardar si se estaba reiniciando.</span>
            </div>
          )}
          {serverStatus === 'down' && (
            <div className="server-status server-status--down" role="alert">
              <strong>El servidor no está respondiendo</strong>
              <span>
                Puede estar reiniciándose. Se vuelve a intentar solo cada {RETRY_SECONDS} segundos; no hace falta recargar la página.
              </span>
              <span className="server-status__meta">
                {server.secondsLeft > 0 ? `Próximo intento en ${server.secondsLeft} s` : 'Probando…'}
                {server.attempts > 1 ? ` · intento ${server.attempts}` : ''}
              </span>
              {pendingLogin && (
                <span>Tu inicio de sesión se enviará en cuanto responda.</span>
              )}
              <div className="server-status__actions">
                <button type="button" className="server-status__btn" onClick={() => void server.check()}>
                  Reintentar ahora
                </button>
                {pendingLogin && (
                  <button type="button" className="server-status__btn server-status__btn--ghost" onClick={() => setPendingLogin(false)}>
                    Cancelar inicio de sesión
                  </button>
                )}
              </div>
            </div>
          )}
          {serverStatus === 'up' && server.recovered && (
            <div className="server-status server-status--up" role="status">
              <span>Servidor disponible.</span>
            </div>
          )}

          {statusMessage && <p className="status success">{statusMessage}</p>}
          {authError && <p className="status error">{authError}</p>}
        </div>

        <div className="panel-footer">
          <div className="helper-row">
            <button type="button" className="link-button">
              ¿Olvidaste tu contraseña?
            </button>
          </div>

          <button
            type="button"
            className={`theme-toggle ${isTogglingTheme ? 'is-toggling' : ''}`}
            onClick={handleToggleTheme}
            aria-label={darkMode ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
          >
            <span className="theme-icon" key={darkMode ? 'sun' : 'moon'}>
              {darkMode ? <SunIcon /> : <MoonIcon />}
            </span>
          </button>
        </div>
      </section>
    </div>
  )
}

export default Login
