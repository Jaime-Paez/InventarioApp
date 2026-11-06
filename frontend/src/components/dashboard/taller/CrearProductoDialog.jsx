import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { API_URL, authFetch } from '../../../utils/api'
import { getAppPortalRoot } from '../../../utils/portalRoot'
import BlockerNotice from '../common/BlockerNotice'
import CreateProducto from '../productos/CreateProducto/CreateProducto'
import TallerDialog from './TallerDialog'
import { formatMoney, parseApiError } from './tallerConstants'

// Repuesto que llego sin codigo nuestro: el administrador elige el proveedor,
// ve el codigo sugerido (como en Importaciones) y abre el formulario de
// producto ya lleno. Lo guarda alla, y la linea queda vinculada al producto.
// Si el OEM ya es de un producto nuestro, puede usar ese directamente.
function CrearProductoDialog({ open, orden, linea, token, user, onClose, onDone, notify }) {
  const [casas, setCasas] = useState([])
  const [casaId, setCasaId] = useState('')
  const [sugerencia, setSugerencia] = useState(null)
  const [codigo, setCodigo] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)

  useEffect(() => {
    if (!open) return undefined
    setCasaId('')
    setSugerencia(null)
    setCodigo('')
    setError('')
    setShowForm(false)
    let cancelled = false
    ;(async () => {
      try {
        const response = await authFetch(`${API_URL}/casa-comercial/casas/?page_size=500&ordering=nombre`, {}, token)
        if (!response.ok) throw new Error(await parseApiError(response, 'No se pudieron cargar los proveedores.'))
        const data = await response.json()
        if (!cancelled) setCasas(Array.isArray(data) ? data : data?.results || [])
      } catch (err) {
        if (!cancelled) setError(err.message)
      }
    })()
    return () => { cancelled = true }
  }, [open, token])

  useEffect(() => {
    if (!open || !linea) return undefined
    const referencia = String(linea.referencia || linea.descripcion || '').trim()
    if (!referencia) return undefined
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const params = new URLSearchParams({ referencia })
        if (casaId) params.set('casa', casaId)
        const response = await authFetch(`${API_URL}/taller/ordenes/sugerir-codigo/?${params}`, {}, token)
        if (!response.ok) throw new Error(await parseApiError(response, 'No se pudo sugerir el código.'))
        const data = await response.json()
        if (cancelled) return
        setSugerencia(data)
        setCodigo(data?.codigo_sugerido || '')
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [open, linea, casaId, token])

  const vincular = async (productoId, codigoProducto) => {
    setBusy(true)
    setError('')
    try {
      const response = await authFetch(
        `${API_URL}/taller/ordenes/${orden.id}/lineas/${linea.id}/vincular-producto/`,
        { method: 'POST', body: JSON.stringify({ producto: productoId }) },
        token
      )
      if (!response.ok) throw new Error(await parseApiError(response, 'No se pudo vincular el producto.'))
      const data = await response.json()
      notify?.({ severity: 'success', detail: `La línea ahora es ${codigoProducto}. Ya se puede despachar cuando haya stock.` })
      onDone?.(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const casa = casas.find((item) => String(item.id) === String(casaId))
  const existente = sugerencia?.existente
  const initialData = linea
    ? {
      codigo,
      nombre: linea.descripcion || linea.referencia || '',
      descripcion: linea.descripcion || '',
      oemItems: linea.referencia ? [linea.referencia] : [],
      casas: casa ? [casa] : [],
      precio: linea.precio,
    }
    : null

  return (
    <>
      <TallerDialog
        open={open && !showForm}
        busy={busy}
        title="Crear el repuesto en el inventario"
        subtitle={linea ? `${linea.referencia || 'Sin OEM'} · ${linea.descripcion || ''} · ${formatMoney(linea.precio)}` : ''}
        onClose={onClose}
        footer={
          <>
            {!casaId && <span className="taller-muted taller-dialog__why">Elige el proveedor para sugerir el código.</span>}
            <button type="button" className="create-user__action create-user__action--cancel" onClick={onClose} disabled={busy}>
              Cancelar
            </button>
            <button
              type="button"
              className="create-user__action create-user__action--primary"
              onClick={() => setShowForm(true)}
              disabled={busy || !casaId}
            >
              Continuar al formulario del producto
            </button>
          </>
        }
      >
        <label className="create-user__field">
          <span>Proveedor (casa comercial)</span>
          <select className="taller-input" value={casaId} onChange={(event) => setCasaId(event.target.value)}>
            <option value="">Elige el proveedor...</option>
            {casas.map((item) => (
              <option key={item.id} value={item.id}>{`${item.nombre}${item.codigo ? ` (${item.codigo})` : ''}`}</option>
            ))}
          </select>
        </label>

        {loading && <span className="taller-muted"><i className="pi pi-spin pi-spinner" /> Buscando el OEM en el catálogo...</span>}

        {existente && (
          <BlockerNotice
            title={`Ese OEM ya es nuestro: ${existente.codigo}`}
            reason={`${existente.nombre} ya está en el inventario con este proveedor. No hace falta crearlo.`}
            actionLabel={`Usar ${existente.codigo}`}
            onAction={() => vincular(existente.id, existente.codigo)}
          />
        )}

        {casaId && !existente && (
          <label className="create-user__field">
            <span>Código nuestro</span>
            <input className="taller-input taller-upper" value={codigo} onChange={(event) => setCodigo(event.target.value.toUpperCase())} placeholder="Escribe el código" />
            {sugerencia?.codigo_sugerido ? (
              <small className="taller-muted">
                {`Sugerido desde ${sugerencia.fuente?.codigo} (${(sugerencia.fuente?.casas || []).join(', ') || 'otra casa'})${sugerencia.fuente?.precio ? `, PVP ${formatMoney(sugerencia.fuente.precio)}` : ''}.`}
              </small>
            ) : (
              <small className="taller-muted">No hay un producto con ese OEM en otra casa: escribe el código.</small>
            )}
          </label>
        )}

        {Boolean(sugerencia?.coincidencias?.length) && (
          <div className="create-user__field">
            <span>Productos parecidos en el catálogo</span>
            <div className="taller-ubicaciones">
              {sugerencia.coincidencias.map((producto) => (
                <div key={producto.id} className="taller-ubicacion">
                  <span className="taller-ubicacion__name"><strong>{producto.codigo}</strong> {producto.nombre}</span>
                  <span className="taller-muted">{producto.casas.join(', ')}</span>
                  <button type="button" className="taller-link" onClick={() => vincular(producto.id, producto.codigo)} disabled={busy}>
                    Es este
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        {error && <BlockerNotice title="Algo falló" reason={error} />}
      </TallerDialog>

      {open && showForm && createPortal(
        <CreateProducto
          open={showForm}
          onClose={() => setShowForm(false)}
          onCreated={async (producto) => {
            setShowForm(false)
            if (producto?.id) await vincular(producto.id, producto.codigo)
          }}
          token={token}
          onError={(detail) => setError(typeof detail === 'string' ? detail : 'No se pudo crear el producto.')}
          currentUser={user}
          showCostField
          initialData={initialData}
          stacked
        />,
        getAppPortalRoot()
      )}
    </>
  )
}

export default CrearProductoDialog
