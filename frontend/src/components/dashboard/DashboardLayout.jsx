import { useMemo, useState } from 'react'
import kavaDark from '../../assets/login/kava(dark).png'
import kavaLight from '../../assets/login/kava(light).png'
import jpaezDark from '../../assets/login/jpaez(dark).png'
import jpaezLight from '../../assets/login/jpaez(light).png'
import './dashboard.css'
import Sidebar, { MENU_STRUCTURE, PanelLeftOpen } from './Sidebar'
import Workspace from './Workspace'

function DashboardLayout({ user, darkMode, onLogout, isEntering }) {
  const [openTabs, setOpenTabs] = useState([MENU_STRUCTURE[0].label])
  const [activeItem, setActiveItem] = useState(MENU_STRUCTURE[0].label)
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)

  const heroLogo = useMemo(() => (darkMode ? kavaDark : kavaLight), [darkMode])
  const brandLogo = useMemo(() => (darkMode ? kavaDark : kavaLight), [darkMode])
  const partnerLogo = useMemo(() => (darkMode ? jpaezDark : jpaezLight), [darkMode])

  const handleSelect = (label) => {
    setActiveItem(label)
    setOpenTabs((prev) => (prev.includes(label) ? prev : [...prev, label]))
  }

  const handleCloseTab = (label) => {
    setOpenTabs((prev) => {
      const filteredTabs = prev.filter((tab) => tab !== label)

      if (label === activeItem) {
        setActiveItem(filteredTabs[filteredTabs.length - 1] || '')
      }

      return filteredTabs
    })
  }

  return (
    <div
      className={`dashboard-shell ${darkMode ? 'dark' : 'light'} ${isEntering ? 'entering' : ''} ${isSidebarOpen ? '' : 'collapsed'}`}
    >
      <Sidebar
        activeItem={activeItem}
        onSelect={handleSelect}
        user={user}
        onLogout={onLogout}
        brandLogo={brandLogo}
        partnerLogo={partnerLogo}
        isOpen={isSidebarOpen}
        onToggleSidebar={() => setIsSidebarOpen((value) => !value)}
      />

      <Workspace
        activeItem={activeItem}
        openTabs={openTabs}
        onSelectTab={handleSelect}
        onCloseTab={handleCloseTab}
        user={user}
        logo={heroLogo}
      />

      {!isSidebarOpen && (
        <button
          type="button"
          className="sidebar__reopen"
          onClick={() => setIsSidebarOpen(true)}
        >
          <PanelLeftOpen />
          Abrir panel
        </button>
      )}
    </div>
  )
}

export default DashboardLayout
