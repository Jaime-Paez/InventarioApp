// Selector de casas comerciales de un producto. Si hay una casa local de por
// medio se pueden combinar varias (un producto de compra local puede venir de
// varios proveedores, p. ej. "COMPRA LOCAL" y "TECNOVA"); entre casas de
// importacion solamente, la nueva reemplaza a la anterior.
export const toggleCasaSelection = (current, supplier) => {
  const list = Array.isArray(current) ? current : []
  const id = String(supplier.id)
  if (list.some((casa) => String(casa.id) === id)) {
    return list.filter((casa) => String(casa.id) !== id)
  }
  const casa = { id: supplier.id, nombre: supplier.nombre, tipo: supplier.tipo }
  const combinable = supplier.tipo === 'local' || list.some((item) => item.tipo === 'local')
  return combinable ? [...list, casa] : [casa]
}
