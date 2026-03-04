import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import '../../admin/CreateUsuario/CreateUsuario.css'
import { API_URL, authFetch } from '../../../../utils/api'
import useModalAnimation from '../../common/useModalAnimation'

const MIN_WIDTH = 720
const MIN_HEIGHT = 520
const VIEWPORT_PADDING = 12

const initialForm = {
  nombre: '',
  codigo: '',
  descripcion: '',
  paisId: '',
  telefono: '',
  correo: '',
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

function CreateMarca({ open, onClose, onCreated, token, onError }) {
  const [formData, setFormData] = useState(initialForm)
  const [loading, setLoading] = useState(false)
  const [countries, setCountries] = useState([])
  const [countryQuery, setCountryQuery] = useState('')
  const [countryOptions, setCountryOptions] = useState([])
  const [showCountryDropdown, setShowCountryDropdown] = useState(false)
  const [countryLoading, setCountryLoading] = useState(false)
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

  useEffect(() => {
    if (!open) return
    setFormData(initialForm)
    setLoading(false)
    setCountryQuery('')
    setCountryOptions([])
    setShowCountryDropdown(false)
    setCountryLoading(false)
    setIsMaximized(false)
    restoreRef.current = null
    fetchCountries()
  }, [open, fetchCountries])

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
    const { name, value } = event.target
    setFormData((prev) => ({
      ...prev,
      [name]: name === 'codigo' ? value.toUpperCase() : value,
    }))
  }

  const handleCountrySearchChange = (event) => {
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

  const handleSubmit = async (event) => {
    event.preventDefault()
    setLoading(true)

    const payload = {
      nombre: formData.nombre.trim(),
      codigo: formData.codigo.trim(),
      descripcion: formData.descripcion.trim(),
      telefono: formData.telefono.trim(),
      correo: formData.correo.trim(),
      pais_id: formData.paisId ? Number(formData.paisId) : null,
    }

    if (!payload.nombre) {
      setLoading(false)
      notifyError('Define un nombre para la marca.')
      return
    }

    if (!payload.codigo) {
      setLoading(false)
      notifyError('Define un codigo para la marca.')
      return
    }

    try {
      const response = await authFetch(
        `${API_URL}/marcas/listado/`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
        token
      )

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = data?.detail || data?.nombre?.[0] || data?.codigo?.[0] || 'No se pudo crear la marca.'
        throw new Error(detail)
      }

      setFormData(initialForm)
      setCountryQuery('')
      setCountryOptions([])
      setShowCountryDropdown(false)
      setCountryLoading(false)
      onCreated?.(data)
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al crear la marca.')
    } finally {
      setLoading(false)
    }
  }

  const selectedCountry = countries.find((country) => String(country.id) === String(formData.paisId))
  const selectedFlagUrl = getFlagUrl(selectedCountry?.codigo_pais)

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

  return (
    <div className={`create-user__overlay${isClosing ? ' create-user__overlay--closing' : ''}`} role="dialog" aria-modal="true" style={overlayStyle}>
      <div className={`create-user__modal${isClosing ? ' create-user__modal--closing' : ''}`} ref={modalRef} style={modalStyle}>
        <header className="create-user__header" onMouseDown={handleMouseDown}>
          <div className="create-user__header-text">
            <h3>
              {formData.codigo && formData.nombre
                ? `${formData.codigo}: ${formData.nombre}`
                : (formData.codigo || formData.nombre || 'Crear marca')}
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

        <form className="create-user__form create-user__form--create" onSubmit={handleSubmit}>
          <div className="create-user__tabs" role="tablist" aria-label="Secciones de la marca">
            <button type="button" className="create-user__tab create-user__tab--active" disabled>
              General
            </button>
          </div>

          <div className="create-user__body">
            <section className="create-user__section">
              <div className="create-user__section-header">
                <div>
                  <p className="create-user__eyebrow">Datos de la marca</p>
                  <h4>Informacion basica</h4>
                </div>
              </div>

              <div className="create-user__grid create-user__grid--two">
                <label className="create-user__field">
                  <span>Código</span>
                  <input
                    name="codigo"
                    type="text"
                    placeholder="Código"
                    value={formData.codigo}
                    onChange={handleChange}
                    required
                    disabled={loading}
                  />
                </label>

                <label className="create-user__field">
                  <span>Nombre</span>
                  <input
                    name="nombre"
                    type="text"
                    placeholder="Nombre de la marca"
                    value={formData.nombre}
                    onChange={handleChange}
                    required
                    disabled={loading}
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
                        disabled={loading}
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
                              disabled={loading}
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
                  <span>Teléfono</span>
                  <input
                    name="telefono"
                    type="text"
                    placeholder="Teléfono"
                    value={formData.telefono}
                    onChange={handleChange}
                    disabled={loading}
                  />
                </label>

                <label className="create-user__field">
                  <span>Correo</span>
                  <input
                    name="correo"
                    type="email"
                    placeholder="correo@empresa.com"
                    value={formData.correo}
                    onChange={handleChange}
                    disabled={loading}
                  />
                </label>

                <label className="create-user__field create-user__field--full">
                  <span>Descripción</span>
                  <input
                    name="descripcion"
                    type="text"
                    placeholder="Descripción"
                    value={formData.descripcion}
                    onChange={handleChange}
                    disabled={loading}
                  />
                </label>
              </div>
            </section>
          </div>

          <div className="create-user__footer">
            <button type="button" className="create-user__action create-user__action--cancel" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="create-user__action create-user__action--primary" disabled={loading}>
              {loading ? 'Guardando...' : 'Crear marca'}
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

export default CreateMarca



