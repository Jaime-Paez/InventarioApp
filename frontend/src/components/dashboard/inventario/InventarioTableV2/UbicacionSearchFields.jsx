import { useEffect, useState } from 'react'
import { API_URL, authFetch } from '../../../../utils/api'

const parseList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const byName = (a, b) => String(a?.nombre || '').localeCompare(String(b?.nombre || ''), 'es', { numeric: true })

// Busqueda avanzada de Inventario: buscar por una ubicacion especifica en
// cascada (sucursal -> bodega -> division -> subdivision). Cada nivel es
// opcional; se busca por el mas especifico que se elija. Las divisiones y
// subdivisiones se piden solo de lo elegido (son miles en total).
function UbicacionSearchFields({ token, branches, bodegas, value, onChange }) {
  const sucursal = String(value?.ubic_sucursal || '')
  const bodega = String(value?.ubic_bodega || '')
  const division = String(value?.ubic_division || '')
  const subdivision = String(value?.ubic_subdivision || '')
  const [divisiones, setDivisiones] = useState([])
  const [subdivisiones, setSubdivisiones] = useState([])
  const [loadingDiv, setLoadingDiv] = useState(false)
  const [loadingSub, setLoadingSub] = useState(false)

  const bodegasSucursal = (bodegas || [])
    .filter((item) => String(item?.sucursal?.id ?? item?.sucursal_id ?? '') === sucursal)
    .sort(byName)

  useEffect(() => {
    if (!bodega || !token) { setDivisiones([]); return undefined }
    let cancelled = false
    setLoadingDiv(true)
    authFetch(`${API_URL}/inventario/divisiones/?page_size=2000&modulo=inventario&bodega_id=${bodega}`, {}, token)
      .then((response) => (response.ok ? response.json() : []))
      .then((payload) => { if (!cancelled) setDivisiones(parseList(payload).sort(byName)) })
      .catch(() => { if (!cancelled) setDivisiones([]) })
      .finally(() => { if (!cancelled) setLoadingDiv(false) })
    return () => { cancelled = true }
  }, [bodega, token])

  useEffect(() => {
    if (!division || !token) { setSubdivisiones([]); return undefined }
    let cancelled = false
    setLoadingSub(true)
    authFetch(`${API_URL}/inventario/subdivisiones/?page_size=2000&modulo=inventario&division_id=${division}`, {}, token)
      .then((response) => (response.ok ? response.json() : []))
      .then((payload) => { if (!cancelled) setSubdivisiones(parseList(payload).sort(byName)) })
      .catch(() => { if (!cancelled) setSubdivisiones([]) })
      .finally(() => { if (!cancelled) setLoadingSub(false) })
    return () => { cancelled = true }
  }, [division, token])

  // Al cambiar un nivel se limpian los de abajo.
  const set = (level, next) => {
    const patch = { ubic_sucursal: sucursal, ubic_bodega: bodega, ubic_division: division, ubic_subdivision: subdivision }
    const order = ['ubic_sucursal', 'ubic_bodega', 'ubic_division', 'ubic_subdivision']
    patch[level] = next
    order.slice(order.indexOf(level) + 1).forEach((key) => { patch[key] = '' })
    onChange(patch)
  }

  return (
    <div className="create-user__grid create-user__grid--two">
      <label className="create-user__field">
        <span>Sucursal</span>
        <select value={sucursal} onChange={(event) => set('ubic_sucursal', event.target.value)}>
          <option value="">Todas</option>
          {(branches || []).map((branch) => (
            <option key={`ubic-suc-${branch.id}`} value={String(branch.id)}>{branch.nombre}</option>
          ))}
        </select>
      </label>
      <label className="create-user__field">
        <span>Bodega</span>
        <select value={bodega} disabled={!sucursal} onChange={(event) => set('ubic_bodega', event.target.value)}>
          <option value="">{sucursal ? 'Todas' : 'Elige una sucursal'}</option>
          {bodegasSucursal.map((item) => (
            <option key={`ubic-bod-${item.id}`} value={String(item.id)}>{item.nombre}</option>
          ))}
        </select>
      </label>
      <label className="create-user__field">
        <span>División</span>
        <select value={division} disabled={!bodega || loadingDiv} onChange={(event) => set('ubic_division', event.target.value)}>
          <option value="">{!bodega ? 'Elige una bodega' : loadingDiv ? 'Cargando...' : 'Todas'}</option>
          {divisiones.map((item) => (
            <option key={`ubic-div-${item.id}`} value={String(item.id)}>{item.nombre}</option>
          ))}
        </select>
      </label>
      <label className="create-user__field">
        <span>Subdivisión</span>
        <select value={subdivision} disabled={!division || loadingSub} onChange={(event) => set('ubic_subdivision', event.target.value)}>
          <option value="">{!division ? 'Elige una división' : loadingSub ? 'Cargando...' : 'Todas'}</option>
          {subdivisiones.map((item) => (
            <option key={`ubic-sub-${item.id}`} value={String(item.id)}>{item.nombre}</option>
          ))}
        </select>
      </label>
    </div>
  )
}

export default UbicacionSearchFields
