import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import '../../admin/CreateUsuario/CreateUsuario.css'
import { API_URL, authFetch } from '../../../../utils/api'
import useModalAnimation from '../../common/useModalAnimation'

const MIN_WIDTH = 720
const MIN_HEIGHT = 520
const VIEWPORT_PADDING = 12

const initialForm = {
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
  marca: '',
  color: '',
}

function CreateCliente({ open, onClose, onCreated, token, onError }) {
  const [formData, setFormData] = useState(initialForm)
  const [autos, setAutos] = useState([])
  const [loading, setLoading] = useState(false)
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
    setAutos([])
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

  const handleChange = (event) => {
    const { name, value } = event.target
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }))
  }

  const handleAutoChange = (index, field, value) => {
    setAutos((prev) =>
      prev.map((auto, i) => (i === index ? { ...auto, [field]: value } : auto))
    )
  }

  const canAddAuto = useCallback(() => {
    if (!autos.length) return true
    const last = autos[autos.length - 1]
    return Boolean(last.placa && last.modelo && last.anio)
  }, [autos])

  const addAutoRow = () => {
    if (!canAddAuto()) {
      notifyError('Completa el auto actual antes de agregar otro.')
      return
    }
    setAutos((prev) => [...prev, { ...emptyAuto }])
  }

  const removeAutoRow = (index) => {
    setAutos((prev) => prev.filter((_, i) => i !== index))
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setLoading(true)

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
        marca: auto.marca.trim(),
        color: auto.color.trim(),
      }))
      .filter((auto) => auto.placa || auto.modelo || auto.anio || auto.marca || auto.color)

    if (autosPayload.length) {
      const validAutos = autosPayload.filter(
        (auto) => auto.placa && auto.modelo && Number.isFinite(auto.anio)
      )
      if (validAutos.length !== autosPayload.length) {
        setLoading(false)
        notifyError('Completa placa, modelo y año para cada auto agregado.')
        return
      }
      payload.autos = validAutos
    }

    if (!payload.nombres) {
      setLoading(false)
      notifyError('Define los nombres del cliente.')
      return
    }

    if (!payload.cedula_ruc) {
      setLoading(false)
      notifyError('Define la cedula/RUC del cliente.')
      return
    }

    try {
      const response = await authFetch(
        `${API_URL}/solicitudes/clientes/`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
        token
      )

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = data?.detail || data?.nombre?.[0] || 'No se pudo crear el cliente.'
        throw new Error(detail)
      }

      setFormData(initialForm)
      onCreated?.(data)
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al crear el cliente.')
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
              {formData.nombres || formData.apellidos
                ? `Crear cliente: ${formData.nombres} ${formData.apellidos}`.trim()
                : 'Crear cliente'}
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

        <form className="create-user__form create-user__form--create" noValidate onSubmitCapture={(event) => event.currentTarget.classList.add('create-user__form--submitted')} onSubmit={handleSubmit}>
          <div className="create-user__tabs" role="tablist" aria-label="Secciones del cliente">
            <button type="button" className="create-user__tab create-user__tab--active" disabled>
              General
            </button>
          </div>

          <div className="create-user__body">
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
                    placeholder="Nombres del cliente"
                    value={formData.nombres}
                    onChange={handleChange}
                    required
                    disabled={loading}
                  />
                </label>

                <label className="create-user__field">
                  <span>Apellidos</span>
                  <input
                    name="apellidos"
                    type="text"
                    placeholder="Apellidos del cliente"
                    value={formData.apellidos}
                    onChange={handleChange}
                    required
                    disabled={loading}
                  />
                </label>

                <label className="create-user__field">
                  <span>Cedula/RUC</span>
                  <input
                    name="cedula_ruc"
                    type="text"
                    placeholder="Cedula o RUC"
                    value={formData.cedula_ruc}
                    onChange={handleChange}
                    required
                    disabled={loading}
                  />
                </label>

                <label className="create-user__field">
                  <span>Correo</span>
                  <input
                    name="correo"
                    type="email"
                    placeholder="cliente@correo.com"
                    value={formData.correo}
                    onChange={handleChange}
                    disabled={loading}
                  />
                </label>

                <label className="create-user__field">
                  <span>Teléfono</span>
                  <input
                    name="telefono"
                    type="text"
                    placeholder="0991234567"
                    value={formData.telefono}
                    onChange={handleChange}
                    disabled={loading}
                  />
                </label>

                <label className="create-user__field create-user__field--full">
                  <span>Dirección</span>
                  <input
                    name="direccion"
                    type="text"
                    placeholder="Dirección"
                    value={formData.direccion}
                    onChange={handleChange}
                    disabled={loading}
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
                          disabled={loading}
                        />
                      </label>

                      <label className="create-user__field">
                        <span>Modelo</span>
                        <input
                          type="text"
                          value={auto.modelo}
                          onChange={(event) => handleAutoChange(index, 'modelo', event.target.value)}
                          disabled={loading}
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
                          disabled={loading}
                        />
                      </label>

                      <label className="create-user__field">
                        <span>Marca</span>
                        <input
                          type="text"
                          value={auto.marca}
                          onChange={(event) => handleAutoChange(index, 'marca', event.target.value)}
                          disabled={loading}
                        />
                      </label>

                      <label className="create-user__field">
                        <span>Color</span>
                        <input
                          type="text"
                          value={auto.color}
                          onChange={(event) => handleAutoChange(index, 'color', event.target.value)}
                          disabled={loading}
                        />
                      </label>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                      <button
                        type="button"
                        className="create-user__action create-user__action--cancel"
                        onClick={() => removeAutoRow(index)}
                        disabled={loading}
                      >
                        Quitar auto
                      </button>
                    </div>
                  </div>

                ))}
              </div>

              <div style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="create-user__action create-user__action--secondary"
                  onClick={addAutoRow}
                  disabled={loading || !canAddAuto()}
                >
                  Agregar auto
                </button>
              </div>
            </section>
          </div>

          <div className="create-user__footer">
            <button type="button" className="create-user__action create-user__action--cancel" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="create-user__action create-user__action--primary" disabled={loading}>
              {loading ? 'Guardando...' : 'Crear cliente'}
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

export default CreateCliente




