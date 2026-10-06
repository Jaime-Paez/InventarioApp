import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import { UnsavedChangesDialog } from './unsavedChanges'
import { UnsavedTabContext, emit, guards } from './unsavedStore'

// ------------------------------------------------------------- hook por ventana
/**
 * Pregunta "¿Guardar cambios?" al cerrar una ventana con cambios, y la registra
 * para que cerrar su pestana tambien pregunte.
 *
 * - watch: el estado editable (objeto serializable). Hay cambios cuando, despues
 *   de que el usuario toco algo dentro de la ventana, difiere de como abrio. Lo
 *   que se carga solo al abrir (catalogos, valores por defecto) no cuenta.
 * - enabled: solo vigila mientras sea true (p. ej. en modo edicion).
 * - onSave: guarda; debe devolver true si se guardo (false/throw si no).
 * - onClose: cierra la ventana sin preguntar.
 *
 * Devuelve { requestClose, dialog, interactionProps, markSaved, dirty }:
 * usar requestClose en la X / Cancelar / clic afuera / Escape, poner {dialog}
 * en el JSX y {...interactionProps} en el contenedor de la ventana.
 */
export default function useUnsavedChangesGuard({ watch, enabled = true, onSave, onClose, label = '' }) {
  const tab = useContext(UnsavedTabContext)
  const id = useId()
  const serialized = useMemo(() => {
    try {
      return JSON.stringify(watch ?? null)
    } catch {
      return ''
    }
  }, [watch])
  const touchedRef = useRef(false)
  const baselineRef = useRef(serialized)
  const [showDialog, setShowDialog] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Al activarse (abrir / entrar a modo edicion) se empieza de cero: el clic
  // en "Editar" no cuenta como cambio. Mientras el usuario no toque nada, lo
  // que llegue (carga inicial, valores por defecto) pasa a ser el punto de partida.
  const wasEnabledRef = useRef(enabled)
  if (enabled && !wasEnabledRef.current) touchedRef.current = false
  wasEnabledRef.current = enabled
  if (!enabled || !touchedRef.current) {
    baselineRef.current = serialized
    if (!enabled) touchedRef.current = false
  }
  const dirty = Boolean(enabled && touchedRef.current && serialized !== baselineRef.current)

  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const markSaved = useCallback(() => {
    touchedRef.current = false
    baselineRef.current = serialized
  }, [serialized])

  useEffect(() => {
    if (!dirty) {
      guards.delete(id)
      emit()
      return undefined
    }
    guards.set(id, {
      tab,
      label,
      save: typeof onSaveRef.current === 'function' ? () => onSaveRef.current() : null,
    })
    emit()
    return () => {
      guards.delete(id)
      emit()
    }
  }, [dirty, id, label, tab])

  useEffect(() => () => {
    guards.delete(id)
    emit()
  }, [id])

  const markTouched = useCallback(() => {
    touchedRef.current = true
  }, [])
  const interactionProps = useMemo(() => ({
    onInputCapture: markTouched,
    onChangeCapture: markTouched,
    onPointerDownCapture: markTouched,
    onKeyDownCapture: markTouched,
  }), [markTouched])

  const requestClose = useCallback(() => {
    if (dirty) {
      setError('')
      setShowDialog(true)
      return
    }
    onCloseRef.current?.()
  }, [dirty])

  const dialog = (
    <UnsavedChangesDialog
      open={showDialog}
      saving={saving}
      error={error}
      canSave={typeof onSave === 'function'}
      onCancel={() => setShowDialog(false)}
      onDiscard={() => {
        setShowDialog(false)
        guards.delete(id)
        emit()
        onCloseRef.current?.()
      }}
      onSave={async () => {
        setSaving(true)
        setError('')
        let ok = false
        try {
          ok = (await onSaveRef.current?.()) === true
        } catch {
          ok = false
        }
        setSaving(false)
        if (ok) {
          setShowDialog(false)
          guards.delete(id)
          emit()
          onCloseRef.current?.()
        } else {
          setError('No se pudo guardar. Revisa los datos marcados en la ventana.')
          setShowDialog(false)
        }
      }}
    />
  )

  return { requestClose, dialog, interactionProps, markSaved, dirty }
}

/**
 * Para ventanas que ya tienen su propio "¿Guardar cambios?": solo las registra
 * en su pestana, para que cerrar la pestana tambien pregunte.
 * - dirty: si hay cambios sin guardar.
 * - onSave: guarda; debe devolver true si se guardo.
 */
export function useUnsavedChangesRegistration({ dirty, onSave, label = '' }) {
  const tab = useContext(UnsavedTabContext)
  const id = useId()
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const hasSave = typeof onSave === 'function'

  useEffect(() => {
    if (!dirty) {
      guards.delete(id)
      emit()
      return undefined
    }
    guards.set(id, {
      tab,
      label,
      save: hasSave ? () => onSaveRef.current() : null,
    })
    emit()
    return () => {
      guards.delete(id)
      emit()
    }
  }, [dirty, hasSave, id, label, tab])
}
