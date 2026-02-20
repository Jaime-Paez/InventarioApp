import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Eye, Pencil } from 'lucide-react'
import '../admin/CreateUsuario/CreateUsuario.css'
import '../admin/UsersDetails/UsersDetails.css'
import { API_URL, authFetch } from '../../../utils/api'

const emptyForm = {
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

const parseProductCode = (label) => {
  if (!label) return null
  const match = /\(([^)]+)\)\s*$/.exec(String(label))
  return match ? match[1].trim() : null
}

const parseSubTipoLabel = (label) => {
  const text = String(label ?? '')
  if (!text) return ''
  const parts = text.split('-')
  return parts.length > 1 ? parts[parts.length - 1].trim() : text.trim()
}

const findByName = (list, name) =>
  list.find((item) => normalizeValue(item?.nombre) === normalizeValue(name))

function SalidaDetails({ open, salidaId, token, onClose, onUpdated, onDeleted, onError }) {
  const [formData, setFormData] = useState(emptyForm)
  const [originalData, setOriginalData] = useState(null)
  const [details, setDetails] = useState([])
  const [detailDraft, setDetailDraft] = useState(initialDetail)
  const [detailError, setDetailError] = useState('')
  const [pagosSelected, setPagosSelected] = useState([])
  const [loadingData, setLoadingData] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [error, setError] = useState('')

  const [branches, setBranches] = useState([])
  const [tipoMovimientos, setTipoMovimientos] = useState([])
  const [subTipos, setSubTipos] = useState([])
  const [estados, setEstados] = useState([])
  const [tiposPago, setTiposPago] = useState([])
  const [productos, setProductos] = useState([])
  const [estadosProducto, setEstadosProducto] = useState([])
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

  const salidaTipoId = tipoMovimientos.find((tipo) => normalizeValue(tipo?.nombre).startsWith('sal'))?.id ?? ''
  const subTiposSalida = subTipos.filter(
    (sub) => String(sub?.tipo_movimiento?.id || '') === String(salidaTipoId)
  )
  const selectedSubTipo = subTiposSalida.find((sub) => String(sub.id) === String(formData.subTipoId))
  const requiresSucursalObjetivo = normalizeValue(selectedSubTipo?.nombre).includes('trasl')

  useEffect(() => {
    if (!requiresSucursalObjetivo && formData.sucursalObjetivoId) {
      setFormData((prev) => ({ ...prev, sucursalObjetivoId: '' }))
    }
  }, [requiresSucursalObjetivo, formData.sucursalObjetivoId])

  const buildFormData = (salida, catalogs) => {
    const {
      branchesList,
      subTiposList,
      estadosList,
      pagosList,
      productosList,
      estadosProductoList,
    } = catalogs

    const sucursalId = findByName(branchesList, salida?.sucursal)?.id ?? ''
    const sucursalObjetivoId = findByName(branchesList, salida?.sucursal_objetivo)?.id ?? ''
    const subTipoName = parseSubTipoLabel(salida?.sub_tipo_movimiento)
    const subTipoId = subTiposList.find((sub) => normalizeValue(sub?.nombre) === normalizeValue(subTipoName))?.id ?? ''
    const estadoId = findByName(estadosList, salida?.estado_movimiento)?.id ?? ''

    const detalles = (Array.isArray(salida?.detalles) ? salida.detalles : []).map((detalle) => {
      const code = parseProductCode(detalle?.producto)
      const product = productosList.find((item) => item.codigo === code) ||
        productosList.find((item) => normalizeValue(item.nombre) === normalizeValue(detalle?.producto))
      const estadoProducto = findByName(estadosProductoList, detalle?.estado_producto)
      return {
        uid: `det-${Math.random().toString(36).slice(2, 8)}`,
        productoId: product?.id ? String(product.id) : '',
        productoCodigo: product?.codigo ?? '',
        productoNombre: product?.nombre ?? detalle?.producto ?? '',
        estadoProductoId: estadoProducto?.id ? String(estadoProducto.id) : '',
        estadoProductoNombre: estadoProducto?.nombre ?? detalle?.estado_producto ?? '',
        cantidad: detalle?.cantidad ?? '',
        valor: detalle?.valor ?? '',
        valor_total: detalle?.valor_total ?? '',
      }
    })

    const pagos = (Array.isArray(salida?.pagos) ? salida.pagos : [])
      .map((pago) => findByName(pagosList, pago?.tipo_pago)?.id)
      .filter(Boolean)
      .map((id) => String(id))

    return {
      form: {
        sucursalId: sucursalId ? String(sucursalId) : '',
        subTipoId: subTipoId ? String(subTipoId) : '',
        estadoId: estadoId ? String(estadoId) : '',
        fecha: salida?.fecha ?? '',
        no_documento: salida?.no_documento ?? '',
        descripcion: salida?.descripcion ?? '',
        funcional: Boolean(salida?.funcional),
        sucursalObjetivoId: sucursalObjetivoId ? String(sucursalObjetivoId) : '',
        descuento: salida?.descuento ?? '',
        iva_rate: salida?.iva_rate ?? '',
      },
      detalles,
      pagos,
    }
  }

  const loadData = useCallback(async () => {
    if (!token || !salidaId) return
    setLoadingData(true)
    setError('')
    try {
      const [
        branchesRes,
        tiposRes,
        subTiposRes,
        estadosRes,
        pagosRes,
        productosRes,
        estadosProductoRes,
        salidaRes,
      ] = await Promise.all([
        authFetch(`${API_URL}/inventario/sucursales/?modulo=movimientos_salidas`, {}, token),
        authFetch(`${API_URL}/tipos/tipos-movimiento/`, {}, token),
        authFetch(`${API_URL}/tipos/subtipos-movimiento/`, {}, token),
        authFetch(`${API_URL}/tipos/estados-movimiento/`, {}, token),
        authFetch(`${API_URL}/tipos/tipos-pago/`, {}, token),
        authFetch(`${API_URL}/productos/listado/`, {}, token),
        authFetch(`${API_URL}/tipos/estados-producto/`, {}, token),
        authFetch(`${API_URL}/movimientos/movimiento_inventario/${salidaId}/`, {}, token),
      ])

      if (!branchesRes.ok) throw new Error('No se pudieron cargar las sucursales.')
      if (!tiposRes.ok) throw new Error('No se pudieron cargar los tipos de movimiento.')
      if (!subTiposRes.ok) throw new Error('No se pudieron cargar los subtipos de movimiento.')
      if (!estadosRes.ok) throw new Error('No se pudieron cargar los estados de movimiento.')
      if (!pagosRes.ok) throw new Error('No se pudieron cargar los tipos de pago.')
      if (!productosRes.ok) throw new Error('No se pudieron cargar los productos.')
      if (!estadosProductoRes.ok) throw new Error('No se pudieron cargar los estados de producto.')
      if (!salidaRes.ok) throw new Error('No se pudo cargar la salida.')

      const [
        branchesData,
        tiposData,
        subTiposData,
        estadosData,
        pagosData,
        productosData,
        estadosProductoData,
        salidaData,
      ] = await Promise.all([
        branchesRes.json(),
        tiposRes.json(),
        subTiposRes.json(),
        estadosRes.json(),
        pagosRes.json(),
        productosRes.json(),
        estadosProductoRes.json(),
        salidaRes.json(),
      ])

      const branchesList = parseApiList(branchesData)
      const tiposList = parseApiList(tiposData)
      const subTiposList = parseApiList(subTiposData)
      const estadosList = parseApiList(estadosData)
      const pagosList = parseApiList(pagosData)
      const productosList = parseApiList(productosData)
      const estadosProductoList = parseApiList(estadosProductoData)

      setBranches(branchesList)
      setTipoMovimientos(tiposList)
      setSubTipos(subTiposList)
      setEstados(estadosList)
      setTiposPago(pagosList)
      setProductos(productosList)
      setEstadosProducto(estadosProductoList)

      const normalized = buildFormData(salidaData, {
        branchesList,
        subTiposList,
        estadosList,
        pagosList,
        productosList,
        estadosProductoList,
      })

      setFormData(normalized.form)
      setDetails(normalized.detalles)
      setPagosSelected(normalized.pagos)
      setOriginalData(normalized)
      setIsEditing(false)
    } catch (err) {
      notifyError(err?.message || 'Ocurrio un error al cargar la salida.')
    } finally {
      setLoadingData(false)
    }
  }, [notifyError, salidaId, token])

  useEffect(() => {
    if (!open) return
    setFormData(emptyForm)
    setDetails([])
    setDetailDraft(initialDetail)
    setPagosSelected([])
    setOriginalData(null)
    setIsEditing(false)
    setError('')
    loadData()
  }, [open, loadData])

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
    if (!isEditing) return
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
    if (!isEditing) return
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
    if (!isEditing) return
    setDetails((prev) => prev.filter((detail) => detail.uid !== uid))
  }

  const togglePago = (id) => {
    if (!isEditing) return
    const key = String(id)
    setPagosSelected((prev) => {
      const exists = prev.includes(key)
      if (exists) return prev.filter((item) => item !== key)
      return [...prev, key]
    })
  }

  const handleCancelEdit = () => {
    if (!originalData) {
      setIsEditing(false)
      return
    }
    setFormData(originalData.form)
    setDetails(originalData.detalles)
    setPagosSelected(originalData.pagos)
    setIsEditing(false)
  }

  const handleSave = async () => {
    if (!isEditing || saving) return
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

    if (details.some((detail) => !detail.productoId || !detail.estadoProductoId)) {
      notifyError('Hay productos con datos incompletos.')
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

    setSaving(true)
    try {
      const response = await authFetch(
        `${API_URL}/movimientos/movimiento_inventario/${salidaId}/`,
        {
          method: 'PUT',
          body: JSON.stringify(payload),
        },
        token
      )

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = data?.detail || 'No se pudo actualizar la salida.'
        throw new Error(detail)
      }

      onUpdated?.(data)
      setIsEditing(false)
      setOriginalData({
        form: formData,
        detalles: details,
        pagos: pagosSelected,
      })
    } catch (err) {
      notifyError(err.message || 'Ocurrio un error al actualizar la salida.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!isEditing || deleteLoading) return
    setDeleteLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/movimientos/movimiento_inventario/${salidaId}/`,
        { method: 'DELETE' },
        token
      )

      if (!response.ok && response.status !== 204) {
        const data = await response.json().catch(() => ({}))
        const detail = data?.detail || 'No se pudo eliminar la salida.'
        throw new Error(detail)
      }

      onDeleted?.(salidaId)
    } catch (err) {
      notifyError(err?.message || 'Ocurrio un error al eliminar la salida.')
    } finally {
      setDeleteLoading(false)
    }
  }

  if (!open) return null

  const editorDisabled = !isEditing || saving || loadingData

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
            <h3>{salidaId ? `Salida #${salidaId}` : 'Salida'}</h3>
          </div>
          <div className="create-user__header-actions">
            <button type="button" className="create-user__icon-button" onClick={onClose} aria-label="Cerrar">
              x
            </button>
          </div>
        </header>

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
                  <select name="sucursalId" value={formData.sucursalId} onChange={handleChange} disabled={editorDisabled}>
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
                  <select name="subTipoId" value={formData.subTipoId} onChange={handleChange} disabled={editorDisabled}>
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
                    <select name="sucursalObjetivoId" value={formData.sucursalObjetivoId} onChange={handleChange} disabled={editorDisabled}>
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
                  <select name="estadoId" value={formData.estadoId} onChange={handleChange} disabled={editorDisabled}>
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
                  <input name="fecha" type="date" value={formData.fecha} onChange={handleChange} disabled={editorDisabled} />
                </label>

                <label className="create-user__field">
                  <span>No. documento</span>
                  <input name="no_documento" type="text" value={formData.no_documento} onChange={handleChange} disabled={editorDisabled} />
                </label>

                <label className="create-user__field">
                  <span>Descuento</span>
                  <input name="descuento" type="number" step="0.01" value={formData.descuento} onChange={handleChange} disabled={editorDisabled} />
                </label>

                <label className="create-user__field">
                  <span>IVA</span>
                  <input name="iva_rate" type="number" step="0.0001" value={formData.iva_rate} onChange={handleChange} disabled={editorDisabled} />
                </label>

                <label className="create-user__field">
                  <span>Funcional</span>
                  <select name="funcional" value={formData.funcional ? 'true' : 'false'} onChange={(event) => isEditing && setFormData((prev) => ({ ...prev, funcional: event.target.value === 'true' }))} disabled={editorDisabled}>
                    <option value="true">Si</option>
                    <option value="false">No</option>
                  </select>
                </label>

                <label className="create-user__field create-user__field--full">
                  <span>Descripcion</span>
                  <input name="descripcion" type="text" value={formData.descripcion} onChange={handleChange} disabled={editorDisabled} />
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

                {isEditing && (
                  <div className="create-user__locations-row create-user__locations-row--form">
                    <span>
                      <select name="productoId" value={detailDraft.productoId} onChange={handleDetailChange} disabled={editorDisabled}>
                        <option value="">Selecciona un producto</option>
                        {productos.map((producto) => (
                          <option key={producto.id} value={producto.id}>
                            {producto.nombre} ({producto.codigo})
                          </option>
                        ))}
                      </select>
                    </span>
                    <span>
                      <select name="estadoProductoId" value={detailDraft.estadoProductoId} onChange={handleDetailChange} disabled={editorDisabled}>
                        <option value="">Selecciona estado</option>
                        {estadosProducto.map((estado) => (
                          <option key={estado.id} value={estado.id}>
                            {estado.nombre}
                          </option>
                        ))}
                      </select>
                    </span>
                    <span>
                      <input name="cantidad" type="number" min="1" step="1" value={detailDraft.cantidad} onChange={handleDetailChange} disabled={editorDisabled} />
                    </span>
                    <span>
                      <input name="valor" type="number" step="0.01" value={detailDraft.valor} onChange={handleDetailChange} disabled={editorDisabled} />
                    </span>
                    <span>
                      <input name="valor_total" type="number" step="0.01" value={detailDraft.valor_total} onChange={handleDetailChange} disabled={editorDisabled} />
                    </span>
                    <span className="create-user__locations-cell create-user__locations-cell--action">
                      <button type="button" className="create-user__ghost" onClick={handleAddDetail} disabled={editorDisabled}>
                        Agregar
                      </button>
                    </span>
                  </div>
                )}

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
                      <button type="button" className="create-user__locations-remove" onClick={() => handleRemoveDetail(detail.uid)} disabled={!isEditing}>
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
                        disabled={!isEditing}
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
          <div className="user-details__footer-left">
            <button type="button" className="create-user__action create-user__action--cancel" onClick={isEditing ? handleCancelEdit : onClose} disabled={saving}>
              Cancelar
            </button>
            <button
              type="button"
              className={`create-user__action create-user__action--edit user-details__edit-toggle${isEditing ? ' user-details__edit-toggle--active' : ''}`}
              onClick={() => setIsEditing((prev) => !prev)}
              disabled={loadingData || saving}
            >
              <span className="user-details__toggle-icon">{isEditing ? <Eye size={14} /> : <Pencil size={14} />}</span>
              {isEditing ? 'Solo lectura' : 'Editar'}
            </button>
          </div>
          <div className="user-details__footer-right">
            {isEditing && (
              <>
                <button type="button" className="create-user__action user-details__delete" onClick={handleDelete} disabled={deleteLoading || saving}>
                  {deleteLoading ? 'Eliminando...' : 'Eliminar'}
                </button>
                <button type="button" className="create-user__action create-user__action--primary" onClick={handleSave} disabled={saving}>
                  {saving ? 'Guardando...' : 'Guardar cambios'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default SalidaDetails
