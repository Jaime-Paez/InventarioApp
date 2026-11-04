import { forwardRef } from 'react'
import { Toast } from 'primereact/toast'

// Toast de toda la app. El de PrimeReact se dibuja dentro del componente
// (appendTo 'self') con capa 1200, asi que en las pantallas con modal
// (1400-20000) quedaba detras, en la zona oscura. Este va siempre directo al
// body y por encima de todo, para que siempre se vea.
const TOAST_Z_INDEX = 30000

const AppToast = forwardRef(function AppToast({ baseZIndex, appendTo, ...props }, ref) {
  return (
    <Toast
      ref={ref}
      {...props}
      appendTo={appendTo || (typeof document !== 'undefined' ? document.body : undefined)}
      baseZIndex={Math.max(Number(baseZIndex) || 0, TOAST_Z_INDEX)}
    />
  )
})

export default AppToast
