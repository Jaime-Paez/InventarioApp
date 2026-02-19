import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import '../admin/CreateUsuario/CreateUsuario.css'
import { API_URL, authFetch } from '../../../utils/api'

const initialForm = {
  sucursalId: '',
  subTipoId: '',
  estadoId: '',
  fecha: '',
  no_documento: '',
  descripcion: '',
  funcional: true,
  sucursalObjetivoId: '',
  descuento: '',
  iva_rate: '',
}

const initialDetail = {
  productoId: '',
  estadoProductoId: '',
  cantidad: '',
  valor: '',
  valor_total: '',
}

const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const normalizeValue = (value) => String(value ?? '').trim().toLowerCase()
const parseNumber = (value) => {
  const cleaned = String(value ?? '').trim()
  if (!cleaned) return null
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}
const parseIntValue = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return Math.max(0, Math.floor(parsed))
}
const todayISO = () => new Date().toISOString().slice(0, 10)

function CreateSalida({ open, onClose, onCreated, token, onError }) {
  const [formData, setFormData] = useState(initialForm)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [branches, setBranches] = useState([])
  const [tipoMovimientos, setTipoMovimientos] = useState([])
  const [subTipos, setSubTipos] = useState([])
  const [estados, setEstados] = useState([])
  const [tiposPago, setTiposPago] = useState([])
  const [productos, setProductos] = useState([])
  const [estadosProducto, setEstadosProducto] = useState([])

  const [details, setDetails] = useState([])
  const [detailDraft, setDetailDraft] = useState(initialDetail)
  const [detailError, setDetailError] = useState('')
  const [pagosSelected, setPagosSelected] = useState([])
  const [modalPosition, setModalPosition] = useState({ x: 0, y: 0 })
  const modalRef = useRef(null)
  const modalDrag = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const MODAL_PADDING = 12
  const MODAL_WIDTH = 1100
  const MODAL_HEIGHT = 820

  const notifyError = useCallback(
    (message) => {
      if (!message) return
      if (onError) {
        onError(message)
        return
      }
      setError(message)
    },
    [onError]
  )

  const salidaTipoId = useMemo(() => {
    const salida = tipoMovimientos.find((tipo) => normalizeValue(tipo?.nombre).startsWith('sal'))
    return salida?.id ?? ''
  }, [tipoMovimientos])

  const subTiposSalida = useMemo(
    () =>
      subTipos.filter(
        (sub) => String(sub?.tipo_movimiento?.id || '') === String(salidaTipoId)
      ),
    [subTipos, salidaTipoId]
  )

  const selectedSubTipo = useMemo(
    () => subTiposSalida.find((sub) => String(sub.id) === String(formData.subTipoId)),
    [subTiposSalida, formData.subTipoId]
  )

  const requiresSucursalObjetivo = normalizeValue(selectedSubTipo?.nombre).includes('trasl')

  useEffect(() => {
    if (!requiresSucursalObjetivo && formData.sucursalObjetivoId) {
      setFormData((prev) => ({ ...prev, sucursalObjetivoId: '' }))
    }
  }, [requiresSucursalObjetivo, formData.sucursalObjetivoId])

  const fetchCatalogs = useCallback(async () => {
    if (!token) return
    try {
      const [
        branchesRes,
        tiposRes,
        subTiposRes,
        estadosRes,
        pagosRes,
        productosRes,
        estadosProductoRes,
      ] = await Promise.all([
        authFetch(`${API_URL}/inventario/sucursales/`, {}, token),
        authFetch(`${API_URL}/tipos/tipos-movimiento/`, {}, token),
        authFetch(`${API_URL}/tipos/subtipos-movimiento/`, {}, token),
        authFetch(`${API_URL}/tipos/estados-movimiento/`, {}, token),
        authFetch(`${API_URL}/tipos/tipos-pago/`, {}, token),
        authFetch(`${API_URL}/productos/listado/`, {}, token),
        authFetch(`${API_URL}/tipos/estados-producto/`, {}, token),
      ])

      if (!branchesRes.ok) throw new Error('No se pudieron cargar las sucursales.')
      if (!tiposRes.ok) throw new Error('No se pudieron cargar los tipos de movimiento.')
      if (!subTiposRes.ok) throw new Error('No se pudieron cargar los subtipos de movimiento.')
      if (!estadosRes.ok) throw new Error('No se pudieron cargar los estados de movimiento.')
      if (!pagosRes.ok) throw new Error('No se pudieron cargar los tipos de pago.')
      if (!productosRes.ok) throw new Error('No se pudieron cargar los productos.')
      if (!estadosProductoRes.ok) throw new Error('No se pudieron cargar los estados de producto.')

      const [
        branchesData,
        tiposData,
        subTiposData,
        estadosData,
        pagosData,
        productosData,
        estadosProductoData,
      ] = await Promise.all([
        branchesRes.json(),
        tiposRes.json(),
        subTiposRes.json(),
        estadosRes.json(),
        pagosRes.json(),
        productosRes.json(),
        estadosProductoRes.json(),
      ])

      setBranches(parseApiList(branchesData))
      setTipoMovimientos(parseApiList(tiposData))
      setSubTipos(parseApiList(subTiposData))
      setEstados(parseApiList(estadosData))
      setTiposPago(parseApiList(pagosData))
      setProductos(parseApiList(productosData))
      setEstadosProducto(parseApiList(estadosProductoData))
    } catch (err) {
      notifyError(err?.message || 'Ocurrio un error al cargar los catalogos.')
    }
  }, [notifyError, token])

  useEffect(() => {
    if (!open) return
    setFormData({ ...initialForm, fecha: todayISO() })
    setDetails([])
    setDetailDraft(initialDetail)
    setDetailError('')
    setPagosSelected([])
    setError('')
    fetchCatalogs()
  }, [open, fetchCatalogs])

  useLayoutEffect(() => {
    if (!open) return
    const width = Math.min(MODAL_WIDTH, Math.max(0, window.innerWidth - MODAL_PADDING * 2))
    const height = Math.min(MODAL_HEIGHT, Math.max(0, window.innerHeight - MODAL_PADDING * 2))
    setModalPosition({
      x: Math.max((window.innerWidth - width) / 2, MODAL_PADDING),
      y: Math.max((window.innerHeight - height) / 2, MODAL_PADDING),
    })
  }, [open])

  const handleModalMouseDown = (event) => {
    if (!modalRef.current) return
    const target = event?.target
    if (target?.closest?.('.create-user__icon-button')) return
    const rect = modalRef.current.getBoundingClientRect()
    modalDrag.current = {
      active: true,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    }
  }

  useEffect(() => {
    if (!open) return undefined
    const handleMouseMove = (event) => {
      if (!modalDrag.current.active) return
      event.preventDefault()
      const width = modalRef.current?.offsetWidth || MODAL_WIDTH
      const height = modalRef.current?.offsetHeight || MODAL_HEIGHT
      const maxX = Math.max(window.innerWidth - width - MODAL_PADDING, MODAL_PADDING)
      const maxY = Math.max(window.innerHeight - height - MODAL_PADDING, MODAL_PADDING)
      const x = event.clientX - modalDrag.current.offsetX
      const y = event.clientY - modalDrag.current.offsetY
      setModalPosition({
        x: Math.min(Math.max(x, MODAL_PADDING), maxX),
        y: Math.min(Math.max(y, MODAL_PADDING), maxY),
      })
    }

    const handleMouseUp = () => {
      modalDrag.current.active = false
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [open])

  const handleChange = (event) => {
    const { name, value, type, checked } = event.target
    setFormData((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }))
  }

  const handleDetailChange = (event) => {
    const { name, value } = event.target
    setDetailDraft((prev) => ({
      ...prev,
      [name]: value,
    }))
  }

  const handleAddDetail = () => {
    setDetailError('')
    const productoId = String(detailDraft.productoId || '').trim()
    const estadoProductoId = String(detailDraft.estadoProductoId || '').trim()
    const cantidad = parseIntValue(detailDraft.cantidad)
    const valor = parseNumber(detailDraft.valor)

    if (!productoId) {
      setDetailError('Selecciona un producto.')
      return
    }
    if (!estadoProductoId) {
      setDetailError('Selecciona un estado del producto.')
      return
    }
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      setDetailError('Ingresa una cantidad valida.')
      return
    }
    if (!Number.isFinite(valor) || valor < 0) {
      setDetailError('Ingresa un valor valido.')
      return
    }

    const valorTotalDraft = parseNumber(detailDraft.valor_total)
    const valor_total = Number.isFinite(valorTotalDraft) ? valorTotalDraft : cantidad * valor
    const producto = productos.find((item) => String(item.id) === productoId)
    const estadoProducto = estadosProducto.find((item) => String(item.id) === estadoProductoId)

    setDetails((prev) => [
      ...prev,
      {
        uid: `det-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        productoId,
        productoCodigo: producto?.codigo ?? '',
        productoNombre: producto?.nombre ?? '',
        estadoProductoId,
        estadoProductoNombre: estadoProducto?.nombre ?? '',
        cantidad,
        valor,
        valor_total,
      },
    ])

    setDetailDraft(initialDetail)
  }

  const handleRemoveDetail = (uid) => {
    setDetails((prev) => prev.filter((detail) => detail.uid !== uid))
  }

  const togglePago = (id) => {
    const key = String(id)
    setPagosSelected((prev) => {
      const exists = prev.includes(key)
      if (exists) return prev.filter((item) => item !== key)
      return [...prev, key]
    })
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setError('')

    if (!salidaTipoId) {
      notifyError('No se encontro el tipo de movimiento de salida.')
      return
    }

    if (!formData.sucursalId) {
      notifyError('Selecciona la sucursal de origen.')
      return
    }

    if (!formData.subTipoId) {
      notifyError('Selecciona el subtipo de salida.')
      return
    }

    if (requiresSucursalObjetivo && !formData.sucursalObjetivoId) {
      notifyError('Selecciona la sucursal de destino.')
      return
    }

    if (!formData.estadoId) {
      notifyError('Selecciona el estado del movimiento.')
      return
    }

    if (!formData.fecha) {
      notifyError('Ingresa la fecha del movimiento.')
      return
    }

    if (!String(formData.no_documento || '').trim()) {
      notifyError('Ingresa el numero de documento.')
      return
    }

    if (!details.length) {
      notifyError('Agrega al menos un producto.')
      return
    }

    const descuento = parseNumber(formData.descuento) ?? 0
    const ivaRate = parseNumber(formData.iva_rate)

    const payload = {
      sucursal_id: Number(formData.sucursalId),
      tipo_movimiento_id: Number(salidaTipoId),
      sub_tipo_movimiento_id: formData.subTipoId ? Number(formData.subTipoId) : null,
      descripcion: formData.descripcion?.trim() || '',
      funcional: Boolean(formData.funcional),
      sucursal_objetivo_id: formData.sucursalObjetivoId ? Number(formData.sucursalObjetivoId) : null,
      estado_movimiento_id: Number(formData.estadoId),
      descuento,
      fecha: formData.fecha,
      no_documento: formData.no_documento.trim(),
      detalles: details.map((detail) => ({
        producto_id: Number(detail.productoId),
        cantidad: detail.cantidad,
        estado_producto_id: Number(detail.estadoProductoId),
        valor: detail.valor,
        valor_total: detail.valor_total,
      })),
      pagos: pagosSelected.map((id) => ({ tipo_pago_id: Number(id) })),
    }

    if (ivaRate !== null) {
      payload.iva_rate = ivaRate
    }

    setLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/movimientos/movimiento_inventario/`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
        token
      )

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = data?.detail || 'No se pudo crear la salida.'
        throw new Error(detail)
      }

      onCreated?.(data)
    } catch (err) {
      notifyError(err.message || 'Ocurrio un error al crear la salida.')
    } finally {
      setLoading(false)
    }
  }

  if (!open) return null

  return (
    <div className="create-user__overlay" role="dialog" aria-modal="true">
      <div
        ref={modalRef}
        className="create-user__modal"
        style={{
          top: modalPosition.y,
          left: modalPosition.x,
          maxWidth: `calc(100vw - ${MODAL_PADDING * 2}px)`,
          maxHeight: `calc(100vh - ${MODAL_PADDING * 2}px)`,
        }}
      >
        <header className="create-user__header" onMouseDown={handleModalMouseDown}>
          <div className="create-user__header-text">
            <h3>Nueva salida</h3>
          </div>
          <div className="create-user__header-actions">
            <button type="button" className="create-user__icon-button" onClick={onClose} aria-label="Cerrar">
              x
            </button>
          </div>
        </header>

        <form className="create-user__form" onSubmit={handleSubmit}>
          <div className="create-user__content">
            <div className="create-user__body">
              <section className="create-user__section">
                <div className="create-user__section-header">
                  <div>
                    <p className="create-user__eyebrow">Datos</p>
                    <h4>Informacion general</h4>
                  </div>
                </div>

                <div className="create-user__grid create-user__grid--two">
                  <label className="create-user__field">
                    <span>Sucursal origen</span>
                    <select name="sucursalId" value={formData.sucursalId} onChange={handleChange} disabled={loading}>
                      <option value="">Selecciona una sucursal</option>
                      {branches.map((branch) => (
                        <option key={branch.id} value={branch.id}>
                          {branch.nombre || `Sucursal ${branch.id}`}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="create-user__field">
                    <span>Subtipo de salida</span>
                    <select name="subTipoId" value={formData.subTipoId} onChange={handleChange} disabled={loading}>
                      <option value="">Selecciona un subtipo</option>
                      {subTiposSalida.map((subTipo) => (
                        <option key={subTipo.id} value={subTipo.id}>
                          {subTipo.nombre}
                        </option>
                      ))}
                    </select>
                  </label>

                  {requiresSucursalObjetivo && (
                    <label className="create-user__field">
                      <span>Sucursal destino</span>
                      <select name="sucursalObjetivoId" value={formData.sucursalObjetivoId} onChange={handleChange} disabled={loading}>
                        <option value="">Selecciona una sucursal</option>
                        {branches.map((branch) => (
                          <option key={branch.id} value={branch.id}>
                            {branch.nombre || `Sucursal ${branch.id}`}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  <label className="create-user__field">
                    <span>Estado del movimiento</span>
                    <select name="estadoId" value={formData.estadoId} onChange={handleChange} disabled={loading}>
                      <option value="">Selecciona un estado</option>
                      {estados.map((estado) => (
                        <option key={estado.id} value={estado.id}>
                          {estado.nombre}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="create-user__field">
                    <span>Fecha</span>
                    <input name="fecha" type="date" value={formData.fecha} onChange={handleChange} disabled={loading} />
                  </label>

                  <label className="create-user__field">
                    <span>No. documento</span>
                    <input name="no_documento" type="text" value={formData.no_documento} onChange={handleChange} disabled={loading} />
                  </label>

                  <label className="create-user__field">
                    <span>Descuento</span>
                    <input name="descuento" type="number" step="0.01" value={formData.descuento} onChange={handleChange} disabled={loading} />
                  </label>

                  <label className="create-user__field">
                    <span>IVA</span>
                    <input name="iva_rate" type="number" step="0.0001" value={formData.iva_rate} onChange={handleChange} disabled={loading} />
                  </label>

                  <label className="create-user__field">
                    <span>Funcional</span>
                    <select name="funcional" value={formData.funcional ? 'true' : 'false'} onChange={(event) => setFormData((prev) => ({ ...prev, funcional: event.target.value === 'true' }))} disabled={loading}>
                      <option value="true">Si</option>
                      <option value="false">No</option>
                    </select>
                  </label>

                  <label className="create-user__field create-user__field--full">
                    <span>Descripcion</span>
                    <input name="descripcion" type="text" value={formData.descripcion} onChange={handleChange} disabled={loading} />
                  </label>
                </div>
              </section>

              <section className="create-user__section">
                <div className="create-user__section-header">
                  <div>
                    <p className="create-user__eyebrow">Detalle</p>
                    <h4>Productos</h4>
                  </div>
                </div>

                <div className="create-user__locations-table">
                  <div className="create-user__locations-row create-user__locations-row--head">
                    <span>Producto</span>
                    <span>Estado</span>
                    <span>Cantidad</span>
                    <span>Valor</span>
                    <span>Total</span>
                    <span>Acciones</span>
                  </div>

                  <div className="create-user__locations-row create-user__locations-row--form">
                    <span>
                      <select name="productoId" value={detailDraft.productoId} onChange={handleDetailChange} disabled={loading}>
                        <option value="">Selecciona un producto</option>
                        {productos.map((producto) => (
                          <option key={producto.id} value={producto.id}>
                            {producto.nombre} ({producto.codigo})
                          </option>
                        ))}
                      </select>
                    </span>
                    <span>
                      <select name="estadoProductoId" value={detailDraft.estadoProductoId} onChange={handleDetailChange} disabled={loading}>
                        <option value="">Selecciona estado</option>
                        {estadosProducto.map((estado) => (
                          <option key={estado.id} value={estado.id}>
                            {estado.nombre}
                          </option>
                        ))}
                      </select>
                    </span>
                    <span>
                      <input name="cantidad" type="number" min="1" step="1" value={detailDraft.cantidad} onChange={handleDetailChange} disabled={loading} />
                    </span>
                    <span>
                      <input name="valor" type="number" step="0.01" value={detailDraft.valor} onChange={handleDetailChange} disabled={loading} />
                    </span>
                    <span>
                      <input name="valor_total" type="number" step="0.01" value={detailDraft.valor_total} onChange={handleDetailChange} disabled={loading} />
                    </span>
                    <span className="create-user__locations-cell create-user__locations-cell--action">
                      <button type="button" className="create-user__ghost" onClick={handleAddDetail} disabled={loading}>
                        Agregar
                      </button>
                    </span>
                  </div>

                  {!details.length && (
                    <div className="create-user__locations-row create-user__locations-row--empty">
                      <span>Sin productos agregados.</span>
                    </div>
                  )}

                  {details.map((detail) => (
                    <div key={detail.uid} className="create-user__locations-row">
                      <span>{detail.productoNombre || detail.productoCodigo || '-'}</span>
                      <span>{detail.estadoProductoNombre || '-'}</span>
                      <span>{detail.cantidad}</span>
                      <span>{detail.valor}</span>
                      <span>{detail.valor_total}</span>
                      <span className="create-user__locations-cell create-user__locations-cell--action">
                        <button type="button" className="create-user__locations-remove" onClick={() => handleRemoveDetail(detail.uid)} disabled={loading}>
                          x
                        </button>
                      </span>
                    </div>
                  ))}
                </div>

                {detailError && <div className="create-user__error">{detailError}</div>}
              </section>

              <section className="create-user__section">
                <div className="create-user__section-header">
                  <div>
                    <p className="create-user__eyebrow">Pagos</p>
                    <h4>Tipos de pago</h4>
                  </div>
                </div>

                <div className="create-user__grid create-user__grid--two">
                  {tiposPago.map((pago) => {
                    const id = String(pago.id)
                    const checked = pagosSelected.includes(id)
                    return (
                      <label key={id} className="create-user__field">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => togglePago(id)}
                          disabled={loading}
                        />
                        <span>{pago.nombre}</span>
                      </label>
                    )
                  })}
                </div>
              </section>
            </div>
          </div>

          {error && <div className="create-user__error">{error}</div>}

          <div className="create-user__footer">
            <button type="button" className="create-user__action create-user__action--cancel" onClick={onClose} disabled={loading}>
              Cancelar
            </button>
            <button type="submit" className="create-user__action create-user__action--primary" disabled={loading}>
              {loading ? 'Guardando...' : 'Crear salida'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default CreateSalida
