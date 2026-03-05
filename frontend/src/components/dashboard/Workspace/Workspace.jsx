import { useCallback, useEffect, useRef, useState } from 'react'
import WorkspaceTabs from '../tabs/WorkspaceTabs/WorkspaceTabs'
import QuickActions from '../QuickActions/QuickActions'
import UsersTable from '../admin/UsersTable/UsersTable'
import SucursalesTable from '../sucursales/SucursalesTable/SucursalesTable'
import BodegasTable from '../bodegas/BodegasTable/BodegasTable'
import MarcasTable from '../marcas/MarcasTable/MarcasTable'
import CasasComercialesTable from '../casasComerciales/CasasComercialesTable/CasasComercialesTable'
import ClientesTable from '../clientes/ClientesTable/ClientesTable'
import ProductosTable from '../productos/ProductosTable/ProductosTable'
import SolicitudesTable from '../solicitudes/SolicitudesTable/SolicitudesTable'
import Configuracion from '../configuracion/Configuracion/Configuracion'
import InventarioTable from '../inventario/InventarioTable/InventarioTable'
import EntradasTable from '../movimientos/EntradasTable'
import SalidasTable from '../movimientos/SalidasTable'
import './Workspace.css'
import { labelHasAccess } from '../menuConfig'
import { API_URL, authFetch } from '../../../utils/api'

const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])
const MOVIMIENTOS_SCOPE_BY_TAB = {
  Entradas: 'movimientos_entradas',
  Salidas: 'movimientos_salidas',
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
  isLeaving = false,
}) {
  const [movementBranchOptions, setMovementBranchOptions] = useState({
    Entradas: [],
    Salidas: [],
  })
  const [movementBranchSelection, setMovementBranchSelection] = useState({
    Entradas: ALL_BRANCH_OPTION_ID,
    Salidas: ALL_BRANCH_OPTION_ID,
  })
  const [isMovementBranchMenuOpen, setIsMovementBranchMenuOpen] = useState(false)
  const movementBranchMenuRef = useRef(null)

  const username = [user?.nombre || user?.first_name, user?.apellido || user?.last_name]
    .filter(Boolean)
    .join(' ')
    .trim() || 'usuario'

  const showWelcome = !activeItem
  const farewellTitle = `Hasta luego, ${username}.`

  const tabComponentMap = {
    Inventario: InventarioTable,
    Administrar: UsersTable,
    Sucursales: SucursalesTable,
    Bodegas: BodegasTable,
    Marcas: MarcasTable,
    'Casas comerciales': CasasComercialesTable,
    Productos: ProductosTable,
    Solicitudes: SolicitudesTable,
    Clientes: ClientesTable,
    Entradas: EntradasTable,
    Salidas: SalidasTable,
    Configuraciones: Configuracion,
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

        setMovementBranchOptions((prev) => ({ ...prev, [tab]: branches }))
        setMovementBranchSelection((prev) => {
          const current = String(prev?.[tab] || '').trim()
          const exists = (
            current === ALL_BRANCH_OPTION_ID ||
            (current && branches.some((branch) => String(branch?.id) === current))
          )
          const next = exists ? current : ALL_BRANCH_OPTION_ID
          if (String(prev?.[tab] || '') === next) return prev
          return { ...prev, [tab]: next }
        })
      } catch {
        setMovementBranchOptions((prev) => ({ ...prev, [tab]: [] }))
        setMovementBranchSelection((prev) => ({ ...prev, [tab]: ALL_BRANCH_OPTION_ID }))
      }
    },
    [token]
  )

  useEffect(() => {
    if (!token) {
      setMovementBranchOptions({ Entradas: [], Salidas: [] })
      setMovementBranchSelection({
        Entradas: ALL_BRANCH_OPTION_ID,
        Salidas: ALL_BRANCH_OPTION_ID,
      })
      return
    }
    if (activeItem !== 'Entradas' && activeItem !== 'Salidas') return
    fetchMovementBranches(activeItem)
  }, [activeItem, fetchMovementBranches, token])

  const handleMovementBranchChange = useCallback((tab, nextId) => {
    const normalized = String(nextId || '').trim()
    setMovementBranchSelection((prev) => {
      if (String(prev?.[tab] || '') === normalized) return prev
      return { ...prev, [tab]: normalized }
    })
  }, [])

  const activeMovementBranches = movementBranchOptions?.[activeItem] || []
  const activeMovementBranchMenuOptions = (
    activeMovementBranches.length
      ? [ALL_BRANCH_OPTION, ...activeMovementBranches]
      : [ALL_BRANCH_OPTION]
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
    (activeItem === 'Entradas' || activeItem === 'Salidas') &&
    activeMovementBranches.length > 0
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

  const renderTabContent = (tab) => {
    const hasAccess = labelHasAccess(tab, permissionIndex)
    const TabComponent = tabComponentMap[tab]

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

    if (tab === 'Configuraciones') {
      return <TabComponent token={token} darkMode={darkMode} onToggleTheme={onToggleTheme} user={user} />
    }

    const createBranchId = tab === 'Entradas'
      ? movementBranchSelection.Entradas
      : tab === 'Salidas'
        ? movementBranchSelection.Salidas
        : ''

    return <TabComponent token={token} user={user} createBranchId={createBranchId} />
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
          {renderTabContent(tab)}
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
        <QuickActions darkMode={darkMode} onToggleTheme={onToggleTheme} token={token} user={user} />
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
