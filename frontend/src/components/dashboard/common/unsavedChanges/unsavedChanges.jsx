import { useEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  UnsavedTabContext,
  getSnapshot,
  guards,
  guardsForTab,
  hasUnsavedChanges,
  setPendingTabClose,
  subscribe,
} from './unsavedStore'
import './unsavedChanges.css'

// ------------------------------------------------------- pestana del contenido
export function UnsavedTabScope({ tab, children }) {
  return <UnsavedTabContext.Provider value={tab}>{children}</UnsavedTabContext.Provider>
}

// ----------------------------------------------------------------- dialogo UI
export function UnsavedChangesDialog({ open, title = '¿Guardar cambios?', message, saving = false, error = '', canSave = true, saveLabel = 'Guardar y cerrar', onCancel, onDiscard, onSave }) {
  if (!open || typeof document === 'undefined') return null
  return createPortal(
    <div
      className="unsaved-dialog"
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onCancel?.() }}
    >
      <div className="unsaved-dialog__card">
        <h4>{title}</h4>
        <p>{message || 'Tienes cambios sin guardar. ¿Quieres guardarlos antes de cerrar?'}</p>
        {error && <p className="unsaved-dialog__error">{error}</p>}
        <div className="unsaved-dialog__actions">
          <button type="button" className="unsaved-dialog__btn" onClick={onCancel} disabled={saving}>
            Cancelar
          </button>
          <button type="button" className="unsaved-dialog__btn unsaved-dialog__btn--discard" onClick={onDiscard} disabled={saving}>
            No guardar
          </button>
          {canSave && (
            <button type="button" className="unsaved-dialog__btn unsaved-dialog__btn--save" onClick={onSave} disabled={saving}>
              {saving ? 'Guardando...' : saveLabel}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

// Va en DashboardLayout: muestra la pregunta al cerrar una pestana y avisa al
// recargar/cerrar el navegador si queda algo sin guardar.
export function UnsavedChangesHost() {
  const { pending } = useSyncExternalStore(subscribe, getSnapshot)

  useEffect(() => {
    const handleBeforeUnload = (event) => {
      if (!guards.size) return undefined
      event.preventDefault()
      event.returnValue = ''
      return ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])

  if (!pending) return null
  const where = pending.labels.length ? ` (${pending.labels.join(', ')})` : ''
  const finish = () => {
    const { close } = pending
    setPendingTabClose(null)
    close()
  }
  return (
    <UnsavedChangesDialog
      open
      message={
        pending.tab
          ? `La pestaña "${pending.tab}" tiene cambios sin guardar${where}. ¿Quieres guardarlos antes de cerrarla?`
          : `Tienes cambios sin guardar${where}. ¿Quieres guardarlos antes de salir?`
      }
      saving={pending.saving}
      error={pending.error}
      canSave={pending.canSave}
      onCancel={() => setPendingTabClose(null)}
      onDiscard={finish}
      onSave={async () => {
        setPendingTabClose({ ...pending, saving: true, error: '' })
        let ok = true
        for (const guard of guardsForTab(pending.tab)) {
          try {
            const result = await guard.save()
            if (result === false) ok = false
          } catch {
            ok = false
          }
        }
        if (ok && !hasUnsavedChanges(pending.tab)) {
          finish()
          return
        }
        setPendingTabClose({
          ...pending,
          saving: false,
          error: 'No se pudo guardar todo. Revisa la ventana abierta y vuelve a intentarlo.',
        })
      }}
    />
  )
}
