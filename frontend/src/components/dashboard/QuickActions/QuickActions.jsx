import { Bell, Moon, Search, SunMedium } from 'lucide-react'
import './QuickActions.css'

function QuickActions({ darkMode, onToggleTheme }) {
  return (
    <div className={`quick-actions ${darkMode ? 'dark' : 'light'}`}>
      <button type="button" className="quick-actions__button" aria-label="Buscar">
        <Search />
      </button>

      <button type="button" className="quick-actions__button" aria-label="Notificaciones">
        <Bell />
      </button>

      <button
        type="button"
        className="quick-actions__button"
        aria-label={darkMode ? 'Activar modo claro' : 'Activar modo oscuro'}
        onClick={onToggleTheme}
      >
        {darkMode ? <SunMedium /> : <Moon />}
      </button>
    </div>
  )
}

export default QuickActions
