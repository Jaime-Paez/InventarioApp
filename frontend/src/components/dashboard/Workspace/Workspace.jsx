import WorkspaceTabs from '../tabs/WorkspaceTabs/WorkspaceTabs'
import QuickActions from '../QuickActions/QuickActions'
import UsersTable from '../admin/UsersTable/UsersTable'
import SucursalesTable from '../sucursales/SucursalesTable/SucursalesTable'
import BodegasTable from '../bodegas/BodegasTable/BodegasTable'
import MarcasTable from '../marcas/MarcasTable/MarcasTable'
import CasasComercialesTable from '../casasComerciales/CasasComercialesTable/CasasComercialesTable'
import ClientesTable from '../clientes/ClientesTable/ClientesTable'
import ProductosTable from '../productos/ProductosTable/ProductosTable'
import Configuracion from '../configuracion/Configuracion/Configuracion'
import InventarioTable from '../inventario/InventarioTable/InventarioTable'
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

  const tabContentMap = {
    Inventario: <InventarioTable token={token} />,
    Administrar: <UsersTable token={token} />,
    Sucursales: <SucursalesTable token={token} />,
    Bodegas: <BodegasTable token={token} />,
    Marcas: <MarcasTable token={token} />,
    'Casas comerciales': <CasasComercialesTable token={token} />,
    Productos: <ProductosTable token={token} />,
    Clientes: <ClientesTable token={token} />,
    Configuraciones: <Configuracion token={token} darkMode={darkMode} onToggleTheme={onToggleTheme} />,
  }

  const renderContent = () => (
    <>
      {openTabs.map((tab) => {
        const isActive = tab === activeItem
        const hasAccess = labelHasAccess(tab, permissionIndex)
        const content = tabContentMap[tab]

        if (!content) {
          if (!isActive) return null
          return (
            <div key={tab} className="workspace__tab-panel active">
              <p className="workspace__subtitle">
                El módulo "{activeItem}" todavía no tiene contenido disponible.
              </p>
            </div>
          )
        }

        if (!hasAccess) {
          if (!isActive) return null
          return (
            <div key={tab} className="workspace__tab-panel active">
              <p className="workspace__subtitle">
                No tienes permisos para acceder a este módulo. Solicita acceso a un administrador.
              </p>
            </div>
          )
        }

        return (
          <div
            key={tab}
            className={`workspace__tab-panel${isActive ? ' active' : ''}`}
            aria-hidden={!isActive}
          >
            {content}
          </div>
        )
      })}
    </>
  )

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
            <h2>{isLeaving ? farewellTitle : `¡Qué gusto tenerte de vuelta, ${username}!`}</h2>
            <p className="workspace__subtitle">
              {isLeaving
                ? 'Nos vemos pronto.'
                : 'Para comenzar, selecciona una opción del menú'}
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
