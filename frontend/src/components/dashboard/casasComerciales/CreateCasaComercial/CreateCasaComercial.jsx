import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import '../../admin/CreateUsuario/CreateUsuario.css'
import { API_URL, authFetch } from '../../../../utils/api'
import useModalAnimation from '../../common/useModalAnimation'
import useUnsavedChangesGuard from '../../common/unsavedChanges/useUnsavedChangesGuard'

const MIN_WIDTH = 720
const MIN_HEIGHT = 520
const VIEWPORT_PADDING = 12

const initialForm = {
  nombre: '',
  codigo: '',
  tipo: 'local',
  descripcion: '',
  paisId: '',
  telefono: '',
  correo: '',
  dias_entrega: '',
  esOriginal: false,
}

const CODIGO_LOCAL = 'CL'
const CODIGO_LOCAL_ORIGINAL = 'CLO'

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

const VOWELS = new Set(['A', 'E', 'I', 'O', 'U'])
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
const normalizeCodeLetters = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
const uniqueInOrder = (items) => {
  const seen = new Set()
  const uniqueItems = []
  for (const item of items) {
    if (seen.has(item)) continue
    seen.add(item)
    uniqueItems.push(item)
  }
  return uniqueItems
}
const generateCasaCode = (name, existingCodes = []) => {
  const letters = normalizeCodeLetters(name).split('')
  const consonants = letters.filter((char) => !VOWELS.has(char))
  const vowels = letters.filter((char) => VOWELS.has(char))
  const blocked = new Set(
    (Array.isArray(existingCodes) ? existingCodes : [])
      .map((code) => String(code || '').trim().toUpperCase())
      .filter(Boolean)
  )

  const baseChars = consonants.slice(0, 3)
  let vowelIndex = 0
  while (baseChars.length < 3 && vowelIndex < vowels.length) {
    baseChars.push(vowels[vowelIndex])
    vowelIndex += 1
  }
  while (baseChars.length < 3) {
    baseChars.push(ALPHABET[Math.floor(Math.random() * ALPHABET.length)])
  }

  const base = baseChars.join('')
  if (!base) return ''
  if (!blocked.has(base)) return base

  const pool = uniqueInOrder([...vowels, ...consonants, ...ALPHABET])
  for (const third of pool) {
    const candidate = `${base.slice(0, 2)}${third}`
    if (!blocked.has(candidate)) return candidate
  }
  for (const second of pool) {
    for (const third of pool) {
      const candidate = `${base.slice(0, 1)}${second}${third}`
      if (!blocked.has(candidate)) return candidate
    }
  }
  for (let i = 0; i < 200; i += 1) {
    const candidate = Array.from(
      { length: 3 },
      () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
    ).join('')
    if (!blocked.has(candidate)) return candidate
  }

  return base
}

function CreateCasaComercial({ open, onClose, onCreated, token, onError }) {
  const [formData, setFormData] = useState(initialForm)
  const [codigoTouched, setCodigoTouched] = useState(false)
  const [loading, setLoading] = useState(false)
  const [countries, setCountries] = useState([])
  const [existingCodes, setExistingCodes] = useState([])
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

  const fetchExistingCodes = useCallback(async () => {
    try {
      let url = `${API_URL}/casa-comercial/casas/?page_size=200`
      const codes = []

      while (url) {
        const response = await authFetch(url, {}, token)
        if (!response.ok) throw new Error('No se pudieron cargar los codigos de casas comerciales.')
        const data = await response.json()
        const list = Array.isArray(data)
          ? data
          : (Array.isArray(data?.results) ? data.results : [])
        list.forEach((item) => {
          const code = String(item?.codigo || '').trim().toUpperCase()
          if (code) codes.push(code)
        })
        url = Array.isArray(data) ? null : (data?.next || null)
      }

      setExistingCodes(uniqueInOrder(codes))
    } catch (err) {
      notifyError(err.message || 'Ocurrio un error al cargar codigos de casas comerciales.')
    }
  }, [notifyError, token])

  useEffect(() => {
    if (!open) return
    setFormData(initialForm)
    setCodigoTouched(false)
    setLoading(false)
    setExistingCodes([])
    setCountryQuery('')
    setCountryOptions([])
    setShowCountryDropdown(false)
    setCountryLoading(false)
    setIsMaximized(false)
    restoreRef.current = null
    fetchCountries()
    fetchExistingCodes()
  }, [open, fetchCountries, fetchExistingCodes])

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

  useEffect(() => {
    if (!open) return
    if (formData.tipo === 'local') {
      const forcedCode = formData.esOriginal ? CODIGO_LOCAL_ORIGINAL : CODIGO_LOCAL
      setFormData((prev) => (prev.codigo === forcedCode ? prev : { ...prev, codigo: forcedCode }))
      return
    }
    if (codigoTouched) return
    setFormData((prev) => {
      const nombre = String(prev.nombre || '').trim()
      if (!nombre) {
        if (!prev.codigo) return prev
        return { ...prev, codigo: '' }
      }
      const autoCode = generateCasaCode(nombre, existingCodes)
      if (autoCode === prev.codigo) return prev
      return { ...prev, codigo: autoCode }
    })
  }, [open, existingCodes, formData.tipo, formData.esOriginal, formData.nombre, codigoTouched])

  const codigoSuggestion = formData.tipo === 'importacion'
    ? generateCasaCode(formData.nombre, existingCodes)
    : ''

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
    const { name, value, type, checked } = event.target
    if (name === 'codigo') {
      setCodigoTouched(true)
      setFormData((prev) => ({ ...prev, codigo: value.toUpperCase() }))
      return
    }
    if (name === 'tipo' && value === 'local') {
      setCodigoTouched(false)
    }
    setFormData((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
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

    const isLocal = formData.tipo === 'local'
    const codigo = isLocal
      ? (formData.esOriginal ? CODIGO_LOCAL_ORIGINAL : CODIGO_LOCAL)
      : String(formData.codigo || '').trim().toUpperCase()

    const payload = {
      nombre: formData.nombre.trim(),
      codigo,
      tipo: formData.tipo,
      descripcion: formData.descripcion.trim(),
      telefono: formData.telefono.trim(),
      correo: formData.correo.trim(),
      pais_id: formData.paisId ? Number(formData.paisId) : null,
      dias_entrega: formData.dias_entrega !== '' ? Number(formData.dias_entrega) : null,
      es_original: Boolean(formData.esOriginal),
    }

    if (!payload.nombre) {
      notifyError('Define un nombre para la casa comercial.')
      return
    }

    if (!isLocal) {
      if (!payload.codigo) {
        notifyError('Escribe un código para la casa comercial.')
        return
      }
      if (existingCodes.includes(payload.codigo)) {
        notifyError('Ya existe una casa comercial con este código.')
        return
      }
    }

    setLoading(true)

    try {
      const response = await authFetch(
        `${API_URL}/casa-comercial/casas/`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
        token
      )

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = data?.detail || data?.nombre?.[0] || data?.codigo?.[0] || 'No se pudo crear la casa comercial.'
        throw new Error(detail)
      }

      setFormData(initialForm)
      setCodigoTouched(false)
      setCountryQuery('')
      setCountryOptions([])
      setShowCountryDropdown(false)
      setCountryLoading(false)
      setExistingCodes((prev) => {
        const createdCode = String(data?.codigo || '').trim().toUpperCase()
        if (!createdCode || prev.includes(createdCode)) return prev
        return [...prev, createdCode]
      })
      onCreated?.(data)
      submitSucceededRef.current = true
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al crear la casa comercial.')
    } finally {
      setLoading(false)
    }
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

  // "¿Guardar cambios?" al cerrar con datos ingresados (tambien al cerrar la
  // pestana). Guardar = el mismo boton de crear.
  const submitSucceededRef = useRef(false)
  const unsavedGuard = useUnsavedChangesGuard({
    watch: { formData },
    enabled: Boolean(open),
    onSave: async () => {
      submitSucceededRef.current = false
      await handleSubmit({ preventDefault() {} })
      return submitSucceededRef.current
    },
    onClose,
    label: 'Nuevo proveedor',
  })

  if (!shouldRender) return null

  const overlayStyle = { padding: `${VIEWPORT_PADDING}px` }
  const modalStyle = {
    top: position.y,
    left: position.x,
    width: size.width,
    height: size.height,
    maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
    maxHeight: `calc(100dvh - ${VIEWPORT_PADDING * 2}px)`,
  }

  return (
    <div className={`create-user__overlay${isClosing ? ' create-user__overlay--closing' : ''}`} role="dialog" aria-modal="true" style={overlayStyle}>
      {unsavedGuard.dialog}
      <div className={`create-user__modal${isClosing ? ' create-user__modal--closing' : ''}`} ref={modalRef} {...unsavedGuard.interactionProps} style={modalStyle}>
        <header className="create-user__header" onMouseDown={handleMouseDown}>
          <div className="create-user__header-text">
            <h3>
              {formData.codigo && formData.nombre
                ? `${formData.codigo}: ${formData.nombre}`
                : (formData.codigo || formData.nombre || 'Crear casa comercial')}
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
              onClick={unsavedGuard.requestClose}
              aria-label="Cerrar"
            >
              <i className="pi pi-times" aria-hidden="true" />
            </button>
          </div>
        </header>

        <form className="create-user__form create-user__form--create" noValidate onSubmitCapture={(event) => event.currentTarget.classList.add('create-user__form--submitted')} onSubmit={handleSubmit}>
          <div className="create-user__tabs" role="tablist" aria-label="Secciones de la casa comercial">
            <button type="button" className="create-user__tab create-user__tab--active" disabled>
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
                <label className="create-user__field">
                  <span>Código</span>
                  {formData.tipo === 'local' ? (
                    <input
                      name="codigo"
                      type="text"
                      value={formData.codigo}
                      readOnly
                      disabled
                      autoComplete="off"
                      required
                    />
                  ) : (
                    <>
                      <input
                        name="codigo"
                        type="text"
                        placeholder="Ej: ABC"
                        value={formData.codigo}
                        onChange={handleChange}
                        autoComplete="off"
                        required
                        disabled={loading}
                      />
                      {codigoSuggestion && (
                        <small className="muted">Sugerencia: {codigoSuggestion}</small>
                      )}
                    </>
                  )}
                </label>

                <label className="create-user__field">
                  <span>Descripción</span>
                  <input
                    name="nombre"
                    type="text"
                    placeholder="Descripción de la casa comercial"
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
                  <span>Tipo</span>
                  <select
                    name="tipo"
                    value={formData.tipo}
                    onChange={handleChange}
                    disabled={loading}
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

                <label className="create-user__field">
                  <span>Días aproximados de entrega</span>
                  <input
                    name="dias_entrega"
                    type="number"
                    min="0"
                    step="1"
                    value={formData.dias_entrega}
                    onChange={handleChange}
                    disabled={loading}
                  />
                </label>

                <label className="create-user__checkbox">
                  <input
                    type="checkbox"
                    name="esOriginal"
                    checked={Boolean(formData.esOriginal)}
                    onChange={handleChange}
                    disabled={loading}
                  />
                  <div>
                    <span>Original</span>
                    <p>Marca si esta casa comercial provee repuestos originales.</p>
                  </div>
                </label>

                <label className="create-user__field create-user__field--full">
                  <span>Nota</span>
                  <input
                    name="descripcion"
                    type="text"
                    placeholder="Nota"
                    value={formData.descripcion}
                    onChange={handleChange}
                    disabled={loading}
                  />
                </label>
              </div>
            </section>
          </div>

          <div className="create-user__footer">
            <button type="button" className="create-user__action create-user__action--cancel" onClick={unsavedGuard.requestClose}>
              Cancelar
            </button>
            <button type="submit" className="create-user__action create-user__action--primary" disabled={loading}>
              {loading ? 'Guardando...' : 'Crear casa comercial'}
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

export default CreateCasaComercial





