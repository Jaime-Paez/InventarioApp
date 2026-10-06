import { createContext } from 'react'

// Cambios sin guardar: una sola pregunta "¿Guardar cambios?" para cerrar una
// ventana (modal) y para cerrar la pestana que la contiene. Cada ventana con
// cambios se registra aqui (con la pestana en la que vive); al cerrar la
// pestana, si alguna tiene cambios, se pregunta antes en vez de perderlos.

export const guards = new Map() // id -> { tab, label, save }
let pendingTabClose = null // { tab, close, labels, canSave, saving, error }
const listeners = new Set()
let snapshot = { size: 0, pending: null }

export const emit = () => {
  snapshot = { size: guards.size, pending: pendingTabClose }
  listeners.forEach((listener) => listener())
}
export const subscribe = (listener) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export const getSnapshot = () => snapshot

export const setPendingTabClose = (value) => {
  pendingTabClose = value
  emit()
}

export const guardsForTab = (tab) => Array.from(guards.values()).filter((guard) => tab == null || guard.tab === tab)

export const hasUnsavedChanges = (tab = null) => guardsForTab(tab).length > 0

// Cierra la pestana `tab` (o, con tab = null, todo: p. ej. al salir) llamando
// a `close`, preguntando antes si hay ventanas con cambios sin guardar.
export const requestTabClose = (tab, close) => {
  const pending = guardsForTab(tab)
  if (!pending.length) {
    close()
    return
  }
  setPendingTabClose({
    tab,
    close,
    labels: Array.from(new Set(pending.map((guard) => guard.label).filter(Boolean))),
    canSave: pending.every((guard) => typeof guard.save === 'function'),
    saving: false,
    error: '',
  })
}

export const UnsavedTabContext = createContext(null)
