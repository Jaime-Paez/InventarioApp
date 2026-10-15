// Navegacion entre secciones del dashboard desde cualquier componente
// (p. ej. el boton "Ir a Usuarios" de un aviso). DashboardLayout escucha el
// evento y abre la pestana como si se hubiera elegido en el menu, respetando
// los permisos. `label` es el nombre del menu (ver menuConfig.js).
export const NAVIGATE_EVENT = 'app:navigate'

// Devuelve false si el usuario no tiene acceso a esa seccion.
export const goToSection = (label) => {
  if (typeof window === 'undefined' || !label) return false
  const detail = { label, handled: false }
  window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail }))
  return detail.handled
}
