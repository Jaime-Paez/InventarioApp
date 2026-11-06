import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import Toast from '../common/AppToast'
import MoneyInput from '../common/MoneyInput'
import BlockerNotice from '../common/BlockerNotice'
import '../admin/UsersTable/UsersTable.css'
import '../admin/CreateUsuario/CreateUsuario.css'
import './Taller.css'
import { API_URL, authFetch } from '../../../utils/api'
import { formatMoney, parseApiError } from './tallerConstants'

const toNumber = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

// Una fila del catalogo: nombre y precio se guardan al salir del campo.
function ManoObraRow({ item, canEdit, canDelete, onSave, onDelete }) {
  const [nombre, setNombre] = useState(item.nombre)
  const [precio, setPrecio] = useState(toNumber(item.precio))
  const precioRef = useRef(precio)

  useEffect(() => { setNombre(item.nombre) }, [item.nombre])
  useEffect(() => { setPrecio(toNumber(item.precio)); precioRef.current = toNumber(item.precio) }, [item.precio])

  const commitNombre = () => {
    const value = nombre.trim()
    if (!value) {
      setNombre(item.nombre)
      return
    }
    if (value !== item.nombre) onSave(item.id, { nombre: value }).catch(() => setNombre(item.nombre))
  }

  const commitPrecio = () => {
    const value = precioRef.current ?? 0
    if (Math.abs(value - toNumber(item.precio)) > 0.0001) {
      onSave(item.id, { precio: value.toFixed(2) }).catch(() => setPrecio(toNumber(item.precio)))
    }
  }

  const blurOnEnter = (event) => { if (event.key === 'Enter') event.currentTarget.blur() }

  return (
    <tr className={item.activo ? '' : 'is-inactive'}>
      <td>
        {canEdit ? (
          <input className="taller-input" value={nombre} onChange={(event) => setNombre(event.target.value)} onBlur={commitNombre} onKeyDown={blurOnEnter} />
        ) : item.nombre}
      </td>
      <td className="taller-lineas__money">
        {canEdit ? (
          <MoneyInput
            className="taller-input taller-input--money"
            value={precio}
            onValueChange={(value) => { precioRef.current = value; setPrecio(value) }}
            onBlur={commitPrecio}
            onKeyDown={blurOnEnter}
          />
        ) : formatMoney(item.precio)}
      </td>
      <td>
        <label className="taller-switch">
          <input
            type="checkbox"
            checked={item.activo}
            disabled={!canEdit}
            onChange={(event) => onSave(item.id, { activo: event.target.checked }).catch(() => {})}
          />
          <span>{item.activo ? 'Activo' : 'Inactivo'}</span>
        </label>
      </td>
      <td className="taller-lineas__actions">
        {canDelete && (
          <button type="button" className="taller-icon-btn taller-icon-btn--no" onClick={() => onDelete(item)} title="Eliminar (si ya se usó en una orden, solo se desactiva)">
            <Trash2 size={14} />
          </button>
        )}
      </td>
    </tr>
  )
}

function ManoObraTable({ token, moduleActions }) {
  const toast = useRef(null)
  const canCreate = moduleActions?.puede_crear ?? true
  const canEdit = moduleActions?.puede_actualizar ?? true
  const canDelete = moduleActions?.puede_eliminar ?? true
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [nuevo, setNuevo] = useState({ nombre: '', precio: null })
  const [saving, setSaving] = useState(false)
  const nombreRef = useRef(null)

  const notifyError = useCallback((detail) => {
    toast.current?.show({ severity: 'error', summary: 'Mano de obra', detail, life: 5000 })
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await authFetch(`${API_URL}/taller/mano-obra/`, {}, token)
      if (!response.ok) throw new Error(await parseApiError(response, 'No se pudo cargar el catálogo.'))
      const data = await response.json()
      setItems(Array.isArray(data) ? data : data?.results || [])
      setError('')
    } catch (err) {
      setError(err.message || 'No se pudo cargar el catálogo.')
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => { load() }, [load])

  const save = useCallback(async (id, body) => {
    try {
      const response = await authFetch(`${API_URL}/taller/mano-obra/${id}/`, { method: 'PATCH', body: JSON.stringify(body) }, token)
      if (!response.ok) throw new Error(await parseApiError(response, 'No se pudo guardar.'))
      const data = await response.json()
      setItems((prev) => prev.map((item) => (item.id === id ? data : item)))
      return data
    } catch (err) {
      notifyError(err.message)
      throw err
    }
  }, [notifyError, token])

  const remove = async (item) => {
    try {
      const response = await authFetch(`${API_URL}/taller/mano-obra/${item.id}/`, { method: 'DELETE' }, token)
      if (!response.ok) throw new Error(await parseApiError(response, 'No se pudo eliminar.'))
      if (response.status === 204) {
        setItems((prev) => prev.filter((row) => row.id !== item.id))
      } else {
        const data = await response.json()
        setItems((prev) => prev.map((row) => (row.id === item.id ? data : row)))
        toast.current?.show({ severity: 'info', summary: 'Mano de obra', detail: 'Ya se usó en órdenes: quedó inactivo en vez de borrarse.', life: 3500 })
      }
    } catch (err) {
      notifyError(err.message)
    }
  }

  const create = async (event) => {
    event.preventDefault()
    const nombre = nuevo.nombre.trim()
    if (!nombre) {
      notifyError('Escribe el nombre del trabajo.')
      return
    }
    setSaving(true)
    try {
      const response = await authFetch(
        `${API_URL}/taller/mano-obra/`,
        { method: 'POST', body: JSON.stringify({ nombre, precio: Number(nuevo.precio || 0).toFixed(2), activo: true }) },
        token
      )
      if (!response.ok) throw new Error(await parseApiError(response, 'No se pudo crear.'))
      const data = await response.json()
      setItems((prev) => [...prev, data].sort((a, b) => a.nombre.localeCompare(b.nombre)))
      setNuevo({ nombre: '', precio: null })
      nombreRef.current?.focus()
    } catch (err) {
      notifyError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const visible = useMemo(() => {
    const term = filter.trim().toLowerCase()
    if (!term) return items
    return items.filter((item) => item.nombre.toLowerCase().includes(term))
  }, [filter, items])

  return (
    <div className="users-page taller-page">
      <Toast ref={toast} />
      <div className="users-table users-table--card taller-catalog">
        <div className="taller-catalog__head">
          <div>
            <p className="create-user__eyebrow">Taller</p>
            <h4>Catálogo de mano de obra</h4>
            <p className="taller-muted">Precios fijos para elegir rápido en la orden. En la orden siempre se puede escribir cualquier otro trabajo.</p>
          </div>
          <div className="search-input-container">
            <input type="text" className="search-input" placeholder="Buscar trabajo" value={filter} onChange={(event) => setFilter(event.target.value)} />
            <i className="pi pi-search search-input-icon" />
          </div>
        </div>

        {canCreate && (
          <form className="taller-add__row taller-catalog__new" onSubmit={create}>
            <label className="taller-add__field taller-add__field--grow">
              <span>Nuevo trabajo</span>
              <input ref={nombreRef} className="taller-input" value={nuevo.nombre} placeholder="Cambio de aceite, ABC de frenos, ..." onChange={(event) => setNuevo((prev) => ({ ...prev, nombre: event.target.value }))} disabled={saving} />
            </label>
            <label className="taller-add__field taller-add__field--money">
              <span>Precio</span>
              <MoneyInput className="taller-input taller-input--money" value={nuevo.precio} onValueChange={(value) => setNuevo((prev) => ({ ...prev, precio: value }))} disabled={saving} />
            </label>
            <button type="submit" className="create-user__action create-user__action--primary taller-add__submit" disabled={saving}>
              {saving ? 'Guardando...' : 'Agregar'}
            </button>
          </form>
        )}

        {error && <BlockerNotice title="No se pudo cargar el catálogo" reason={error} actionLabel="Reintentar" onAction={load} />}

        <div className="taller-lineas__wrap">
          <table className="taller-lineas taller-catalog__table">
            <thead>
              <tr>
                <th>Trabajo</th>
                <th>Precio</th>
                <th>Estado</th>
                <th aria-label="Acciones" />
              </tr>
            </thead>
            <tbody>
              {loading && !items.length && (
                <tr><td colSpan={4} className="taller-lineas__empty"><i className="pi pi-spin pi-spinner" /> Cargando...</td></tr>
              )}
              {!loading && !visible.length && (
                <tr>
                  <td colSpan={4} className="taller-lineas__empty">
                    {items.length ? 'Ningún trabajo coincide.' : 'El catálogo está vacío. Agrega el primer trabajo arriba.'}
                  </td>
                </tr>
              )}
              {visible.map((item) => (
                <ManoObraRow key={item.id} item={item} canEdit={canEdit} canDelete={canDelete} onSave={save} onDelete={remove} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

export default ManoObraTable
