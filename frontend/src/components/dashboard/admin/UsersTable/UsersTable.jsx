import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FilterMatchMode } from 'primereact/api'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Toast } from 'primereact/toast'
import { Tooltip } from 'primereact/tooltip'
import { OverlayPanel } from 'primereact/overlaypanel'
import { Checkbox } from 'primereact/checkbox'
import { Button } from 'primereact/button'

import CreateUsuario from '../CreateUsuario/CreateUsuario'
import UsersDetails from '../UsersDetails/UsersDetails'
import './UsersTable.css'

import useModalAnimation from '../../common/useModalAnimation'
import { API_URL, authFetch } from '../../../../utils/api'
import { tableLayoutStore } from '../../../../utils/tableLayoutStore'
import { buildFileName, exportToExcel, exportToPdf } from '../../../../utils/exportUtils'
import { autoFitTableColumns, makeWidthStateHandlers } from '../../../../utils/autoFitColumns'

const formatFullName = (u) =>
  [u?.nombres, u?.apellidos].filter(Boolean).join(' ').trim() || u?.nombre || '-'

const normId = (v) => (v == null ? null : String(v))
const isCheckboxSelection = (event) => {
  const type = event?.type
  if (type === 'checkbox' || type === 'all') return true
  const target = event?.originalEvent?.target
  if (!target) return true
  if (target.type === 'checkbox') return true
  return Boolean(
    target.closest?.('.p-checkbox, .p-checkbox-box, .p-checkbox-icon, .p-checkbox-input, .row-selection-column')
  )
}


function UsersTable({
  token,
  onSelect,
  moduleActions,

  onExportExcel,
  onExportPdf,
}) {
  const toast = useRef(null)
  const opColumns = useRef(null)
  const tableWrapperRef = useRef(null)
  const widthHandlers = useMemo(() => makeWidthStateHandlers('usuarios-table-state-v2'), [])
  const [tableResetKey, setTableResetKey] = useState(0)
  const canCreate = moduleActions?.puede_crear ?? true
  const canEdit = moduleActions?.puede_actualizar ?? true
  const canDelete = moduleActions?.puede_eliminar ?? true

  const showErrorToast = useCallback(
    (detail, summary = 'Error') =>
      toast.current?.show({
        severity: 'error',
        summary,
        detail,
        life: 4000,
      }),
    []
  )

  const [users, setUsers] = useState([])
  const [allUsers, setAllUsers] = useState([])
  const [loading, setLoading] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isQuickSearchLoading, setIsQuickSearchLoading] = useState(false)
  const [error, setError] = useState(null)
  const [sortField, setSortField] = useState(null)
  const [sortOrder, setSortOrder] = useState(null)

  const fetchUsers = useCallback(async (searchTerm = '', options = {}) => {
    const withOverlay = options?.withOverlay !== false
    if (withOverlay) {
      setLoading(true)
    } else {
      setIsQuickSearchLoading(true)
    }
    setError(null)
    try {
      const list = []
      const normalizedSearch = String(searchTerm ?? '').trim()
      const searchQuery = normalizedSearch ? `?search=${encodeURIComponent(normalizedSearch)}` : ''
      let url = `${API_URL}/usuarios/listado/${searchQuery}`

      while (url) {
        const res = await authFetch(url, {}, token)
        if (!res.ok) throw new Error('No se pudo obtener la lista de usuarios.')

        const data = await res.json()
        if (Array.isArray(data)) {
          list.push(...data)
          url = null
        } else {
          const pageList = Array.isArray(data?.results) ? data.results : []
          list.push(...pageList)
          url = data?.next || null
        }
      }

      setUsers(list)
      setAllUsers(list)
      return list
    } catch (e) {
      const msg = e?.message || 'Ocurrió un error al cargar los usuarios.'
      setError(msg)
      toast.current?.show({ severity: 'warn', summary: 'Aviso', detail: msg, life: 3500 })
    } finally {
      if (withOverlay) {
        setLoading(false)
      } else {
        setIsQuickSearchLoading(false)
      }
      setIsRefreshing(false)
    }
  }, [token])

  useEffect(() => {
    fetchUsers()
  }, [fetchUsers])

  const refreshData = () => {
    if (globalSearchDebounceRef.current) {
      clearTimeout(globalSearchDebounceRef.current)
    }
    setIsQuickSearchLoading(false)
    setIsRefreshing(true)
    fetchUsers(globalFilterValue)
  }

  // ---------------- Filters ----------------
  const [filters, setFilters] = useState(null)
  const [globalFilterValue, setGlobalFilterValue] = useState('')
  const globalSearchDebounceRef = useRef(null)

  useEffect(
    () => () => {
      if (globalSearchDebounceRef.current) {
        clearTimeout(globalSearchDebounceRef.current)
      }
    },
    []
  )

  const initFilters = (preserveSearch = false) => {
    setFilters({
      global: { value: preserveSearch ? (globalFilterValue || null) : null, matchMode: FilterMatchMode.CONTAINS },
    })
    if (!preserveSearch) setGlobalFilterValue('')
  }

  useEffect(() => {
    initFilters()
  }, [])

  const handleSortChange = (event) => {
    const order = Number(event?.sortOrder)
    const normalizedOrder = order === 1 || order === -1 ? order : null
    const field = normalizedOrder ? (event?.sortField || null) : null
    setSortField(field)
    setSortOrder(normalizedOrder)
  }

  const clearFilter = () => {
    if (globalSearchDebounceRef.current) {
      clearTimeout(globalSearchDebounceRef.current)
    }
    setIsQuickSearchLoading(false)
    setSortField(null)
    setSortOrder(null)
    initFilters(true)
    setIsRefreshing(true)
    fetchUsers(globalFilterValue)
  }

  const autoFitColumns = useCallback(() => {
    autoFitTableColumns(tableWrapperRef.current, 'usuarios-table-state-v2')
  }, [])

  const handleResetTable = () => {
    tableLayoutStore.removeItem('usuarios-table-columns')
    tableLayoutStore.removeItem('usuarios-table-state-v2')
    setSelectedColumns(columnsData)
    clearFilter()
    setTableResetKey((k) => k + 1)
    opColumns.current?.hide()
  }

  const handleGlobalFilterChange = (event) => {
    const value = event.target.value
    setGlobalFilterValue(value)
    const nextFilters = {
      ...(filters || {}),
      global: { value: value || null, matchMode: FilterMatchMode.CONTAINS },
    }
    setFilters(nextFilters)
    if (globalSearchDebounceRef.current) {
      clearTimeout(globalSearchDebounceRef.current)
    }
    setIsQuickSearchLoading(true)
    globalSearchDebounceRef.current = setTimeout(() => {
      fetchUsers(value, { withOverlay: false })
    }, 500)
  }

  const initialSearchCriteria = {
    codigo: '',
    nombre: '',
    correo: '',
    telefono: '',
    cargo: '',
    activo: '',
    fecha_creacion: '',
  }

  const [searchCriteria, setSearchCriteria] = useState(initialSearchCriteria)
  const [showSearchModal, setShowSearchModal] = useState(false)
  const lastSearchRef = useRef({ ...initialSearchCriteria })
  const [isSearchMaximized, setIsSearchMaximized] = useState(false)
  const [searchPosition, setSearchPosition] = useState({ x: 0, y: 0 })
  const [searchSize, setSearchSize] = useState({ width: 720, height: 520 })
  const searchModalRef = useRef(null)
  const searchDrag = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const searchResize = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const searchSizeRef = useRef(searchSize)
  const searchPosRef = useRef(searchPosition)
  const searchRestoreRef = useRef(null)
  const SEARCH_MIN_WIDTH = 640
  const SEARCH_MIN_HEIGHT = 480
  const SEARCH_PADDING = 12

  const normalizeValue = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
  const contains = (fieldValue, target) => {
    const needle = normalizeValue(target)
    if (!needle) return true
    return normalizeValue(fieldValue).includes(needle)
  }
  const exact = (fieldValue, target) => {
    const needle = normalizeValue(target)
    if (!needle) return true
    return normalizeValue(fieldValue) === needle
  }
  const pickValue = (row, keys) => {
    for (const key of keys) {
      const value = key.split('.').reduce((acc, part) => acc?.[part], row)
      if (value != null && value !== '') return value
    }
    return ''
  }

  const applySearchFilters = useCallback(
    (list, criteria) =>
      list.filter((row) => {
        const dateValue = pickValue(row, ['fecha_creacion', 'created_at', 'creado_en', 'registrado_en'])
        const activoValue = String(row?.activo ?? '').toLowerCase()
        const activoCriteria = normalizeValue(criteria.activo)

        return (
          contains(row?.codigo, criteria.codigo) &&
          contains(formatFullName(row), criteria.nombre) &&
          contains(row?.correo, criteria.correo) &&
          contains(row?.telefono, criteria.telefono) &&
          contains(row?.cargo, criteria.cargo) &&
          (activoCriteria ? activoValue === activoCriteria : true) &&
          contains(dateValue, criteria.fecha_creacion)
        )
      }),
    []
  )

  const handleSearchInputChange = (event) => {
    const { name, value } = event.target
    setSearchCriteria((prev) => ({
      ...prev,
      [name]: value,
    }))
  }

  const handleSearchSubmit = async (event) => {
    event.preventDefault()
    lastSearchRef.current = { ...searchCriteria }
    setShowSearchModal(false)
    const source = allUsers.length ? allUsers : (await fetchUsers()) || []
    setUsers(applySearchFilters(source, lastSearchRef.current))
  }


  // =========================================================
  // OK. Row selection (Prime nativo) + persistencia por IDs
  // =========================================================
  const [selectedUsers, setSelectedUsers] = useState([]) // rows completos

  const selectedRowIds = useMemo(
    () => (selectedUsers || []).map((u) => normId(u?.id)).filter(Boolean),
    [selectedUsers]
  )

  const allRowIds = useMemo(() => users.map((u) => normId(u?.id)).filter(Boolean), [users])
  const allRowsSelected = allRowIds.length > 0 && selectedRowIds.length === allRowIds.length

  // Restore selección (IDs) al iniciar
  useEffect(() => {
    const saved = sessionStorage.getItem('usuarios-table-selected-rows')
    if (!saved) return
    try {
      const parsed = JSON.parse(saved)
      const ids = (parsed.selectedRowIds || []).map(normId).filter(Boolean)
      // guardamos IDs pendientes; los convertimos a rows cuando exista `users`
      sessionStorage.setItem('usuarios-table-selected-rows-pending', JSON.stringify({ ids }))
    } catch {
      sessionStorage.removeItem('usuarios-table-selected-rows')
      sessionStorage.removeItem('usuarios-table-selected-rows-pending')
    }
  }, [])

  // Cuando cambia users, aplica la selección pendiente (ids -> rows)
  useEffect(() => {
    const pending = sessionStorage.getItem('usuarios-table-selected-rows-pending')
    if (!pending) return
    try {
      const parsed = JSON.parse(pending)
      const ids = (parsed.ids || []).map(normId).filter(Boolean)
      if (!ids.length) {
        setSelectedUsers([])
        sessionStorage.removeItem('usuarios-table-selected-rows-pending')
        return
      }
      const map = new Map(users.map((u) => [normId(u?.id), u]))
      const rows = ids.map((id) => map.get(id)).filter(Boolean)
      setSelectedUsers(rows)
      sessionStorage.removeItem('usuarios-table-selected-rows-pending')
    } catch {
      sessionStorage.removeItem('usuarios-table-selected-rows-pending')
    }
  }, [users])

  // Limpia selección si ya no existe en la data
  useEffect(() => {
    if (!users?.length) {
      if (selectedUsers?.length) setSelectedUsers([])
      return
    }
    const idsSet = new Set(allRowIds)
    const filtered = (selectedUsers || []).filter((u) => idsSet.has(normId(u?.id)))
    if (filtered.length !== (selectedUsers || []).length) setSelectedUsers(filtered)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [users])

  // Persistir IDs
  useEffect(() => {
    sessionStorage.setItem(
      'usuarios-table-selected-rows',
      JSON.stringify({
        selectedRowIds,
        allRowsSelected,
      })
    )
  }, [selectedRowIds, allRowsSelected])

  // OK. Estilos duros para clavar el ancho (header + body)
  const selectionColStyle = useMemo(
    () => ({
      width: '40px',
      minWidth: '40px',
      maxWidth: '40px',
      textAlign: 'center',
    }),
    []
  )

  // ---------------- Columns ----------------
  const columnsData = useMemo(
    () => [
      { nombrevar: 'codigo', header: 'Código', filterPlaceholder: 'Buscar por código' },
      { nombrevar: 'nombre', header: 'Nombre', filterPlaceholder: 'Buscar por nombre' },
      { nombrevar: 'correo', header: 'Correo', filterPlaceholder: 'Buscar por correo' },
      { nombrevar: 'telefono', header: 'Teléfono', filterPlaceholder: 'Buscar por teléfono' },
      { nombrevar: 'cargo', header: 'Cargo', filterPlaceholder: 'Buscar por cargo' },
      { nombrevar: 'activo', header: 'Estado', filterPlaceholder: 'Filtrar estado' },
    ],
    []
  )

  const [selectedColumns, setSelectedColumns] = useState(columnsData)
  const selectedColumnsRef = useRef(selectedColumns)
  const [processedRows, setProcessedRows] = useState(null)

  useEffect(() => {
    selectedColumnsRef.current = selectedColumns
  }, [selectedColumns])

  useEffect(() => {
    const stored = tableLayoutStore.getItem('usuarios-table-columns')
    if (stored) setSelectedColumns(JSON.parse(stored))
    return () => {
      tableLayoutStore.setItem('usuarios-table-columns', JSON.stringify(selectedColumnsRef.current))
    }
  }, [])

  const handleCheckboxChangeColumn = (column) => {
    const next = selectedColumns.some((c) => c.nombrevar === column.nombrevar)
      ? selectedColumns.filter((c) => c.nombrevar !== column.nombrevar)
      : [...selectedColumns, column]
    setSelectedColumns(next)
    tableLayoutStore.setItem('usuarios-table-columns', JSON.stringify(next))
  }

  const handleOrderChange = (e) => {
    const columnOrder = e.columns.map((col) => col.props.field)
    const sorted = columnOrder.map((f) => selectedColumns.find((c) => c.nombrevar === f)).filter(Boolean)
    setSelectedColumns(sorted)
    tableLayoutStore.setItem('usuarios-table-columns', JSON.stringify(sorted))
  }

  const exportColumns = useMemo(
    () => selectedColumns.map((col) => ({ key: col.nombrevar, header: col.header })),
    [selectedColumns]
  )

  const getExportValue = useCallback((row, field) => {
    switch (field) {
      case 'codigo':
        return row?.codigo ?? row?.id ?? ''
      case 'nombre':
        return formatFullName(row)
      case 'correo':
        return row?.correo ?? row?.email ?? ''
      case 'activo': {
        const v = row?.activo
        const isTrue = v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true'
        return isTrue ? 'Activo' : 'Inactivo'
      }
      default:
        return row?.[field] ?? ''
    }
  }, [])

  const getRowsToExport = useCallback(() => {
    if (selectedUsers?.length) return selectedUsers
    return processedRows === null ? users : processedRows
  }, [processedRows, selectedUsers, users])

  const notifyExportWarning = useCallback((detail) => {
    toast.current?.show({ severity: 'warn', summary: 'Sin datos', detail, life: 3000 })
  }, [])

  const handleExportExcel = useCallback(async () => {
    if (!exportColumns.length) {
      notifyExportWarning('Selecciona al menos una columna para exportar.')
      return
    }
    const baseRows = processedRows === null ? users : processedRows
    if (!selectedUsers?.length) {
      notifyExportWarning(baseRows.length ? 'Debe seleccionar al menos una fila para generar el reporte.' : 'No hay registros para exportar.')
      return
    }
    const rows = selectedUsers
    await exportToExcel({
      rows,
      columns: exportColumns,
      valueGetter: getExportValue,
      fileName: buildFileName('usuarios'),
    })
  }, [exportColumns, getExportValue, notifyExportWarning, processedRows, selectedUsers, users])

  const handleExportPdf = useCallback(async () => {
    if (!exportColumns.length) {
      notifyExportWarning('Selecciona al menos una columna para exportar.')
      return
    }
    const baseRows = processedRows === null ? users : processedRows
    if (!selectedUsers?.length) {
      notifyExportWarning(baseRows.length ? 'Debe seleccionar al menos una fila para generar el reporte.' : 'No hay registros para exportar.')
      return
    }
    const rows = selectedUsers
    await exportToPdf({
      rows,
      columns: exportColumns,
      valueGetter: getExportValue,
      fileName: buildFileName('usuarios'),
      title: 'Reporte de Administrar Usuarios',
    })
  }, [exportColumns, getExportValue, notifyExportWarning, processedRows, selectedUsers, users])

  // ---------------- Body templates ----------------
  const cellWithTooltip = (rowData, field) => {
    const content = rowData?.[field] ?? '-'
    const textColor = content === '-' ? '#9ca3af' : undefined
    return (
      <span className="cell-tooltip" data-pr-tooltip={String(content)} style={{ color: textColor }}>
        {String(content)}
      </span>
    )
  }

  const codigoBodyTemplate = (rowData) => {
    const code = rowData?.codigo ?? rowData?.id ?? '-'
    const textColor = code === '-' ? '#9ca3af' : undefined
    return (
      <span className="cell-tooltip" data-pr-tooltip={String(code)} style={{ color: textColor }}>
        {String(code)}
      </span>
    )
  }

  const nombreBodyTemplate = (rowData) => {
    const name = formatFullName(rowData)
    return (
      <span className="cell-tooltip" data-pr-tooltip={name}>
        {name}
      </span>
    )
  }

  const activoBodyTemplate = (rowData) => {
    const v = rowData?.activo
    const isTrue = v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true'
    return (
      <span style={{ display: 'flex', justifyContent: 'center' }}>
        <i className={`pi pi-${isTrue ? 'check-circle' : 'times-circle'}`} style={{ color: isTrue ? '#22c55e' : '#9ca3af' }} />
      </span>
    )
  }


  // ---------------- Row click -> detalles ----------------
  const [selectedUserId, setSelectedUserId] = useState(null)
  const [showDetailsModal, setShowDetailsModal] = useState(false)

  const clickTimerRef = useRef(null)

  const handleRowClick = (event) => {
    const t = event?.originalEvent?.target
    if (t?.closest?.('.p-checkbox') || t?.closest?.('.row-selection-column')) return

    const rowData = event?.data
    if (!rowData) return
    const id = normId(rowData?.id)
    if (!id) return

    if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
    clickTimerRef.current = setTimeout(() => {
      setSelectedUsers((prev) => {
        const prevMap = new Map((prev || []).map((u) => [normId(u?.id), u]))
        if (prevMap.has(id)) {
          prevMap.delete(id)
        } else {
          prevMap.set(id, rowData)
        }
        return Array.from(prevMap.values())
      })
    }, 220)
  }

  const handleRowDoubleClick = (event) => {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }

    const t = event?.originalEvent?.target
    if (t?.closest?.('.p-checkbox') || t?.closest?.('.row-selection-column')) return

    const id = event?.data?.id
    if (id == null) return

    setSelectedUserId(id)
    setShowDetailsModal(true)

    if (typeof onSelect === 'function') onSelect(id)
  }

  const handleUserUpdated = () => {
    refreshData()
    toast.current?.show({ severity: 'success', summary: 'Actualizado', detail: 'Usuario actualizado correctamente', life: 2500 })
  }

  const handleUserDeleted = () => {
    setShowDetailsModal(false)
    setSelectedUserId(null)
    refreshData()
    toast.current?.show({ severity: 'success', summary: 'Eliminado', detail: 'Usuario eliminado', life: 2500 })
  }

  // ---------------- Header (de la tabla) ----------------
  const dataLength = users?.length ?? 0

  const header = (
    <div className="users-header">
      <div className="users-header__left">
        <div className="search-input-container">
          <input
            type="text"
            value={globalFilterValue}
            onChange={handleGlobalFilterChange}
            className="search-input"
            placeholder="Buscar en tabla"
          />
          <i className={`pi ${isQuickSearchLoading ? 'pi-spinner pi-spin' : 'pi-search'} search-input-icon`} />
        </div>

        <button className="rounded-icon-btn" type="button" onClick={refreshData} disabled={loading || isRefreshing} title="Recargar">
          <i className="pi pi-refresh" />
        </button>

        <button className="rounded-icon-btn" type="button" onClick={clearFilter} title="Limpiar filtros">
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

        <button className="rounded-icon-btn" type="button" onClick={(e) => opColumns.current?.toggle(e)} title="Campos">
          <i className="pi pi-sliders-h" />
        </button>
      </div>

      <div className="users-header__right">
        <span className="users-header__count">Reg. {dataLength}</span>

        <button
          className="users-circle users-circle--excel"
          type="button"
          title="Excel"
          onClick={onExportExcel || handleExportExcel}
        >
          <i className="pi pi-file-excel" />
        </button>

        <button
          className="users-circle users-circle--pdf"
          type="button"
          title="PDF"
          onClick={onExportPdf || handleExportPdf}
        >
          <i className="pi pi-file-pdf" />
        </button>
      </div>
    </div>
  )

  // ---------------- Create modal ----------------
  const [showCreateModal, setShowCreateModal] = useState(false)
  const handleUserCreated = () => {
    setShowCreateModal(false)
    refreshData()
    toast.current?.show({ severity: 'success', summary: 'Éxito', detail: 'Usuario creado correctamente', life: 2500 })
  }

  const focusSearch = () => setShowSearchModal(true)
  const hasSearched = Boolean(lastSearchRef.current)

  useEffect(() => {
    searchSizeRef.current = searchSize
  }, [searchSize])

  useEffect(() => {
    searchPosRef.current = searchPosition
  }, [searchPosition])

  useLayoutEffect(() => {
    if (!showSearchModal) return
    setIsSearchMaximized(false)
    searchRestoreRef.current = null
    const width = Math.min(720, window.innerWidth - SEARCH_PADDING * 2)
    const height = Math.min(520, window.innerHeight - SEARCH_PADDING * 2)
    setSearchSize({ width, height })
    setSearchPosition({
      x: Math.max((window.innerWidth - width) / 2, SEARCH_PADDING),
      y: Math.max((window.innerHeight - height) / 2, SEARCH_PADDING),
    })
  }, [showSearchModal])

  const handleSearchMouseDown = (event) => {
    if (isSearchMaximized) return
    if (!searchModalRef.current) return
    const rect = searchModalRef.current.getBoundingClientRect()
    searchDrag.current = {
      active: true,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    }
  }

  const handleSearchResizeMouseDown = (event) => {
    if (isSearchMaximized) return
    event.preventDefault()
    event.stopPropagation()
    searchResize.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: searchSizeRef.current.width,
      startHeight: searchSizeRef.current.height,
    }

    const handleResizeMove = (moveEvent) => {
      if (!searchResize.current.active) return
      const deltaX = moveEvent.clientX - searchResize.current.startX
      const deltaY = moveEvent.clientY - searchResize.current.startY
      const maxWidth = Math.max(SEARCH_MIN_WIDTH, window.innerWidth - searchPosRef.current.x - SEARCH_PADDING)
      const maxHeight = Math.max(SEARCH_MIN_HEIGHT, window.innerHeight - searchPosRef.current.y - SEARCH_PADDING)
      const width = Math.min(Math.max(searchResize.current.startWidth + deltaX, SEARCH_MIN_WIDTH), maxWidth)
      const height = Math.min(Math.max(searchResize.current.startHeight + deltaY, SEARCH_MIN_HEIGHT), maxHeight)
      setSearchSize({ width, height })
    }

    const handleResizeUp = () => {
      searchResize.current.active = false
      window.removeEventListener('mousemove', handleResizeMove)
      window.removeEventListener('mouseup', handleResizeUp)
    }

    window.addEventListener('mousemove', handleResizeMove)
    window.addEventListener('mouseup', handleResizeUp)
  }

  useEffect(() => {
    const handleMouseMove = (event) => {
      if (!searchDrag.current.active) return
      event.preventDefault()
      const newX = event.clientX - searchDrag.current.offsetX
      const newY = event.clientY - searchDrag.current.offsetY
      const maxX = window.innerWidth - searchSizeRef.current.width - SEARCH_PADDING
      const maxY = window.innerHeight - searchSizeRef.current.height - SEARCH_PADDING
      setSearchPosition({
        x: Math.min(Math.max(newX, SEARCH_PADDING), Math.max(maxX, SEARCH_PADDING)),
        y: Math.min(Math.max(newY, SEARCH_PADDING), Math.max(maxY, SEARCH_PADDING)),
      })
    }

    const handleMouseUp = () => {
      searchDrag.current.active = false
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  useEffect(() => {
    const handleWindowResize = () => {
      if (!showSearchModal) return
      if (isSearchMaximized) {
        setSearchSize({
          width: Math.max(0, window.innerWidth - SEARCH_PADDING * 2),
          height: Math.max(0, window.innerHeight - SEARCH_PADDING * 2),
        })
        setSearchPosition({ x: SEARCH_PADDING, y: SEARCH_PADDING })
        return
      }
      setSearchSize((prev) => {
        const width = Math.min(Math.max(prev.width, SEARCH_MIN_WIDTH), window.innerWidth - SEARCH_PADDING * 2)
        const height = Math.min(Math.max(prev.height, SEARCH_MIN_HEIGHT), window.innerHeight - SEARCH_PADDING * 2)
        setSearchPosition((prevPos) => ({
          x: Math.min(Math.max(prevPos.x, SEARCH_PADDING), Math.max(window.innerWidth - width - SEARCH_PADDING, SEARCH_PADDING)),
          y: Math.min(Math.max(prevPos.y, SEARCH_PADDING), Math.max(window.innerHeight - height - SEARCH_PADDING, SEARCH_PADDING)),
        }))
        return { width, height }
      })
    }
    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [isSearchMaximized, showSearchModal])

  const toggleSearchMaximize = () => {
    if (isSearchMaximized) {
      const restore = searchRestoreRef.current
      if (restore) {
        setSearchSize(restore.size)
        setSearchPosition(restore.position)
      }
      setIsSearchMaximized(false)
      return
    }
    searchRestoreRef.current = {
      size: searchSizeRef.current,
      position: searchPosRef.current,
    }
    setSearchSize({
      width: Math.max(0, window.innerWidth - SEARCH_PADDING * 2),
      height: Math.max(0, window.innerHeight - SEARCH_PADDING * 2),
    })
    setSearchPosition({ x: SEARCH_PADDING, y: SEARCH_PADDING })
    setIsSearchMaximized(true)
  }

  const { shouldRender: shouldRenderSearchModal, isClosing: isClosingSearchModal } = useModalAnimation(showSearchModal)

  return (
    <div className="users-page">
      <Tooltip position="top" showDelay={1800} target=".cell-tooltip" style={{ maxWidth: '340px' }} />
      <Toast ref={toast} />

      <div className="users-page__top">
        <div className="users-page__actions">
          {canCreate && (
            <Button label="Crear" icon="pi pi-plus" className="users-topbtn users-topbtn--create" onClick={() => setShowCreateModal(true)} type="button" />
          )}
          <Button label="Buscar" icon="pi pi-search" className="users-topbtn users-topbtn--search" onClick={focusSearch} type="button" />
        </div>
      </div>

      <div className="users-table users-table--card" ref={tableWrapperRef}>
        {!hasSearched ? (
          <div className="users-search-empty-state">
            <div className="users-search-empty-state__content">
              <h2 className="users-search-empty-state__title">Usuarios</h2>
              <div className="users-search-empty-state__hint">
                <span className="users-search-empty-state__hint-text">Para iniciar, seleccione</span>
                <Button
                  label="Buscar"
                  icon="pi pi-search"
                  className="users-topbtn users-topbtn--search users-search-empty-state__btn"
                  onClick={focusSearch}
                  type="button"
                />
              </div>
            </div>
          </div>
        ) : (
          <>
        {(loading || isRefreshing) && (
          <div className="spinner-container spinner-container--table">
            <div className="spinner" />
          </div>
        )}

        {error && (
          <div className="stale-data-msg">
            <i className="pi pi-exclamation-circle" style={{ fontSize: '0.8rem', margin: 0, color: 'white' }} />
            <span>
              <strong>Los datos pueden estar desactualizados</strong> | intenta recargar la tabla
            </span>
          </div>
        )}

        <DataTable
          value={users}
          dataKey="id"
          header={header}
          className={`users-datatable${loading || isRefreshing ? ' users-datatable--loading-content' : ''}`}
          tableStyle={{ width: '100%' }}
          emptyMessage="No se encontraron usuarios"
          showGridlines
          size="small"
          scrollable
          scrollHeight="flex"
          frozenWidth="40px"
          paginator
          rows={25}
          rowsPerPageOptions={[5, 10, 25, 50]}
          removableSort
          sortField={sortField || undefined}
          sortOrder={sortOrder || 0}
          onSort={handleSortChange}
          filters={filters}
          onValueChange={(value) => setProcessedRows(value ?? [])}
          globalFilterFields={['codigo', 'nombre', 'nombres', 'apellidos', 'correo', 'telefono', 'cargo', 'activo']}
          reorderableColumns
          onColReorder={handleOrderChange}
          resizableColumns
          columnResizeMode="expand"
          key={tableResetKey}
          stateStorage="custom"
          customSaveState={widthHandlers.save}
          customRestoreState={widthHandlers.restore}
          onRowClick={handleRowClick}
          onRowDoubleClick={handleRowDoubleClick}
          rowClassName={(rowData) => (selectedRowIds.includes(normId(rowData?.id)) ? 'selected-row-shadow' : '')}
          // OK. selección nativa
          selectionMode="multiple"
          selection={selectedUsers}
          onSelectionChange={(e) => {
            if (!isCheckboxSelection(e)) return
            const value = e.value || []
            setSelectedUsers(value)
            const ids = value.map((user) => normId(user?.id)).filter(Boolean)
            console.log('Usuarios seleccionados:', ids)
          }}
        >
          {/* OK. Columna de selección nativa (checkbox + header checkbox) */}
          <Column
            selectionMode="multiple"
            frozen
            headerClassName="row-selection-column"
            bodyClassName="row-selection-column"
            style={selectionColStyle}
            headerStyle={selectionColStyle}
            bodyStyle={selectionColStyle}
            exportable={false}
            reorderable={false}
            resizable={false}
          />

          {selectedColumns.map((column, index) => {
            let bodyTemplate = (rowData) => cellWithTooltip(rowData, column.nombrevar)
            let className = 'column-max-min-width'

            switch (column.nombrevar) {
              case 'codigo':
                bodyTemplate = (rowData) => codigoBodyTemplate(rowData)
                break
              case 'nombre':
                bodyTemplate = (rowData) => nombreBodyTemplate(rowData)
                break
              case 'activo':
                bodyTemplate = (rowData) => activoBodyTemplate(rowData)
                className = 'column-max-min-width--small'
                break
              default:
                bodyTemplate = (rowData) => cellWithTooltip(rowData, column.nombrevar)
                break
            }

            return (
              <Column
                key={index}
                field={column.nombrevar}
                header={column.header}
                body={bodyTemplate}
                sortable
                className={className}
                headerClassName={className}
                style={{ minWidth: '32px' }}
              />
            )
          })}
        </DataTable>

        <OverlayPanel ref={opColumns} className="table-options-list">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <strong>Campos</strong>
            <button className="rounded-icon-btn" type="button" onClick={handleResetTable} title="Restablecer tabla" style={{ width: 28, height: 28 }}>
              <i className="pi pi-refresh" />
            </button>
          </div>

          {columnsData.map((column, idx) => (
            <div key={idx} className="p-field-checkbox" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
              <Checkbox
                inputId={`usuarios-col-${idx}`}
                value={column}
                onChange={() => handleCheckboxChangeColumn(column)}
                checked={selectedColumns.some((item) => item.nombrevar === column.nombrevar)}
              />
              <label htmlFor={`usuarios-col-${idx}`} style={{ cursor: 'pointer' }}>
                {column.header}
              </label>
            </div>
          ))}
        </OverlayPanel>
          </>
        )}

        <CreateUsuario
          open={showCreateModal}
          onClose={() => setShowCreateModal(false)}
          onCreated={handleUserCreated}
          token={token}
          onError={showErrorToast}
        />

        <UsersDetails
          open={showDetailsModal}
          userId={selectedUserId}
          token={token}
          onClose={() => setShowDetailsModal(false)}
          onUpdated={handleUserUpdated}
          onDeleted={handleUserDeleted}
          onError={showErrorToast}
          allowEdit={canEdit}
          allowDelete={canDelete}
        />

        {shouldRenderSearchModal && (
          <div className={`create-user__overlay${isClosingSearchModal ? ' create-user__overlay--closing' : ''}`} role="dialog" aria-modal="true" style={{ padding: `${SEARCH_PADDING}px` }}>
            <div
              className={`create-user__modal${isClosingSearchModal ? ' create-user__modal--closing' : ''}`}
              ref={searchModalRef}
              style={{
                top: searchPosition.y,
                left: searchPosition.x,
                width: searchSize.width,
                height: searchSize.height,
                maxWidth: `calc(100vw - ${SEARCH_PADDING * 2}px)`,
                maxHeight: `calc(100vh - ${SEARCH_PADDING * 2}px)`,
              }}
            >
              <header className="create-user__header" onMouseDown={handleSearchMouseDown}>
                <div className="create-user__header-text">
                  <h3>Buscar usuarios</h3>
                </div>
                <div className="create-user__header-actions">
                  <button
                    type="button"
                    className="create-user__icon-button create-user__icon-button--maximize"
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={toggleSearchMaximize}
                    aria-label={isSearchMaximized ? 'Restaurar' : 'Maximizar'}
                  >
                    <i className={isSearchMaximized ? 'pi pi-window-minimize' : 'pi pi-window-maximize'} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="create-user__icon-button"
                    onClick={() => setShowSearchModal(false)}
                    aria-label="Cerrar"
                  ><i className="pi pi-times" aria-hidden="true" /></button>
                </div>
              </header>

              <form className="create-user__form" onSubmit={handleSearchSubmit}>
                <div className="create-user__body">
                  <section className="create-user__section">
                    <div className="create-user__section-header">
                      <div>
                        <p className="create-user__eyebrow">Filtros</p>
                        <h4>Búsqueda avanzada</h4>
                      </div>
                    </div>

                    <div className="create-user__grid create-user__grid--two">
                      <label className="create-user__field">
                      <span>Código</span>
                      <input name="codigo" type="text" placeholder="Ej: USR-001" value={searchCriteria.codigo} onChange={handleSearchInputChange} />
                    </label>

                      <label className="create-user__field">
                      <span>Nombre</span>
                      <input name="nombre" type="text" placeholder="Ej: Ana Perez" value={searchCriteria.nombre} onChange={handleSearchInputChange} />
                    </label>

                      <label className="create-user__field">
                      <span>Correo</span>
                      <input name="correo" type="text" placeholder="Ej: usuario@empresa.com" value={searchCriteria.correo} onChange={handleSearchInputChange} />
                    </label>

                      <label className="create-user__field">
                      <span>Teléfono</span>
                      <input name="telefono" type="text" placeholder="Ej: 0991234567" value={searchCriteria.telefono} onChange={handleSearchInputChange} />
                    </label>

                      <label className="create-user__field">
                      <span>Cargo</span>
                      <input name="cargo" type="text" placeholder="Ej: Administrador" value={searchCriteria.cargo} onChange={handleSearchInputChange} />
                    </label>

                      <label className="create-user__field">
                        <span>Estado</span>
                        <select
                          name="activo"
                          value={searchCriteria.activo}
                          onChange={handleSearchInputChange}
                          className={!searchCriteria.activo ? 'is-placeholder' : undefined}
                        >
                          <option value="">Selecciona un estado</option>
                          <option value="true">Activo</option>
                          <option value="false">Inactivo</option>
                        </select>
                      </label>

                      <label className="create-user__field">
                      <span>Fecha de creación</span>
                      <input name="fecha_creacion" type="text" placeholder="Ej: 2025-12-31" value={searchCriteria.fecha_creacion} onChange={handleSearchInputChange} />
                    </label>

                    </div>
                  </section>
                </div>

                <div className="create-user__footer">
                  <div className="user-details__footer-left">
                    <button
                      type="button"
                      className="create-user__action"
                      onClick={() => setSearchCriteria(initialSearchCriteria)}
                    >
                      Limpiar filtros
                    </button>
                    <button type="button" className="create-user__action create-user__action--cancel" onClick={() => setShowSearchModal(false)}>
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
                onMouseDown={handleSearchResizeMouseDown}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default UsersTable





