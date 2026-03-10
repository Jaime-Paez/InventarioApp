self.addEventListener('message', (event) => {
  const payload = event?.data || {}
  if (payload?.type !== 'SHOW_NOTIFICATION') return

  const data = payload?.payload || {}
  const title = String(data?.title || '').trim() || 'Inventario App'
  const options = {
    body: String(data?.options?.body || '').trim(),
    tag: String(data?.options?.tag || '').trim(),
    renotify: Boolean(data?.options?.renotify ?? true),
    requireInteraction: Boolean(data?.options?.requireInteraction || false),
    data: {
      ...(data?.options?.data || {}),
      url: String(data?.options?.data?.url || '/').trim() || '/',
    },
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = String(event?.notification?.data?.url || '/').trim() || '/'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (!client) continue
        if ('focus' in client) {
          client.focus()
          client.postMessage({
            type: 'SYSTEM_NOTIFICATION_CLICK',
            payload: { url: targetUrl },
          })
          return
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl)
      }
      return undefined
    })
  )
})
