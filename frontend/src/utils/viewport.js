// Mismo corte que DashboardLayout usa para "mobile".
export const PHONE_VIEWPORT_QUERY = '(max-width: 900px)'

export const isPhoneViewport = () =>
  typeof window !== 'undefined' && Boolean(window.matchMedia?.(PHONE_VIEWPORT_QUERY).matches)
