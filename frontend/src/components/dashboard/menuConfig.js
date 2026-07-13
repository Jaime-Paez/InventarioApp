import {
  Layers,
  ArrowRightLeft,
  CircleArrowDown,
  CircleArrowUp,
  AlertTriangle,
  Tag,
  Map as MapIcon,
  Compass,
  Box,
  Building,
  UsersRound,
  IdCard,
  ClipboardCheck,
  ScrollText,
  PackagePlus,
  PackageCheck,
  Truck,
  Hand,
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
  {
    label: 'Importaciones',
    icon: PackagePlus,
    children: [
      { label: 'Solicitudes', icon: Hand, moduleKey: 'solicitudes' },
      { label: 'Importaciones', icon: PackageCheck, moduleKey: 'importaciones' },
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
  { label: 'Proveedores', icon: Truck, moduleKey: 'proveedores_casas' },
  { label: 'Clientes', icon: UsersRound, moduleKey: 'clientes' },
  {
    label: 'Inconvenientes',
    icon: AlertTriangle,
    moduleKey: 'movimientos_inconvenientes',
  },
  { label: 'Revision inventario', icon: ClipboardCheck, moduleKey: 'usuarios', requiresAdmin: true },
  { label: 'Administrar', icon: IdCard, moduleKey: 'usuarios' },
  { label: 'Auditoría', icon: ScrollText, moduleKey: 'usuarios', requiresAdmin: true },
]

const STANDALONE_LABEL_RULES = {
  Configuraciones: { moduleKey: 'configuracion', requiresAdmin: true },
  'Revision de inventario por sucursal': { moduleKey: 'usuarios', requiresAdmin: true },
  Solicitudes: { moduleKey: 'solicitudes' },
}

const BRANCH_SCOPED_MODULE_KEYS = new Set([
  'movimientos_entradas',
  'movimientos_salidas',
  'movimientos_inconvenientes',
  'productos',
  'sucursales_bodegas',
  'solicitudes',
  'importaciones',
])

const normalizeModuleKey = (value) => String(value || '').trim().toLowerCase()

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

export const buildModuleScopeAccessIndex = (moduleScopes, isAdmin = false) => {
  if (isAdmin) return null
  if (!Array.isArray(moduleScopes)) return null

  const index = new Map()
  moduleScopes.forEach((scope) => {
    const moduleKey = normalizeModuleKey(scope?.modulo)
    if (!moduleKey) return

    const actionsByBranch = Array.isArray(scope?.acciones_por_sucursal) ? scope.acciones_por_sucursal : []
    if (actionsByBranch.length) {
      const hasReadableBranch = actionsByBranch.some((entry) =>
        Boolean(
          entry?.puede_leer ||
            entry?.puede_crear ||
            entry?.puede_actualizar ||
            entry?.puede_eliminar
        )
      )
      index.set(moduleKey, hasReadableBranch)
      return
    }

    const branchIds = Array.isArray(scope?.sucursales_ids) ? scope.sucursales_ids : []
    index.set(moduleKey, branchIds.length > 0)
  })

  return index
}

const MODULE_ACTION_KEYS = ['puede_crear', 'puede_leer', 'puede_actualizar', 'puede_eliminar']

const getScopedModuleActions = (moduleKey, moduleScopes) => {
  const normalizedModuleKey = normalizeModuleKey(moduleKey)
  const initialActions = {
    puede_crear: false,
    puede_leer: false,
    puede_actualizar: false,
    puede_eliminar: false,
    puede_importar: false,
    puede_marcar_llegada: false,
  }

  if (
    !normalizedModuleKey ||
    !BRANCH_SCOPED_MODULE_KEYS.has(normalizedModuleKey) ||
    !Array.isArray(moduleScopes)
  ) {
    return initialActions
  }

  return moduleScopes.reduce((acc, scope) => {
    if (normalizeModuleKey(scope?.modulo) !== normalizedModuleKey) return acc

    const actionsByBranch = Array.isArray(scope?.acciones_por_sucursal) ? scope.acciones_por_sucursal : []
    if (actionsByBranch.length) {
      actionsByBranch.forEach((entry) => {
        acc.puede_crear = acc.puede_crear || Boolean(entry?.puede_crear)
        acc.puede_leer = acc.puede_leer || Boolean(
          entry?.puede_leer ||
          entry?.puede_crear ||
          entry?.puede_actualizar ||
          entry?.puede_eliminar
        )
        acc.puede_actualizar = acc.puede_actualizar || Boolean(entry?.puede_actualizar)
        acc.puede_eliminar = acc.puede_eliminar || Boolean(entry?.puede_eliminar)
        acc.puede_importar = acc.puede_importar || Boolean(entry?.puede_importar)
        acc.puede_marcar_llegada = acc.puede_marcar_llegada || Boolean(entry?.puede_marcar_llegada)
      })
      return acc
    }

    const branchIds = Array.isArray(scope?.sucursales_ids) ? scope.sucursales_ids : []
    if (branchIds.length) {
      acc.puede_leer = true
    }
    return acc
  }, initialActions)
}

export const getModuleActions = (moduleKey, permissionIndex, moduleScopes = null) => {
  if (!permissionIndex || !moduleKey) {
    return {
      puede_crear: true,
      puede_leer: true,
      puede_actualizar: true,
      puede_eliminar: true,
      puede_importar: true,
      puede_marcar_llegada: true,
    }
  }

  const permiso = permissionIndex.get(moduleKey)
  const scopedActions = getScopedModuleActions(moduleKey, moduleScopes)
  // moduleScopes === null signals an admin user (backend returns null for admins).
  // Scoped-only flags must be granted unconditionally in that case.
  const isAdminContext = moduleScopes === null
  return {
    puede_crear: Boolean(permiso?.puede_crear) || Boolean(scopedActions?.puede_crear),
    puede_leer: Boolean(permiso?.puede_leer) || Boolean(scopedActions?.puede_leer),
    puede_actualizar: Boolean(permiso?.puede_actualizar) || Boolean(scopedActions?.puede_actualizar),
    puede_eliminar: Boolean(permiso?.puede_eliminar) || Boolean(scopedActions?.puede_eliminar),
    puede_importar: isAdminContext || Boolean(scopedActions?.puede_importar),
    puede_marcar_llegada: isAdminContext || Boolean(scopedActions?.puede_marcar_llegada),
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

const hasPermissionForTarget = (moduleKey, permissionIndex, moduleScopeAccessIndex = null) => {
  if (!permissionIndex || !moduleKey) return true
  const permiso = permissionIndex.get(moduleKey)
  if (Boolean(permiso?.puede_leer)) return true
  if (BRANCH_SCOPED_MODULE_KEYS.has(moduleKey) && moduleScopeAccessIndex !== null) {
    return Boolean(moduleScopeAccessIndex?.get(moduleKey))
  }
  return false
}

const hasBranchScopeAccessForTarget = (moduleKey, moduleScopeAccessIndex) => {
  if (!moduleKey || !BRANCH_SCOPED_MODULE_KEYS.has(moduleKey)) return true
  if (moduleScopeAccessIndex === null) return true
  return Boolean(moduleScopeAccessIndex?.get(moduleKey))
}

const itemRequiresAdministrator = (item) => Boolean(item?.requiresAdmin)

export const itemHasAccess = (
  item,
  permissionIndex,
  moduleScopeAccessIndex = null,
  isAdministrator = false
) => {
  if (itemRequiresAdministrator(item) && !isAdministrator) return false
  if (!permissionIndex) return true
  if (item.children?.length) {
    return item.children.some((child) => itemHasAccess(child, permissionIndex, moduleScopeAccessIndex, isAdministrator))
  }
  return (
    hasPermissionForTarget(item.moduleKey, permissionIndex, moduleScopeAccessIndex) &&
    hasBranchScopeAccessForTarget(item.moduleKey, moduleScopeAccessIndex)
  )
}

export const filterMenuByPermissions = (
  menu,
  permissionIndex,
  moduleScopeAccessIndex = null,
  isAdministrator = false
) => {
  if (!permissionIndex) return menu

  return menu
    .map((item) => {
      if (item.children?.length) {
        const filteredChildren = item.children.filter((child) =>
          itemHasAccess(child, permissionIndex, moduleScopeAccessIndex, isAdministrator)
        )
        if (!filteredChildren.length) return null
        return { ...item, children: filteredChildren }
      }
      return itemHasAccess(item, permissionIndex, moduleScopeAccessIndex, isAdministrator) ? item : null
    })
    .filter(Boolean)
}

// Solo se incluyen los ítems seleccionables (hojas): los grupos con hijos nunca
// son un tab por sí mismos (el Sidebar solo los usa para expandir/colapsar), y
// si un grupo comparte label con uno de sus hijos (p. ej. "Importaciones"),
// incluir el grupo haría que el match por label devolviera el grupo primero.
const flattenMenu = (menu) =>
  menu.reduce((acc, item) => {
    if (item.children?.length) {
      acc.push(...flattenMenu(item.children))
    } else {
      acc.push(item)
    }
    return acc
  }, [])

export const labelHasAccess = (
  label,
  permissionIndex,
  menu = MENU_STRUCTURE,
  moduleScopeAccessIndex = null,
  isAdministrator = false
) => {
  const flattened = flattenMenu(menu)
  const item = flattened.find((entry) => entry.label === label)
  if (!item) {
    const standaloneRule = STANDALONE_LABEL_RULES[label]
    if (!standaloneRule) return true
    if (standaloneRule.requiresAdmin && !isAdministrator) return false
    return (
      hasPermissionForTarget(standaloneRule.moduleKey, permissionIndex, moduleScopeAccessIndex) &&
      hasBranchScopeAccessForTarget(standaloneRule.moduleKey, moduleScopeAccessIndex)
    )
  }
  return itemHasAccess(item, permissionIndex, moduleScopeAccessIndex, isAdministrator)
}
