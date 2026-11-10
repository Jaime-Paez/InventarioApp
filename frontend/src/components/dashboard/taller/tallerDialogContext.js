import { createContext } from 'react'

// La pagina avisa si su pestana del sistema esta activa. Con la pestana en
// otra seccion, las ventanas (TallerDialog) se ocultan sin cerrarse ni perder
// lo escrito, y vuelven al regresar: antes quedaban encima de la otra seccion.
export const TallerDialogsOcultos = createContext(false)
