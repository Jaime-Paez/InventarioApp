export const IVA_UPDATED_EVENT = 'iva:updated'

export const emitIvaUpdated = (rate) => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent(IVA_UPDATED_EVENT, {
      detail: { rate },
    })
  )
}

export const onIvaUpdated = (handler) => {
  if (typeof window === 'undefined' || typeof handler !== 'function') return () => {}

  const listener = (event) => {
    handler(event?.detail?.rate)
  }

  window.addEventListener(IVA_UPDATED_EVENT, listener)
  return () => window.removeEventListener(IVA_UPDATED_EVENT, listener)
}
