let swRegistrationPromise = null

const isBrowser = () => typeof window !== 'undefined'

export const supportsSystemNotifications = () => {
  if (!isBrowser()) return false
  return 'Notification' in window
}

export const supportsServiceWorkerNotifications = () => {
  if (!isBrowser()) return false
  return window.isSecureContext && 'serviceWorker' in navigator
}

export const registerSystemNotificationWorker = async () => {
  if (!supportsServiceWorkerNotifications()) return null

  if (!swRegistrationPromise) {
    swRegistrationPromise = navigator.serviceWorker
      .register('/system-notifications-sw.js')
      .catch(() => null)
  }

  return swRegistrationPromise
}

export const requestSystemNotificationPermission = async ({ prompt = false } = {}) => {
  if (!supportsSystemNotifications()) return 'unsupported'

  const current = String(Notification.permission || 'default')
  if (current === 'granted' || !prompt) return current

  try {
    return await Notification.requestPermission()
  } catch {
    return String(Notification.permission || 'default')
  }
}

const normalizeText = (value, fallback = '') => {
  const normalized = String(value || '').trim()
  return normalized || fallback
}

// Destino de una notificacion: { kind, id }. Viaja en la url de la
// notificacion (/?abrir=kind&id=id) para que el clic lleve al lugar exacto,
// tanto con la app abierta (mensaje del service worker) como cerrada (la url).
export const NOTIFICATION_OPEN_EVENT = 'app:notification-open'

const buildNotificationUrl = (target) => {
  const kind = normalizeText(target?.kind)
  if (!kind) return '/'
  const params = new URLSearchParams({ abrir: kind })
  const id = normalizeText(target?.id)
  if (id) params.set('id', id)
  return `/?${params.toString()}`
}

export const parseNotificationTarget = (url) => {
  if (!isBrowser() || !url) return null
  try {
    const parsed = new URL(url, window.location.origin)
    const kind = normalizeText(parsed.searchParams.get('abrir'))
    if (!kind) return null
    return { kind, id: normalizeText(parsed.searchParams.get('id')) }
  } catch {
    return null
  }
}

const dispatchNotificationTarget = (target) => {
  if (!target) return
  window.dispatchEvent(new CustomEvent(NOTIFICATION_OPEN_EVENT, { detail: target }))
}

export const subscribeToNotificationClicks = (handler) => {
  if (!isBrowser() || typeof handler !== 'function') return () => {}

  const handleWindowEvent = (event) => {
    if (event?.detail) handler(event.detail)
  }
  const handleWorkerMessage = (event) => {
    if (event?.data?.type !== 'SYSTEM_NOTIFICATION_CLICK') return
    const target = parseNotificationTarget(event?.data?.payload?.url)
    if (target) handler(target)
  }

  window.addEventListener(NOTIFICATION_OPEN_EVENT, handleWindowEvent)
  const container = 'serviceWorker' in navigator ? navigator.serviceWorker : null
  container?.addEventListener('message', handleWorkerMessage)

  // Clic con la app cerrada: el service worker abrio /?abrir=... Se consume
  // una sola vez y se limpia la url.
  const initialTarget = parseNotificationTarget(window.location.href)
  let initialTimer = null
  if (initialTarget) {
    window.history.replaceState(null, '', window.location.pathname)
    initialTimer = window.setTimeout(() => handler(initialTarget), 0)
  }

  return () => {
    window.removeEventListener(NOTIFICATION_OPEN_EVENT, handleWindowEvent)
    container?.removeEventListener('message', handleWorkerMessage)
    if (initialTimer) window.clearTimeout(initialTimer)
  }
}

export const showSystemNotification = async ({
  title,
  body,
  tag = '',
  target = null,
  requireInteraction = false,
} = {}) => {
  if (!supportsSystemNotifications()) return false
  if (String(Notification.permission || '') !== 'granted') return false

  const notificationTitle = normalizeText(title, 'Inventario App')
  const options = {
    body: normalizeText(body),
    tag: normalizeText(tag),
    renotify: true,
    requireInteraction: Boolean(requireInteraction),
    data: {
      url: buildNotificationUrl(target),
      createdAt: new Date().toISOString(),
    },
  }

  const registration = await registerSystemNotificationWorker()
  if (registration?.showNotification) {
    await registration.showNotification(notificationTitle, options)
    return true
  }

  try {
    // Fallback when SW is unavailable but Notification API exists.
    const notification = new Notification(notificationTitle, options)
    notification.onclick = () => {
      try {
        window.focus()
      } catch {
        // No-op.
      }
      notification.close()
      dispatchNotificationTarget(parseNotificationTarget(options?.data?.url))
    }
    return true
  } catch {
    return false
  }
}
