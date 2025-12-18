import {
  Layers,
  ArrowRightLeft,
  CircleArrowDown,
  CircleArrowUp,
  Tag,
  Map as MapIcon,
  Compass,
  Box,
  Truck,
  Hexagon,
  Building,
  Hand,
  UsersRound,
  IdCard,
} from 'lucide-react'

export const MENU_STRUCTURE = [
  { label: 'Inventario', icon: Layers, moduleKey: 'inventario' },
  {
    label: 'Movimientos',
    icon: ArrowRightLeft,
    moduleKey: 'movimientos',
    children: [
      { label: 'Entradas', icon: CircleArrowDown, moduleKey: 'movimientos', submoduleKey: 'mov_entradas' },
      { label: 'Salidas', icon: CircleArrowUp, moduleKey: 'movimientos', submoduleKey: 'mov_salidas' },
    ],
  },
  { label: 'Productos', icon: Tag, moduleKey: 'productos' },
  {
    label: 'Sucursales',
    icon: MapIcon,
    moduleKey: 'sucursales',
    children: [
      { label: 'Sucursales', icon: Compass, moduleKey: 'sucursales', submoduleKey: 'suc_sucursales' },
      { label: 'Bodegas', icon: Box, moduleKey: 'sucursales', submoduleKey: 'suc_bodegas' },
    ],
  },
  {
    label: 'Proveedores',
    icon: Truck,
    moduleKey: 'proveedores',
    children: [
      { label: 'Marcas', icon: Hexagon, moduleKey: 'proveedores', submoduleKey: 'prov_marcas' },
      { label: 'Casas comerciales', icon: Building, moduleKey: 'proveedores', submoduleKey: 'prov_casas' },
    ],
  },
  { label: 'Solicitudes', icon: Hand, moduleKey: 'solicitudes' },
  { label: 'Clientes', icon: UsersRound, moduleKey: 'clientes' },
  { label: 'Administrar', icon: IdCard, moduleKey: 'usuarios' },
]

export const buildPermissionIndex = (permissions) => {
  if (!Array.isArray(permissions)) return null
  const index = new Map()
  permissions.forEach((permiso) => {
    if (!permiso?.modulo) return
    const key = `${permiso.modulo}:${permiso.submodulo || ''}`
    const current = index.get(key) || {
      puede_crear: false,
      puede_leer: false,
      puede_actualizar: false,
      puede_eliminar: false,
    }

    index.set(key, {
      puede_crear: current.puede_crear || Boolean(permiso.puede_crear),
      puede_leer: current.puede_leer || Boolean(permiso.puede_leer),
      puede_actualizar: current.puede_actualizar || Boolean(permiso.puede_actualizar),
      puede_eliminar: current.puede_eliminar || Boolean(permiso.puede_eliminar),
    })
  })
  return index
}

const hasActions = (permiso) =>
  permiso && (permiso.puede_crear || permiso.puede_leer || permiso.puede_actualizar || permiso.puede_eliminar)

const hasPermissionForTarget = (moduleKey, submoduleKey, permissionIndex) => {
  if (!permissionIndex || !moduleKey) return true
  const key = `${moduleKey}:${submoduleKey || ''}`
  const specific = permissionIndex.get(key)
  if (hasActions(specific)) return true

  const generalKey = `${moduleKey}:`
  const general = permissionIndex.get(generalKey)
  return hasActions(general)
}

export const itemHasAccess = (item, permissionIndex) => {
  if (!permissionIndex) return true
  if (item.children?.length) {
    return item.children.some((child) => itemHasAccess(child, permissionIndex))
  }
  return hasPermissionForTarget(item.moduleKey, item.submoduleKey, permissionIndex)
}

export const filterMenuByPermissions = (menu, permissionIndex) => {
  if (!permissionIndex) return menu

  return menu
    .map((item) => {
      if (item.children?.length) {
        const filteredChildren = item.children.filter((child) => itemHasAccess(child, permissionIndex))
        if (!filteredChildren.length) return null
        return { ...item, children: filteredChildren }
      }
      return itemHasAccess(item, permissionIndex) ? item : null
    })
    .filter(Boolean)
}

const flattenMenu = (menu) =>
  menu.reduce((acc, item) => {
    acc.push(item)
    if (item.children?.length) acc.push(...flattenMenu(item.children))
    return acc
  }, [])

export const labelHasAccess = (label, permissionIndex, menu = MENU_STRUCTURE) => {
  const flattened = flattenMenu(menu)
  const item = flattened.find((entry) => entry.label === label)
  if (!item) return true
  return itemHasAccess(item, permissionIndex)
}
