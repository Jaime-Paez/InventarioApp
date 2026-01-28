import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import './CreateUsuario.css'
import { API_URL, authFetch } from '../../../../utils/api'
const MIN_WIDTH = 720
const MIN_HEIGHT = 520
const VIEWPORT_PADDING = 12

const ACTIONS = [
  { key: 'puede_leer', label: 'Ver' },
  { key: 'puede_crear', label: 'Crear' },
  { key: 'puede_actualizar', label: 'Editar' },
  { key: 'puede_eliminar', label: 'Eliminar' },
]

const serializeMatrix = (matrix) =>
  Object.entries(matrix)
    .map(([modulo, value]) => {
      const payload = {
        modulo,
        submodulo: '',
        puede_crear: Boolean(value?.puede_crear),
        puede_leer: Boolean(value?.puede_leer),
        puede_actualizar: Boolean(value?.puede_actualizar),
        puede_eliminar: Boolean(value?.puede_eliminar),
      }
      const hasAction = ACTIONS.some((action) => payload[action.key])
      return hasAction ? payload : null
    })
    .filter(Boolean)

const initialForm = {
  nombres: '',
  apellidos: '',
  correo: '',
  telefono: '',
  cargo: '',
  activo: true,
}

function CreateUsuario({ open, onClose, onCreated, token, onError }) {
  const [formData, setFormData] = useState(initialForm)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordCopied, setPasswordCopied] = useState(false)
  const [permissionOptions, setPermissionOptions] = useState([])
  const [permissionsMatrix, setPermissionsMatrix] = useState({})
  const [permissionsLoading, setPermissionsLoading] = useState(false)
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('general')
  const [isMaximized, setIsMaximized] = useState(false)

  const modalRef = useRef(null)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })
  const dragData = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const resizeData = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const sizeRef = useRef(size)
  const positionRef = useRef(position)
  const restoreRef = useRef(null)

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
  const getViewportMetrics = () => {
    const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2)
    const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2)
    return {
      availableWidth,
      availableHeight,
      minWidth: Math.min(MIN_WIDTH, availableWidth),
      minHeight: Math.min(MIN_HEIGHT, availableHeight),
    }
  }

  const notifyError = useCallback(
    (message) => {
      if (!message) return
      if (onError) {
        onError(message)
        return
      }
      console.error(message)
    },
    [onError]
  )

  const fetchPermissionOptions = useCallback(async () => {
    setPermissionsLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/usuarios/permisos/opciones/`,
        {},
        token
      )

      if (!response.ok) throw new Error('No se pudieron cargar los permisos disponibles.')

      const data = await response.json().catch(() => ({}))
      const modulos = Array.isArray(data?.modulos) ? data.modulos : []
      setPermissionOptions(modulos)
    } catch (err) {
      notifyError(err.message || 'Ocurrió un problema al cargar los permisos.')
    } finally {
      setPermissionsLoading(false)
    }
  }, [notifyError, token])

  useEffect(() => {
    if (!open) return
    setFormData(initialForm)
    setPassword('')
    setConfirmPassword('')
    setPasswordCopied(false)
    setPermissionsMatrix({})
    setActiveTab('general')
    setIsMaximized(false)
    restoreRef.current = null
    fetchPermissionOptions()
  }, [open, fetchPermissionOptions])

  useLayoutEffect(() => {
    if (!open) return
    const { availableWidth, availableHeight } = getViewportMetrics()
    const nextWidth = Math.min(MIN_WIDTH, availableWidth)
    const nextHeight = Math.min(MIN_HEIGHT, availableHeight)
    setSize({ width: nextWidth, height: nextHeight })

    const centeredX = (window.innerWidth - nextWidth) / 2
    const centeredY = (window.innerHeight - nextHeight) / 2
    setPosition({ x: Math.max(centeredX, VIEWPORT_PADDING), y: Math.max(centeredY, VIEWPORT_PADDING) })
  }, [open])

  useEffect(() => {
    sizeRef.current = size
  }, [size])

  useEffect(() => {
    positionRef.current = position
  }, [position])

  const handleChange = (event) => {
    const { name, value, type, checked } = event.target
    setFormData((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }))
  }

  const togglePermission = (moduleKey, actionKey) => {
    setPermissionsMatrix((prev) => {
      const current = prev[moduleKey] || {
        puede_crear: false,
        puede_leer: false,
        puede_actualizar: false,
        puede_eliminar: false,
      }

      const nextValue = !current[actionKey]
      const updatedEntry = { ...current, [actionKey]: nextValue }
      const hasAction = ACTIONS.some((action) => updatedEntry[action.key])

      if (!hasAction) {
        const { [moduleKey]: _ignored, ...rest } = prev
        return rest
      }

      return { ...prev, [moduleKey]: updatedEntry }
    })
  }

  const renderPermissionRow = (module) => {
    const entryKey = module.key
    const current = permissionsMatrix[entryKey] || {}
    const isDisabled = loading || permissionsLoading

    return (
      <div key={entryKey} className="permissions-matrix__row">
        <div className="permissions-matrix__cell permissions-matrix__cell--label">
          {module.label}
        </div>
        {ACTIONS.map((action) => (
          <label key={action.key} className="permissions-matrix__cell permissions-matrix__cell--action">
            <input
              type="checkbox"
              checked={Boolean(current?.[action.key])}
              onChange={() => togglePermission(module.key, action.key)}
              disabled={isDisabled}
            />
          </label>
        ))}
      </div>
    )
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setLoading(true)

    const payload = {
      ...formData,
      nombres: formData.nombres.trim(),
      apellidos: formData.apellidos.trim(),
      correo: formData.correo.trim().toLowerCase(),
      telefono: formData.telefono.trim(),
      cargo: formData.cargo.trim(),
      permisos_personalizados: serializeMatrix(permissionsMatrix),
    }

    if (!payload.nombres || !payload.apellidos || !payload.correo) {
      setLoading(false)
      notifyError('Completa los campos de nombres, apellidos y correo para continuar.')
      return
    }

    if (!password || password.length < 8) {
      setLoading(false)
      notifyError('Define una contraseña de al menos 8 caracteres para el usuario.')
      return
    }

    if (password !== confirmPassword) {
      setLoading(false)
      notifyError('La confirmación de contraseña no coincide.')
      return
    }

    try {
      const response = await authFetch(
        `${API_URL}/usuarios/listado/`,
        {
          method: 'POST',
          body: JSON.stringify({ ...payload, password }),
        },
        token
      )

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail =
          data?.detail ||
          data?.correo?.[0] ||
          data?.password?.[0] ||
          data?.nombres?.[0] ||
          'No se pudo crear el usuario. Verifica la información enviada.'
        throw new Error(detail)
      }

      setFormData(initialForm)
      setPassword('')
      setConfirmPassword('')
      setPasswordCopied(false)
      setPermissionsMatrix({})
      onCreated?.({ ...data, password })
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al crear el usuario.')
    } finally {
      setLoading(false)
    }
  }

  const handleMouseDown = (event) => {
    if (isMaximized) return
    if (!modalRef.current) return
    const rect = modalRef.current.getBoundingClientRect()
    dragData.current = {
      active: true,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    }
  }

  const handleResizeMouseDown = (event) => {
    if (isMaximized) return
    event.preventDefault()
    event.stopPropagation()
    const { minWidth, minHeight } = getViewportMetrics()
    resizeData.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: sizeRef.current.width,
      startHeight: sizeRef.current.height,
    }

    const handleResizeMove = (moveEvent) => {
      if (!resizeData.current.active) return
      const deltaX = moveEvent.clientX - resizeData.current.startX
      const deltaY = moveEvent.clientY - resizeData.current.startY
      const maxWidth = Math.max(minWidth, window.innerWidth - positionRef.current.x - VIEWPORT_PADDING)
      const maxHeight = Math.max(minHeight, window.innerHeight - positionRef.current.y - VIEWPORT_PADDING)
      const width = clamp(resizeData.current.startWidth + deltaX, minWidth, maxWidth)
      const height = clamp(resizeData.current.startHeight + deltaY, minHeight, maxHeight)
      setSize({ width, height })
    }

    const handleResizeUp = () => {
      resizeData.current.active = false
      window.removeEventListener('mousemove', handleResizeMove)
      window.removeEventListener('mouseup', handleResizeUp)
    }

    window.addEventListener('mousemove', handleResizeMove)
    window.addEventListener('mouseup', handleResizeUp)
  }

  useEffect(() => {
    const handleMouseMove = (event) => {
      if (!dragData.current.active) return
      event.preventDefault()
      const newX = event.clientX - dragData.current.offsetX
      const newY = event.clientY - dragData.current.offsetY
      const maxX = window.innerWidth - sizeRef.current.width - VIEWPORT_PADDING
      const maxY = window.innerHeight - sizeRef.current.height - VIEWPORT_PADDING
      setPosition({
        x: Math.min(Math.max(newX, VIEWPORT_PADDING), Math.max(maxX, VIEWPORT_PADDING)),
        y: Math.min(Math.max(newY, VIEWPORT_PADDING), Math.max(maxY, VIEWPORT_PADDING)),
      })
    }

    const handleMouseUp = () => {
      dragData.current.active = false
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  useEffect(() => {
    const handleWindowResize = () => {
      const { minWidth, minHeight, availableWidth, availableHeight } = getViewportMetrics()

      if (isMaximized) {
        setSize({ width: availableWidth, height: availableHeight })
        setPosition({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
        return
      }

      setSize((prev) => {
        const width = clamp(prev.width, minWidth, availableWidth)
        const height = clamp(prev.height, minHeight, availableHeight)

        setPosition((prevPosition) => ({
          x: Math.min(Math.max(prevPosition.x, VIEWPORT_PADDING), Math.max(window.innerWidth - width - VIEWPORT_PADDING, VIEWPORT_PADDING)),
          y: Math.min(Math.max(prevPosition.y, VIEWPORT_PADDING), Math.max(window.innerHeight - height - VIEWPORT_PADDING, VIEWPORT_PADDING)),
        }))

        return { width, height }
      })
    }

    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [isMaximized])

  const toggleMaximize = () => {
    if (isMaximized) {
      const restore = restoreRef.current
      if (restore) {
        setSize(restore.size)
        setPosition(restore.position)
      }
      setIsMaximized(false)
      return
    }

    restoreRef.current = {
      size: sizeRef.current,
      position: positionRef.current,
    }
    const { availableWidth, availableHeight } = getViewportMetrics()
    setSize({ width: availableWidth, height: availableHeight })
    setPosition({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
    setIsMaximized(true)
  }

  const generatePassword = () => {
    const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789!@$%#?'
    let result = ''
    for (let i = 0; i < 12; i += 1) {
      result += charset.charAt(Math.floor(Math.random() * charset.length))
    }
    setPassword(result)
    setConfirmPassword(result)
    setPasswordCopied(false)
  }

  const copyPassword = async () => {
    if (!password) return
    try {
      await navigator.clipboard.writeText(password)
      setPasswordCopied(true)
      setTimeout(() => setPasswordCopied(false), 2500)
    } catch {
      notifyError('No se pudo copiar la contraseña. Intenta nuevamente.')
    }
  }

  if (!open) return null

  return (
    <div className="create-user__overlay" role="dialog" aria-modal="true">
      <div
        className="create-user__modal"
        ref={modalRef}
        style={{ top: position.y, left: position.x, width: size.width, height: size.height }}
      >
        <header className="create-user__header" onMouseDown={handleMouseDown}>
          <div className="create-user__header-text">
            <h3>Crear cuenta interna</h3>
          </div>
          <div className="create-user__header-actions">
            <button
              type="button"
              className="create-user__icon-button create-user__icon-button--maximize"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={toggleMaximize}
              aria-label={isMaximized ? 'Restaurar' : 'Maximizar'}
            >
              {isMaximized ? '🗗' : '🗖'}
            </button>
            <button
              type="button"
              className="create-user__icon-button"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={onClose}
              aria-label="Cerrar"
            >
              ×
            </button>
          </div>
        </header>

        <form className="create-user__form" onSubmit={handleSubmit}>
          <div className="create-user__tabs" role="tablist" aria-label="Secciones del usuario">
            <button
              type="button"
              className={`create-user__tab${activeTab === 'general' ? ' create-user__tab--active' : ''}`}
              onClick={() => setActiveTab('general')}
              role="tab"
              aria-selected={activeTab === 'general'}
            >
              General
            </button>
            <button
              type="button"
              className={`create-user__tab${activeTab === 'permisos' ? ' create-user__tab--active' : ''}`}
              onClick={() => setActiveTab('permisos')}
              role="tab"
              aria-selected={activeTab === 'permisos'}
            >
              Permisos
            </button>
          </div>

          <div className="create-user__body">
            {activeTab === 'general' && (
              <>
                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Datos del usuario</p>
                      <h4>Información personal y de contacto</h4>
                    </div>
                  </div>

                  <div className="create-user__grid create-user__grid--two">
                    <label className="create-user__field">
                      <span>Nombres</span>
                      <input
                        name="nombres"
                        type="text"
                        placeholder="Nombres"
                        value={formData.nombres}
                        onChange={handleChange}
                        required
                      />
                    </label>

                    <label className="create-user__field">
                      <span>Apellidos</span>
                      <input
                        name="apellidos"
                        type="text"
                        placeholder="Apellidos"
                        value={formData.apellidos}
                        onChange={handleChange}
                        required
                      />
                    </label>

                    <label className="create-user__field">
                      <span>Correo</span>
                      <input
                        name="correo"
                        type="email"
                        placeholder="Correo"
                        value={formData.correo}
                        onChange={handleChange}
                        required
                      />
                    </label>

                    <label className="create-user__field">
                      <span>Teléfono</span>
                      <input
                        name="telefono"
                        type="tel"
                        placeholder="Teléfono"
                        value={formData.telefono}
                        onChange={handleChange}
                      />
                    </label>

                    <label className="create-user__field create-user__field--full">
                      <span>Cargo</span>
                      <input
                        name="cargo"
                        type="text"
                        placeholder="Cargo"
                        value={formData.cargo}
                        onChange={handleChange}
                      />
                    </label>
                  </div>
                </section>

                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Acceso y permisos</p>
                      <h4>Credenciales y activación</h4>
                    </div>
                  </div>

                  <div className="create-user__access-grid">
                    <div className="create-user__access-left">
                      <label className="create-user__field create-user__field--password">
                        <div className="create-user__field-label">
                          <span>Contraseña</span>
                          <div className="create-user__password-actions">
                            <button type="button" className="create-user__ghost" onClick={generatePassword}>
                              Generar
                            </button>
                            <button type="button" className="create-user__ghost" onClick={copyPassword}>
                              {passwordCopied ? 'Copiada' : 'Copiar'}
                            </button>
                          </div>
                        </div>
                        <input
                          name="password"
                          type="text"
                          placeholder="Contraseña"
                          value={password}
                          onChange={(event) => setPassword(event.target.value)}
                          required
                        />
                      </label>

                      <label className="create-user__field create-user__field--password-confirm">
                        <div className="create-user__field-label">
                          <span>Confirmar contraseña</span>
                        </div>
                        <input
                          name="confirmPassword"
                          type="text"
                          placeholder="Repite la contraseña"
                          value={confirmPassword}
                          onChange={(event) => setConfirmPassword(event.target.value)}
                          required
                        />
                      </label>
                    </div>

                    <div className="create-user__access-right">
                      <label className="create-user__checkbox">
                        <input type="checkbox" name="activo" checked={formData.activo} onChange={handleChange} />
                        <div>
                          <span>Cuenta activa</span>
                          <p>El usuario podrá iniciar sesión y operar el sistema.</p>
                        </div>
                      </label>
                    </div>
                  </div>
                </section>
              </>
            )}

            {activeTab === 'permisos' && (
              <section className="create-user__section">
                <div className="create-user__section-header">
                  <div>
                    <p className="create-user__eyebrow">Acceso y permisos</p>
                    <h4>Permisos</h4>
                  </div>
                  {(permissionsLoading || !permissionOptions.length) && (
                    <small className="muted">{permissionsLoading ? 'Cargando permisos...' : 'No hay módulos configurados.'}</small>
                  )}
                </div>

                <div className="permissions-matrix__table" role="grid">
                  <div className="permissions-matrix__row permissions-matrix__row--head">
                    <div className="permissions-matrix__cell permissions-matrix__cell--label">Módulo</div>
                    {ACTIONS.map((action) => (
                      <div key={action.key} className="permissions-matrix__cell permissions-matrix__cell--action">
                        {action.label}
                      </div>
                    ))}
                  </div>

                  {permissionOptions.map((module) => renderPermissionRow(module))}
                </div>
              </section>
            )}

          </div>

          <div className="create-user__footer">
            <button type="button" className="create-user__action create-user__action--cancel" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="create-user__action create-user__action--primary" disabled={loading}>
              {loading ? 'Guardando...' : 'Crear usuario'}
            </button>
          </div>
        </form>

        <button
          type="button"
          aria-label="Cambiar tamaño de ventana"
          className="create-user__resize-handle"
          onMouseDown={handleResizeMouseDown}
        />
      </div>
    </div>
  )
}

export default CreateUsuario
