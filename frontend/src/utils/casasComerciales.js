// Selector de casas comerciales de un producto. Solo las casas locales se
// combinan entre si (un producto de compra local puede venir de varios
// proveedores, p. ej. "COMPRA LOCAL" y "TECNOVA"); si entra una casa de
// importacion, o una local sobre una de importacion, reemplaza a las demas.
export const toggleCasaSelection = (current, supplier) => {
  const list = Array.isArray(current) ? current : []
  const id = String(supplier.id)
  if (list.some((casa) => String(casa.id) === id)) {
    return list.filter((casa) => String(casa.id) !== id)
  }
  const casa = { id: supplier.id, nombre: supplier.nombre, tipo: supplier.tipo }
  const combinable = supplier.tipo === 'local' && list.every((item) => item.tipo === 'local')
  return combinable ? [...list, casa] : [casa]
}
