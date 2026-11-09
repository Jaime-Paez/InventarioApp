import { useCallback, useEffect, useRef, useState } from 'react'
import { API_URL, authFetch } from '../../../utils/api'

const AUTOSAVE_MS = 1200

const borradorUrl = (formulario) => `${API_URL}/borradores/${encodeURIComponent(formulario)}/`

/**
 * Borrador de un formulario a medio llenar (nueva salida, nueva entrada...),
 * guardado en la base de datos por usuario. Solo es un respaldo: NO crea el
 * movimiento ni mueve inventario.
 *
 * - Se guarda solo (cada cambio, con una pequena espera) y con save().
 * - Al abrir la ventana se recupera con onRestore(datos).
 * - clear() lo borra (al registrar de verdad o al volver Atras).
 *
 * Parametros:
 * - formulario: clave del formulario ('nueva-salida', 'nueva-entrada'...).
 * - open: si la ventana esta abierta.
 * - enabled: si se guarda ahora (p. ej. no en modos que ya tienen su propio borrador).
 * - restoreEnabled: si al abrir se recupera (no cuando la ventana llega precargada).
 * - snapshot: objeto serializable con lo que hay que guardar.
 * - hasContent: si hay algo que valga la pena guardar.
 * - onRestore: (datos) => void.
 */
export default function useBorradorFormulario({
  formulario,
  open,
  token,
  enabled = true,
  restoreEnabled = true,
  snapshot,
  hasContent,
  onRestore,
}) {
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const [restoredAt, setRestoredAt] = useState(null)
  const [error, setError] = useState('')

  const serialized = (() => {
    try {
      return JSON.stringify(snapshot ?? null)
    } catch {
      return ''
    }
  })()

  const lastSavedRef = useRef('')
  const timerRef = useRef(null)
  const pendingRef = useRef(null)
  const blockedRef = useRef(false)
  const onRestoreRef = useRef(onRestore)
  onRestoreRef.current = onRestore
  const tokenRef = useRef(token)
  tokenRef.current = token
  const restoreEnabledRef = useRef(restoreEnabled)
  restoreEnabledRef.current = restoreEnabled

  const put = useCallback(
    async (body, { keepalive = false } = {}) => {
      const response = await authFetch(
        borradorUrl(formulario),
        {
          method: 'PUT',
          keepalive,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ datos: JSON.parse(body) }),
        },
        tokenRef.current
      )
      if (!response.ok) throw new Error('No se pudo guardar el borrador.')
      const data = await response.json().catch(() => ({}))
      lastSavedRef.current = body
      setSavedAt(data?.actualizado_en || new Date().toISOString())
      setError('')
      return true
    },
    [formulario]
  )

  // Al abrir: trae el borrador guardado y lo recupera.
  useEffect(() => {
    if (!open) {
      setReady(false)
      return undefined
    }
    let cancelled = false
    blockedRef.current = false
    lastSavedRef.current = ''
    setSavedAt(null)
    setRestoredAt(null)
    setError('')
    setReady(false)
    authFetch(borradorUrl(formulario), {}, tokenRef.current)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled) return
        const datos = data?.datos
        if (datos && typeof datos === 'object' && restoreEnabledRef.current) {
          // Despues de que la ventana termine de reiniciarse al abrir.
          setTimeout(() => {
            if (cancelled) return
            onRestoreRef.current?.(datos)
            setRestoredAt(data.actualizado_en || null)
            setSavedAt(data.actualizado_en || null)
            setReady(true)
          }, 0)
          return
        }
        setReady(true)
      })
      .catch(() => {
        if (!cancelled) setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [open, formulario])

  // Guardado automatico.
  const canAutosave = Boolean(open && ready && enabled && hasContent && serialized)
  useEffect(() => {
    if (!canAutosave || blockedRef.current || serialized === lastSavedRef.current) return undefined
    pendingRef.current = serialized
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      const body = pendingRef.current
      pendingRef.current = null
      if (!body || blockedRef.current) return
      put(body).catch((err) => setError(err.message))
    }, AUTOSAVE_MS)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [canAutosave, serialized, put])

  // Si se cierra la ventana o la pagina con un cambio aun sin guardar, se guarda ya.
  const flush = useCallback(() => {
    const body = pendingRef.current
    if (!body || blockedRef.current) return
    pendingRef.current = null
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    put(body, { keepalive: true }).catch(() => {})
  }, [put])

  useEffect(() => {
    if (!open) return undefined
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [open, flush])

  const save = useCallback(async () => {
    if (!serialized) return false
    blockedRef.current = false
    pendingRef.current = null
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    setSaving(true)
    try {
      return await put(serialized)
    } catch (err) {
      setError(err.message)
      return false
    } finally {
      setSaving(false)
    }
  }, [put, serialized])

  // Borra el borrador. Hasta el siguiente cambio no se vuelve a guardar.
  const clear = useCallback(async () => {
    blockedRef.current = true
    pendingRef.current = null
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    lastSavedRef.current = ''
    setSavedAt(null)
    setRestoredAt(null)
    try {
      await authFetch(borradorUrl(formulario), { method: 'DELETE', keepalive: true }, tokenRef.current)
    } catch {
      // Si falla, el siguiente guardado lo reemplaza.
    }
  }, [formulario])

  // Tras clear(), el siguiente cambio real vuelve a habilitar el guardado.
  const clearedSnapshotRef = useRef(null)
  useEffect(() => {
    if (!blockedRef.current) {
      clearedSnapshotRef.current = null
      return
    }
    if (clearedSnapshotRef.current === null) {
      clearedSnapshotRef.current = serialized
      return
    }
    if (serialized !== clearedSnapshotRef.current && hasContent) {
      blockedRef.current = false
      clearedSnapshotRef.current = null
    }
  }, [serialized, hasContent])

  return { save, clear, saving, savedAt, restoredAt, error, ready }
}
