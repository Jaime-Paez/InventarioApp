import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './styles/polish.css'
import App from './App.jsx'
import { registerSystemNotificationWorker } from './utils/systemNotifications'
import { startNativeTooltipBlocker } from './utils/nativeTooltips'
import { addLocale, locale } from 'primereact/api'

// /descargar es una pagina estatica (public/descargar/) con el APK; si el
// hosting reescribe la ruta sin barra final a la SPA, se manda alli.
if (window.location.pathname === '/descargar') {
  window.location.replace('/descargar/')
}

addLocale('es', {
  startsWith: 'Comienza con',
  contains: 'Contiene',
  notContains: 'No contiene',
  endsWith: 'Termina con',
  equals: 'Es igual a',
  notEquals: 'No es igual a',
  noFilter: 'Sin filtro',
  lt: 'Menor que',
  lte: 'Menor o igual que',
  gt: 'Mayor que',
  gte: 'Mayor o igual que',
  dateIs: 'Fecha es',
  dateIsNot: 'Fecha no es',
  dateBefore: 'Antes de',
  dateAfter: 'Después de',
  clear: 'Limpiar',
  apply: 'Aplicar',
  matchAll: 'Coincidir todos',
  matchAny: 'Coincidir alguno',
  addRule: 'Agregar regla',
  removeRule: 'Eliminar regla',
  accept: 'Sí',
  reject: 'No',
  choose: 'Elegir',
  upload: 'Subir',
  cancel: 'Cancelar',
  fileSizeTypes: ['B', 'KB', 'MB', 'GB', 'TB'],
  dayNames: ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'],
  dayNamesShort: ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'],
  dayNamesMin: ['D', 'L', 'M', 'X', 'J', 'V', 'S'],
  monthNames: ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'],
  monthNamesShort: ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'],
  today: 'Hoy',
  weekHeader: 'Sem',
  firstDayOfWeek: 1,
  showMonthAfterYear: false,
  dateFormat: 'dd/mm/yy',
  weak: 'Débil',
  medium: 'Medio',
  strong: 'Fuerte',
  passwordPrompt: 'Ingrese una contraseña',
  emptyFilterMessage: 'Sin resultados',
  emptyMessage: 'Sin opciones disponibles',
})
locale('es')

document.addEventListener('wheel', () => {
  if (document.activeElement?.type === 'number') {
    document.activeElement.blur()
  }
}, { passive: true })

startNativeTooltipBlocker()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

void registerSystemNotificationWorker()
