import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import '../../admin/CreateUsuario/CreateUsuario.css'
import { API_URL, authFetch } from '../../../../utils/api'
import BodegaLayoutEditor from '../BodegaLayoutEditor/BodegaLayoutEditor'
import useModalAnimation from '../../common/useModalAnimation'
import useUnsavedChangesGuard from '../../common/unsavedChanges/useUnsavedChangesGuard'

const MIN_WIDTH = 720
const MIN_HEIGHT = 540
const VIEWPORT_PADDING = 12

const initialForm = {
  nombre: '',
  sucursalId: '',
  ancho_metros: '',
  alto_metros: '',
  ubicaciones: [],
}

function CreateBodega({ open, onClose, onCreated, token, onError }) {
  const [formData, setFormData] = useState(initialForm)
  const [loading, setLoading] = useState(false)
  const [branches, setBranches] = useState([])
  const [creatingSubdivisions, setCreatingSubdivisions] = useState(false)
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

  useEffect(() => {
    if (!open) return
    setFormData(initialForm)
    setLoading(false)
    setIsMaximized(false)
    restoreRef.current = null
  }, [open])

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

  const fetchBranches = useCallback(async () => {
    try {
      const response = await authFetch(`${API_URL}/inventario/sucursales/?modulo=sucursales_bodegas`, {}, token)
      if (!response.ok) throw new Error('No se pudieron cargar las sucursales.')
      const data = await response.json()
      const list = Array.isArray(data) ? data : data?.results || []
      setBranches(list)
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al cargar las sucursales.')
    }
  }, [notifyError, token])

  useEffect(() => {
    if (!open) return
    fetchBranches()
  }, [fetchBranches, open])

  const handleChange = (event) => {
    const { name, value } = event.target
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }))
  }

  const handleLayoutChange = (locations) => {
    setFormData((prev) => ({
      ...prev,
      ubicaciones: locations,
    }))
  }

  const updateLocationMeta = (id, updates) => {
    setFormData((prev) => ({
      ...prev,
      ubicaciones: prev.ubicaciones.map((location) => {
        if (location.id !== id) return location
        return { ...location, ...updates }
      }),
    }))
  }

  const parseMeasure = (value) => {
    const numeric = Number(value)
    return Number.isFinite(numeric) ? Number(numeric.toFixed(1)) : 0
  }

  const normalizeKey = (value) => String(value ?? '').trim().toLowerCase()

  const sanitizeLocations = (locations) =>
    locations.map((location) => {
      const sanitized = { ...location }
      delete sanitized.subdivision_draft
      delete sanitized.subdivisions_list
      return sanitized
    })

  const fetchAll = async (url) => {
    let next = url
    const all = []

    while (next) {
      const response = await authFetch(next, {}, token)
      if (!response.ok) throw new Error('No se pudieron cargar los datos.')
      const data = await response.json()
      if (Array.isArray(data)) {
        all.push(...data)
        next = null
      } else {
        const list = data?.results || []
        all.push(...list)
        next = data?.next || null
      }
    }

    return all
  }

  const createDivisionsAndSubdivisions = async (bodegaId, locations) => {
    const aggregated = new Map()

    locations.forEach((location) => {
      const name = String(location?.nombre ?? '').trim()
      if (!name) return
      const key = normalizeKey(name)
      if (!aggregated.has(key)) {
        aggregated.set(key, {
          name,
          typeName: String(location?.tipo ?? '').trim(),
          subdivisions: new Set(),
        })
      }

      const entry = aggregated.get(key)
      if (!entry.typeName && location?.tipo) entry.typeName = String(location.tipo).trim()

      const names = Array.isArray(location?.subdivisions_list) ? location.subdivisions_list : []
      names.forEach((subName) => {
        const trimmed = String(subName ?? '').trim()
        if (trimmed) entry.subdivisions.add(trimmed)
      })
    })

    if (!aggregated.size) return

    const tipos = await fetchAll(`${API_URL}/tipos/tipos-division/`)
    const tipoMap = new Map(
      tipos
        .map((tipo) => ({
          key: normalizeKey(tipo?.nombre),
          id: tipo?.id,
        }))
        .filter((item) => item.key && item.id != null)
        .map((item) => [item.key, item.id])
    )

    const getOrCreateTipoId = async (typeName) => {
      const tipoKey = normalizeKey(typeName)
      if (!tipoKey) throw new Error('Define un tipo de división.')
      if (tipoMap.has(tipoKey)) return tipoMap.get(tipoKey)

      const createResponse = await authFetch(
        `${API_URL}/tipos/tipos-division/`,
        {
          method: 'POST',
          body: JSON.stringify({ nombre: typeName, descripcion: '' }),
        },
        token
      )

      const createData = await createResponse.json().catch(() => ({}))
      if (createResponse.ok && createData?.id != null) {
        tipoMap.set(tipoKey, createData.id)
        return createData.id
      }

      const refreshed = await fetchAll(`${API_URL}/tipos/tipos-division/`)
      refreshed.forEach((tipo) => {
        const key = normalizeKey(tipo?.nombre)
        if (key && tipo?.id != null && !tipoMap.has(key)) tipoMap.set(key, tipo.id)
      })
      if (tipoMap.has(tipoKey)) return tipoMap.get(tipoKey)

      const detail =
        createData?.detail || createData?.nombre?.[0] || 'No se pudo crear el tipo de división.'
      throw new Error(detail)
    }

    for (const entry of aggregated.values()) {
      const tipoId = await getOrCreateTipoId(entry.typeName)

      const divisionResponse = await authFetch(
        `${API_URL}/inventario/divisiones/`,
        {
          method: 'POST',
          body: JSON.stringify({
            nombre: entry.name,
            bodega_id: Number(bodegaId),
            tipo_division_id: tipoId,
          }),
        },
        token
      )

      const divisionData = await divisionResponse.json().catch(() => ({}))
      if (!divisionResponse.ok) {
        const detail =
          divisionData?.detail ||
          divisionData?.nombre?.[0] ||
          divisionData?.non_field_errors?.[0] ||
          'No se pudo crear la división.'
        throw new Error(detail)
      }

      const divisionId = divisionData?.id
      if (!divisionId || !entry.subdivisions.size) continue

      for (const subName of entry.subdivisions) {
        const subResponse = await authFetch(
          `${API_URL}/inventario/subdivisiones/`,
          {
            method: 'POST',
            body: JSON.stringify({
              nombre: subName,
              division_id: Number(divisionId),
            }),
          },
          token
        )

        const subData = await subResponse.json().catch(() => ({}))
        if (!subResponse.ok) {
          const detail =
            subData?.detail || subData?.nombre?.[0] || 'No se pudo crear la subdivisión.'
          throw new Error(detail)
        }
      }
    }
  }

  const addSubdivisionToLocation = (location) => {
    const draft = String(location?.subdivision_draft ?? '').trim()
    if (!draft) return

    const current = Array.isArray(location?.subdivisions_list) ? location.subdivisions_list : []
    const exists = current.some((name) => normalizeKey(name) === normalizeKey(draft))
    if (exists) {
      notifyError('Esa subdivisión ya está en la lista.')
      return
    }

    updateLocationMeta(location.id, {
      subdivisions_list: [...current, draft],
      subdivision_draft: '',
    })
  }

  const handleSubdivisionDraftChange = (locationId, value) => {
    updateLocationMeta(locationId, { subdivision_draft: value })
  }

  const removeSubdivisionFromLocation = (locationId, name) => {
    const current = Array.isArray(formData.ubicaciones) ? formData.ubicaciones : []
    const target = current.find((loc) => loc.id === locationId)
    if (!target) return
    const list = Array.isArray(target.subdivisions_list) ? target.subdivisions_list : []
    const filtered = list.filter((item) => normalizeKey(item) !== normalizeKey(name))
    updateLocationMeta(locationId, { subdivisions_list: filtered })
  }

  const renderLocationSubdivisions = (location) => {
    const names = Array.isArray(location?.subdivisions_list) ? location.subdivisions_list : []
    return (
      <div className="bodega-layout__subdivisions">
        <div className="bodega-layout__subdivisions-header">
          <strong>Subdivisiones</strong>
          <span>{names.length} pendientes</span>
        </div>
        {names.length > 0 ? (
          <div className="bodega-layout__subdivision-list">
            {names.map((name) => (
              <span key={name} className="bodega-layout__subdivision-chip">
                {name}
                <button
                  type="button"
                  className="bodega-layout__subdivision-remove"
                  onClick={() => removeSubdivisionFromLocation(location.id, name)}
                  disabled={loading || creatingSubdivisions}
                  aria-label={`Eliminar ${name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="bodega-layout__hint">Aún no hay subdivisiones.</p>
        )}
        <div className="bodega-layout__subdivision-form">
          <label className="create-user__field">
            <span>Agregar subdivisión</span>
            <input
              type="text"
              value={location?.subdivision_draft ?? ''}
              onChange={(event) => handleSubdivisionDraftChange(location.id, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addSubdivisionToLocation(location)
                }
              }}
              placeholder="Ej: Lado A"
              disabled={loading || creatingSubdivisions}
            />
          </label>
          <div className="create-user__field">
            <button
              type="button"
              className="create-user__action create-user__action--primary"
              onClick={() => addSubdivisionToLocation(location)}
              disabled={loading || creatingSubdivisions}
            >
              Agregar
            </button>
          </div>
        </div>
      </div>
    )
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setLoading(true)

    const payload = {
      nombre: formData.nombre.trim(),
      sucursal_id: formData.sucursalId ? Number(formData.sucursalId) : null,
      ancho_metros: parseMeasure(formData.ancho_metros),
      alto_metros: parseMeasure(formData.alto_metros),
      ubicaciones: sanitizeLocations(formData.ubicaciones),
    }

    if (!payload.nombre) {
      setLoading(false)
      notifyError('Define un nombre para la bodega.')
      return
    }

    if (!payload.sucursal_id) {
      setLoading(false)
      notifyError('Selecciona una sucursal para la bodega.')
      return
    }

    try {
      const response = await authFetch(
        `${API_URL}/inventario/bodegas/`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
        token
      )

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = data?.detail || data?.nombre?.[0] || 'No se pudo crear la bodega.'
        throw new Error(detail)
      }

      try {
        setCreatingSubdivisions(true)
        await createDivisionsAndSubdivisions(data.id, formData.ubicaciones)
      } catch (err) {
        notifyError(err.message || 'Ocurrió un error al crear divisiones o subdivisiones.')
      } finally {
        setCreatingSubdivisions(false)
      }

      setFormData(initialForm)
      onCreated?.(data)
      submitSucceededRef.current = true
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al crear la bodega.')
    } finally {
      setLoading(false)
    }
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
    label: 'Nueva bodega',
  })

  if (!shouldRender) return null

  const overlayStyle = { padding: `${VIEWPORT_PADDING}px` }
  const modalStyle = {
    top: position.y,
    left: position.x,
    width: size.width,
    height: size.height,
    maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)` ,
    maxHeight: `calc(100vh - ${VIEWPORT_PADDING * 2}px)` ,
  }

  return (
    <div className={`create-user__overlay${isClosing ? ' create-user__overlay--closing' : ''}`} role="dialog" aria-modal="true" style={overlayStyle}>
      {unsavedGuard.dialog}
      <div className={`create-user__modal${isClosing ? ' create-user__modal--closing' : ''}`} ref={modalRef} {...unsavedGuard.interactionProps} style={modalStyle}>
        <header className="create-user__header" onMouseDown={handleMouseDown}>
          <div className="create-user__header-text">
            <h3>Crear bodega</h3>
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
          <div className="create-user__tabs" role="tablist" aria-label="Secciones de la bodega">
            <button type="button" className="create-user__tab create-user__tab--active" disabled>
              General
            </button>
          </div>

          <div className="create-user__body">
            <section className="create-user__section">
              <div className="create-user__section-header">
                <div>
                  <p className="create-user__eyebrow">Datos de la bodega</p>
                  <h4>Información básica</h4>
                </div>
              </div>

              <div className="create-user__grid create-user__grid--two">
                <label className="create-user__field">
                  <span>Descripción</span>
                  <input
                    name="nombre"
                    type="text"
                    placeholder="Descripción de la bodega"
                    value={formData.nombre}
                    onChange={handleChange}
                    required
                    disabled={loading}
                  />
                </label>

                <label className="create-user__field">
                  <span>Sucursal</span>
                  <select
                    name="sucursalId"
                    value={formData.sucursalId}
                    onChange={handleChange}
                    disabled={loading}
                    required
                  >
                    <option value="" />
                    {branches.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.nombre}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="create-user__field">
                  <span>Ancho (m)</span>
                  <input
                    name="ancho_metros"
                    type="number"
                    min="0"
                    step="0.1"
                    value={formData.ancho_metros}
                    onChange={handleChange}
                    disabled={loading}
                  />
                </label>

                <label className="create-user__field">
                  <span>Alto (m)</span>
                  <input
                    name="alto_metros"
                    type="number"
                    min="0"
                    step="0.1"
                    value={formData.alto_metros}
                    onChange={handleChange}
                    disabled={loading}
                  />
                </label>
              </div>

              <div className="create-user__section-header">
                <div>
                  <p className="create-user__eyebrow">Plano interno</p>
                  <h4>Ubicaciones de la bodega</h4>
                </div>
              </div>

              <BodegaLayoutEditor
                widthMeters={Number(formData.ancho_metros) || 0}
                heightMeters={Number(formData.alto_metros) || 0}
                locations={formData.ubicaciones}
                onChange={handleLayoutChange}
                disabled={loading}
                renderLocationFooter={renderLocationSubdivisions}
              />
            </section>
          </div>

          <div className="create-user__footer">
            <button type="button" className="create-user__action create-user__action--cancel" onClick={unsavedGuard.requestClose}>
              Cancelar
            </button>
            <button type="submit" className="create-user__action create-user__action--primary" disabled={loading}>
              {loading ? 'Guardando...' : 'Crear bodega'}
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

export default CreateBodega




