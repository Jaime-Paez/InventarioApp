import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Eye, Info, Pencil } from 'lucide-react'
import '../../admin/CreateUsuario/CreateUsuario.css'
import '../../admin/UsersDetails/UsersDetails.css'
import { API_URL, authFetch } from '../../../../utils/api'
import useModalAnimation from '../../common/useModalAnimation'
import EntityRemindersTab from '../../common/reminders/EntityRemindersTab'

const MIN_WIDTH = 720
const MIN_HEIGHT = 520
const VIEWPORT_PADDING = 12

const emptyForm = {
  nombres: '',
  apellidos: '',
  cedula_ruc: '',
  correo: '',
  telefono: '',
  direccion: '',
}

const emptyAuto = {
  placa: '',
  modelo: '',
  anio: '',
  marcaId: '',
  marcaNombre: '',
  color: '',
}

function ClienteDetails({
  open,
  clienteId,
  token,
  onClose,
  onUpdated,
  onDeleted,
  onError,
  currentUser,
  allowEdit = true,
  allowDelete = true,
}) {
  const [formData, setFormData] = useState(emptyForm)
  const [originalData, setOriginalData] = useState(emptyForm)
  const [autos, setAutos] = useState([])
  const [originalAutos, setOriginalAutos] = useState([])
  const [loadingData, setLoadingData] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [marcas, setMarcas] = useState([])
  const [loadingMarcas, setLoadingMarcas] = useState(false)
  const [activeAutoMarcaDropdown, setActiveAutoMarcaDropdown] = useState(null)
  const [activeTab, setActiveTab] = useState('general')
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })

  const modalRef = useRef(null)
  const autoMarcaDropdownRefs = useRef({})
  const dragData = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const resizeData = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const sizeRef = useRef(size)
  const positionRef = useRef(position)
  const restoreRef = useRef(null)
  const marcaSearchRef = useRef(null)

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

  const getMarcaLabel = useCallback(
    (marcaId) => marcas.find((marca) => String(marca.id) === String(marcaId))?.nombre || '',
    [marcas]
  )

  const searchMarcas = useCallback(
    (query) => {
      const term = String(query ?? '').trim()
      if (marcaSearchRef.current) clearTimeout(marcaSearchRef.current)
      if (!term || !token) {
        setMarcas([])
        return
      }
      marcaSearchRef.current = setTimeout(async () => {
        setLoadingMarcas(true)
        try {
          const response = await authFetch(
            `${API_URL}/marcas/listado/?search=${encodeURIComponent(term)}&page_size=20`,
            {},
            token
          )
          if (!response.ok) return
          const data = await response.json()
          const list = Array.isArray(data) ? data : data?.results || []
          setMarcas(list)
        } finally {
          setLoadingMarcas(false)
        }
      }, 300)
    },
    [token]
  )

  const normalizeCliente = (data) => ({
    nombres: data?.nombres ?? '',
    apellidos: data?.apellidos ?? '',
    cedula_ruc: data?.cedula_ruc ?? '',
    correo: data?.correo ?? '',
    telefono: data?.telefono ?? '',
    direccion: data?.direccion ?? '',
    autos: Array.isArray(data?.autos)
      ? data.autos.map((auto) => ({
        placa: auto?.placa ?? '',
        modelo: auto?.modelo ?? '',
        anio: auto?.anio ?? '',
        marcaId: auto?.marca_id ?? '',
        marcaNombre: auto?.marca ?? '',
        color: auto?.color ?? '',
      }))
      : [],
  })

  const handleChange = (event) => {
    if (!isEditing) return
    const { name, value } = event.target
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }))
  }

  const handleAutoChange = (index, field, value) => {
    if (!isEditing) return
    setAutos((prev) =>
      prev.map((auto, i) => (i === index ? { ...auto, [field]: value } : auto))
    )
  }

  const handleAutoMarcaChange = (index, value) => {
    if (!isEditing) return
    setAutos((prev) =>
      prev.map((auto, i) =>
        i === index
          ? {
              ...auto,
              marcaNombre: value,
              marcaId: '',
            }
          : auto
      )
    )
    searchMarcas(value)
  }

  const handleAutoMarcaSelect = (index, marca) => {
    if (!isEditing || !marca) return
    setAutos((prev) =>
      prev.map((auto, i) =>
        i === index
          ? {
              ...auto,
              marcaNombre: marca.nombre,
              marcaId: String(marca.id),
            }
          : auto
      )
    )
    setActiveAutoMarcaDropdown(null)
  }

  const canAddAuto = useCallback(() => {
    if (!autos.length) return true
    const last = autos[autos.length - 1]
    return Boolean(last.placa && last.modelo && last.anio && last.marcaId)
  }, [autos])

  const addAutoRow = () => {
    if (!isEditing) return
    if (!canAddAuto()) {
      notifyError('Completa el auto actual antes de agregar otro.')
      return
    }
    setAutos((prev) => [...prev, { ...emptyAuto }])
  }

  const removeAutoRow = (index) => {
    if (!isEditing) return
    setAutos((prev) => prev.filter((_, i) => i !== index))
  }

  const fetchCliente = useCallback(async () => {
    if (!clienteId) return
    setLoadingData(true)
    try {
      const response = await authFetch(`${API_URL}/solicitudes/clientes/${clienteId}/`, {}, token)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = data?.detail || 'No se pudo cargar la información del cliente.'
        throw new Error(detail)
      }
      const normalized = normalizeCliente(data)
      const { autos: autosList, ...clientData } = normalized
      setFormData(clientData)
      setOriginalData(clientData)
      const nextAutos = autosList
      setAutos(nextAutos)
      setOriginalAutos(nextAutos)
      setIsEditing(false)
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al obtener la información del cliente.')
    } finally {
      setLoadingData(false)
    }
  }, [notifyError, token, clienteId])

  useEffect(() => {
    if (!open) return
    setIsEditing(false)
    setFormData(emptyForm)
    setOriginalData(emptyForm)
    setAutos([])
    setOriginalAutos([])
    setActiveAutoMarcaDropdown(null)
    setActiveTab('general')
    setSubmitAttempted(false)
    setIsMaximized(false)
    restoreRef.current = null
    setMarcas([])
    fetchCliente()
  }, [open, fetchCliente])

  useEffect(() => {
    if (!open) {
      setLoadingData(true)
    }
  }, [open])

  useEffect(() => {
    if (allowEdit || !isEditing) return
    setIsEditing(false)
  }, [allowEdit, isEditing])

  useEffect(() => {
    if (allowDelete || !showDeleteDialog) return
    setShowDeleteDialog(false)
  }, [allowDelete, showDeleteDialog])

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

  useEffect(() => {
    if (activeAutoMarcaDropdown === null) return
    const handleClick = (event) => {
      const node = autoMarcaDropdownRefs.current[activeAutoMarcaDropdown]
      if (node && !node.contains(event.target)) {
        setActiveAutoMarcaDropdown(null)
      }
    }
    window.addEventListener('mousedown', handleClick)
    return () => window.removeEventListener('mousedown', handleClick)
  }, [activeAutoMarcaDropdown])

  const handleSave = async () => {
    if (!isEditing || saving || !clienteId) return
    setSubmitAttempted(true)
    setSaving(true)

    const payload = {
      nombres: formData.nombres.trim(),
      apellidos: formData.apellidos.trim(),
      cedula_ruc: formData.cedula_ruc.trim(),
      correo: formData.correo.trim(),
      telefono: formData.telefono.trim(),
      direccion: formData.direccion.trim(),
    }

    const autosPayload = autos
      .map((auto) => ({
        placa: auto.placa.trim(),
        modelo: auto.modelo.trim(),
        anio: auto.anio ? Number(auto.anio) : null,
        marca_id: auto.marcaId ? Number(auto.marcaId) : null,
        color: auto.color.trim(),
      }))
      .filter((auto) => auto.placa || auto.modelo || auto.anio || auto.marca_id || auto.color)

    if (autosPayload.length) {
      const validAutos = autosPayload.filter(
        (auto) => auto.placa && auto.modelo && Number.isFinite(auto.anio) && auto.marca_id
      )
      if (validAutos.length !== autosPayload.length) {
        setSaving(false)
      notifyError('Completa placa, modelo, año y marca para cada auto agregado.')
        return
      }
      payload.autos = validAutos
    } else {
      payload.autos = []
    }

    if (!payload.nombres) {
      setSaving(false)
      notifyError('Define los nombres del cliente.')
      return
    }

    if (!payload.apellidos) {
      setSaving(false)
      notifyError('Define los apellidos del cliente.')
      return
    }

    if (!payload.cedula_ruc) {
      setSaving(false)
      notifyError('La cedula/RUC es obligatoria para este cliente.')
      return
    }

    try {
      const response = await authFetch(
        `${API_URL}/solicitudes/clientes/${clienteId}/`,
        {
          method: 'PUT',
          body: JSON.stringify(payload),
        },
        token
      )

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = data?.detail || data?.nombre?.[0] || 'No se pudo actualizar el cliente.'
        throw new Error(detail)
      }

      const normalized = normalizeCliente(data)
      const { autos: autosList, ...clientData } = normalized
      setFormData(clientData)
      setOriginalData(clientData)
      const nextAutos = autosList
      setAutos(nextAutos)
      setOriginalAutos(nextAutos)
      setSubmitAttempted(false)
      setIsEditing(false)
      onUpdated?.(data)
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al actualizar el cliente.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!allowDelete) return
    if (!isEditing || deleteLoading || !clienteId) return
    setDeleteLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/solicitudes/clientes/${clienteId}/`,
        { method: 'DELETE' },
        token
      )

      if (!response.ok && response.status !== 204) {
        const data = await response.json().catch(() => ({}))
        const detail = data?.detail || 'No se pudo eliminar el cliente.'
        throw new Error(detail)
      }

      onDeleted?.(clienteId)
      setShowDeleteDialog(false)
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al eliminar el cliente.')
    } finally {
      setDeleteLoading(false)
    }
  }

  const handleCancelEdit = () => {
    setFormData(originalData)
    setAutos(originalAutos)
    setSubmitAttempted(false)
    setIsEditing(false)
  }

  const handleToggleEdit = () => {
    if (!allowEdit) return
    setIsEditing((prev) => {
      const next = !prev
      if (!next) {
        setSubmitAttempted(false)
      }
      return next
    })
  }

  const handleMouseDown = (event) => {
    if (isMaximized) {
      const restore = restoreRef.current
      const fallbackSize = sizeRef.current
      const restoredSize = restore?.size || fallbackSize
      const restoredPosition = restore?.position || {
        x: Math.max((window.innerWidth - restoredSize.width) / 2, VIEWPORT_PADDING),
        y: Math.max((window.innerHeight - restoredSize.height) / 2, VIEWPORT_PADDING),
      }

      sizeRef.current = restoredSize
      positionRef.current = restoredPosition
      setSize(restoredSize)
      setPosition(restoredPosition)
      setIsMaximized(false)

      const offsetX = Math.min(
        Math.max(event.clientX - restoredPosition.x, 24),
        Math.max(restoredSize.width - 24, 24)
      )
      const offsetY = Math.min(
        Math.max(event.clientY - restoredPosition.y, 12),
        56
      )
      dragData.current = {
        active: true,
        offsetX,
        offsetY,
      }
      return
    }

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
  const { shouldRender, isClosing } = useModalAnimation(open)

  if (!shouldRender) return null

  const overlayStyle = { padding: `${VIEWPORT_PADDING}px` }
  const modalStyle = {
    top: position.y,
    left: position.x,
    width: size.width,
    height: size.height,
    maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
    maxHeight: `calc(100vh - ${VIEWPORT_PADDING * 2}px)`,
  }

  const isViewMode = !isEditing
  const editorDisabled = saving || loadingData || !isEditing

  return (
    <div className={`create-user__overlay${isClosing ? ' create-user__overlay--closing' : ''}`} role="dialog" aria-modal="true" style={overlayStyle}>
      <div
        className={`create-user__modal${submitAttempted ? ' create-user__modal--submitted' : ''}${isClosing ? ' create-user__modal--closing' : ''}`}
        ref={modalRef}
        style={modalStyle}
      >
        <header className="create-user__header" onMouseDown={handleMouseDown}>
          <div className="create-user__header-text">
            <h3>
              {formData.nombres || formData.apellidos
                ? `${formData.nombres} ${formData.apellidos}`.trim()
                : (clienteId ? `Cliente #${clienteId}` : 'Cliente')}
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
              <i className={isMaximized ? 'pi pi-window-minimize' : 'pi pi-window-maximize'} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="create-user__icon-button"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={onClose}
              aria-label="Cerrar"
            >
              <i className="pi pi-times" aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="create-user__content">
          {loadingData && (
            <div className="create-user__loading-overlay" role="status" aria-live="polite">
              <i className="pi pi-spin pi-spinner" aria-hidden="true" />
              <span>Cargando datos...</span>
            </div>
          )}
          <div className="create-user__tabs" role="tablist" aria-label="Secciones del cliente">
            <button
              type="button"
              className={`create-user__tab ${activeTab === 'general' ? 'create-user__tab--active' : ''}`}
              onClick={() => setActiveTab('general')}
            >
              General
            </button>
            <button
              type="button"
              className={`create-user__tab ${activeTab === 'recordatorios' ? 'create-user__tab--active' : ''}`}
              onClick={() => setActiveTab('recordatorios')}
            >
              Recordatorios
            </button>
          </div>

          <div className="create-user__body">
            {activeTab === 'general' && (
              <section className="create-user__section">
              <div className="create-user__section-header">
                <div>
                  <p className="create-user__eyebrow">Datos del cliente</p>
                  <h4>Informacion basica</h4>
                </div>
              </div>

              <div className="create-user__grid create-user__grid--two">
                <label className="create-user__field">
                  <span>Nombres</span>
                  <input
                    name="nombres"
                    type="text"
                    value={formData.nombres}
                    onChange={handleChange}
                    required
                    disabled={editorDisabled}
                  />
                </label>

                <label className="create-user__field">
                  <span>Apellidos</span>
                  <input
                    name="apellidos"
                    type="text"
                    value={formData.apellidos}
                    onChange={handleChange}
                    required
                    disabled={editorDisabled}
                  />
                </label>

                <label className="create-user__field">
                  <span>Cedula/RUC</span>
                  <input
                    name="cedula_ruc"
                    type="text"
                    value={formData.cedula_ruc}
                    onChange={handleChange}
                    required
                    disabled={editorDisabled}
                  />
                </label>

                <label className="create-user__field">
                  <span>Correo</span>
                  <input
                    name="correo"
                    type="email"
                    value={formData.correo}
                    onChange={handleChange}
                    disabled={editorDisabled}
                  />
                </label>

                <label className="create-user__field">
                  <span>Teléfono</span>
                  <input
                    name="telefono"
                    type="text"
                    value={formData.telefono}
                    onChange={handleChange}
                    disabled={editorDisabled}
                  />
                </label>

                <label className="create-user__field create-user__field--full">
                  <span>Dirección</span>
                  <input
                    name="direccion"
                    type="text"
                    value={formData.direccion}
                    onChange={handleChange}
                    disabled={editorDisabled}
                  />
                </label>
              </div>

              <div className="create-user__section-header" style={{ marginTop: 18 }}>
                <div>
                  <p className="create-user__eyebrow">Autos</p>
                  <h4>Vehiculos asociados</h4>
                </div>
              </div>

              <div className="create-user__grid create-user__grid--two">
                {autos.length === 0 && (
                  <p className="workspace__subtitle" style={{ margin: 0 }}>
                    No hay autos asociados.
                  </p>
                )}

                {autos.map((auto, index) => (
                  <div key={`auto-${index}`} className="create-user__field create-user__field--full" style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: 14 }}>
                    <div className="create-user__grid create-user__grid--two">
                      <label className="create-user__field">
                        <span>Placa</span>
                        <input
                          type="text"
                          value={auto.placa}
                          onChange={(event) => handleAutoChange(index, 'placa', event.target.value)}
                          disabled={editorDisabled}
                        />
                      </label>

                      <label className="create-user__field">
                        <span>Modelo</span>
                        <input
                          type="text"
                          value={auto.modelo}
                          onChange={(event) => handleAutoChange(index, 'modelo', event.target.value)}
                          disabled={editorDisabled}
                        />
                      </label>

                      <label className="create-user__field">
                        <span>Año</span>
                        <input
                          type="number"
                          min="1900"
                          max="2100"
                          value={auto.anio}
                          onChange={(event) => handleAutoChange(index, 'anio', event.target.value)}
                          disabled={editorDisabled}
                        />
                      </label>

                      <label className="create-user__field">
                        <span>Marca</span>
                        <div
                          className="create-user__dropdown"
                          ref={(node) => {
                            autoMarcaDropdownRefs.current[index] = node
                          }}
                        >
                          <button
                            type="button"
                            className="create-user__dropdown-trigger"
                            onClick={() =>
                              setActiveAutoMarcaDropdown((prev) => (prev === index ? null : index))
                            }
                            disabled={editorDisabled || loadingMarcas}
                          >
                            <span>{auto.marcaNombre || getMarcaLabel(auto.marcaId) || 'Selecciona una marca'}</span>
                            <i className={`pi pi-chevron-${activeAutoMarcaDropdown === index ? 'up' : 'down'}`} />
                          </button>

                          {activeAutoMarcaDropdown === index && (
                            <div className="create-user__dropdown-panel">
                              <div className="create-user__dropdown-search">
                                <i className="pi pi-search" />
                                <input
                                  type="text"
                                  placeholder="Buscar marcas"
                                  value={auto.marcaNombre}
                                  onChange={(event) => handleAutoMarcaChange(index, event.target.value)}
                                  disabled={editorDisabled || loadingMarcas}
                                />
                              </div>

                              <div className="create-user__dropdown-results">
                                {loadingMarcas && <small className="muted">Buscando marcas...</small>}
                                {!loadingMarcas && !auto.marcaNombre?.trim() && (
                                  <small className="muted">Escribe para buscar.</small>
                                )}
                                {!loadingMarcas && auto.marcaNombre?.trim() && !marcas.length && (
                                  <small className="muted">Sin resultados.</small>
                                )}
                                {marcas.map((marca) => (
                                  <button
                                    key={marca.id}
                                    type="button"
                                    className="create-user__result-option"
                                    onMouseDown={(event) => event.preventDefault()}
                                    onClick={(event) => {
                                      event.preventDefault()
                                      event.stopPropagation()
                                      handleAutoMarcaSelect(index, marca)
                                    }}
                                    disabled={editorDisabled}
                                  >
                                    <div className="create-user__result-info">
                                      <strong>{marca.nombre}</strong>
                                      <small>{marca.codigo ? `Código: ${marca.codigo}` : `ID: ${marca.id}`}</small>
                                    </div>
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </label>

                      <label className="create-user__field">
                        <span>Color</span>
                        <input
                          type="text"
                          value={auto.color}
                          onChange={(event) => handleAutoChange(index, 'color', event.target.value)}
                          disabled={editorDisabled}
                        />
                      </label>
                    </div>

                    {isEditing && (
                      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                        <button
                          type="button"
                          className="create-user__action create-user__action--cancel"
                          onClick={() => removeAutoRow(index)}
                          disabled={editorDisabled}
                        >
                          Quitar auto
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {isEditing && (
                <div style={{ marginTop: 10 }}>
                  <button
                    type="button"
                    className="create-user__action create-user__action--secondary"
                    onClick={addAutoRow}
                    disabled={editorDisabled || !canAddAuto()}
                  >
                    Agregar auto
                  </button>
                </div>
              )}
              </section>
            )}

            {activeTab === 'recordatorios' && (
              <EntityRemindersTab
                token={token}
                currentUser={currentUser}
                entityType="cliente"
                entityId={clienteId}
                isOpen={open}
                entityLabel={
                  `${formData.nombres || ''} ${formData.apellidos || ''}`.trim() ||
                  (clienteId ? `Cliente #${clienteId}` : 'Cliente')
                }
                canCreateReminder={allowEdit && isEditing}
                onError={notifyError}
              />
            )}
          </div>
        </div>

        <div className="create-user__footer">
          <div className="user-details__footer-left">
            <button
              type="button"
              className="create-user__action create-user__action--cancel"
              onClick={isEditing ? handleCancelEdit : onClose}
              disabled={saving}
            >
              Cancelar
            </button>
            {allowEdit && (
              <button
                type="button"
                className={`create-user__action create-user__action--edit user-details__edit-toggle${isEditing ? ' user-details__edit-toggle--active' : ''}`}
                onClick={handleToggleEdit}
                disabled={loadingData || saving}
              >
                <span className="user-details__toggle-icon">{isEditing ? <Eye size={14} /> : <Pencil size={14} />}</span>
                {isEditing ? 'Solo lectura' : 'Editar'}
              </button>
            )}
          </div>

          <div className="user-details__footer-right">
            {isEditing && (
              <>
                {allowDelete && (
                  <button
                    type="button"
                    className="create-user__action user-details__delete"
                    onClick={() => setShowDeleteDialog(true)}
                    disabled={saving}
                  >
                    Eliminar
                  </button>
                )}
                <button
                  type="button"
                  className="create-user__action create-user__action--primary"
                  onClick={handleSave}
                  disabled={isViewMode || saving}
                >
                  {saving ? 'Guardando...' : 'Guardar cambios'}
                </button>
              </>
            )}
          </div>
        </div>

        <button
          type="button"
          aria-label="Cambiar tamaño de ventana"
          className="create-user__resize-handle"
          onMouseDown={handleResizeMouseDown}
        />
      </div>

      {allowDelete && showDeleteDialog && (
        <div className="user-details__confirm-overlay">
          <div className="user-details__confirm-dialog">
            <div className="user-details__confirm-icon">
              <Info size={18} />
            </div>
            <div className="user-details__confirm-content">
              <h4>Eliminar cliente</h4>
              <p>¿Deseas eliminar este cliente? Esta acción no se puede deshacer.</p>
            </div>
            <div className="user-details__confirm-actions">
              <button
                type="button"
                className="create-user__action create-user__action--cancel"
                onClick={() => setShowDeleteDialog(false)}
                disabled={deleteLoading}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="create-user__action user-details__confirm-danger"
                onClick={handleDelete}
                disabled={deleteLoading}
              >
                {deleteLoading ? 'Eliminando...' : 'Eliminar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ClienteDetails


