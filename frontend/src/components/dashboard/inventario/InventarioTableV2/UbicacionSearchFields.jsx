import { useCallback, useRef, useState } from 'react'
import CascadeDropdown from '../../common/CascadeDropdown'
import { API_URL, authFetch } from '../../../../utils/api'

const parseList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const byName = (a, b) => String(a?.nombre || '').localeCompare(String(b?.nombre || ''), 'es', { numeric: true })
const optionName = (option) => String(option?.nombre || '')
const RESULTS_LIMIT = 50

// Busqueda en el servidor (con el debounce de CascadeDropdown): las
// divisiones y subdivisiones son miles, traerlas todas tardaba mucho.
function useServerOptions(token, path) {
  const [options, setOptions] = useState([])
  const [loading, setLoading] = useState(false)
  const requestRef = useRef(0)

  const search = useCallback(async (params, term) => {
    if (!token) return
    const requestId = ++requestRef.current
    setLoading(true)
    try {
      const query = new URLSearchParams({ page_size: String(RESULTS_LIMIT), modulo: 'inventario', ordering: 'nombre', ...params })
      if (term) query.set('search', term)
      const response = await authFetch(`${API_URL}/inventario/${path}/?${query.toString()}`, {}, token)
      const payload = response.ok ? await response.json().catch(() => ({})) : {}
      if (requestId === requestRef.current) setOptions(parseList(payload))
    } catch {
      if (requestId === requestRef.current) setOptions([])
    } finally {
      if (requestId === requestRef.current) setLoading(false)
    }
  }, [token, path])

  return { options, loading, search }
}

// Busqueda avanzada de Inventario: buscar por una ubicacion especifica en
// cascada (sucursal -> bodega -> division -> subdivision). Cada nivel es
// opcional; se busca por el mas especifico que se elija.
function UbicacionSearchFields({ token, branches, bodegas, value, onChange }) {
  const sucursal = String(value?.ubic_sucursal || '')
  const bodega = String(value?.ubic_bodega || '')
  const division = String(value?.ubic_division || '')
  const subdivision = String(value?.ubic_subdivision || '')
  // Nombre de lo elegido (los resultados del servidor cambian al buscar).
  const [labels, setLabels] = useState({})
  const divisiones = useServerOptions(token, 'divisiones')
  const subdivisiones = useServerOptions(token, 'subdivisiones')

  const sucursalOptions = [{ id: '', nombre: 'Todas' }, ...(branches || [])]
  const bodegaOptions = [
    { id: '', nombre: 'Todas' },
    ...(bodegas || [])
      .filter((item) => String(item?.sucursal?.id ?? item?.sucursal_id ?? '') === sucursal)
      .sort(byName),
  ]

  // Al cambiar un nivel se limpian los de abajo.
  const set = (level, option) => {
    const next = String(option?.id || '')
    const patch = { ubic_sucursal: sucursal, ubic_bodega: bodega, ubic_division: division, ubic_subdivision: subdivision }
    const order = ['ubic_sucursal', 'ubic_bodega', 'ubic_division', 'ubic_subdivision']
    patch[level] = next
    order.slice(order.indexOf(level) + 1).forEach((key) => { patch[key] = '' })
    setLabels((prev) => ({ ...prev, [level]: next ? optionName(option) : '' }))
    onChange(patch)
  }

  return (
    <div className="create-user__grid create-user__grid--two">
      <div className="create-user__field">
        <span>Sucursal</span>
        <CascadeDropdown
          placeholder="Todas"
          searchPlaceholder="Buscar sucursal"
          options={sucursalOptions}
          valueId={sucursal}
          getOptionLabel={optionName}
          onSelect={(option) => set('ubic_sucursal', option)}
        />
      </div>
      <div className="create-user__field">
        <span>Bodega</span>
        <CascadeDropdown
          placeholder={sucursal ? 'Todas' : 'Elige una sucursal'}
          searchPlaceholder="Buscar bodega"
          options={bodegaOptions}
          valueId={bodega}
          disabled={!sucursal}
          getOptionLabel={optionName}
          emptyMessage="Esta sucursal no tiene bodegas"
          onSelect={(option) => set('ubic_bodega', option)}
        />
      </div>
      <div className="create-user__field">
        <span>División</span>
        <CascadeDropdown
          placeholder={bodega ? 'Todas' : 'Elige una bodega'}
          searchPlaceholder="Buscar división"
          options={[{ id: '', nombre: 'Todas' }, ...divisiones.options]}
          loading={divisiones.loading}
          onSearch={(term) => divisiones.search({ bodega_id: bodega }, term)}
          valueId={division}
          selectedLabel={labels.ubic_division}
          disabled={!bodega}
          getOptionLabel={optionName}
          emptyMessage="Esta bodega no tiene divisiones"
          onSelect={(option) => set('ubic_division', option)}
        />
      </div>
      <div className="create-user__field">
        <span>Subdivisión</span>
        <CascadeDropdown
          placeholder={division ? 'Todas' : 'Elige una división'}
          searchPlaceholder="Buscar subdivisión"
          options={[{ id: '', nombre: 'Todas' }, ...subdivisiones.options]}
          loading={subdivisiones.loading}
          onSearch={(term) => subdivisiones.search({ division_id: division }, term)}
          valueId={subdivision}
          selectedLabel={labels.ubic_subdivision}
          disabled={!division}
          getOptionLabel={optionName}
          emptyMessage="Esta división no tiene subdivisiones"
          onSelect={(option) => set('ubic_subdivision', option)}
        />
      </div>
    </div>
  )
}

export default UbicacionSearchFields
