import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Eye, Info, Pencil } from 'lucide-react'
import '../../admin/CreateUsuario/CreateUsuario.css'
import '../../admin/UsersDetails/UsersDetails.css'
import { API_URL, authFetch } from '../../../../utils/api'
import useModalAnimation from '../../common/useModalAnimation'

const MIN_WIDTH = 720
const MIN_HEIGHT = 520
const VIEWPORT_PADDING = 12

const emptyForm = {
  nombre: '',
  codigo: '',
  tipo: 'local',
  descripcion: '',
  paisId: '',
  telefono: '',
  correo: '',
  dias_entrega: '',
}

const getFlagUrl = (code) => {
  if (!code) return ''
  const clean = String(code).trim().toLowerCase()
  if (clean.length !== 2) return ''
  return `https://flagsapi.com/${clean.toUpperCase()}/flat/64.png`
}

const normalizeCountrySearch = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()

function CasaComercialDetails({
  open,
  casaComercialId,
  token,
  onClose,
  onUpdated,
  onDeleted,
  onDuplicated,
  onError,
  allowEdit = true,
  allowDelete = true,
}) {
  const [formData, setFormData] = useState(emptyForm)
  const [originalData, setOriginalData] = useState(emptyForm)
  const [countries, setCountries] = useState([])
  const [countryQuery, setCountryQuery] = useState('')
  const [countryOptions, setCountryOptions] = useState([])
  const [showCountryDropdown, setShowCountryDropdown] = useState(false)
  const [countryLoading, setCountryLoading] = useState(false)
  const [loadingData, setLoadingData] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })

  const modalRef = useRef(null)
  const countryDropdownRef = useRef(null)
  const countrySearchTimerRef = useRef(null)
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

  const normalizeCasaComercial = (data) => ({
    nombre: data?.nombre ?? '',
    codigo: data?.codigo ?? '',
    tipo: data?.tipo ?? 'local',
    descripcion: data?.descripcion ?? '',
    paisId: data?.pais?.id ?? '',
    telefono: data?.telefono ?? '',
    correo: data?.correo ?? '',
    dias_entrega: data?.dias_entrega != null ? String(data.dias_entrega) : '',
  })

  const handleChange = (event) => {
    if (!isEditing) return
    const { name, value } = event.target
    setFormData((prev) => ({
      ...prev,
      [name]: name === 'codigo' ? value.toUpperCase() : value,
    }))
  }

  const handleCountrySearchChange = (event) => {
    if (!isEditing) return
    const value = event.target.value
    setCountryQuery(value)
    setShowCountryDropdown(true)
    if (formData.paisId) {
      setFormData((prev) => ({ ...prev, paisId: '' }))
    }
  }

  const handleCountrySelect = (country) => {
    if (!country) return
    setFormData((prev) => ({ ...prev, paisId: String(country.id) }))
    setCountryQuery(String(country.nombre || '').trim())
    setShowCountryDropdown(false)
  }

  const fetchCountries = useCallback(async () => {
    try {
      let url = `${API_URL}/tipos/paises/`
      const all = []

      while (url) {
        const response = await authFetch(url, {}, token)
        if (!response.ok) throw new Error('No se pudieron cargar los países.')
        const data = await response.json()
        if (Array.isArray(data)) {
          all.push(...data)
          url = null
        } else {
          const list = data?.results || []
          all.push(...list)
          url = data?.next || null
        }
      }

      setCountries(all)
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al cargar los países.')
    }
  }, [notifyError, token])

  const fetchCasaComercial = useCallback(async () => {
    if (!casaComercialId) return
    setLoadingData(true)
    try {
      const response = await authFetch(`${API_URL}/casa-comercial/casas/${casaComercialId}/`, {}, token)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = data?.detail || 'No se pudo cargar la información de la casa comercial.'
        throw new Error(detail)
      }
      const normalized = normalizeCasaComercial(data)
      setFormData(normalized)
      setOriginalData(normalized)
      setIsEditing(false)
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al obtener la información de la casa comercial.')
    } finally {
      setLoadingData(false)
    }
  }, [notifyError, token, casaComercialId])

  useEffect(() => {
    if (!open) return
    setIsEditing(false)
    setFormData(emptyForm)
    setOriginalData(emptyForm)
    setSubmitAttempted(false)
    setCountryQuery('')
    setCountryOptions([])
    setShowCountryDropdown(false)
    setCountryLoading(false)
    setIsMaximized(false)
    restoreRef.current = null
    fetchCountries()
    fetchCasaComercial()
  }, [open, fetchCountries, fetchCasaComercial])

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

  useEffect(() => {
    if (!open || !showCountryDropdown) return
    if (countrySearchTimerRef.current) clearTimeout(countrySearchTimerRef.current)

    setCountryLoading(true)
    countrySearchTimerRef.current = setTimeout(() => {
      const term = normalizeCountrySearch(countryQuery)
      const filtered = term
        ? countries.filter((country) => {
            const nombre = normalizeCountrySearch(country?.nombre)
            const codigoPais = normalizeCountrySearch(country?.codigo_pais)
            return nombre.includes(term) || codigoPais.includes(term)
          })
        : countries
      setCountryOptions(filtered.slice(0, term ? 20 : 5))
      setCountryLoading(false)
    }, 280)

    return () => {
      if (countrySearchTimerRef.current) {
        clearTimeout(countrySearchTimerRef.current)
        countrySearchTimerRef.current = null
      }
    }
  }, [open, showCountryDropdown, countryQuery, countries])

  useEffect(() => {
    if (!showCountryDropdown) return
    const handleClickOutside = (event) => {
      if (!countryDropdownRef.current?.contains(event.target)) {
        setShowCountryDropdown(false)
      }
    }
    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [showCountryDropdown])

  useEffect(
    () => () => {
      if (countrySearchTimerRef.current) {
        clearTimeout(countrySearchTimerRef.current)
        countrySearchTimerRef.current = null
      }
    },
    []
  )

  useEffect(() => {
    if (!isEditing) {
      setShowCountryDropdown(false)
    }
  }, [isEditing])

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

  const handleSave = async () => {
    if (!isEditing || saving || !casaComercialId) return
    setSubmitAttempted(true)
    setSaving(true)

    const payload = {
      nombre: formData.nombre.trim(),
      codigo: formData.codigo.trim(),
      tipo: formData.tipo,
      descripcion: formData.descripcion.trim(),
      telefono: formData.telefono.trim(),
      correo: formData.correo.trim(),
      pais_id: formData.paisId ? Number(formData.paisId) : null,
      dias_entrega: formData.dias_entrega !== '' ? Number(formData.dias_entrega) : null,
    }

    if (!payload.nombre) {
      setSaving(false)
      notifyError('Define un nombre para la casa comercial.')
      return
    }

    if (!payload.codigo) {
      setSaving(false)
      notifyError('Define un codigo para la casa comercial.')
      return
    }

    try {
      const response = await authFetch(
        `${API_URL}/casa-comercial/casas/${casaComercialId}/`,
        {
          method: 'PUT',
          body: JSON.stringify(payload),
        },
        token
      )

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = data?.detail || data?.nombre?.[0] || data?.codigo?.[0] || 'No se pudo actualizar la casa comercial.'
        throw new Error(detail)
      }

      const normalized = normalizeCasaComercial(data)
      setFormData(normalized)
      setOriginalData(normalized)
      setSubmitAttempted(false)
      setIsEditing(false)
      onUpdated?.(data)
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al actualizar la casa comercial.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!allowDelete) return
    if (!isEditing || deleteLoading || !casaComercialId) return
    setDeleteLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/casa-comercial/casas/${casaComercialId}/`,
        { method: 'DELETE' },
        token
      )

      if (!response.ok && response.status !== 204) {
        const data = await response.json().catch(() => ({}))
        const detail = data?.detail || 'No se pudo eliminar la casa comercial.'
        throw new Error(detail)
      }

      onDeleted?.(casaComercialId)
      setShowDeleteDialog(false)
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al eliminar la casa comercial.')
    } finally {
      setDeleteLoading(false)
    }
  }

  const handleCancelEdit = () => {
    setFormData(originalData)
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

  const selectedCountry = countries.find((country) => String(country.id) === String(formData.paisId))
  const selectedFlagUrl = getFlagUrl(selectedCountry?.codigo_pais)

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

  const editorDisabled = saving || loadingData || !isEditing

  return (
    <div className={`create-user__overlay${isClosing ? ' create-user__overlay--closing' : ''}`} role="dialog" aria-modal="true" style={overlayStyle}>
      <div
        className={`create-user__modal${submitAttempted && isEditing ? ' create-user__modal--submitted' : ''}${isClosing ? ' create-user__modal--closing' : ''}`}
        ref={modalRef}
        style={modalStyle}
      >
        <header className="create-user__header" onMouseDown={handleMouseDown}>
          <div className="create-user__header-text">
            <h3>
              {formData.codigo && formData.nombre
                ? `${formData.codigo}: ${formData.nombre}`
                : (formData.codigo || formData.nombre || (casaComercialId ? `Casa comercial #${casaComercialId}` : 'Casa comercial'))}
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
          <div className="create-user__tabs" role="tablist" aria-label="Secciones de la casa comercial">
            <button
              type="button"
              className="create-user__tab create-user__tab--active"
              disabled
            >
              General
            </button>
          </div>

          <div className="create-user__body">
            <section className="create-user__section">
              <div className="create-user__section-header">
                <div>
                  <p className="create-user__eyebrow">Datos de la casa comercial</p>
                  <h4>Informacion basica</h4>
                </div>
              </div>

              <div className="create-user__grid create-user__grid--two">
                <label className="create-user__field create-user__field--required">
                  <span>Código</span>
                  <input
                    name="codigo"
                    type="text"
                    value={formData.codigo}
                    onChange={handleChange}
                    autoComplete="off"
                    required
                    maxLength={50}
                    disabled={editorDisabled}
                  />
                </label>

                <label className="create-user__field create-user__field--required">
                  <span>Descripción</span>
                  <input
                    name="nombre"
                    type="text"
                    value={formData.nombre}
                    onChange={handleChange}
                    required
                    disabled={editorDisabled}
                  />
                </label>

                <label className="create-user__field">
                  <span>País</span>
                  <div className="create-user__select-with-flag">
                    <div className="create-user__dropdown" ref={countryDropdownRef}>
                      <button
                        type="button"
                        className="create-user__dropdown-trigger"
                        onClick={() => setShowCountryDropdown((prev) => !prev)}
                        disabled={editorDisabled}
                      >
                        <span>{selectedCountry?.nombre || 'Selecciona un pais'}</span>
                        <i className={`pi pi-chevron-${showCountryDropdown ? 'up' : 'down'}`} />
                      </button>

                      {showCountryDropdown && (
                        <div className="create-user__dropdown-panel">
                          <div className="create-user__dropdown-search">
                            <i className="pi pi-search" />
                            <input
                              type="text"
                              placeholder="Buscar pais"
                              value={countryQuery}
                              onChange={handleCountrySearchChange}
                              disabled={editorDisabled}
                              autoFocus
                            />
                          </div>

                          <div className="create-user__dropdown-results">
                            {countryLoading && <small className="muted">Buscando paises...</small>}
                            {!countryLoading && !countryQuery.trim() && (
                              <small className="muted">Mostrando 5 paises.</small>
                            )}
                            {!countryLoading && countryQuery.trim() && !countryOptions.length && (
                              <small className="muted">Sin resultados.</small>
                            )}
                            {countryOptions.map((country) => (
                              <button
                                key={country.id}
                                type="button"
                                className="create-user__result-option"
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => handleCountrySelect(country)}
                              >
                                <div className="create-user__result-info">
                                  <strong>{country.nombre}</strong>
                                  <small>{country.codigo_pais || `ID: ${country.id}`}</small>
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                    <span className={`create-user__flag${selectedFlagUrl ? '' : ' is-empty'}`} aria-hidden="true">
                      {selectedFlagUrl ? <img src={selectedFlagUrl} alt="" /> : '□'}
                    </span>
                  </div>
                </label>

                <label className="create-user__field">
                  <span>Tipo</span>
                  <select
                    name="tipo"
                    value={formData.tipo}
                    onChange={handleChange}
                    disabled={editorDisabled}
                  >
                    <option value="local">Local</option>
                    <option value="importacion">Importación</option>
                  </select>
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
                  <span>Días aproximados de entrega</span>
                  <input
                    name="dias_entrega"
                    type="number"
                    min="0"
                    step="1"
                    value={formData.dias_entrega}
                    onChange={handleChange}
                    disabled={editorDisabled}
                  />
                </label>

                <label className="create-user__field create-user__field--full">
                  <span>Nota</span>
                  <input
                    name="descripcion"
                    type="text"
                    value={formData.descripcion}
                    onChange={handleChange}
                    disabled={editorDisabled}
                  />
                </label>
              </div>
            </section>
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
            {isEditing && allowDelete && (
              <button
                type="button"
                className="create-user__action user-details__delete"
                onClick={() => setShowDeleteDialog(true)}
                disabled={saving}
              >
                Eliminar
              </button>
            )}
            {isEditing && (
              <button
                type="button"
                className="create-user__action create-user__action--primary"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? 'Guardando...' : 'Guardar cambios'}
              </button>
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
              <h4>Eliminar casa comercial</h4>
              <p>¿Deseas eliminar esta casa comercial? Esta acción no se puede deshacer.</p>
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

export default CasaComercialDetails



