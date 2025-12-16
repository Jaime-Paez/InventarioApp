import { useEffect, useMemo, useState } from 'react'
import { PanelLeftOpen } from 'lucide-react'
import kavaDark from '../../../assets/login/kava(dark).png'
import kavaLight from '../../../assets/login/kava(light).png'
import jpaezDark from '../../../assets/login/jpaez(dark).png'
import jpaezLight from '../../../assets/login/jpaez(light).png'
import './DashboardLayout.css'
import Sidebar from '../Sidebar/Sidebar'
import Workspace from '../Workspace/Workspace'

function DashboardLayout({ user, token, darkMode, onLogout, onToggleTheme }) {
  const [openTabs, setOpenTabs] = useState([])
  const [activeItem, setActiveItem] = useState('')
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [hasEntered, setHasEntered] = useState(false)

  const heroLogo = useMemo(() => (darkMode ? kavaDark : kavaLight), [darkMode])
  const brandLogo = useMemo(() => (darkMode ? kavaDark : kavaLight), [darkMode])
  const partnerLogo = useMemo(() => (darkMode ? jpaezDark : jpaezLight), [darkMode])

  useEffect(() => {
    setHasEntered(true)
  }, [])

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
      className={`dashboard-shell ${darkMode ? 'dark' : 'light'} ${isSidebarOpen ? '' : 'collapsed'} ${hasEntered ? 'enter' : ''}`}
    >
      <Sidebar
        activeItem={activeItem}
        onSelect={handleSelect}
        openTabs={openTabs}
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
        token={token}
        darkMode={darkMode}
        onToggleTheme={onToggleTheme}
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
