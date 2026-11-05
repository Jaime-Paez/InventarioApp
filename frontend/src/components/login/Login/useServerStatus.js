import { useCallback, useEffect, useRef, useState } from 'react'
import { API_URL } from '../../../utils/api'

export const RETRY_SECONDS = 15
const PING_TIMEOUT_MS = 10000
// Sobrevive a la recarga de la pagina (solo esta pestana). Nunca la contrasena.
const RECOVERY_KEY = 'kava-login-servidor-caido'

const readRecovery = () => {
  try {
    const raw = sessionStorage.getItem(RECOVERY_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

const writeRecovery = (value) => {
  try {
    if (value) sessionStorage.setItem(RECOVERY_KEY, JSON.stringify(value))
    else sessionStorage.removeItem(RECOVERY_KEY)
  } catch {
    // Sin sessionStorage: igual se recarga, solo no recuerda el intento.
  }
}

// Estado del backend para el login. No se prueba nada al abrir la pantalla:
// solo despues de que un intento de login falla por el servidor (markDown).
// Desde ahi la PAGINA COMPLETA se recarga cada RETRY_SECONDS; tras cada
// recarga se prueba el servidor y, si sigue caido, se vuelve a esperar.
// status: 'idle' | 'checking' | 'up' | 'down'
export default function useServerStatus() {
  const [recovery] = useState(readRecovery)
  const [status, setStatus] = useState(recovery ? 'checking' : 'idle')
  const [secondsLeft, setSecondsLeft] = useState(RETRY_SECONDS)
  const [attempts, setAttempts] = useState(recovery?.attempts || 0)
  const [recovered, setRecovered] = useState(false)
  const reloadingRef = useRef(false)

  const reloadPage = useCallback(() => {
    if (reloadingRef.current) return
    reloadingRef.current = true
    const current = readRecovery() || {}
    writeRecovery({ ...current, attempts: (current.attempts || 0) + 1 })
    window.location.reload()
  }, [])

  // El login fallo por el servidor (no por credenciales).
  const markDown = useCallback((email = '') => {
    const current = readRecovery() || {}
    writeRecovery({ ...current, email: email || current.email || '', attempts: current.attempts || 1 })
    setAttempts(current.attempts || 1)
    setSecondsLeft(RETRY_SECONDS)
    setStatus('down')
  }, [])

  const cancel = useCallback(() => {
    writeRecovery(null)
    setStatus('idle')
  }, [])

  // Despues de una recarga por servidor caido: probar si ya responde.
  useEffect(() => {
    if (!recovery) return undefined
    let cancelled = false
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), PING_TIMEOUT_MS)
    fetch(`${API_URL}/ping/?db=1`, { signal: controller.signal, cache: 'no-store' })
      .then((response) => response.ok)
      .catch(() => false)
      .then((ok) => {
        window.clearTimeout(timer)
        if (cancelled) return
        if (ok) {
          writeRecovery(null)
          setRecovered(true)
          setStatus('up')
        } else {
          setSecondsLeft(RETRY_SECONDS)
          setStatus('down')
        }
      })
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [recovery])

  // Cuenta regresiva mientras este caido; al llegar a 0 se recarga todo.
  useEffect(() => {
    if (status !== 'down') return undefined
    const timer = window.setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [status])

  useEffect(() => {
    if (status === 'down' && secondsLeft === 0) reloadPage()
  }, [status, secondsLeft, reloadPage])

  // "Servidor disponible" se ve unos segundos y se va.
  useEffect(() => {
    if (!recovered) return undefined
    const timer = window.setTimeout(() => setRecovered(false), 5000)
    return () => window.clearTimeout(timer)
  }, [recovered])

  return {
    status,
    secondsLeft,
    attempts,
    recovered,
    savedEmail: recovery?.email || '',
    markDown,
    reloadNow: reloadPage,
    cancel,
  }
}
