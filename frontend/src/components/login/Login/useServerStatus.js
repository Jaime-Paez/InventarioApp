import { useCallback, useEffect, useRef, useState } from 'react'
import { API_URL } from '../../../utils/api'

export const RETRY_SECONDS = 15
const PING_TIMEOUT_MS = 10000
const SLOW_AFTER_MS = 2500

// Estado del backend para el login. No se prueba nada al abrir la pantalla:
// solo cuando un intento de login falla por el servidor (markDown). Desde ahi
// se vuelve a probar solo cada RETRY_SECONDS hasta que responda.
// status: 'idle' (sin probar) | 'checking' | 'slow' | 'up' | 'down'
export default function useServerStatus() {
  const [status, setStatus] = useState('idle')
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [attempts, setAttempts] = useState(0)
  const [recovered, setRecovered] = useState(false)
  const statusRef = useRef('idle')
  const inFlightRef = useRef(false)
  const wasDownRef = useRef(false)

  const update = (next) => {
    statusRef.current = next
    setStatus(next)
  }

  const check = useCallback(async () => {
    if (inFlightRef.current) return statusRef.current === 'up'
    inFlightRef.current = true
    setAttempts((n) => n + 1)
    if (statusRef.current !== 'down') update('checking')
    const slowTimer = window.setTimeout(() => {
      if (statusRef.current === 'checking') update('slow')
    }, SLOW_AFTER_MS)
    const controller = new AbortController()
    const abortTimer = window.setTimeout(() => controller.abort(), PING_TIMEOUT_MS)
    let ok = false
    try {
      const response = await fetch(`${API_URL}/ping/?db=1`, { signal: controller.signal, cache: 'no-store' })
      ok = response.ok
    } catch {
      ok = false
    } finally {
      window.clearTimeout(slowTimer)
      window.clearTimeout(abortTimer)
      inFlightRef.current = false
    }
    if (ok) {
      if (wasDownRef.current) setRecovered(true)
      wasDownRef.current = false
      update('up')
      setAttempts(0)
    } else {
      wasDownRef.current = true
      update('down')
      setSecondsLeft(RETRY_SECONDS)
    }
    return ok
  }, [])

  // El login fallo por el servidor (no por credenciales): pasar a reintentar.
  const markDown = useCallback(() => {
    wasDownRef.current = true
    update('down')
    setSecondsLeft(RETRY_SECONDS)
  }, [])

  // Cuenta regresiva mientras este caido; al llegar a 0 se reintenta.
  useEffect(() => {
    if (status !== 'down') return undefined
    const timer = window.setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [status])

  useEffect(() => {
    if (status === 'down' && secondsLeft === 0) void check()
  }, [status, secondsLeft, check])

  // "Servidor disponible" se ve unos segundos y se va.
  useEffect(() => {
    if (!recovered) return undefined
    const timer = window.setTimeout(() => setRecovered(false), 4000)
    return () => window.clearTimeout(timer)
  }, [recovered])

  return { status, secondsLeft, attempts, recovered, check, markDown }
}
