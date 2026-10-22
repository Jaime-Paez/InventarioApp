// Aviso para que el contador/lista de "Por guardar" se actualice apenas algo
// entra a POR UBICAR (al recibir un envio), sin esperar al siguiente sondeo.
export const POR_GUARDAR_REFRESH_EVENT = 'kava:por-guardar-refresh'

export const requestPorGuardarRefresh = () => {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(POR_GUARDAR_REFRESH_EVENT))
}
