import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { API_URL, authFetch } from '../../../../utils/api'
import { formatDateTime } from '../../../../utils/dateFormat'
import CascadeDropdown from '../../common/CascadeDropdown'
import BlockerNotice from '../../common/BlockerNotice'
import '../../common/unsavedChanges/unsavedChanges.css'

const normalizeId = (value) => String(value ?? '').trim()

const uniqueBy = (list, idKey, nameKey) => {
  const seen = new Map()
  list.forEach((option) => {
    if (option[idKey] && !seen.has(option[idKey])) seen.set(option[idKey], { id: option[idKey], nombre: option[nameKey] || '-' })
  })
  return [...seen.values()].sort((left, right) => left.nombre.localeCompare(right.nombre, 'es', { numeric: true }))
}

// Faltante abierto de una revision: registra cuantas unidades aparecieron y
// donde. Se suman al stock en esa ubicacion; lo que no aparece sigue abierto.
export default function FaltanteAparecioDialog({ item, token, onClose, onSaved }) {
  const pendiente = Number(item?.faltante_pendiente || 0)
  const branchId = normalizeId(item?.sucursal_id)
  const [options, setOptions] = useState(null)
  const [loadError, setLoadError] = useState(false)
  const [bodegaId, setBodegaId] = useState('')
  const [divisionId, setDivisionId] = useState('')
  const [subdivisionId, setSubdivisionId] = useState('')
  const [cantidad, setCantidad] = useState(String(pendiente || ''))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!token || !branchId) return undefined
    let cancelled = false
    authFetch(`${API_URL}/inventario/subdivisiones/?page_size=2000&sucursal_id=${encodeURIComponent(branchId)}`, {}, token)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('error'))))
      .then((payload) => {
        if (cancelled) return
        const list = Array.isArray(payload) ? payload : (Array.isArray(payload?.results) ? payload.results : [])
        setOptions(list.map((subdivision) => ({
          id: normalizeId(subdivision?.id),
          nombre: String(subdivision?.nombre || '').trim(),
          divisionId: normalizeId(subdivision?.division?.id),
          divisionNombre: String(subdivision?.division?.nombre || '').trim(),
          bodegaId: normalizeId(subdivision?.division?.bodega?.id),
          bodegaNombre: String(subdivision?.division?.bodega?.nombre || '').trim(),
        })).filter((option) => option.id))
      })
      .catch(() => { if (!cancelled) setLoadError(true) })
    return () => { cancelled = true }
  }, [token, branchId])

  const bodegaOptions = useMemo(() => uniqueBy(options || [], 'bodegaId', 'bodegaNombre'), [options])
  const divisionOptions = useMemo(
    () => uniqueBy((options || []).filter((option) => option.bodegaId === bodegaId), 'divisionId', 'divisionNombre'),
    [options, bodegaId]
  )
  const subdivisionOptions = useMemo(
    () => (options || [])
      .filter((option) => option.divisionId === divisionId)
      .map((option) => ({ id: option.id, nombre: option.nombre || '-' }))
      .sort((left, right) => left.nombre.localeCompare(right.nombre, 'es', { numeric: true })),
    [options, divisionId]
  )

  if (!item || typeof document === 'undefined') return null

  const qty = Number.parseInt(cantidad, 10)
  const qtyValid = Number.isFinite(qty) && qty > 0 && qty <= pendiente
  const loadingLabel = loadError ? 'No se pudieron cargar' : options == null ? 'Cargando...' : null
  const recuperaciones = Array.isArray(item?.faltante_recuperaciones) ? item.faltante_recuperaciones : []

  const handleSave = async () => {
    if (!subdivisionId) { setError('Elige la ubicacion donde aparecio.'); return }
    if (!qtyValid) { setError(`La cantidad debe ser de 1 a ${pendiente}.`); return }
    setError('')
    setSaving(true)
    try {
      const response = await authFetch(
        `${API_URL}/recordatorios/inspeccion-aleatoria/items/${encodeURIComponent(normalizeId(item.id))}/aparecio/`,
        { method: 'POST', body: JSON.stringify({ subdivision_id: Number(subdivisionId), cantidad: qty }) },
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudo guardar.')
      onSaved?.(payload?.item || null, qty)
    } catch (saveError) {
      setError(saveError?.message || 'No se pudo guardar.')
      setSaving(false)
    }
  }

  return createPortal(
    <div
      className="unsaved-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Aparecio el faltante"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose?.() }}
    >
      <div className="unsaved-dialog__card inspection-admin__aparecio">
        <h4>{`Apareció ${String(item?.producto_codigo || '').trim()}`}</h4>
        <p>
          {`Faltaban ${Number(item?.cantidad_faltante || 0)} desde la inspección #${item?.inspeccion_id ?? '-'}`}
          {Number(item?.faltante_recuperado || 0) > 0 ? `; ya aparecieron ${item.faltante_recuperado}` : ''}
          {`. Siguen faltando `}<strong>{pendiente}</strong>
          {'. Lo que registres se suma al stock en esa ubicación; el resto sigue como faltante.'}
        </p>

        {recuperaciones.length > 0 && (
          <ul className="inspection-admin__aparecio-history">
            {recuperaciones.map((entry, index) => (
              <li key={`recuperacion-${index}`}>
                {`${entry?.cantidad ?? 0} · ${entry?.origen === 'manual' ? 'registrado a mano' : `en la inspección #${entry?.inspeccion_id ?? '-'}`}`}
                {entry?.ubicacion ? ` · ${entry.ubicacion}` : ''}
                {entry?.fecha ? ` · ${formatDateTime(entry.fecha)}` : ''}
              </li>
            ))}
          </ul>
        )}

        {!loadingLabel && !bodegaOptions.length ? (
          <BlockerNotice
            compact
            title="Esta sucursal no tiene ubicaciones."
            reason="Para registrar dónde apareció, crea la subdivisión en Sucursales > Bodegas."
            goTo="Bodegas"
          />
        ) : (
          <div className="inspection-admin__relocate-cascade">
            <CascadeDropdown
              placeholder={loadingLabel || 'Bodega'}
              searchPlaceholder="Buscar bodega"
              options={bodegaOptions}
              valueId={bodegaId}
              getOptionLabel={(option) => option.nombre}
              onSelect={(option) => { setBodegaId(option.id); setDivisionId(''); setSubdivisionId('') }}
              disabled={saving || Boolean(loadingLabel)}
              emptyMessage="No hay bodegas en esta sucursal."
            />
            <CascadeDropdown
              placeholder="División"
              searchPlaceholder="Buscar división"
              options={divisionOptions}
              valueId={divisionId}
              getOptionLabel={(option) => option.nombre}
              onSelect={(option) => { setDivisionId(option.id); setSubdivisionId('') }}
              disabled={saving || !bodegaId}
              emptyMessage="Esta bodega no tiene divisiones."
            />
            <CascadeDropdown
              placeholder="Subdivisión"
              searchPlaceholder="Buscar subdivisión"
              options={subdivisionOptions}
              valueId={subdivisionId}
              getOptionLabel={(option) => option.nombre}
              onSelect={(option) => setSubdivisionId(option.id)}
              disabled={saving || !divisionId}
              emptyMessage="Esta división no tiene subdivisiones."
            />
          </div>
        )}

        <label className="inspection-admin__aparecio-qty">
          <span>{`Cantidad que apareció (máx. ${pendiente})`}</span>
          <input
            type="text"
            inputMode="numeric"
            value={cantidad}
            onChange={(event) => setCantidad(String(event.target.value || '').replace(/\D+/g, '').slice(0, 5))}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void handleSave() } }}
            disabled={saving}
          />
        </label>

        {error && <p className="inspection-admin__aparecio-error">{error}</p>}

        <div className="unsaved-dialog__actions">
          <button type="button" className="unsaved-dialog__btn" onClick={onClose} disabled={saving}>
            Cancelar
          </button>
          <button
            type="button"
            className="unsaved-dialog__btn unsaved-dialog__btn--save"
            onClick={() => void handleSave()}
            disabled={saving || !subdivisionId || !qtyValid}
          >
            {saving ? 'Guardando...' : qtyValid && qty < pendiente ? `Registrar ${qty} (siguen faltando ${pendiente - qty})` : 'Registrar'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
