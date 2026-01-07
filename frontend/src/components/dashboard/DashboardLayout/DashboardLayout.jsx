import { useEffect, useMemo, useState } from 'react'
import { PanelLeftOpen } from 'lucide-react'
import kavaDark from '../../../assets/login/kava(dark).png'
import kavaLight from '../../../assets/login/kava(light).png'
import jpaezDark from '../../../assets/login/jpaez(dark).png'
import jpaezLight from '../../../assets/login/jpaez(light).png'
import './DashboardLayout.css'
import Sidebar from '../Sidebar/Sidebar'
import Workspace from '../Workspace/Workspace'
import { buildPermissionIndex, labelHasAccess } from '../menuConfig'

function DashboardLayout({
  user,
  token,
  darkMode,
  onLogout,
  onToggleTheme,
  permissions,
  isLeaving = false,
}) {
  const [openTabs, setOpenTabs] = useState([])
  const [activeItem, setActiveItem] = useState('')
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return true
    return !window.matchMedia('(max-width: 900px)').matches
  })
  const [hasEntered, setHasEntered] = useState(false)
  const [entryAnimationDone, setEntryAnimationDone] = useState(false)
  const [isMobileViewport, setIsMobileViewport] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(max-width: 900px)').matches
  })

  const heroLogo = useMemo(() => (darkMode ? kavaDark : kavaLight), [darkMode])
  const brandLogo = useMemo(() => (darkMode ? kavaDark : kavaLight), [darkMode])
  const partnerLogo = useMemo(() => (darkMode ? jpaezDark : jpaezLight), [darkMode])
  const permissionIndex = useMemo(() => buildPermissionIndex(permissions), [permissions])

  useEffect(() => {
    setHasEntered(true)
    const timeout = setTimeout(() => setEntryAnimationDone(true), 2600)

    return () => clearTimeout(timeout)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined
    const mediaQuery = window.matchMedia('(max-width: 900px)')
    const handleChange = (event) => setIsMobileViewport(event.matches)
    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [])

  useEffect(() => {
    setOpenTabs((prev) => prev.filter((tab) => labelHasAccess(tab, permissionIndex)))
    if (activeItem && !labelHasAccess(activeItem, permissionIndex)) {
      setActiveItem('')
    }
  }, [permissionIndex, activeItem])

  useEffect(() => {
    if (isLeaving) {
      setOpenTabs([])
      setActiveItem('')
    }
  }, [isLeaving])

  const handleSelect = (label) => {
    if (!labelHasAccess(label, permissionIndex)) return
    setActiveItem(label)
    setOpenTabs((prev) => (prev.includes(label) ? prev : [...prev, label]))
    if (isMobileViewport) {
      setIsSidebarOpen(false)
    }
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
      className={`dashboard-shell ${darkMode ? 'dark' : 'light'} ${isSidebarOpen ? '' : 'collapsed'} ${isLeaving ? 'leaving' : hasEntered && !entryAnimationDone ? 'enter' : ''}`}
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
        permissionIndex={permissionIndex}
      />

      {isSidebarOpen && isMobileViewport && (
        <button
          type="button"
          className="sidebar__backdrop"
          aria-label="Cerrar panel de navegación"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

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
        permissionIndex={permissionIndex}
        isLeaving={isLeaving}
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
