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
    children: [
      { label: 'Entradas', icon: CircleArrowDown, moduleKey: 'movimientos_entradas' },
      { label: 'Salidas', icon: CircleArrowUp, moduleKey: 'movimientos_salidas' },
    ],
  },
  { label: 'Productos', icon: Tag, moduleKey: 'productos' },
  {
    label: 'Sucursales',
    icon: MapIcon,
    children: [
      { label: 'Sucursales', icon: Compass, moduleKey: 'sucursales_sucursales' },
      { label: 'Bodegas', icon: Box, moduleKey: 'sucursales_bodegas' },
    ],
  },
  {
    label: 'Proveedores',
    icon: Truck,
    children: [
      { label: 'Marcas', icon: Hexagon, moduleKey: 'proveedores_marcas' },
      { label: 'Casas comerciales', icon: Building, moduleKey: 'proveedores_casas' },
    ],
  },
  { label: 'Solicitudes', icon: Hand, moduleKey: 'solicitudes' },
  { label: 'Administrar', icon: IdCard, moduleKey: 'usuarios' },
  { label: 'Clientes', icon: UsersRound, moduleKey: 'clientes' },
]

const collectPermissionEntries = (permissionSource) => {
  const collected = []

  const visit = (entry) => {
    if (!entry) return

    if (Array.isArray(entry)) {
      entry.forEach(visit)
      return
    }

    if (Array.isArray(entry.results)) {
      visit(entry.results)
    }

    if (Array.isArray(entry.permisos)) {
      visit(entry.permisos)
    }

    if (entry.modulo) {
      collected.push(entry)
    }
  }

  visit(permissionSource)
  return collected
}

export const buildPermissionIndex = (permissions) => {
  const hasPermissionData =
    Array.isArray(permissions) || Array.isArray(permissions?.results) || Array.isArray(permissions?.permisos)

  if (!hasPermissionData) return null

  const permissionEntries = collectPermissionEntries(permissions)
  const index = new Map()

  permissionEntries.forEach((permiso) => {
    if (!permiso?.modulo) return
    const key = permiso.modulo
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

const MODULE_ACTION_KEYS = ['puede_crear', 'puede_leer', 'puede_actualizar', 'puede_eliminar']

export const getModuleActions = (moduleKey, permissionIndex) => {
  if (!permissionIndex || !moduleKey) {
    return {
      puede_crear: true,
      puede_leer: true,
      puede_actualizar: true,
      puede_eliminar: true,
    }
  }

  const permiso = permissionIndex.get(moduleKey)
  return {
    puede_crear: Boolean(permiso?.puede_crear),
    puede_leer: Boolean(permiso?.puede_leer),
    puede_actualizar: Boolean(permiso?.puede_actualizar),
    puede_eliminar: Boolean(permiso?.puede_eliminar),
  }
}

export const moduleHasAnyAction = (moduleKey, permissionIndex, actionKeys = MODULE_ACTION_KEYS) => {
  const actions = getModuleActions(moduleKey, permissionIndex)
  return actionKeys.some((key) => Boolean(actions?.[key]))
}

export const moduleHasAllActions = (moduleKey, permissionIndex, actionKeys = MODULE_ACTION_KEYS) => {
  const actions = getModuleActions(moduleKey, permissionIndex)
  return actionKeys.every((key) => Boolean(actions?.[key]))
}

const hasPermissionForTarget = (moduleKey, permissionIndex) => {
  if (!permissionIndex || !moduleKey) return true
  const permiso = permissionIndex.get(moduleKey)
  return Boolean(permiso?.puede_leer)
}

export const itemHasAccess = (item, permissionIndex) => {
  if (!permissionIndex) return true
  if (item.children?.length) {
    return item.children.some((child) => itemHasAccess(child, permissionIndex))
  }
  return hasPermissionForTarget(item.moduleKey, permissionIndex)
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
