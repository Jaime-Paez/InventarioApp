import { useCallback, useEffect, useRef, useState } from 'react'
import WorkspaceTabs from '../tabs/WorkspaceTabs/WorkspaceTabs'
import QuickActions from '../QuickActions/QuickActions'
import UsersTable from '../admin/UsersTable/UsersTable'
import RandomInspectionAdminTable from '../admin/RandomInspectionAdminTable/RandomInspectionAdminTable'
import AuditoriaTable from '../admin/AuditoriaTable/AuditoriaTable'
import SucursalesTable from '../sucursales/SucursalesTable/SucursalesTable'
import BodegasTable from '../bodegas/BodegasTable/BodegasTable'
import CasasComercialesTable from '../casasComerciales/CasasComercialesTable/CasasComercialesTable'
import ClientesTable from '../clientes/ClientesTable/ClientesTable'
import ProductosTable from '../productos/ProductosTable/ProductosTable'
import SolicitudesTable from '../solicitudes/SolicitudesTable/SolicitudesTable'
import ImportacionesTable from '../importaciones/ImportacionesTable'
import Configuracion from '../configuracion/Configuracion/Configuracion'
import InventarioTable from '../inventario/InventarioTableV2/InventarioTableV2'
import EntradasTable from '../movimientos/EntradasTable'
import SalidasTable from '../movimientos/SalidasTable'
import TrasladosInconvenientesTable from '../movimientos/TrasladosInconvenientesTable'
import './Workspace.css'
import { getModuleActions, labelHasAccess } from '../menuConfig'
import { API_URL, authFetch } from '../../../utils/api'

const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const parseScopedBranchIdsHeader = (rawValue) => {
  const normalized = String(rawValue || '').trim()
  if (!normalized) return null
  if (normalized.toLowerCase() === 'all') return null
  if (normalized.toLowerCase() === 'none') return []
  return Array.from(
    new Set(
      normalized
        .split(',')
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  )
}
const INCONVENIENTES_TAB = 'Inconvenientes'
const INCONVENIENTES_TAB_LEGACY = 'Traslados con inconvenientes'
const INVENTORY_REVIEW_TAB = 'Revision inventario'
const INVENTORY_REVIEW_TAB_LEGACY = 'Revision de inventario por sucursal'
const MOVIMIENTOS_SCOPE_BY_TAB = {
  Entradas: 'movimientos_entradas',
  Salidas: 'movimientos_salidas',
  Solicitudes: 'solicitudes',
  [INCONVENIENTES_TAB]: 'movimientos_inconvenientes',
  [INCONVENIENTES_TAB_LEGACY]: 'movimientos_inconvenientes',
}
const MODULE_KEY_BY_TAB = {
  Inventario: 'inventario',
  Administrar: 'usuarios',
  'Auditoría': 'usuarios',
  [INVENTORY_REVIEW_TAB]: 'usuarios',
  [INVENTORY_REVIEW_TAB_LEGACY]: 'usuarios',
  Sucursales: 'sucursales_sucursales',
  Bodegas: 'sucursales_bodegas',
  'Proveedores': 'proveedores_casas',
  Productos: 'productos',
  Importaciones: 'importaciones',
  'En proceso': 'importaciones',
  'En camino': 'importaciones',
  Importadas: 'importaciones',
  Solicitudes: 'solicitudes',
  Clientes: 'clientes',
  Entradas: 'movimientos_entradas',
  Salidas: 'movimientos_salidas',
  [INCONVENIENTES_TAB]: 'movimientos_inconvenientes',
  [INCONVENIENTES_TAB_LEGACY]: 'movimientos_inconvenientes',
}
const ALL_BRANCH_OPTION_ID = 'all'
const ALL_BRANCH_OPTION = { id: ALL_BRANCH_OPTION_ID, nombre: 'Todas' }

function Workspace({
  activeItem,
  openTabs,
  onSelectTab,
  onCloseTab,
  user,
  logo,
  darkMode,
  onToggleTheme,
  token,
  permissionIndex,
  moduleScopeAccessIndex = null,
  isLeaving = false,
  allowUrgentShield = true,
}) {
  const [movementBranchOptions, setMovementBranchOptions] = useState({
    Entradas: [],
    Salidas: [],
    Solicitudes: [],
  })
  const [movementBranchCanViewAll, setMovementBranchCanViewAll] = useState({
    Entradas: false,
    Salidas: false,
    Solicitudes: false,
  })
  const [movementBranchWritableIds, setMovementBranchWritableIds] = useState({
    Entradas: null,
    Salidas: null,
    Solicitudes: null,
  })
  const [movementBranchSelection, setMovementBranchSelection] = useState({
    Entradas: ALL_BRANCH_OPTION_ID,
    Salidas: ALL_BRANCH_OPTION_ID,
    Solicitudes: ALL_BRANCH_OPTION_ID,
  })
  const [isMovementBranchMenuOpen, setIsMovementBranchMenuOpen] = useState(false)
  const movementBranchMenuRef = useRef(null)
  const [pendingTransferSalidaRequest, setPendingTransferSalidaRequest] = useState(null)
  const [pendingTransferEntradaRequest, setPendingTransferEntradaRequest] = useState(null)
  const [pendingOpenIssueId, setPendingOpenIssueId] = useState(null)
  const [pendingOpenClienteSolicitudId, setPendingOpenClienteSolicitudId] = useState(null)
  const [pendingOpenBorradorData, setPendingOpenBorradorData] = useState(null)
  const [pendingOpenBorradorTab, setPendingOpenBorradorTab] = useState(null)
  const [pendingOpenDetailsId, setPendingOpenDetailsId] = useState(null)
  const [pendingOpenDetailsTab, setPendingOpenDetailsTab] = useState(null)
  const [pendingOpenDetailsStatus, setPendingOpenDetailsStatus] = useState(null)

  const handleOpenImportacionBorrador = useCallback((borradorData) => {
    // Tabs that show borradores (no fixed statusProp). Prefer whichever is already open.
    // 'En camino' queda solo por compatibilidad con tabs viejos ya abiertos antes del
    // rename del menú a 'Importaciones'.
    const borradorCapableTabs = ['Importaciones', 'En camino']
    const targetTab = openTabs.find((t) => borradorCapableTabs.includes(t)) || 'Importaciones'
    onSelectTab?.(targetTab)
    setPendingOpenBorradorData(borradorData)
    setPendingOpenBorradorTab(targetTab)
  }, [onSelectTab, openTabs])

  const handleOpenImportacionDetails = useCallback((importacionId, estado) => {
    const tabByEstado = {
      en_camino: 'Importaciones',
      importada: 'Importadas',
      borrador: 'Importaciones',
    }
    const preferredTab = tabByEstado[estado] || 'Importaciones'
    const targetTab = openTabs.includes(preferredTab) ? preferredTab : preferredTab
    onSelectTab?.(targetTab)
    setPendingOpenDetailsId(importacionId)
    setPendingOpenDetailsTab(targetTab)
    setPendingOpenDetailsStatus(estado || null)
  }, [onSelectTab, openTabs])

  const username = [user?.nombre || user?.first_name, user?.apellido || user?.last_name]
    .filter(Boolean)
    .join(' ')
    .trim() || 'usuario'
  const isAdministrator = Boolean(
    user?.is_superuser ||
      user?.is_staff ||
      user?.es_administrador ||
      String(user?.rol || '').trim().toLowerCase() === 'administrador'
  )

  const showWelcome = !activeItem
  const farewellTitle = `Hasta luego, ${username}.`

  const tabComponentMap = {
    Inventario: InventarioTable,
    Administrar: UsersTable,
    [INVENTORY_REVIEW_TAB]: RandomInspectionAdminTable,
    [INVENTORY_REVIEW_TAB_LEGACY]: RandomInspectionAdminTable,
    Sucursales: SucursalesTable,
    Bodegas: BodegasTable,
    'Proveedores': CasasComercialesTable,
    Productos: ProductosTable,
    Importaciones: ImportacionesTable,
    'En proceso': ImportacionesTable,
    'En camino': ImportacionesTable,
    Importadas: ImportacionesTable,
    Solicitudes: SolicitudesTable,
    Clientes: ClientesTable,
    Entradas: EntradasTable,
    Salidas: SalidasTable,
    [INCONVENIENTES_TAB]: TrasladosInconvenientesTable,
    [INCONVENIENTES_TAB_LEGACY]: TrasladosInconvenientesTable,
    Configuraciones: Configuracion,
    'Auditoría': AuditoriaTable,
  }

  const fetchMovementBranches = useCallback(
    async (tab) => {
      const scope = MOVIMIENTOS_SCOPE_BY_TAB[tab]
      if (!scope || !token) return

      try {
        const response = await authFetch(
          `${API_URL}/inventario/sucursales/?modulo=${scope}&page_size=200`,
          {},
          token
        )
        if (!response.ok) throw new Error('No se pudieron cargar las sucursales del módulo.')

        const payload = await response.json().catch(() => ({}))
        const branches = parseApiList(payload)
        const canViewAll = String(
          response.headers.get('X-Sucursal-Scope-Unrestricted') ||
          response.headers.get('x-sucursal-scope-unrestricted') ||
          ''
        ).trim() === '1'
        const writableBranchIds = parseScopedBranchIdsHeader(
          response.headers.get('X-Sucursal-Scope-Writable-Ids') ||
          response.headers.get('x-sucursal-scope-writable-ids') ||
          ''
        )

        setMovementBranchOptions((prev) => ({ ...prev, [tab]: branches }))
        setMovementBranchCanViewAll((prev) => ({ ...prev, [tab]: canViewAll }))
        setMovementBranchWritableIds((prev) => ({ ...prev, [tab]: writableBranchIds }))
        setMovementBranchSelection((prev) => {
          const current = String(prev?.[tab] || '').trim()
          const firstBranchId = String(branches?.[0]?.id || '').trim()
          const exists = (
            (canViewAll && current === ALL_BRANCH_OPTION_ID) ||
            (current && branches.some((branch) => String(branch?.id) === current))
          )
          const next = exists ? current : (canViewAll ? ALL_BRANCH_OPTION_ID : firstBranchId)
          if (String(prev?.[tab] || '') === next) return prev
          return { ...prev, [tab]: next }
        })
      } catch {
        setMovementBranchOptions((prev) => ({ ...prev, [tab]: [] }))
        setMovementBranchCanViewAll((prev) => ({ ...prev, [tab]: false }))
        setMovementBranchWritableIds((prev) => ({ ...prev, [tab]: [] }))
        setMovementBranchSelection((prev) => ({ ...prev, [tab]: '' }))
      }
    },
    [token]
  )

  useEffect(() => {
    if (!token) {
      setMovementBranchOptions({ Entradas: [], Salidas: [], Solicitudes: [] })
      setMovementBranchCanViewAll({ Entradas: false, Salidas: false, Solicitudes: false })
      setMovementBranchWritableIds({ Entradas: null, Salidas: null, Solicitudes: null })
      setMovementBranchSelection({
        Entradas: ALL_BRANCH_OPTION_ID,
        Salidas: ALL_BRANCH_OPTION_ID,
        Solicitudes: ALL_BRANCH_OPTION_ID,
      })
      return
    }
    if (activeItem !== 'Entradas' && activeItem !== 'Salidas' && activeItem !== 'Solicitudes') return
    fetchMovementBranches(activeItem)
  }, [activeItem, fetchMovementBranches, token])

  const handleMovementBranchChange = useCallback((tab, nextId) => {
    const normalized = String(nextId || '').trim()
    setMovementBranchSelection((prev) => {
      if (String(prev?.[tab] || '') === normalized) return prev
      return { ...prev, [tab]: normalized }
    })
  }, [])

  const handleTransferDecisionAccepted = useCallback((payload) => {
    const payloadSolicitud = payload?.solicitud || null
    const solicitudIdRaw = payload?.solicitudId ?? payloadSolicitud?.id
    const solicitudId = String(solicitudIdRaw || '').trim()
    if (!solicitudId) return
    if (!labelHasAccess('Salidas', permissionIndex, undefined, moduleScopeAccessIndex, isAdministrator)) return

    const sucursalProveedoraRaw = (
      payload?.nextAction?.sucursal_proveedora_id ??
      payloadSolicitud?.sucursal_proveedora_id
    )
    const sucursalProveedoraId = String(sucursalProveedoraRaw || '').trim()

    if (sucursalProveedoraId) {
      setMovementBranchSelection((prev) => ({ ...prev, Salidas: sucursalProveedoraId }))
    }
    onSelectTab?.('Salidas')
    setPendingTransferSalidaRequest({
      requestKey: `${Date.now()}-${solicitudId}`,
      solicitudId,
      sucursalProveedoraId,
      solicitud: payloadSolicitud,
    })
  }, [onSelectTab, permissionIndex, moduleScopeAccessIndex, isAdministrator])

  const handleTransferSalidaRequestHandled = useCallback(() => {
    setPendingTransferSalidaRequest(null)
  }, [])

  const handleOpenTransferRequestInEntradas = useCallback((payload) => {
    const previewData = payload?.previewData || null
    const solicitudId = String(payload?.solicitudId || previewData?.solicitud_traslado_id || '').trim()
    if (!solicitudId) return
    if (!labelHasAccess('Entradas', permissionIndex, undefined, moduleScopeAccessIndex, isAdministrator)) return
    const requestMode = String(payload?.mode || '').trim().toLowerCase()
    const movimientoEntradaId = String(
      payload?.movimientoEntradaId ||
      previewData?.movimiento_entrada_id ||
      ''
    ).trim()

    const sucursalSolicitanteId = String(
      payload?.sucursalSolicitanteId ||
      previewData?.sucursal_solicitante_id ||
      previewData?.sucursal_id ||
      ''
    ).trim()

    if (sucursalSolicitanteId) {
      setMovementBranchSelection((prev) => ({ ...prev, Entradas: sucursalSolicitanteId }))
    }

    onSelectTab?.('Entradas')
    setPendingTransferEntradaRequest({
      requestKey: `${Date.now()}-${solicitudId}`,
      solicitudId,
      sucursalSolicitanteId,
      previewData,
      movimientoEntradaId,
      mode: requestMode === 'view' && movimientoEntradaId ? 'view' : 'preview',
    })
  }, [onSelectTab, permissionIndex, moduleScopeAccessIndex, isAdministrator])

  const handleOpenTransferRequestInSalidas = useCallback((payload) => {
    const solicitud = payload?.solicitud || null
    const solicitudId = String(payload?.solicitudId || solicitud?.id || '').trim()
    if (!solicitudId) return
    if (!labelHasAccess('Salidas', permissionIndex, undefined, moduleScopeAccessIndex, isAdministrator)) return
    const requestMode = String(payload?.mode || '').trim().toLowerCase()

    const sucursalProveedoraId = String(
      payload?.sucursalProveedoraId ||
      solicitud?.sucursal_proveedora_id ||
      ''
    ).trim()
    const movimientoSalidaId = String(
      payload?.movimientoSalidaId ||
      solicitud?.movimiento_salida_id ||
      ''
    ).trim()

    if (sucursalProveedoraId) {
      setMovementBranchSelection((prev) => ({ ...prev, Salidas: sucursalProveedoraId }))
    }

    onSelectTab?.('Salidas')
    setPendingTransferSalidaRequest({
      requestKey: `${Date.now()}-${solicitudId}`,
      solicitudId,
      sucursalProveedoraId,
      movimientoSalidaId,
      solicitud,
      mode: requestMode === 'view' && movimientoSalidaId ? 'view' : 'preview',
    })
  }, [onSelectTab, permissionIndex, moduleScopeAccessIndex, isAdministrator])

  const handleOpenInventoryReviewSection = useCallback(() => {
    if (!labelHasAccess(INVENTORY_REVIEW_TAB, permissionIndex, undefined, moduleScopeAccessIndex, isAdministrator)) {
      if (!labelHasAccess(INVENTORY_REVIEW_TAB_LEGACY, permissionIndex, undefined, moduleScopeAccessIndex, isAdministrator)) return false
      onSelectTab?.(INVENTORY_REVIEW_TAB_LEGACY)
      return true
    }
    onSelectTab?.(INVENTORY_REVIEW_TAB)
    return true
  }, [onSelectTab, permissionIndex, moduleScopeAccessIndex, isAdministrator])

  const handleOpenTransferIssuesSection = useCallback((reminder) => {
    const solicitudId = String(reminder?.context?.id || '').trim()
    if (solicitudId) setPendingOpenIssueId(solicitudId)
    if (!labelHasAccess(INCONVENIENTES_TAB, permissionIndex, undefined, moduleScopeAccessIndex, isAdministrator)) {
      if (!labelHasAccess(INCONVENIENTES_TAB_LEGACY, permissionIndex, undefined, moduleScopeAccessIndex, isAdministrator)) return false
      onSelectTab?.(INCONVENIENTES_TAB_LEGACY)
      return true
    }
    onSelectTab?.(INCONVENIENTES_TAB)
    return true
  }, [onSelectTab, permissionIndex, moduleScopeAccessIndex, isAdministrator])

  const handlePendingOpenIssueHandled = useCallback(() => {
    setPendingOpenIssueId(null)
  }, [])

  const handleOpenSolicitudCliente = useCallback((solicitudId) => {
    if (!solicitudId) return
    setPendingOpenClienteSolicitudId(String(solicitudId))
    onSelectTab?.('Solicitudes')
  }, [onSelectTab])

  const handlePendingOpenClienteSolicitudHandled = useCallback(() => {
    setPendingOpenClienteSolicitudId(null)
  }, [])

  const handleTransferEntradaRequestHandled = useCallback(() => {
    setPendingTransferEntradaRequest(null)
  }, [])

  const activeMovementBranches = movementBranchOptions?.[activeItem] || []
  const activeMovementCanViewAll = Boolean(movementBranchCanViewAll?.[activeItem])
  const activeMovementBranchMenuOptions = (
    activeMovementBranches.length
      ? (activeMovementCanViewAll
        ? [ALL_BRANCH_OPTION, ...activeMovementBranches]
        : activeMovementBranches)
      : []
  )
  const activeMovementBranchId = String(movementBranchSelection?.[activeItem] || '').trim()
  const activeMovementBranchLabel = (
    activeMovementBranchMenuOptions.find((branch) => String(branch?.id) === activeMovementBranchId)?.nombre ||
    ''
  )
  const resolvedActiveMovementBranchLabel = String(
    activeMovementBranchLabel || activeMovementBranches?.[0]?.nombre || 'Sucursal'
  ).trim()
  const showMovementBranchSwitcher = (
    (activeItem === 'Entradas' || activeItem === 'Salidas' || activeItem === 'Solicitudes') &&
    activeMovementBranchMenuOptions.length > 0
  )

  useEffect(() => {
    if (showMovementBranchSwitcher) return
    setIsMovementBranchMenuOpen(false)
  }, [showMovementBranchSwitcher])

  useEffect(() => {
    setIsMovementBranchMenuOpen(false)
  }, [activeItem])

  useEffect(() => {
    if (!isMovementBranchMenuOpen) return undefined

    const handleClickOutside = (event) => {
      if (movementBranchMenuRef.current?.contains(event.target)) return
      setIsMovementBranchMenuOpen(false)
    }

    const handleEscape = (event) => {
      if (event.key !== 'Escape') return
      setIsMovementBranchMenuOpen(false)
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('touchstart', handleClickOutside, { passive: true })
    window.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('touchstart', handleClickOutside)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [isMovementBranchMenuOpen])

  const renderTabContent = (tab, isActive = false) => {
    const hasAccess = labelHasAccess(tab, permissionIndex, undefined, moduleScopeAccessIndex, isAdministrator)
    const TabComponent = tabComponentMap[tab]
    const moduleKey = MODULE_KEY_BY_TAB[tab] || ''
    const moduleActions = getModuleActions(moduleKey, permissionIndex, user?.sucursales_por_modulo)

    if (!TabComponent) {
      return (
        <p className="workspace__subtitle">
          El módulo "{tab}" todavía no tiene contenido disponible.
        </p>
      )
    }

    if (!hasAccess) {
      return (
        <p className="workspace__subtitle">
          No tienes permisos para acceder a este módulo. Solicita acceso a un administrador.
        </p>
      )
    }

    if (tab === 'Configuraciones' || tab === 'Auditoría') {
      if (!isAdministrator) {
        return (
          <p className="workspace__subtitle">
            No tienes permisos para acceder a este módulo. Solicita acceso a un administrador.
          </p>
        )
      }
      return <TabComponent token={token} user={user} />
    }

    const createBranchId = tab === 'Entradas'
      ? movementBranchSelection.Entradas
      : tab === 'Salidas'
        ? movementBranchSelection.Salidas
        : tab === 'Solicitudes'
          ? movementBranchSelection.Solicitudes
        : ''
    const scopedModuleActions = (() => {
      if (tab !== 'Entradas' && tab !== 'Salidas' && tab !== 'Solicitudes') return moduleActions

      const selectedBranchId = String(createBranchId || '').trim()
      const writableIds = movementBranchWritableIds?.[tab]
      const canWriteInSelectedBranch = Boolean(
        selectedBranchId &&
        selectedBranchId !== ALL_BRANCH_OPTION_ID &&
        (
          writableIds === null ||
          (Array.isArray(writableIds) && writableIds.includes(selectedBranchId))
        )
      )

      return {
        ...moduleActions,
        puede_crear: Boolean(moduleActions?.puede_crear) && canWriteInSelectedBranch,
        puede_actualizar: Boolean(moduleActions?.puede_actualizar) && canWriteInSelectedBranch,
        puede_eliminar: Boolean(moduleActions?.puede_eliminar) && canWriteInSelectedBranch,
      }
    })()

    return (
      <TabComponent
        token={token}
        user={user}
        status={
          tab === 'En proceso'
            ? 'en_proceso'
            : tab === 'Importadas'
              ? 'importada'
              : undefined
        }
        isTabActive={
          tab === 'Entradas' || tab === 'Salidas' || tab === 'Solicitudes' ||
          tab === INVENTORY_REVIEW_TAB || tab === INVENTORY_REVIEW_TAB_LEGACY ||
          tab === 'Importaciones' || tab === 'En proceso' || tab === 'En camino' || tab === 'Importadas' ||
          tab === 'Administrar'
            ? isActive
            : undefined
        }
        createBranchId={createBranchId}
        moduleKey={moduleKey}
        moduleActions={scopedModuleActions}
        permissionIndex={permissionIndex}
        pendingTransferSalidaRequest={tab === 'Salidas' ? pendingTransferSalidaRequest : null}
        pendingTransferEntradaRequest={tab === 'Entradas' ? pendingTransferEntradaRequest : null}
        onPendingTransferSalidaRequestHandled={
          tab === 'Salidas' ? handleTransferSalidaRequestHandled : undefined
        }
        onPendingTransferEntradaRequestHandled={
          tab === 'Entradas' ? handleTransferEntradaRequestHandled : undefined
        }
        pendingOpenSolicitudId={
          (tab === INCONVENIENTES_TAB || tab === INCONVENIENTES_TAB_LEGACY)
            ? pendingOpenIssueId
            : undefined
        }
        onPendingOpenHandled={
          (tab === INCONVENIENTES_TAB || tab === INCONVENIENTES_TAB_LEGACY)
            ? handlePendingOpenIssueHandled
            : undefined
        }
        pendingOpenClienteSolicitudId={
          tab === 'Solicitudes' ? pendingOpenClienteSolicitudId : undefined
        }
        onPendingOpenClienteSolicitudHandled={
          tab === 'Solicitudes' ? handlePendingOpenClienteSolicitudHandled : undefined
        }
        onOpenImportacionBorrador={
          tab === 'Solicitudes' ? handleOpenImportacionBorrador : undefined
        }
        onOpenImportacionDetails={
          tab === 'Solicitudes' ? handleOpenImportacionDetails : undefined
        }
        pendingOpenBorradorData={
          tab === pendingOpenBorradorTab ? pendingOpenBorradorData : null
        }
        onPendingOpenBorradorHandled={
          tab === pendingOpenBorradorTab
            ? () => { setPendingOpenBorradorData(null); setPendingOpenBorradorTab(null) }
            : undefined
        }
        pendingOpenDetailsId={
          tab === pendingOpenDetailsTab ? pendingOpenDetailsId : null
        }
        pendingOpenDetailsStatus={
          tab === pendingOpenDetailsTab ? pendingOpenDetailsStatus : null
        }
        onPendingOpenDetailsHandled={
          tab === pendingOpenDetailsTab
            ? () => { setPendingOpenDetailsId(null); setPendingOpenDetailsTab(null); setPendingOpenDetailsStatus(null) }
            : undefined
        }
      />
    )
  }

  const renderContent = () => {
    if (!openTabs.length) return null

    return openTabs.map((tab) => {
      const isActive = tab === activeItem
      return (
        <div
          key={tab}
          className={`workspace__tab-panel ${isActive ? 'active' : ''}`}
          aria-hidden={!isActive}
        >
          {renderTabContent(tab, isActive)}
        </div>
      )
    })
  }

  return (
    <main className="workspace">
      <div className="workspace__toolbar">
        <WorkspaceTabs
          openTabs={openTabs}
          activeItem={activeItem}
          onSelectTab={onSelectTab}
          onCloseTab={onCloseTab}
        />
        <QuickActions
          darkMode={darkMode}
          onToggleTheme={onToggleTheme}
          token={token}
          user={user}
          allowUrgentShield={allowUrgentShield}
          onTransferDecisionAccepted={handleTransferDecisionAccepted}
          onOpenTransferRequestInEntradas={handleOpenTransferRequestInEntradas}
          onOpenTransferRequestInSalidas={handleOpenTransferRequestInSalidas}
          onOpenInventoryReviewSection={handleOpenInventoryReviewSection}
          onOpenTransferIssuesSection={handleOpenTransferIssuesSection}
          onOpenSolicitudCliente={handleOpenSolicitudCliente}
        />
      </div>

      {showWelcome && (
        <section className="workspace__hero">
          <div className="workspace__logo">
            <img src={logo} alt="Logotipo Kava" />
          </div>
          <div className="workspace__copy">
            <h2>{isLeaving ? farewellTitle : `Qué gusto tenerte de vuelta, ${username}!`}</h2>
            <p className="workspace__subtitle">
              {isLeaving ? 'Nos vemos pronto.' : 'Para comenzar, selecciona una opción del menú'}
            </p>
          </div>
        </section>
      )}

      {!showWelcome && (
        <section className="workspace__panel">
          <div className="workspace__view-head">
            <h1 className="workspace__view-title">{activeItem}</h1>
            {showMovementBranchSwitcher && (
              <div className="workspace__view-branch" ref={movementBranchMenuRef}>
                <button
                  type="button"
                  className="workspace__view-branch-trigger"
                  onClick={() => setIsMovementBranchMenuOpen((prev) => !prev)}
                  aria-haspopup="listbox"
                  aria-expanded={isMovementBranchMenuOpen}
                  aria-label={`Sucursal actual para ${String(activeItem || '').toLowerCase()}`}
                >
                  <span>{resolvedActiveMovementBranchLabel}</span>
                  <i className={`pi pi-chevron-${isMovementBranchMenuOpen ? 'up' : 'down'}`} aria-hidden="true" />
                </button>

                {isMovementBranchMenuOpen && (
                  <div className="workspace__view-branch-panel" role="listbox">
                    {activeMovementBranchMenuOptions.map((branch) => {
                      const branchId = String(branch?.id || '').trim()
                      const selected = branchId && branchId === activeMovementBranchId
                      return (
                        <button
                          key={branch.id}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          className={`workspace__view-branch-option${selected ? ' is-active' : ''}`}
                          onClick={() => {
                            handleMovementBranchChange(activeItem, branchId)
                            setIsMovementBranchMenuOpen(false)
                          }}
                        >
                          {branch.nombre || `Sucursal ${branch.id}`}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
          {renderContent()}
        </section>
      )}
    </main>
  )
}

export default Workspace
