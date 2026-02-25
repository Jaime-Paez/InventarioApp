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
import SalidasTable from '../movimientos/SalidasTable'
import './Workspace.css'
import { labelHasAccess } from '../menuConfig'

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
    Salidas: SalidasTable,
    Configuraciones: Configuracion,
  }

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
      return <TabComponent token={token} darkMode={darkMode} onToggleTheme={onToggleTheme} />
    }

    return <TabComponent token={token} />
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
        <QuickActions darkMode={darkMode} onToggleTheme={onToggleTheme} />
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
          <h1 className="workspace__view-title">{activeItem}</h1>
          {renderContent()}
        </section>
      )}
    </main>
  )
}

export default Workspace
