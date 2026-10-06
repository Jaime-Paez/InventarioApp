import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, X } from 'lucide-react'
import { API_URL, authFetch } from '../../../../utils/api'
import { formatDateTime } from '../../../../utils/dateFormat'
import './InspectionCoverageMap.css'

// Mapa de conteo: el plano de cada bodega de la sucursal con cada percha
// (division) pintada segun cuanto de lo que tiene stock ya se conto.
const VERTICAL_LABEL_RATIO = 1.6

const normalizeKey = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()

const toPositive = (value) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0
}

const getStatus = (division) => {
  const total = Number(division?.total || 0)
  const contados = Number(division?.contados || 0)
  if (!division || total <= 0) return 'empty'
  if (contados >= total) return 'done'
  if (contados <= 0) return 'none'
  return 'partial'
}

const getPercent = (division) => {
  const total = Number(division?.total || 0)
  if (total <= 0) return 0
  return Math.floor((Number(division?.contados || 0) / total) * 100)
}

const STATUS_LABEL = {
  done: 'Contada',
  partial: 'En proceso',
  none: 'Sin contar',
  empty: 'Sin productos',
}

function InspectionCoverageMap({ sucursal, token, darkMode, onClose }) {
  const [desde, setDesde] = useState('')
  const [hasta, setHasta] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [bodegaId, setBodegaId] = useState('')
  const [selectedDivisionId, setSelectedDivisionId] = useState('')

  const sucursalId = String(sucursal?.id ?? '')

  const load = useCallback(async () => {
    if (!token || !sucursalId) return
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ sucursal_id: sucursalId })
      if (desde) params.set('desde', desde)
      if (hasta) params.set('hasta', hasta)
      const response = await authFetch(
        `${API_URL}/recordatorios/inspeccion-aleatoria/admin/croquis/?${params.toString()}`,
        {},
        token
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(payload?.detail || '').trim() || 'No se pudo cargar el mapa.')
      setData(payload)
      setBodegaId((current) => {
        const ids = (payload?.bodegas || []).map((bodega) => String(bodega.id))
        return ids.includes(current) ? current : ids[0] || ''
      })
    } catch (loadError) {
      setError(loadError?.message || 'No se pudo cargar el mapa.')
    } finally {
      setLoading(false)
    }
  }, [token, sucursalId, desde, hasta])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.()
    }
    document.addEventListener('keydown', handleKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [onClose])

  const bodegas = useMemo(() => (Array.isArray(data?.bodegas) ? data.bodegas : []), [data])
  const bodega = bodegas.find((item) => String(item.id) === bodegaId) || null

  const bodegaDivisions = useMemo(
    () => (Array.isArray(data?.divisiones) ? data.divisiones : []).filter(
      (division) => String(division.bodega_id) === bodegaId
    ),
    [data, bodegaId]
  )
  const divisionsByName = useMemo(() => {
    const map = new Map()
    bodegaDivisions.forEach((division) => map.set(normalizeKey(division.nombre), division))
    return map
  }, [bodegaDivisions])

  const shapes = useMemo(() => {
    const raw = Array.isArray(bodega?.ubicaciones) ? bodega.ubicaciones : []
    return raw
      .map((shape, index) => ({
        id: String(shape?.id ?? `shape-${index}`),
        nombre: String(shape?.nombre ?? '').trim(),
        x: toPositive(shape?.x),
        y: toPositive(shape?.y),
        ancho: toPositive(shape?.ancho),
        alto: toPositive(shape?.alto),
      }))
      .filter((shape) => shape.ancho > 0 && shape.alto > 0)
  }, [bodega])

  const planSize = useMemo(() => {
    const width = toPositive(bodega?.ancho_metros)
    const height = toPositive(bodega?.alto_metros)
    if (width > 0 && height > 0) return { width, height }
    return {
      width: shapes.reduce((max, shape) => Math.max(max, shape.x + shape.ancho), 0),
      height: shapes.reduce((max, shape) => Math.max(max, shape.y + shape.alto), 0),
    }
  }, [bodega, shapes])
  const hasPlan = planSize.width > 0 && planSize.height > 0 && shapes.length > 0

  // Perchas con productos que no estan dibujadas en el mapa: se listan
  // aparte para que no queden fuera del control.
  const shapeNames = useMemo(() => new Set(shapes.map((shape) => normalizeKey(shape.nombre))), [shapes])
  const unplacedDivisions = useMemo(
    () => bodegaDivisions.filter(
      (division) => Number(division.total || 0) > 0 && !shapeNames.has(normalizeKey(division.nombre))
    ),
    [bodegaDivisions, shapeNames]
  )

  const totals = useMemo(() => bodegaDivisions.reduce(
    (acc, division) => {
      const status = getStatus(division)
      acc.total += Number(division.total || 0)
      acc.contados += Number(division.contados || 0)
      if (status !== 'empty') acc.perchas += 1
      if (status === 'done') acc.completas += 1
      return acc
    },
    { total: 0, contados: 0, perchas: 0, completas: 0 }
  ), [bodegaDivisions])

  const selectedDivision = bodegaDivisions.find((division) => String(division.id) === selectedDivisionId) || null

  const selectDivisionByName = (name) => {
    const division = divisionsByName.get(normalizeKey(name))
    setSelectedDivisionId(division ? String(division.id) : '')
  }

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      className={`coverage-map${darkMode ? ' coverage-map--dark' : ''}`}
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.() }}
    >
      <div className="coverage-map__dialog">
        <header className="coverage-map__header">
          <div>
            <h4>Mapa de conteo</h4>
            <p>{sucursal?.nombre || 'Sucursal'}</p>
          </div>
          <button type="button" className="coverage-map__close" onClick={onClose} aria-label="Cerrar mapa">
            <X size={16} />
          </button>
        </header>

        <div className="coverage-map__toolbar">
          <label className="coverage-map__date">
            <span>Desde</span>
            <input type="date" value={desde} max={hasta || undefined} onChange={(event) => setDesde(event.target.value)} />
          </label>
          <label className="coverage-map__date">
            <span>Hasta</span>
            <input type="date" value={hasta} min={desde || undefined} onChange={(event) => setHasta(event.target.value)} />
          </label>
          {(desde || hasta) && (
            <button type="button" className="coverage-map__clear" onClick={() => { setDesde(''); setHasta('') }}>
              Todas las fechas
            </button>
          )}
          <div className="coverage-map__legend" aria-label="Leyenda">
            <span className="coverage-map__legend-item coverage-map__legend-item--done">Contada</span>
            <span className="coverage-map__legend-item coverage-map__legend-item--partial">En proceso</span>
            <span className="coverage-map__legend-item coverage-map__legend-item--none">Sin contar</span>
          </div>
        </div>

        {bodegas.length > 1 && (
          <div className="coverage-map__tabs" role="tablist">
            {bodegas.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={String(item.id) === bodegaId}
                className={`coverage-map__tab${String(item.id) === bodegaId ? ' is-active' : ''}`}
                onClick={() => { setBodegaId(String(item.id)); setSelectedDivisionId('') }}
              >
                {item.nombre}
              </button>
            ))}
          </div>
        )}

        <div className="coverage-map__body">
          {loading && !data ? (
            <p className="coverage-map__hint"><Loader2 size={14} className="coverage-map__spin" /> Cargando mapa...</p>
          ) : error ? (
            <p className="coverage-map__hint coverage-map__hint--error">{error}</p>
          ) : (
            <>
              <div className="coverage-map__main">
                <p className="coverage-map__summary">
                  {`${totals.completas} de ${totals.perchas} perchas completas · ${totals.contados} de ${totals.total} productos contados`}
                  {totals.total > 0 ? ` (${Math.floor((totals.contados / totals.total) * 100)}%)` : ''}
                  {loading && <Loader2 size={13} className="coverage-map__spin" />}
                </p>
                {hasPlan ? (
                  <div className="coverage-map__plan-scroll">
                    <div
                      className="coverage-map__plan"
                      style={{ aspectRatio: `${planSize.width} / ${planSize.height}` }}
                    >
                      {shapes.map((shape) => {
                        const division = divisionsByName.get(normalizeKey(shape.nombre)) || null
                        const status = division ? getStatus(division) : 'empty'
                        const isSelected = division && String(division.id) === selectedDivisionId
                        const isVertical = shape.alto > shape.ancho * VERTICAL_LABEL_RATIO
                        const title = division && status !== 'empty'
                          ? `${shape.nombre}: ${division.contados} de ${division.total} contados (${getPercent(division)}%)`
                          : `${shape.nombre || 'Ubicacion'}: sin productos con stock`
                        return (
                          <button
                            type="button"
                            key={shape.id}
                            className={`coverage-map__shape coverage-map__shape--${status}${isSelected ? ' is-selected' : ''}${isVertical ? ' coverage-map__shape--vertical' : ''}`}
                            style={{
                              left: `${(shape.x / planSize.width) * 100}%`,
                              top: `${(shape.y / planSize.height) * 100}%`,
                              width: `${(shape.ancho / planSize.width) * 100}%`,
                              height: `${(shape.alto / planSize.height) * 100}%`,
                            }}
                            title={title}
                            onClick={() => selectDivisionByName(shape.nombre)}
                          >
                            <span className="coverage-map__shape-name">{shape.nombre || 'Ubicacion'}</span>
                            {division && status !== 'empty' && (
                              <span className="coverage-map__shape-pct">{`${getPercent(division)}%`}</span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ) : (
                  <p className="coverage-map__hint">Esta bodega no tiene mapa dibujado. Las perchas se listan abajo.</p>
                )}

                {(unplacedDivisions.length > 0 || !hasPlan) && (
                  <div className="coverage-map__unplaced">
                    <span>{hasPlan ? 'Perchas que no estan en el mapa:' : 'Perchas:'}</span>
                    {(hasPlan ? unplacedDivisions : bodegaDivisions.filter((division) => Number(division.total || 0) > 0)).map((division) => (
                      <button
                        type="button"
                        key={division.id}
                        className={`coverage-map__chip coverage-map__chip--${getStatus(division)}`}
                        onClick={() => setSelectedDivisionId(String(division.id))}
                      >
                        {`${division.nombre} · ${getPercent(division)}%`}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <aside className="coverage-map__side">
                {!selectedDivision ? (
                  <p className="coverage-map__hint">Toca una percha para ver sus niveles y lo que falta por contar.</p>
                ) : (
                  <>
                    <div className="coverage-map__side-head">
                      <h5>{selectedDivision.nombre}</h5>
                      <span className={`coverage-map__badge coverage-map__badge--${getStatus(selectedDivision)}`}>
                        {STATUS_LABEL[getStatus(selectedDivision)]}
                      </span>
                    </div>
                    <p className="coverage-map__side-meta">
                      {`${selectedDivision.contados} de ${selectedDivision.total} contados (${getPercent(selectedDivision)}%)`}
                      {selectedDivision.ultimo_conteo ? ` · Ultimo conteo: ${formatDateTime(selectedDivision.ultimo_conteo)}` : ''}
                    </p>
                    {!(selectedDivision.subdivisiones || []).length ? (
                      <p className="coverage-map__hint">Esta percha no tiene productos con stock.</p>
                    ) : (
                      <ul className="coverage-map__levels">
                        {selectedDivision.subdivisiones.map((subdivision) => {
                          const percent = getPercent(subdivision)
                          const status = getStatus(subdivision)
                          return (
                            <li key={subdivision.id} className="coverage-map__level">
                              <div className="coverage-map__level-head">
                                <strong>{subdivision.nombre || 'Sin nombre'}</strong>
                                <span>{`${subdivision.contados}/${subdivision.total}`}</span>
                              </div>
                              <div className="coverage-map__bar">
                                <div className={`coverage-map__bar-fill coverage-map__bar-fill--${status}`} style={{ width: `${percent}%` }} />
                              </div>
                              {(subdivision.pendientes || []).length > 0 && (
                                <details className="coverage-map__pending">
                                  <summary>{`Faltan ${subdivision.pendientes.length}`}</summary>
                                  <ul>
                                    {subdivision.pendientes.map((product) => (
                                      <li key={product.producto_id}>
                                        <span className="coverage-map__pending-code">{product.codigo}</span>
                                        <span className="coverage-map__pending-name">{product.nombre}</span>
                                        <span className="coverage-map__pending-qty">{product.cantidad}</span>
                                      </li>
                                    ))}
                                  </ul>
                                </details>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </>
                )}
              </aside>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

export default InspectionCoverageMap
