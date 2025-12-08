import { useMemo, useState } from 'react'
import kavaDark from '../../assets/login/kava(dark).png'
import kavaLight from '../../assets/login/kava(light).png'
import './dashboard.css'
import Sidebar from './Sidebar'
import TopBar from './TopBar'
import Workspace from './Workspace'

const MENU_ITEMS = [
  'Inventario',
  'Movimientos',
  'Productos',
  'Sucursales',
  'Proveedores',
  'Solicitudes',
  'Clientes',
  'Administrar',
]

function DashboardLayout({ user, darkMode, onToggleTheme, onLogout, isEntering }) {
  const [activeItem, setActiveItem] = useState(MENU_ITEMS[0])
  const [search, setSearch] = useState('')

  const heroLogo = useMemo(() => (darkMode ? kavaLight : kavaDark), [darkMode])
  const brandLogo = useMemo(() => (darkMode ? kavaLight : kavaDark), [darkMode])

  return (
    <div className={`dashboard-shell ${darkMode ? 'dark' : 'light'} ${isEntering ? 'entering' : ''}`}>
      <Sidebar
        items={MENU_ITEMS}
        activeItem={activeItem}
        onSelect={setActiveItem}
        user={user}
        onLogout={onLogout}
      />

      <div className="dashboard-canvas">
        <TopBar
          user={user}
          search={search}
          onSearchChange={setSearch}
          darkMode={darkMode}
          onToggleTheme={onToggleTheme}
          brandLogo={brandLogo}
        />

        <Workspace activeItem={activeItem} user={user} logo={heroLogo} />
      </div>
    </div>
  )
}

export default DashboardLayout
