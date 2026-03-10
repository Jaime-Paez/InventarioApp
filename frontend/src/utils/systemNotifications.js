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

export const showSystemNotification = async ({
  title,
  body,
  tag = '',
  url = '/',
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
      url: normalizeText(url, '/'),
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
      try {
        const targetUrl = normalizeText(options?.data?.url, '/')
        if (targetUrl) window.location.assign(targetUrl)
      } catch {
        // No-op.
      }
    }
    return true
  } catch {
    return false
  }
}
