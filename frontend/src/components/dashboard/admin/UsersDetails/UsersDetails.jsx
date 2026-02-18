import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Eye, Info, Pencil } from 'lucide-react'
import '../CreateUsuario/CreateUsuario.css'
import './UsersDetails.css'
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

const buildMatrixFromList = (permisos = []) => {
  const matrix = {}
  permisos.forEach((permiso) => {
    if (!permiso?.modulo) return
    matrix[permiso.modulo] = {
      puede_crear: Boolean(permiso.puede_crear),
      puede_leer: Boolean(permiso.puede_leer),
      puede_actualizar: Boolean(permiso.puede_actualizar),
      puede_eliminar: Boolean(permiso.puede_eliminar),
    }
  })
  return matrix
}

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

const emptyForm = {
  nombres: '',
  apellidos: '',
  correo: '',
  telefono: '',
  cargo: '',
  activo: false,
  permisos_personalizados: [],
  sucursales: [],
  roles: [],
}

function UsersDetails({ open, userId, token, onClose, onUpdated, onDeleted, onError }) {
  const [formData, setFormData] = useState(emptyForm)
  const [originalData, setOriginalData] = useState(emptyForm)
  const [permissionOptions, setPermissionOptions] = useState([])
  const [permissionsMatrix, setPermissionsMatrix] = useState({})
  const [permissionsLoading, setPermissionsLoading] = useState(false)
  const [branches, setBranches] = useState([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [selectedBranches, setSelectedBranches] = useState([])
  const [loadingData, setLoadingData] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [activeTab, setActiveTab] = useState('general')
  const [isMaximized, setIsMaximized] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })

  const modalRef = useRef(null)
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

  const normalizeUser = (data) => ({
    nombres: data?.nombres ?? '',
    apellidos: data?.apellidos ?? '',
    correo: data?.correo ?? '',
    telefono: data?.telefono ?? '',
    cargo: data?.cargo ?? '',
    activo: Boolean(data?.activo),
    permisos_personalizados: Array.isArray(data?.permisos_personalizados)
      ? data.permisos_personalizados
      : [],
    sucursales: Array.isArray(data?.sucursales) ? data.sucursales : [],
  })

  const handleChange = (event) => {
    if (!isEditing) return
    const { name, value, type, checked } = event.target
    setFormData((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }))
  }

  const togglePermission = (moduleKey, actionKey) => {
    if (!isEditing) return
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
    const isDisabled = !isEditing || loadingData || saving || deleteLoading || permissionsLoading

    return (
      <div
        key={entryKey}
        className="permissions-matrix__row"
      >
        <div className="permissions-matrix__cell permissions-matrix__cell--label">{module.label}</div>
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

  const loadPermissionOptions = useCallback(async () => {
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

  const fetchBranches = useCallback(async () => {
    setBranchesLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/inventario/sucursales/`,
        {},
        token
      )

      if (!response.ok) throw new Error('No se pudieron cargar las sucursales.')

      const data = await response.json().catch(() => [])
      const items = Array.isArray(data) ? data : data?.results || []
      setBranches(items)
    } catch (err) {
      notifyError(err.message || 'Ocurrió un problema al cargar las sucursales.')
    } finally {
      setBranchesLoading(false)
    }
  }, [notifyError, token])

  const toggleBranch = (branchId) => {
    if (!isEditing) return
    setSelectedBranches((prev) => {
      const exists = prev.includes(branchId)
      if (exists) return prev.filter((id) => id !== branchId)
      return [...prev, branchId]
    })
  }

  const fetchUser = useCallback(async () => {
    if (!userId) return
    setLoadingData(true)
    try {
      const response = await authFetch(
        `${API_URL}/usuarios/listado/${userId}/`,
        {},
        token
      )
      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        const detail = data?.detail || 'No se pudo cargar la información del usuario.'
        throw new Error(detail)
      }

      const normalized = normalizeUser(data)
      setFormData(normalized)
      setOriginalData(normalized)
      setPermissionsMatrix(buildMatrixFromList(normalized.permisos_personalizados))
      setSelectedBranches(normalized.sucursales.map((branch) => branch.id))
      setIsEditing(false)
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al obtener la información del usuario.')
    } finally {
      setLoadingData(false)
    }
  }, [notifyError, token, userId])

  useEffect(() => {
    if (!open) return
    setIsEditing(false)
    setFormData(emptyForm)
    setOriginalData(emptyForm)
    setPermissionsMatrix({})
    setBranches([])
    setSelectedBranches([])
    setActiveTab('general')
    setIsMaximized(false)
    restoreRef.current = null
    fetchUser()
    loadPermissionOptions()
    fetchBranches()
  }, [open, fetchUser, loadPermissionOptions, fetchBranches])

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

  const handleToggleEdit = () => {
    if (loadingData || saving || deleteLoading) return
    setIsEditing((prev) => {
      const next = !prev
      if (!next) {
        setFormData(originalData)
        setPermissionsMatrix(buildMatrixFromList(originalData.permisos_personalizados))
        setSelectedBranches(originalData.sucursales.map((branch) => branch.id))
      }
      return next
    })
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!isEditing || loadingData) return
    setSaving(true)

    const payload = {
      ...formData,
      nombres: formData.nombres.trim(),
      apellidos: formData.apellidos.trim(),
      correo: formData.correo.trim().toLowerCase(),
      telefono: formData.telefono.trim(),
      cargo: formData.cargo.trim(),
      permisos_personalizados: serializeMatrix(permissionsMatrix),
      sucursales_ids: selectedBranches,
    }

    if (!payload.nombres || !payload.apellidos || !payload.correo) {
      setSaving(false)
      notifyError('Completa los campos de nombres, apellidos y correo para continuar.')
      return
    }

    try {
      const response = await authFetch(
        `${API_URL}/usuarios/listado/${userId}/`,
        {
          method: 'PATCH',
          body: JSON.stringify(payload),
        },
        token
      )

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail =
          data?.detail ||
          data?.correo?.[0] ||
          data?.nombres?.[0] ||
          data?.roles?.[0] ||
          data?.sucursales_ids?.[0] ||
          data?.permisos_personalizados?.[0] ||
          'No se pudo actualizar el usuario. Verifica la información enviada.'
        throw new Error(detail)
      }

      const normalized = normalizeUser(data)
      setFormData(normalized)
      setOriginalData(normalized)
      setPermissionsMatrix(buildMatrixFromList(normalized.permisos_personalizados))
      setSelectedBranches(normalized.sucursales.map((branch) => branch.id))
      setIsEditing(false)
      onUpdated?.(data)
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al actualizar el usuario.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!isEditing || deleteLoading || !userId) return
    setShowDeleteDialog(false)
    setDeleteLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/usuarios/listado/${userId}/`,
        {
          method: 'DELETE',
        },
        token
      )

      if (!response.ok && response.status !== 204) {
        const data = await response.json().catch(() => ({}))
        const detail = data?.detail || 'No se pudo eliminar el usuario.'
        throw new Error(detail)
      }

      onDeleted?.(userId)
      onClose?.()
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al eliminar el usuario.')
    } finally {
      setDeleteLoading(false)
    }
  }

  const handleClose = () => {
    onClose?.()
    setIsEditing(false)
    setShowDeleteDialog(false)
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
          {/* Mostramos el ID y el nombre completo del estado originalData */}
          <h3>
            {userId && originalData.nombres
              ? `${userId} : ${originalData.nombres} ${originalData.apellidos}`
              : 'Cargando usuario...'}
          </h3>
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
            onClick={handleClose}
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
          <button
            type="button"
            className={`create-user__tab${activeTab === 'sucursales' ? ' create-user__tab--active' : ''}`}
            onClick={() => setActiveTab('sucursales')}
            role="tab"
            aria-selected={activeTab === 'sucursales'}
          >
            Sucursales
          </button>
        </div>

        <div className={`create-user__body${activeTab === 'permisos' ? ' create-user__body--permissions' : ''}`}>
          {activeTab === 'general' && (
            <section className="create-user__section">
              <div className="create-user__section-header">
                <div>
                  <p className="create-user__eyebrow">Perfil</p>
                  <h4>Información del usuario</h4>
                </div>
                {loadingData && <small className="muted">Cargando datos...</small>}
              </div>

              <div className="create-user__grid create-user__grid--two">
                <label className="create-user__field">
                  <span>Nombres</span>
                  <input
                    name="nombres"
                    type="text"
                    placeholder="Ana María"
                    value={formData.nombres}
                    onChange={handleChange}
                    disabled={!isEditing || loadingData || saving}
                    required
                  />
                </label>

                <label className="create-user__field">
                  <span>Apellidos</span>
                  <input
                    name="apellidos"
                    type="text"
                    placeholder="Pérez Ruiz"
                    value={formData.apellidos}
                    onChange={handleChange}
                    disabled={!isEditing || loadingData || saving}
                    required
                  />
                </label>

                <label className="create-user__field">
                  <span>Correo</span>
                  <input
                    name="correo"
                    type="email"
                    placeholder="usuario@empresa.com"
                    value={formData.correo}
                    onChange={handleChange}
                    disabled={!isEditing || loadingData || saving}
                    required
                  />
                </label>

                <label className="create-user__field">
                  <span>Teléfono</span>
                  <input
                    name="telefono"
                    type="tel"
                    placeholder="099 999 9999"
                    value={formData.telefono}
                    onChange={handleChange}
                    disabled={!isEditing || loadingData || saving}
                  />
                </label>

                <label className="create-user__field create-user__field--full">
                  <span>Cargo</span>
                  <input
                    name="cargo"
                    type="text"
                    placeholder="Coordinador de inventario"
                    value={formData.cargo}
                    onChange={handleChange}
                    disabled={!isEditing || loadingData || saving}
                  />
                </label>
              </div>

              <div className="create-user__section-header">
                <div>
                  <p className="create-user__eyebrow">Perfil</p>
                  <h4>Activación</h4>
                </div>
                {loadingData && <small className="muted">Cargando datos...</small>}
              </div>

              <div className="create-user__access-grid">
                <label className="create-user__checkbox">
                  <input type="checkbox" name="activo" checked={formData.activo} onChange={handleChange} disabled={!isEditing || loadingData || saving} />
                  <div>
                    <span>Cuenta activa</span>
                    <p>El usuario podrá iniciar sesión y operar el sistema.</p>
                  </div>
                </label>
              </div>

            </section>
          )}

          {activeTab === 'permisos' && (
            <section className="create-user__section create-user__section--permissions">
              <div className="create-user__section-header">
                <div>
                  <p className="create-user__eyebrow">Acceso y permisos</p>
                  <h4>Permisos</h4>
                </div>
                {(permissionsLoading || !permissionOptions.length) && (
                  <small className="muted">
                    {permissionsLoading ? 'Cargando permisos...' : 'No hay módulos configurados.'}
                  </small>
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

                {permissionOptions.map((module) => (
                  renderPermissionRow(module)
                ))}
              </div>
              </section>
            )}

            {activeTab === 'sucursales' && (
              <section className="create-user__section">
                <div className="create-user__section-header">
                  <div>
                    <p className="create-user__eyebrow">Sucursales</p>
                    <h4>Acceso por sucursal</h4>
                  </div>
                  {(branchesLoading || !branches.length) && (
                    <small className="muted">
                      {branchesLoading ? 'Cargando sucursales...' : 'No hay sucursales registradas.'}
                    </small>
                  )}
                </div>

                <div className="create-user__branches">
                  {branches.map((branch) => (
                    <label key={branch.id} className="create-user__branch-option">
                      <input
                        type="checkbox"
                        checked={selectedBranches.includes(branch.id)}
                        onChange={() => toggleBranch(branch.id)}
                        disabled={!isEditing || loadingData || saving || branchesLoading}
                      />
                      <div className="create-user__branch-info">
                        <span>{branch.nombre}</span>
                        {branch.direccion ? <small>{branch.direccion}</small> : null}
                      </div>
                    </label>
                  ))}
                </div>
              </section>
            )}
        </div>

          <div className="create-user__footer">
            <div className="user-details__footer-left">
              <button type="button" className="create-user__action create-user__action--cancel" onClick={handleClose}>
                Cancelar
              </button>
              <button
                type="button"
                className={`create-user__action create-user__action--edit user-details__edit-toggle${isEditing ? ' user-details__edit-toggle--active' : ''}`}
                onClick={handleToggleEdit}
                disabled={loadingData || saving || deleteLoading}
              >
                {isEditing ? (
                  <>
                    <span className="user-details__toggle-icon" aria-hidden="true">
                      <Eye size={16} />
                    </span>
                    <span>Solo lectura</span>
                  </>
                ) : (
                  <>
                    <span className="user-details__toggle-icon" aria-hidden="true">
                      <Pencil size={16} />
                    </span>
                    <span>Editar</span>
                  </>
                )}
              </button>
            </div>

            <div className="user-details__footer-right">
              {isEditing && (
                <>
                  <button
                    type="button"
                    className="create-user__action user-details__delete"
                    onClick={() => setShowDeleteDialog(true)}
                    disabled={deleteLoading || saving || loadingData}
                  >
                    {deleteLoading ? 'Eliminando...' : 'Eliminar'}
                  </button>

                  <button
                    type="submit"
                    className="create-user__action create-user__action--primary"
                    disabled={saving || loadingData}
                  >
                    {saving ? 'Guardando...' : 'Guardar'}
                  </button>
                </>
              )}
            </div>
          </div>
      </form>

      {showDeleteDialog && (
        <div className="user-details__confirm-overlay" role="alertdialog" aria-modal="true" aria-label="Confirmar eliminación">
          <div className="user-details__confirm-dialog">
            <div className="user-details__confirm-icon" aria-hidden="true">
              <Info size={22} />
            </div>
            <div className="user-details__confirm-content">
              <h4>¿Estás seguro?</h4>
              <p>Esta acción es irreversible</p>
            </div>
            <div className="user-details__confirm-actions">
              <button
                type="button"
                className="create-user__ghost create-user__cancel"
                onClick={() => setShowDeleteDialog(false)}
              >
                No
              </button>
              <button
                type="button"
                className="user-details__confirm-danger"
                onClick={handleDelete}
                disabled={deleteLoading}
              >
                Sí
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteDialog && (
        <div className="user-details__confirm-overlay" role="alertdialog" aria-modal="true" aria-label="Confirmar eliminación">
          <div className="user-details__confirm-dialog">
            <div className="user-details__confirm-icon" aria-hidden="true">
              <Info size={22} />
            </div>
            <div className="user-details__confirm-content">
              <h4>¿Estás seguro?</h4>
              <p>Esta acción es irreversible</p>
            </div>
            <div className="user-details__confirm-actions">
              <button
                type="button"
                className="create-user__action create-user__action--cancel"
                onClick={() => setShowDeleteDialog(false)}
              >
                No
              </button>
              <button
                type="button"
                className="create-user__action user-details__confirm-danger"
                onClick={handleDelete}
                disabled={deleteLoading}
              >
                Sí
              </button>
            </div>
          </div>
        </div>
      )}

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

export default UsersDetails
