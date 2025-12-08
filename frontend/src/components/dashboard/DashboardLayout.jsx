import { useMemo, useState } from 'react'
import kavaDark from '../../assets/login/kava(dark).png'
import kavaLight from '../../assets/login/kava(light).png'
import jpaezDark from '../../assets/login/jpaez(dark).png'
import jpaezLight from '../../assets/login/jpaez(light).png'
import './dashboard.css'
import Sidebar from './Sidebar'
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

function DashboardLayout({ user, darkMode, onLogout, isEntering }) {
  const [activeItem, setActiveItem] = useState(MENU_ITEMS[0])

  const heroLogo = useMemo(() => (darkMode ? kavaDark : kavaLight), [darkMode])
  const brandLogo = useMemo(() => (darkMode ? kavaDark : kavaLight), [darkMode])
  const partnerLogo = useMemo(() => (darkMode ? jpaezDark : jpaezLight), [darkMode])

  return (
    <div className={`dashboard-shell ${darkMode ? 'dark' : 'light'} ${isEntering ? 'entering' : ''}`}>
      <Sidebar
        items={MENU_ITEMS}
        activeItem={activeItem}
        onSelect={setActiveItem}
        user={user}
        onLogout={onLogout}
        brandLogo={brandLogo}
        partnerLogo={partnerLogo}
      />

      <Workspace activeItem={activeItem} user={user} logo={heroLogo} />
    </div>
  )
}

export default DashboardLayout
