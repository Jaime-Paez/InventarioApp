// Tipo de salida a otra sucursal (solo traslados). Debe coincidir con
// MovimientoInventario.TipoEnvio en el backend.
export const TIPO_ENVIO_OPTIONS = [
  { value: 'traslado_normal', label: 'Traslado normal' },
  { value: 'envio_cliente', label: 'Envío cliente' },
  { value: 'envio_provincia', label: 'Envío provincia' },
]

export const tipoEnvioLabel = (value) =>
  TIPO_ENVIO_OPTIONS.find((option) => option.value === value)?.label || 'Traslado normal'
