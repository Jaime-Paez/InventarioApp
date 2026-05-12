const parseProductCodeFromLabel = (label) => {
  const raw = String(label ?? '').trim()
  if (!raw) return ''
  const match = /\(([^)]+)\)\s*$/.exec(raw)
  return match ? match[1].trim() : ''
}

const parseProductNameFromLabel = (label) => {
  const raw = String(label ?? '').trim()
  if (!raw) return ''
  const match = /\(([^)]+)\)\s*$/.exec(raw)
  return match ? raw.slice(0, match.index).trim() : raw
}

export const formatMovementProductLabel = (product) =>
  [product?.producto_codigo, product?.producto_nombre]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .join(' - ')

export const formatMovementProductQuantity = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return '-'
  return Number.isInteger(parsed) ? String(parsed) : parsed.toFixed(2)
}

export const normalizeMovementProducts = (details) =>
  (Array.isArray(details) ? details : [])
    .map((detail) => {
      const productLabel = String(detail?.producto || '').trim()
      const productoCodigo = String(
        detail?.producto_codigo || parseProductCodeFromLabel(productLabel)
      ).trim()
      const productoNombre = String(
        detail?.producto_nombre || parseProductNameFromLabel(productLabel)
      ).trim()
      const cantidad = Number(detail?.cantidad)

      return {
        ...detail,
        producto_codigo: productoCodigo,
        producto_nombre: productoNombre,
        cantidad: Number.isFinite(cantidad) ? cantidad : 0,
      }
    })
    .filter((detail) => detail.producto_codigo || detail.producto_nombre)

export const buildMovementProductsSearchText = (products) =>
  (Array.isArray(products) ? products : [])
    .map((product) =>
      [product?.producto_codigo, product?.producto_nombre].filter(Boolean).join(' ')
    )
    .filter(Boolean)
    .join(' | ')

export const buildMovementProductsExportText = (products) =>
  (Array.isArray(products) ? products : [])
    .map((product) => {
      const base = formatMovementProductLabel(product)
      if (!base) return ''
      const quantity = formatMovementProductQuantity(product?.cantidad)
      return quantity === '-' ? base : `${base} x ${quantity}`
    })
    .filter(Boolean)
    .join('; ')

export const buildMovementExportColumns = (columns) =>
  (Array.isArray(columns) ? columns : []).flatMap((col) => {
    if (col?.key === 'productos_resumen') {
      return [
        { key: 'producto_codigo', header: 'Código' },
        { key: 'producto_nombre', header: 'Nombre producto' },
        { key: 'producto_cantidad', header: 'Cantidad' },
      ]
    }
    return [col]
  })

export const buildMovementProductExportRows = (rows, columns) => {
  const exportColumns = Array.isArray(columns) ? columns : []
  const shouldExpandByProduct = exportColumns.some(
    (col) => col?.key === 'producto_cantidad' || col?.key === 'producto_codigo' || col?.key === 'producto_nombre'
  )
  const baseRows = Array.isArray(rows) ? rows : []
  if (!shouldExpandByProduct) return baseRows

  return baseRows.flatMap((row) => {
    const products = Array.isArray(row?.productos) ? row.productos : []
    if (!products.length) {
      return [{ ...row, __export_product: null }]
    }
    return products.map((product) => ({
      ...row,
      __export_product: product,
    }))
  })
}
