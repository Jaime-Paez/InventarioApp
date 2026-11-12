import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, Search, X } from 'lucide-react'
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
  // Conteos con diferencia sin resolver (p. ej. contaron 0): la percha queda
  // en revision hasta que se apruebe o rechace el ajuste; no pasa a verde.
  if (Number(division?.en_revision || 0) > 0) return 'review'
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
  review: 'En revisión',
  partial: 'En proceso',
  none: 'Sin contar',
  empty: 'Sin productos',
}

// Resultado del ultimo conteo de un producto en esa ubicacion.
const isResultOk = (result) => {
  if (!result) return false
  // Si la diferencia ya se resolvio (aprobada o rechazada), queda en verde.
  if (result.resuelto) return true
  if (result.no_encontrado) return false
  if (result.por_ubicacion && result.cantidad_contada != null && result.cantidad_sistema != null) {
    return result.cantidad_contada === result.cantidad_sistema
  }
  return Boolean(result.coincide)
}

const VERIFICATION_LABEL = {
  aprobada: 'Ajustado',
  rechazada: 'Verificado sin ajuste',
  pendiente: 'Por verificar',
  reconteo: 'En reconteo',
}

const describeResult = (result) => {
  if (!result) return ''
  // Diferencia ya resuelta: queda bien, solo con el valor final (lo contado
  // si se ajusto; lo del sistema si se rechazo el ajuste).
  if (result.resuelto) {
    const final = result.verificacion === 'aprobada' ? result.cantidad_contada : result.cantidad_sistema
    const base = final == null ? 'Verificado' : `Queda ${final}`
    // Reconteo disculpado por el admin: se cerro sin ajustar el sistema.
    return result.verificacion === 'reconteo' ? `Reconteo disculpado · ${base}` : base
  }
  let text
  if (result.no_encontrado) text = 'No encontrado'
  else if (result.cantidad_contada == null) text = result.coincide ? 'Coincide' : 'Con diferencia'
  else if (result.cantidad_sistema == null) text = `Conto ${result.cantidad_contada}`
  else text = `Conto ${result.cantidad_contada} · Sistema ${result.cantidad_sistema}`
  // Solo se aclara el estado cuando hubo diferencia.
  const differs = result.no_encontrado || !result.coincide
    || (result.cantidad_contada != null && result.cantidad_sistema != null && result.cantidad_contada !== result.cantidad_sistema)
  const label = differs ? VERIFICATION_LABEL[result.verificacion] : ''
  return label ? `${text} · ${label}` : text
}

const describeResultMeta = (result) => [
  result?.revisor,
  result?.revisado_en ? formatDateTime(result.revisado_en) : '',
].filter(Boolean).join(' · ')

const MAX_LIST_PRODUCTS = 200
const MIN_QUERY_LENGTH = 2
const MAX_SEARCH_RESULTS = 40

const productKey = (subdivisionId, productId) => `${subdivisionId}-${productId}`

function InspectionCoverageMap({ sucursal, token, darkMode, onClose, reviewers = [], reviewersLoading = false, onSendMissing }) {
  const [desde, setDesde] = useState('')
  const [hasta, setHasta] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [bodegaId, setBodegaId] = useState('')
  const [selectedDivisionIds, setSelectedDivisionIds] = useState([])
  const [missingReviewerId, setMissingReviewerId] = useState('')
  const [sendingMissing, setSendingMissing] = useState(false)
  const [sentMissingMessage, setSentMissingMessage] = useState('')
  const [query, setQuery] = useState('')
  const [showResults, setShowResults] = useState(false)
  const [focusKey, setFocusKey] = useState('')
  const sideRef = useRef(null)
  const searchRef = useRef(null)

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
      if (event.defaultPrevented) return
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

  // Los resultados de busqueda se cierran al hacer clic fuera del buscador.
  useEffect(() => {
    if (!showResults) return undefined
    const handlePointerDown = (event) => {
      if (searchRef.current && !searchRef.current.contains(event.target)) setShowResults(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [showResults])

  const bodegas = useMemo(() => (Array.isArray(data?.bodegas) ? data.bodegas : []), [data])
  const bodega = bodegas.find((item) => String(item.id) === bodegaId) || null
  const allDivisions = useMemo(() => (Array.isArray(data?.divisiones) ? data.divisiones : []), [data])

  const bodegaDivisions = useMemo(
    () => allDivisions.filter((division) => String(division.bodega_id) === bodegaId),
    [allDivisions, bodegaId]
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

  // Busqueda: cualquier producto con stock en la sucursal, en todas las
  // bodegas, contado o no. Cada ubicacion donde esta es un resultado.
  const bodegaNames = useMemo(() => {
    const map = new Map()
    bodegas.forEach((item) => map.set(String(item.id), item.nombre))
    return map
  }, [bodegas])

  const normalizedQuery = normalizeKey(query)
  const searchActive = normalizedQuery.length >= MIN_QUERY_LENGTH

  const searchMatches = useMemo(() => {
    if (!searchActive) return []
    const terms = normalizedQuery.split(/\s+/).filter(Boolean)
    const matches = []
    allDivisions.forEach((division) => {
      ;(division.subdivisiones || []).forEach((subdivision) => {
        const push = (product, counted) => {
          const haystack = `${normalizeKey(product.codigo)} ${normalizeKey(product.nombre)}`
          if (!terms.every((term) => haystack.includes(term))) return
          matches.push({ product, counted, division, subdivision })
        }
        ;(subdivision.pendientes || []).forEach((product) => push(product, false))
        ;(subdivision.contados_lista || []).forEach((product) => push(product, true))
      })
    })
    const exactCode = (match) => (normalizeKey(match.product.codigo) === normalizedQuery ? 0 : 1)
    matches.sort((a, b) => exactCode(a) - exactCode(b)
      || String(a.product.codigo).localeCompare(String(b.product.codigo), 'es', { numeric: true })
      || String(a.division.nombre).localeCompare(String(b.division.nombre), 'es', { numeric: true }))
    return matches
  }, [searchActive, normalizedQuery, allDivisions])

  const matchKeys = useMemo(
    () => new Set(searchMatches.map((match) => productKey(match.subdivision.id, match.product.producto_id))),
    [searchMatches]
  )
  const matchDivisionIds = useMemo(
    () => new Set(searchMatches.map((match) => String(match.division.id))),
    [searchMatches]
  )
  const matchCountByBodega = useMemo(() => {
    const map = new Map()
    searchMatches.forEach((match) => {
      const key = String(match.division.bodega_id)
      map.set(key, (map.get(key) || 0) + 1)
    })
    return map
  }, [searchMatches])

  const selectedDivisions = useMemo(
    () => selectedDivisionIds
      .map((id) => allDivisions.find((division) => String(division.id) === id))
      .filter(Boolean),
    [selectedDivisionIds, allDivisions]
  )

  const selectionTotals = useMemo(() => selectedDivisions.reduce(
    (acc, division) => {
      acc.total += Number(division.total || 0)
      acc.contados += Number(division.contados || 0)
      acc.en_revision += Number(division.en_revision || 0)
      return acc
    },
    { total: 0, contados: 0, en_revision: 0 }
  ), [selectedDivisions])

  // Productos que faltan contar en las perchas elegidas (para mandarlos a revisar).
  const missingProductIds = useMemo(() => {
    const ids = new Set()
    selectedDivisions.forEach((division) => {
      ;(division.subdivisiones || []).forEach((subdivision) => {
        ;(subdivision.pendientes || []).forEach((product) => {
          if (product?.producto_id) ids.add(Number(product.producto_id))
        })
      })
    })
    return Array.from(ids)
  }, [selectedDivisions])

  // Al cambiar de perchas se limpia el "Enviado a ..." de la seleccion anterior.
  const selectionKey = selectedDivisionIds.join(',')
  useEffect(() => {
    setSentMissingMessage('')
  }, [selectionKey])

  // Lleva a la vista el producto elegido en la busqueda.
  useEffect(() => {
    if (!focusKey || !sideRef.current) return
    const frame = window.requestAnimationFrame(() => {
      const row = sideRef.current?.querySelector(`[data-product-key="${focusKey}"]`)
      row?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [focusKey, selectionKey])

  const handleSendMissing = async () => {
    if (!onSendMissing || !missingReviewerId || !missingProductIds.length) return
    setSendingMissing(true)
    const divisionIds = selectedDivisions.map((division) => Number(division.id))
    const ok = await onSendMissing({
      usuarioId: missingReviewerId,
      productIds: missingProductIds.slice(0, MAX_LIST_PRODUCTS),
      ...(divisionIds.length === 1 ? { divisionId: divisionIds[0] } : { divisionIds }),
    })
    setSendingMissing(false)
    if (ok) {
      const reviewer = reviewers.find((item) => String(item.id) === String(missingReviewerId))
      setSentMissingMessage(`Enviado a ${String(reviewer?.nombre_completo || reviewer?.correo || 'el revisor').trim()}.`)
      setMissingReviewerId('')
    }
  }

  // Clic en una percha: se suma a la seleccion; otro clic la quita.
  const toggleDivision = (division) => {
    if (!division) return
    const id = String(division.id)
    setFocusKey('')
    setSelectedDivisionIds((current) => (
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
    ))
  }

  const handleDivisionClick = (division) => {
    toggleDivision(division)
  }

  // Desde la busqueda: la percha se suma a la seleccion (sin quitarla si ya
  // estaba); si es de otra bodega, queda sola.
  const goToMatch = (match) => {
    const id = String(match.division.id)
    const sameBodega = String(match.division.bodega_id) === bodegaId
    setBodegaId(String(match.division.bodega_id))
    setSelectedDivisionIds((current) => {
      if (sameBodega) return current.includes(id) ? current : [...current, id]
      return [id]
    })
    setFocusKey(productKey(match.subdivision.id, match.product.producto_id))
    setShowResults(false)
  }

  const handleSearchKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (showResults) setShowResults(false)
      else if (query) setQuery('')
      else onClose?.()
    } else if (event.key === 'Enter' && searchMatches.length) {
      event.preventDefault()
      goToMatch(searchMatches[0])
    }
  }

  const changeBodega = (id) => {
    setBodegaId(id)
    setSelectedDivisionIds([])
    setFocusKey('')
    setSentMissingMessage('')
  }

  const renderProductRow = (product, subdivision, counted) => {
    const key = productKey(subdivision.id, product.producto_id)
    const result = counted ? product.resultado : null
    const classes = [
      'coverage-map__product',
      !counted ? 'coverage-map__product--none'
        : (result && !isResultOk(result) ? 'coverage-map__product--review' : 'coverage-map__product--done'),
      searchActive && matchKeys.has(key) ? 'is-match' : '',
      focusKey === key ? 'is-focus' : '',
    ].filter(Boolean).join(' ')
    return (
      <li key={key} className={classes} data-product-key={key}>
        <span className="coverage-map__pending-code">{product.codigo}</span>
        <span className="coverage-map__pending-name">{product.nombre}</span>
        <span className="coverage-map__pending-qty">{product.cantidad}</span>
        {counted && result && (
          <span className={`coverage-map__result coverage-map__result--${isResultOk(result) ? 'ok' : 'bad'}`}>
            <strong>{describeResult(result)}</strong>
            {describeResultMeta(result) && <small>{describeResultMeta(result)}</small>}
          </span>
        )}
      </li>
    )
  }

  const subdivisionHasMatch = (subdivision, counted) => searchActive && (
    (counted ? subdivision.contados_lista : subdivision.pendientes) || []
  ).some((product) => matchKeys.has(productKey(subdivision.id, product.producto_id)))

  const subdivisionHasFocus = (subdivision, counted) => Boolean(focusKey) && (
    (counted ? subdivision.contados_lista : subdivision.pendientes) || []
  ).some((product) => productKey(subdivision.id, product.producto_id) === focusKey)

  const renderDivisionLevels = (division) => {
    const subdivisions = division.subdivisiones || []
    if (!subdivisions.length) {
      return <p className="coverage-map__hint">Esta percha no tiene productos con stock.</p>
    }
    return (
      <ul className="coverage-map__levels">
        {subdivisions.map((subdivision) => {
          const percent = getPercent(subdivision)
          const status = getStatus(subdivision)
          const pending = subdivision.pendientes || []
          const counted = subdivision.contados_lista || []
          const inReview = counted.filter((product) => product.resultado && !isResultOk(product.resultado))
          const countedOk = counted.filter((product) => !(product.resultado && !isResultOk(product.resultado)))
          const openPending = subdivisionHasMatch(subdivision, false) || subdivisionHasFocus(subdivision, false)
          const openCounted = subdivisionHasMatch(subdivision, true) || subdivisionHasFocus(subdivision, true)
          return (
            <li key={subdivision.id} className="coverage-map__level">
              <div className="coverage-map__level-head">
                <strong>{subdivision.nombre || 'Sin nombre'}</strong>
                <span>
                  {`${subdivision.contados}/${subdivision.total}`}
                  {Number(subdivision.en_revision || 0) > 0 && ` · ${subdivision.en_revision} en revisión`}
                </span>
              </div>
              <div className="coverage-map__bar">
                <div className={`coverage-map__bar-fill coverage-map__bar-fill--${status}`} style={{ width: `${percent}%` }} />
              </div>
              {pending.length > 0 && (
                <details
                  key={`pending-${openPending ? `open-${normalizedQuery}-${focusKey}` : 'closed'}`}
                  className="coverage-map__pending"
                  open={openPending || undefined}
                >
                  <summary>{`Faltan ${pending.length}`}</summary>
                  <ul>{pending.map((product) => renderProductRow(product, subdivision, false))}</ul>
                </details>
              )}
              {/* Los que tienen diferencia sin resolver van aparte y abiertos:
                  asi se ve de una vez cuales dejan la percha "En revision". */}
              {inReview.length > 0 && (
                <details className="coverage-map__pending coverage-map__pending--review" open>
                  <summary>{`En revisión ${inReview.length}`}</summary>
                  <ul>{inReview.map((product) => renderProductRow(product, subdivision, true))}</ul>
                </details>
              )}
              {countedOk.length > 0 && (
                <details
                  key={`counted-${openCounted ? `open-${normalizedQuery}-${focusKey}` : 'closed'}`}
                  className="coverage-map__pending coverage-map__pending--done"
                  open={openCounted || undefined}
                >
                  <summary>{`Contados ${countedOk.length}`}</summary>
                  <ul>{countedOk.map((product) => renderProductRow(product, subdivision, true))}</ul>
                </details>
              )}
            </li>
          )
        })}
      </ul>
    )
  }

  const selectionStatus = getStatus(selectionTotals)
  const selectionPercent = getPercent(selectionTotals)
  const singleDivision = selectedDivisions.length === 1 ? selectedDivisions[0] : null

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

        {/* Hasta que llega el mapa solo se ve el titulo, la X y el icono de
            carga: nada de controles a medio armar. */}
        {data && (
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
            <span className="coverage-map__legend-item coverage-map__legend-item--review">En revisión</span>
            <span className="coverage-map__legend-item coverage-map__legend-item--partial">En proceso</span>
            <span className="coverage-map__legend-item coverage-map__legend-item--none">Sin contar</span>
          </div>
        </div>
        )}

        <div className="coverage-map__body">
          {loading && !data ? (
            <div className="coverage-map__loading" role="status" aria-label="Cargando mapa">
              <Loader2 size={30} className="coverage-map__spin" />
            </div>
          ) : error ? (
            <p className="coverage-map__hint coverage-map__hint--error">{error}</p>
          ) : (
            <>
              <div className="coverage-map__main">
                <div className="coverage-map__tabs-row">
                  <div className="coverage-map__tabs-left">
                  {bodegas.length > 1 && (
                <div className="coverage-map__tabs" role="tablist">
                  {bodegas.map((item) => {
                    const matchCount = searchActive ? matchCountByBodega.get(String(item.id)) || 0 : 0
                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="tab"
                        aria-selected={String(item.id) === bodegaId}
                        className={`coverage-map__tab${String(item.id) === bodegaId ? ' is-active' : ''}`}
                        onClick={() => changeBodega(String(item.id))}
                      >
                        {item.nombre}
                        {matchCount > 0 && <span className="coverage-map__tab-count">{matchCount}</span>}
                      </button>
                    )
                  })}
                </div>
                  )}
                <div className="coverage-map__search" ref={searchRef}>
                  <div className="coverage-map__search-box">
                    <input
                      type="search"
                      value={query}
                      placeholder="Buscar producto"
                      aria-label="Buscar producto"
                      onChange={(event) => { setQuery(event.target.value); setShowResults(true); setFocusKey('') }}
                      onFocus={() => { if (query) setShowResults(true) }}
                      onKeyDown={handleSearchKeyDown}
                    />
                    {query && (
                      <button
                        type="button"
                        className="coverage-map__search-clear"
                        aria-label="Limpiar busqueda"
                        onClick={() => { setQuery(''); setFocusKey(''); setShowResults(false) }}
                      >
                        <X size={13} />
                      </button>
                    )}
                    {!query && <Search size={14} className="coverage-map__search-icon" aria-hidden="true" />}
                  </div>
                  {showResults && searchActive && (
                    <div className="coverage-map__results" role="listbox">
                      {!searchMatches.length ? (
                        <p className="coverage-map__results-empty">
                          Ningun producto con stock en esta sucursal coincide con la busqueda.
                        </p>
                      ) : (
                        <>
                          <p className="coverage-map__results-count">
                            {searchMatches.length === 1 ? '1 ubicacion' : `${searchMatches.length} ubicaciones`}
                            {searchMatches.length > MAX_SEARCH_RESULTS ? ` · se muestran ${MAX_SEARCH_RESULTS}, escribe mas para afinar` : ''}
                          </p>
                          <ul>
                            {searchMatches.slice(0, MAX_SEARCH_RESULTS).map((match) => {
                              const result = match.counted ? match.product.resultado : null
                              return (
                                <li key={`${match.subdivision.id}-${match.product.producto_id}`}>
                                  <button
                                    type="button"
                                    role="option"
                                    aria-selected="false"
                                    className={`coverage-map__result-row coverage-map__result-row--${match.counted ? (isResultOk(result) ? 'done' : 'review') : 'none'}`}
                                    onClick={() => goToMatch(match)}
                                  >
                                    <span className="coverage-map__result-product">
                                      <strong>{match.product.codigo}</strong>
                                      <span>{match.product.nombre}</span>
                                    </span>
                                    <span className="coverage-map__result-location">
                                      {[
                                        bodegas.length > 1 ? bodegaNames.get(String(match.division.bodega_id)) : '',
                                        match.division.nombre,
                                        match.subdivision.nombre,
                                      ].filter(Boolean).join(' › ')}
                                      {` · Stock ${match.product.cantidad}`}
                                    </span>
                                    <span className={`coverage-map__result-status coverage-map__result-status--${match.counted ? (isResultOk(result) ? 'ok' : 'bad') : 'none'}`}>
                                      {match.counted ? `Contado · ${describeResult(result)}` : 'Falta contar'}
                                    </span>
                                  </button>
                                </li>
                              )
                            })}
                          </ul>
                        </>
                      )}
                    </div>
                  )}
                </div>
                  </div>
                </div>
                {hasPlan ? (
                  <div className="coverage-map__plan-scroll">
                    <div
                      className="coverage-map__plan"
                      style={{ aspectRatio: `${planSize.width} / ${planSize.height}` }}
                    >
                      {shapes.map((shape) => {
                        const division = divisionsByName.get(normalizeKey(shape.nombre)) || null
                        const status = division ? getStatus(division) : 'empty'
                        const isSelected = division && selectedDivisionIds.includes(String(division.id))
                        const isMatch = searchActive && division && matchDivisionIds.has(String(division.id))
                        const isVertical = shape.alto > shape.ancho * VERTICAL_LABEL_RATIO
                        const title = division && status !== 'empty'
                          ? `${shape.nombre}: ${division.contados} de ${division.total} contados (${getPercent(division)}%)${Number(division.en_revision || 0) > 0 ? ` · ${division.en_revision} en revisión` : ''}`
                          : `${shape.nombre || 'Ubicacion'}: sin productos con stock`
                        return (
                          <button
                            type="button"
                            key={shape.id}
                            className={`coverage-map__shape coverage-map__shape--${status}${isSelected ? ' is-selected' : ''}${isMatch ? ' is-match' : ''}${isVertical ? ' coverage-map__shape--vertical' : ''}`}
                            style={{
                              left: `${(shape.x / planSize.width) * 100}%`,
                              top: `${(shape.y / planSize.height) * 100}%`,
                              width: `${(shape.ancho / planSize.width) * 100}%`,
                              height: `${(shape.alto / planSize.height) * 100}%`,
                            }}
                            title={title}
                            onClick={() => handleDivisionClick(division)}
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

                <p className="coverage-map__summary">
                  {`${totals.completas} de ${totals.perchas} perchas completas · ${totals.contados} de ${totals.total} productos contados`}
                  {totals.total > 0 ? ` (${Math.floor((totals.contados / totals.total) * 100)}%)` : ''}
                  {loading && <Loader2 size={14} className="coverage-map__spin" aria-label="Actualizando" />}
                </p>

                {(unplacedDivisions.length > 0 || !hasPlan) && (
                  <div className="coverage-map__unplaced">
                    <span>{hasPlan ? 'Perchas que no estan en el mapa:' : 'Perchas:'}</span>
                    {(hasPlan ? unplacedDivisions : bodegaDivisions.filter((division) => Number(division.total || 0) > 0)).map((division) => {
                      const isSelected = selectedDivisionIds.includes(String(division.id))
                      const isMatch = searchActive && matchDivisionIds.has(String(division.id))
                      return (
                        <button
                          type="button"
                          key={division.id}
                          className={`coverage-map__chip coverage-map__chip--${getStatus(division)}${isSelected ? ' is-selected' : ''}${isMatch ? ' is-match' : ''}`}
                          onClick={() => handleDivisionClick(division)}
                        >
                          {`${division.nombre} · ${getPercent(division)}%`}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>

              <aside className="coverage-map__side" ref={sideRef}>
                {!selectedDivisions.length ? (
                  <p className="coverage-map__hint">
                    Toca una o varias perchas para ver sus niveles, lo contado y lo que falta por contar. Otro clic la quita.
                  </p>
                ) : (
                  <>
                    <div className="coverage-map__side-head">
                      <h5>{singleDivision ? singleDivision.nombre : `${selectedDivisions.length} perchas`}</h5>
                      <span className={`coverage-map__badge coverage-map__badge--${selectionStatus}`}>
                        {STATUS_LABEL[selectionStatus]}
                      </span>
                    </div>
                    {!singleDivision && (
                      <div className="coverage-map__selection">
                        {selectedDivisions.map((division) => (
                          <button
                            type="button"
                            key={division.id}
                            className={`coverage-map__chip coverage-map__chip--${getStatus(division)}`}
                            onClick={() => toggleDivision(division)}
                            aria-label={`Quitar ${division.nombre}`}
                          >
                            {division.nombre}
                            <X size={11} aria-hidden="true" />
                          </button>
                        ))}
                      </div>
                    )}
                    <p className="coverage-map__side-meta">
                      {`${selectionTotals.contados} de ${selectionTotals.total} contados (${selectionPercent}%)`}
                      {singleDivision?.ultimo_conteo ? ` · Ultimo conteo: ${formatDateTime(singleDivision.ultimo_conteo)}` : ''}
                    </p>
                    {onSendMissing && missingProductIds.length > 0 && (
                      <div className="coverage-map__send">
                        <strong>{`Enviar faltantes a revisar (${missingProductIds.length})`}</strong>
                        <div className="coverage-map__send-row">
                          <select
                            value={missingReviewerId}
                            onChange={(event) => setMissingReviewerId(event.target.value)}
                            disabled={sendingMissing || reviewersLoading || !reviewers.length}
                            aria-label="Revisor"
                          >
                            <option value="">
                              {reviewersLoading ? 'Cargando revisores...' : reviewers.length ? 'Selecciona un revisor' : 'Sin revisores en esta sucursal'}
                            </option>
                            {reviewers.map((reviewer) => (
                              <option key={reviewer.id} value={reviewer.id}>
                                {String(reviewer?.nombre_completo || reviewer?.correo || `Usuario ${reviewer?.id}`).trim()}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="coverage-map__send-btn"
                            onClick={() => void handleSendMissing()}
                            disabled={sendingMissing || !missingReviewerId}
                          >
                            {sendingMissing ? 'Enviando...' : 'Enviar'}
                          </button>
                        </div>
                        {sentMissingMessage && (
                          <small className="coverage-map__send-ok">{sentMissingMessage}</small>
                        )}
                        {missingProductIds.length > MAX_LIST_PRODUCTS && (
                          <small>{`Se envian los primeros ${MAX_LIST_PRODUCTS}; el resto queda para otra revision.`}</small>
                        )}
                      </div>
                    )}
                    {singleDivision ? renderDivisionLevels(singleDivision) : (
                      <div className="coverage-map__groups">
                        {selectedDivisions.map((division) => (
                          <section key={division.id} className="coverage-map__group">
                            <div className="coverage-map__group-head">
                              <strong>{division.nombre}</strong>
                              <span>{`${division.contados}/${division.total} · ${getPercent(division)}%`}</span>
                            </div>
                            {renderDivisionLevels(division)}
                          </section>
                        ))}
                      </div>
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
