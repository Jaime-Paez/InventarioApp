import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Toast } from 'primereact/toast'
import { Tooltip } from 'primereact/tooltip'
import { OverlayPanel } from 'primereact/overlaypanel'
import { Checkbox } from 'primereact/checkbox'
import '../UsersTable/UsersTable.css'
import './AuditoriaTable.css'
import useModalAnimation from '../../common/useModalAnimation'
import { API_URL, authFetch } from '../../../../utils/api'
import { tableLayoutStore } from '../../../../utils/tableLayoutStore'
import { autoFitTableColumns, makeWidthStateHandlers } from '../../../../utils/autoFitColumns'
import { buildPrimeOrdering } from '../../../../utils/primeTableQuery'

const ACCION_COLORS = {
  creacion: '#22c55e',
  actualizacion: '#3b82f6',
  eliminacion: '#ef4444',
  otro: '#a78bfa',
}
const ACCION_LABELS = {
  creacion: 'Creación',
  actualizacion: 'Actualización',
  eliminacion: 'Eliminación',
  otro: 'Otro',
}

const MODAL_MIN_W = 640
const MODAL_MIN_H = 480
const MODAL_PAD = 12

const emptyFilters = () => ({
  usuario_search: '',
  accion: '',
  modelo: '',
  fecha_desde: '',
  fecha_hasta: '',
})

const columnsData = [
  { field: 'id', header: 'ID', small: true },
  { field: 'usuario', header: 'Usuario' },
  { field: 'accion', header: 'Acción', small: true },
  { field: 'modelo', header: 'Modelo' },
  { field: 'representacion_objeto', header: 'Objeto' },
  { field: 'registrado_en', header: 'Fecha / Hora' },
]

const AUDITORIA_ORDERING_MAP = {
  id: 'id',
  usuario: 'usuario',
  accion: 'accion',
  modelo: 'modelo',
  representacion_objeto: 'representacion_objeto',
  registrado_en: 'registrado_en',
}

function AuditoriaTable({ token }) {
  const toast = useRef(null)
  const opRef = useRef(null)
  const tableWrapperRef = useRef(null)
  const widthHandlers = useMemo(() => makeWidthStateHandlers('auditoria-table-state-v2'), [])
  const [tableResetKey, setTableResetKey] = useState(0)

  const [records, setRecords] = useState([])
  const [totalRecords, setTotalRecords] = useState(0)
  const [loading, setLoading] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isQuickSearchLoading, setIsQuickSearchLoading] = useState(false)
  const [error, setError] = useState(null)

  // server-side page
  const [page, setPage] = useState(1)
  const [first, setFirst] = useState(0)
  const [rows, setRows] = useState(25)

  // server-side sort
  const [sortField, setSortField] = useState(null)
  const [sortOrder, setSortOrder] = useState(null)

  // quick search (inline)
  const [quickSearch, setQuickSearch] = useState('')
  const quickSearchDebounce = useRef(null)

  // advanced filters (applied via modal)
  const [filters, setFilters] = useState(emptyFilters())
  const [pending, setPending] = useState(emptyFilters())

  // column visibility
  const [selectedColumns, setSelectedColumns] = useState(columnsData)

  useEffect(() => {
    const stored = tableLayoutStore.getItem('auditoria-table-columns')
    if (stored) {
      try {
        const parsed = JSON.parse(stored)
        const columnsByField = new Map(columnsData.map((c) => [c.field, c]))
        const restored = (Array.isArray(parsed) ? parsed : [])
          .map((c) => columnsByField.get(c?.field))
          .filter(Boolean)
        if (restored.length > 0) setSelectedColumns(restored)
      } catch {
        // ignore
      }
    }
    // No cleanup-based flush here: handleToggleColumn already persists
    // synchronously on every real change.
  }, [])

  const handleToggleColumn = (col) => {
    setSelectedColumns((prev) => {
      const next = prev.some((c) => c.field === col.field)
        ? prev.filter((c) => c.field !== col.field)
        : [...columnsData.filter((c) => prev.some((p) => p.field === c.field) || c.field === col.field)]
      tableLayoutStore.setItemNow('auditoria-table-columns', JSON.stringify(next))
      return next
    })
  }

  const fetchRecords = useCallback(async (overrides = {}) => {
    if (!token) return
    const isRefresh = overrides.refresh === true
    const isQuick = overrides.quick === true
    if (isRefresh) setIsRefreshing(true)
    else if (isQuick) setIsQuickSearchLoading(true)
    else setLoading(true)
    setError(null)
    try {
      const p = new URLSearchParams()
      const search = overrides.search ?? quickSearch
      const f = overrides.filters ?? filters
      if (search) p.set('search', search)
      if (f.usuario_search) p.set('usuario_search', f.usuario_search)
      if (f.accion) p.set('accion', f.accion)
      if (f.modelo) p.set('modelo', f.modelo)
      if (f.fecha_desde) p.set('fecha_desde', f.fecha_desde)
      if (f.fecha_hasta) p.set('fecha_hasta', f.fecha_hasta)
      p.set('page', String(overrides.page ?? page))
      p.set('page_size', String(overrides.rows ?? rows))

      const nextSortField = overrides.sortField ?? sortField
      const nextSortOrder = overrides.sortOrder ?? sortOrder
      const ordering = buildPrimeOrdering(nextSortField, nextSortOrder, AUDITORIA_ORDERING_MAP)
      if (ordering) p.set('ordering', ordering)

      const res = await authFetch(`${API_URL}/auditoria/registros/?${p.toString()}`, {}, token)
      if (!res.ok) throw new Error('No se pudieron cargar los registros de auditoría.')
      const data = await res.json()
      setRecords(Array.isArray(data.results) ? data.results : [])
      setTotalRecords(data.count ?? 0)
    } catch (e) {
      const msg = e?.message || 'Error al cargar los registros.'
      setError(msg)
      toast.current?.show({ severity: 'warn', summary: 'Aviso', detail: msg, life: 3500 })
    } finally {
      setLoading(false)
      setIsRefreshing(false)
      setIsQuickSearchLoading(false)
    }
  }, [token, quickSearch, filters, page, rows, sortField, sortOrder])

  useEffect(() => {
    void fetchRecords()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, page, rows, quickSearch, filters, sortField, sortOrder])

  // cleanup debounce on unmount
  useEffect(() => () => {
    if (quickSearchDebounce.current) clearTimeout(quickSearchDebounce.current)
  }, [])

  const handlePage = (e) => {
    setFirst(e.first)
    setRows(e.rows)
    setPage(Math.floor(e.first / e.rows) + 1)
  }

  const handleSortChange = (e) => {
    const rawSortOrder = Number(e?.sortOrder)
    const normalizedSortOrder = rawSortOrder === 1 || rawSortOrder === -1 ? rawSortOrder : null
    const nextSortField = normalizedSortOrder ? e?.sortField || null : null
    setSortField(nextSortField)
    setSortOrder(normalizedSortOrder)
    setPage(1)
    setFirst(0)
  }

  const handleRefresh = () => {
    if (quickSearchDebounce.current) clearTimeout(quickSearchDebounce.current)
    setIsQuickSearchLoading(false)
    setIsRefreshing(true)
    void fetchRecords({ refresh: true })
  }

  const handleQuickSearchChange = (e) => {
    const value = e.target.value
    setQuickSearch(value)
    if (quickSearchDebounce.current) clearTimeout(quickSearchDebounce.current)
    setIsQuickSearchLoading(true)
    quickSearchDebounce.current = setTimeout(() => {
      setPage(1)
      setFirst(0)
    }, 450)
  }

  const handleClearAll = () => {
    if (quickSearchDebounce.current) clearTimeout(quickSearchDebounce.current)
    setIsQuickSearchLoading(false)
    setQuickSearch('')
    setFilters(emptyFilters())
    setPage(1)
    setFirst(0)
    setSortField(null)
    setSortOrder(null)
  }

  const autoFitColumns = useCallback(() => {
    autoFitTableColumns(tableWrapperRef.current, 'auditoria-table-state-v2')
  }, [])

  const handleResetTable = () => {
    tableLayoutStore.removeItem('auditoria-table-columns')
    tableLayoutStore.removeItem('auditoria-table-state-v2')
    setSelectedColumns(columnsData)
    handleClearAll()
    setTableResetKey((k) => k + 1)
    opRef.current?.hide()
  }

  // ---- modal drag/resize ----
  const [showModal, setShowModal] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)
  const [modalPos, setModalPos] = useState({ x: 0, y: 0 })
  const [modalSize, setModalSize] = useState({ width: 720, height: 520 })
  const modalRef = useRef(null)
  const dragRef = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const resizeRef = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const sizeRef = useRef(modalSize)
  const posRef = useRef(modalPos)
  const restoreRef = useRef(null)

  useEffect(() => { sizeRef.current = modalSize }, [modalSize])
  useEffect(() => { posRef.current = modalPos }, [modalPos])

  useLayoutEffect(() => {
    if (!showModal) return
    setIsMaximized(false)
    restoreRef.current = null
    const w = Math.min(720, window.innerWidth - MODAL_PAD * 2)
    const h = Math.min(520, window.innerHeight - MODAL_PAD * 2)
    setModalSize({ width: w, height: h })
    setModalPos({
      x: Math.max((window.innerWidth - w) / 2, MODAL_PAD),
      y: Math.max((window.innerHeight - h) / 2, MODAL_PAD),
    })
  }, [showModal])

  const handleHeaderMouseDown = (e) => {
    if (isMaximized || !modalRef.current) return
    const rect = modalRef.current.getBoundingClientRect()
    dragRef.current = { active: true, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top }
  }

  const handleResizeMouseDown = (e) => {
    if (isMaximized) return
    e.preventDefault()
    e.stopPropagation()
    resizeRef.current = { active: true, startX: e.clientX, startY: e.clientY, startWidth: sizeRef.current.width, startHeight: sizeRef.current.height }
    const onMove = (ev) => {
      if (!resizeRef.current.active) return
      const dx = ev.clientX - resizeRef.current.startX
      const dy = ev.clientY - resizeRef.current.startY
      const maxW = Math.max(MODAL_MIN_W, window.innerWidth - posRef.current.x - MODAL_PAD)
      const maxH = Math.max(MODAL_MIN_H, window.innerHeight - posRef.current.y - MODAL_PAD)
      setModalSize({ width: Math.min(Math.max(resizeRef.current.startWidth + dx, MODAL_MIN_W), maxW), height: Math.min(Math.max(resizeRef.current.startHeight + dy, MODAL_MIN_H), maxH) })
    }
    const onUp = () => { resizeRef.current.active = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  useEffect(() => {
    const onMove = (e) => {
      if (!dragRef.current.active) return
      e.preventDefault()
      const maxX = window.innerWidth - sizeRef.current.width - MODAL_PAD
      const maxY = window.innerHeight - sizeRef.current.height - MODAL_PAD
      setModalPos({ x: Math.min(Math.max(e.clientX - dragRef.current.offsetX, MODAL_PAD), Math.max(maxX, MODAL_PAD)), y: Math.min(Math.max(e.clientY - dragRef.current.offsetY, MODAL_PAD), Math.max(maxY, MODAL_PAD)) })
    }
    const onUp = () => { dragRef.current.active = false }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])

  useEffect(() => {
    const onResize = () => {
      if (!showModal) return
      if (isMaximized) { setModalSize({ width: Math.max(0, window.innerWidth - MODAL_PAD * 2), height: Math.max(0, window.innerHeight - MODAL_PAD * 2) }); setModalPos({ x: MODAL_PAD, y: MODAL_PAD }); return }
      setModalSize((prev) => { const w = Math.min(Math.max(prev.width, MODAL_MIN_W), window.innerWidth - MODAL_PAD * 2); const h = Math.min(Math.max(prev.height, MODAL_MIN_H), window.innerHeight - MODAL_PAD * 2); setModalPos((pp) => ({ x: Math.min(Math.max(pp.x, MODAL_PAD), Math.max(window.innerWidth - w - MODAL_PAD, MODAL_PAD)), y: Math.min(Math.max(pp.y, MODAL_PAD), Math.max(window.innerHeight - h - MODAL_PAD, MODAL_PAD)) })); return { width: w, height: h } })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [isMaximized, showModal])

  const toggleMaximize = () => {
    if (isMaximized) {
      const r = restoreRef.current
      if (r) { setModalSize(r.size); setModalPos(r.position) }
      setIsMaximized(false)
    } else {
      restoreRef.current = { size: sizeRef.current, position: posRef.current }
      setModalSize({ width: Math.max(0, window.innerWidth - MODAL_PAD * 2), height: Math.max(0, window.innerHeight - MODAL_PAD * 2) })
      setModalPos({ x: MODAL_PAD, y: MODAL_PAD })
      setIsMaximized(true)
    }
  }

  const openModal = () => { setPending({ ...filters }); setShowModal(true) }

  const handleSubmit = (e) => {
    e.preventDefault()
    setFilters({ ...pending })
    setPage(1)
    setFirst(0)
    setShowModal(false)
  }

  const { shouldRender: shouldRenderModal, isClosing: isClosingModal } = useModalAnimation(showModal)

  // ---- body templates ----
  const usuarioTemplate = (row) => {
    const u = row.usuario
    if (!u) return <span style={{ color: '#9ca3af' }}>Sistema</span>
    const label = u.nombre || u.email || `#${u.id}`
    return <span className="cell-tooltip" data-pr-tooltip={u.email ? `${label} · ${u.email}` : label}>{label}</span>
  }

  const accionTemplate = (row) => {
    const color = ACCION_COLORS[row.accion] || '#9ca3af'
    const label = ACCION_LABELS[row.accion] || row.accion_display || row.accion
    return <span className={`auditoria-badge auditoria-badge--${row.accion}`} style={{ '--badge-color': color }}>{label}</span>
  }

  const modeloTemplate = (row) => {
    const text = row.modelo || '-'
    const tooltip = row.modelo ? `${row.app_label}.${row.modelo}` : '-'
    return <span className="cell-tooltip" data-pr-tooltip={tooltip} style={{ color: !row.modelo ? '#9ca3af' : undefined }}>{text}</span>
  }

  const objetoTemplate = (row) => {
    const text = row.representacion_objeto || row.object_id || '-'
    return <span className="cell-tooltip" data-pr-tooltip={text} style={{ color: text === '-' ? '#9ca3af' : undefined }}>{text}</span>
  }

  const fechaTemplate = (row) => {
    if (!row.registrado_en) return <span style={{ color: '#9ca3af' }}>-</span>
    const d = new Date(row.registrado_en)
    const fecha = d.toLocaleDateString('es-EC', { day: '2-digit', month: '2-digit', year: 'numeric' })
    const hora = d.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const label = `${fecha}  ${hora}`
    return <span className="cell-tooltip" data-pr-tooltip={d.toISOString()}>{label}</span>
  }

  const getColumnBody = (col) => {
    switch (col.field) {
      case 'id': return (row) => <span className="cell-tooltip" data-pr-tooltip={String(row.id)}>{row.id}</span>
      case 'usuario': return usuarioTemplate
      case 'accion': return accionTemplate
      case 'modelo': return modeloTemplate
      case 'representacion_objeto': return objetoTemplate
      case 'registrado_en': return fechaTemplate
      default: return (row) => <span>{row[col.field] ?? '-'}</span>
    }
  }

  const header = (
    <div className="users-header">
      <div className="users-header__left">
        <div className="search-input-container">
          <input
            type="text"
            value={quickSearch}
            onChange={handleQuickSearchChange}
            className="search-input"
            placeholder="Buscar en tabla"
          />
          <i className={`pi ${isQuickSearchLoading ? 'pi-spinner pi-spin' : 'pi-search'} search-input-icon`} />
        </div>

        <button className="rounded-icon-btn" type="button" onClick={handleRefresh} disabled={loading || isRefreshing} title="Recargar">
          <i className={`pi ${isRefreshing ? 'pi-spin pi-spinner' : 'pi-refresh'}`} />
        </button>

        <button className="rounded-icon-btn" type="button" onClick={handleClearAll} title="Limpiar filtros">
          <i className="pi pi-filter-slash" />
        </button>

        <button
          className="rounded-icon-btn"
          type="button"
          onClick={autoFitColumns}
          title="Ajustar columnas"
        >
          <i className="pi pi-arrows-h" />
        </button>

        <button
          className="rounded-icon-btn"
          type="button"
          onClick={(e) => opRef.current?.toggle(e)}
          title="Campos"
        >
          <i className="pi pi-sliders-h" />
        </button>
      </div>

      <div className="users-header__right">
        <span className="users-header__count">Reg. {totalRecords}</span>
      </div>
    </div>
  )

  return (
    <div className="users-page">
      <Tooltip position="top" showDelay={1800} target=".cell-tooltip" style={{ maxWidth: '400px' }} />
      <Toast ref={toast} />

      <div className="users-page__top">
        <div className="users-page__actions">
          <button className="users-topbtn p-button p-component" type="button" onClick={openModal}>
            <i className="pi pi-search p-button-icon p-button-icon-left" />
            <span className="p-button-label">Buscar</span>
          </button>
        </div>
      </div>

      <div className="users-table users-table--card" ref={tableWrapperRef}>
        {(loading || isRefreshing) && (
          <div className="spinner-container spinner-container--table">
            <div className="spinner" />
          </div>
        )}

        {error && (
          <div className="stale-data-msg">
            <i className="pi pi-exclamation-circle" style={{ fontSize: '0.8rem', margin: 0, color: 'white' }} />
            <span><strong>Los datos pueden estar desactualizados</strong> | intenta recargar la tabla</span>
          </div>
        )}

        <DataTable
          value={records}
          dataKey="id"
          header={header}
          className={`users-datatable${loading || isRefreshing ? ' users-datatable--loading-content' : ''}`}
          tableStyle={{ width: '100%' }}
          emptyMessage="No se encontraron registros"
          showGridlines
          size="small"
          scrollable
          scrollHeight="flex"
          lazy
          paginator
          rows={rows}
          totalRecords={totalRecords}
          first={first}
          onPage={handlePage}
          rowsPerPageOptions={[5, 10, 25, 50]}
          sortField={sortField || undefined}
          sortOrder={sortOrder || 0}
          onSort={handleSortChange}
          removableSort
          key={tableResetKey}
          resizableColumns
          columnResizeMode="fit"
          stateStorage="custom"
          customSaveState={widthHandlers.save}
          customRestoreState={widthHandlers.restore}
        >
          {selectedColumns.map((col) => (
            <Column
              key={col.field}
              field={col.field}
              header={col.header}
              sortable
              className={col.small ? 'column-max-min-width--small' : 'column-max-min-width'}
              headerClassName={col.small ? 'column-max-min-width--small' : 'column-max-min-width'}
              style={col.field === 'id' ? { minWidth: '70px', maxWidth: '90px' } : undefined}
              body={getColumnBody(col)}
            />
          ))}
        </DataTable>

        <OverlayPanel ref={opRef} className="table-options-list">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <strong>Campos</strong>
            <button className="rounded-icon-btn" type="button" onClick={handleResetTable} title="Restablecer tabla" style={{ width: 28, height: 28 }}>
              <i className="pi pi-refresh" />
            </button>
          </div>
          {columnsData.map((col, idx) => (
            <div key={idx} className="p-field-checkbox" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
              <Checkbox
                inputId={`auditoria-col-${idx}`}
                value={col}
                onChange={() => handleToggleColumn(col)}
                checked={selectedColumns.some((c) => c.field === col.field)}
              />
              <label htmlFor={`auditoria-col-${idx}`} style={{ cursor: 'pointer' }}>
                {col.header}
              </label>
            </div>
          ))}
        </OverlayPanel>
      </div>

      {shouldRenderModal && (
        <div
          className={`create-user__overlay${isClosingModal ? ' create-user__overlay--closing' : ''}`}
          role="dialog"
          aria-modal="true"
          style={{ padding: `${MODAL_PAD}px` }}
        >
          <div
            className={`create-user__modal${isClosingModal ? ' create-user__modal--closing' : ''}`}
            ref={modalRef}
            style={{
              top: modalPos.y,
              left: modalPos.x,
              width: modalSize.width,
              height: modalSize.height,
              maxWidth: `calc(100vw - ${MODAL_PAD * 2}px)`,
              maxHeight: `calc(100vh - ${MODAL_PAD * 2}px)`,
            }}
          >
            <header className="create-user__header" onMouseDown={handleHeaderMouseDown}>
              <div className="create-user__header-text">
                <h3>Buscar registros</h3>
              </div>
              <div className="create-user__header-actions">
                <button
                  type="button"
                  className="create-user__icon-button create-user__icon-button--maximize"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={toggleMaximize}
                  aria-label={isMaximized ? 'Restaurar' : 'Maximizar'}
                >
                  <i className={isMaximized ? 'pi pi-window-minimize' : 'pi pi-window-maximize'} aria-hidden="true" />
                </button>
                <button type="button" className="create-user__icon-button" onClick={() => setShowModal(false)} aria-label="Cerrar">
                  <i className="pi pi-times" aria-hidden="true" />
                </button>
              </div>
            </header>

            <form className="create-user__form" onSubmit={handleSubmit}>
              <div className="create-user__body">
                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Filtros</p>
                      <h4>Búsqueda avanzada</h4>
                    </div>
                  </div>

                  <div className="create-user__grid create-user__grid--two">
                    <label className="create-user__field" style={{ gridColumn: '1 / -1' }}>
                      <span>Usuario</span>
                      <input
                        type="text"
                        placeholder="Nombre, apellido o correo del usuario"
                        value={pending.usuario_search}
                        onChange={(e) => setPending((p) => ({ ...p, usuario_search: e.target.value }))}
                      />
                    </label>

                    <label className="create-user__field">
                      <span>Acción</span>
                      <select
                        value={pending.accion}
                        onChange={(e) => setPending((p) => ({ ...p, accion: e.target.value }))}
                        className={!pending.accion ? 'is-placeholder' : undefined}
                      >
                        <option value="">Todas</option>
                        <option value="creacion">Creación</option>
                        <option value="actualizacion">Actualización</option>
                        <option value="eliminacion">Eliminación</option>
                        <option value="otro">Otro</option>
                      </select>
                    </label>

                    <label className="create-user__field">
                      <span>Modelo</span>
                      <input
                        type="text"
                        placeholder="Ej: producto, inventario…"
                        value={pending.modelo}
                        onChange={(e) => setPending((p) => ({ ...p, modelo: e.target.value }))}
                      />
                    </label>

                    <label className="create-user__field">
                      <span>Fecha desde</span>
                      <input
                        type="date"
                        value={pending.fecha_desde}
                        onChange={(e) => setPending((p) => ({ ...p, fecha_desde: e.target.value }))}
                      />
                    </label>

                    <label className="create-user__field">
                      <span>Fecha hasta</span>
                      <input
                        type="date"
                        value={pending.fecha_hasta}
                        onChange={(e) => setPending((p) => ({ ...p, fecha_hasta: e.target.value }))}
                      />
                    </label>
                  </div>
                </section>
              </div>

              <div className="create-user__footer">
                <div className="user-details__footer-left">
                  <button type="button" className="create-user__action" onClick={() => setPending(emptyFilters())}>
                    Limpiar filtros
                  </button>
                  <button type="button" className="create-user__action create-user__action--cancel" onClick={() => setShowModal(false)}>
                    Cancelar
                  </button>
                </div>
                <div className="user-details__footer-right">
                  <button type="submit" className="create-user__action create-user__action--primary">
                    Buscar
                  </button>
                </div>
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
      )}
    </div>
  )
}

export default AuditoriaTable
