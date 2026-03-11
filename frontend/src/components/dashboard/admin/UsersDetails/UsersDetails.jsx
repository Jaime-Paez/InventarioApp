import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Eye, Info, Pencil } from 'lucide-react'
import '../CreateUsuario/CreateUsuario.css'
import './UsersDetails.css'
import { API_URL, authFetch } from '../../../../utils/api'
import useModalAnimation from '../../common/useModalAnimation'
const MIN_WIDTH = 720
const MIN_HEIGHT = 520
const VIEWPORT_PADDING = 12
const ACTIONS = [
  { key: 'puede_leer', label: 'Ver' },
  { key: 'puede_crear', label: 'Crear' },
  { key: 'puede_actualizar', label: 'Editar' },
  { key: 'puede_eliminar', label: 'Eliminar' },
]
const INVENTORY_MODULE_KEY = 'inventario'

const isActionAllowedForModule = (moduleKey, actionKey) =>
  moduleKey === INVENTORY_MODULE_KEY ? actionKey === 'puede_leer' : true

const getAllowedActionsForModule = (moduleKey) =>
  ACTIONS.filter((action) => isActionAllowedForModule(moduleKey, action.key))

const EMPTY_PERMISSION_ENTRY = Object.freeze({
  puede_crear: false,
  puede_leer: false,
  puede_actualizar: false,
  puede_eliminar: false,
})

const normalizePermissionEntry = (moduleKey, currentEntry, actionKey, nextChecked) => {
  const allowedActions = getAllowedActionsForModule(moduleKey)
  const allowedActionKeys = new Set(allowedActions.map((action) => action.key))
  const nextEntry = {
    puede_crear: false,
    puede_leer: false,
    puede_actualizar: false,
    puede_eliminar: false,
  }

  ACTIONS.forEach((action) => {
    if (allowedActionKeys.has(action.key)) {
      nextEntry[action.key] = Boolean(currentEntry?.[action.key])
    }
  })

  if (!allowedActionKeys.has(actionKey)) return nextEntry

  nextEntry[actionKey] = nextChecked

  if (actionKey === 'puede_crear' && nextChecked && allowedActionKeys.has('puede_leer')) {
    nextEntry.puede_leer = true
    if (allowedActionKeys.has('puede_actualizar')) nextEntry.puede_actualizar = false
    if (allowedActionKeys.has('puede_eliminar')) nextEntry.puede_eliminar = false
  }

  if (actionKey === 'puede_actualizar' && nextChecked && allowedActionKeys.has('puede_leer')) {
    nextEntry.puede_leer = true
  }

  if (actionKey === 'puede_eliminar' && nextChecked) {
    if (allowedActionKeys.has('puede_leer')) nextEntry.puede_leer = true
    if (allowedActionKeys.has('puede_crear')) nextEntry.puede_crear = true
    if (allowedActionKeys.has('puede_actualizar')) nextEntry.puede_actualizar = true
  }

  if (actionKey === 'puede_leer' && nextChecked) {
    if (allowedActionKeys.has('puede_crear')) nextEntry.puede_crear = false
    if (allowedActionKeys.has('puede_actualizar')) nextEntry.puede_actualizar = false
    if (allowedActionKeys.has('puede_eliminar')) nextEntry.puede_eliminar = false
  }

  if (actionKey === 'puede_leer' && !nextChecked) {
    if (allowedActionKeys.has('puede_crear')) nextEntry.puede_crear = false
    if (allowedActionKeys.has('puede_actualizar')) nextEntry.puede_actualizar = false
    if (allowedActionKeys.has('puede_eliminar')) nextEntry.puede_eliminar = false
  }

  if (actionKey === 'puede_crear' && !nextChecked && allowedActionKeys.has('puede_eliminar')) {
    nextEntry.puede_eliminar = false
  }

  if (actionKey === 'puede_actualizar' && !nextChecked && allowedActionKeys.has('puede_eliminar')) {
    nextEntry.puede_eliminar = false
  }

  if (allowedActionKeys.has('puede_leer') && !nextEntry.puede_leer) {
    if (allowedActionKeys.has('puede_crear')) nextEntry.puede_crear = false
    if (allowedActionKeys.has('puede_actualizar')) nextEntry.puede_actualizar = false
    if (allowedActionKeys.has('puede_eliminar')) nextEntry.puede_eliminar = false
  } else {
    if (allowedActionKeys.has('puede_crear') && nextEntry.puede_crear && allowedActionKeys.has('puede_leer')) {
      nextEntry.puede_leer = true
    }
    if (allowedActionKeys.has('puede_actualizar') && nextEntry.puede_actualizar && allowedActionKeys.has('puede_leer')) {
      nextEntry.puede_leer = true
    }
    if (allowedActionKeys.has('puede_eliminar') && nextEntry.puede_eliminar) {
      if (allowedActionKeys.has('puede_leer')) nextEntry.puede_leer = true
      if (allowedActionKeys.has('puede_crear')) nextEntry.puede_crear = true
      if (allowedActionKeys.has('puede_actualizar')) nextEntry.puede_actualizar = true
    }
  }

  return nextEntry
}

const normalizeIdentityValue = (value) => String(value || '').trim().toLowerCase()

const buildMatrixFromList = (permisos = []) => {
  const matrix = {}
  permisos.forEach((permiso) => {
    if (!permiso?.modulo) return
    const modulo = permiso.modulo
    matrix[permiso.modulo] = {
      puede_crear: isActionAllowedForModule(modulo, 'puede_crear') ? Boolean(permiso.puede_crear) : false,
      puede_leer: isActionAllowedForModule(modulo, 'puede_leer') ? Boolean(permiso.puede_leer) : false,
      puede_actualizar: isActionAllowedForModule(modulo, 'puede_actualizar') ? Boolean(permiso.puede_actualizar) : false,
      puede_eliminar: isActionAllowedForModule(modulo, 'puede_eliminar') ? Boolean(permiso.puede_eliminar) : false,
    }
  })
  return matrix
}

const serializeMatrix = (matrix) =>
  Object.entries(matrix)
    .map(([modulo, value]) => {
      const allowedActions = getAllowedActionsForModule(modulo)
      const payload = {
        modulo,
        submodulo: '',
        puede_crear: isActionAllowedForModule(modulo, 'puede_crear') ? Boolean(value?.puede_crear) : false,
        puede_leer: isActionAllowedForModule(modulo, 'puede_leer') ? Boolean(value?.puede_leer) : false,
        puede_actualizar: isActionAllowedForModule(modulo, 'puede_actualizar') ? Boolean(value?.puede_actualizar) : false,
        puede_eliminar: isActionAllowedForModule(modulo, 'puede_eliminar') ? Boolean(value?.puede_eliminar) : false,
      }
      const hasAction = allowedActions.some((action) => payload[action.key])
      return hasAction ? payload : null
    })
    .filter(Boolean)

const buildModuleBranchMatrixFromList = (scopes = []) => {
  const matrix = {}
  scopes.forEach((scope) => {
    if (!scope?.modulo) return
    const ids = Array.isArray(scope?.sucursales_ids) ? scope.sucursales_ids : []
    matrix[scope.modulo] = Array.from(new Set(ids.map((id) => Number(id)).filter(Number.isFinite)))
  })
  return matrix
}

const serializeModuleBranchMatrix = (matrix, allowedModules = []) => {
  const allowedSet = Array.isArray(allowedModules) && allowedModules.length > 0
    ? new Set(allowedModules)
    : null

  return Object.entries(matrix)
    .filter(([modulo]) => !allowedSet || allowedSet.has(modulo))
    .map(([modulo, sucursales]) => ({
      modulo,
      sucursales_ids: Array.from(
        new Set((Array.isArray(sucursales) ? sucursales : []).map((id) => Number(id)).filter(Number.isFinite))
      ),
    }))
    .filter((entry) => entry.sucursales_ids.length > 0)
}

const emptyForm = {
  nombres: '',
  apellidos: '',
  correo: '',
  telefono: '',
  cargo: '',
  activo: false,
  inspeccion_aleatoria: false,
  permisos_personalizados: [],
  sucursales: [],
  sucursales_por_modulo: [],
  roles: [],
}

function UsersDetails({
  open,
  userId,
  token,
  onClose,
  onUpdated,
  onDeleted,
  onError,
  allowEdit = true,
  allowDelete = true,
}) {
  const [formData, setFormData] = useState(emptyForm)
  const [originalData, setOriginalData] = useState(emptyForm)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordCopied, setPasswordCopied] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [permissionOptions, setPermissionOptions] = useState([])
  const [permissionsMatrix, setPermissionsMatrix] = useState({})
  const [moduleBranchMatrix, setModuleBranchMatrix] = useState({})
  const [branchScopedModules, setBranchScopedModules] = useState([])
  const [permissionsLoading, setPermissionsLoading] = useState(false)
  const [branches, setBranches] = useState([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [loadingData, setLoadingData] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [activeTab, setActiveTab] = useState('general')
  const [selectedBranchId, setSelectedBranchId] = useState(null)
  const [showPermissionsPopup, setShowPermissionsPopup] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })

  const modalRef = useRef(null)
  const dragData = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const resizeData = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const sizeRef = useRef(size)
  const positionRef = useRef(position)
  const restoreRef = useRef(null)

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
  const getViewportMetrics = () => {
    const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2)
    const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2)
    return {
      availableWidth,
      availableHeight,
      minWidth: Math.min(MIN_WIDTH, availableWidth),
      minHeight: Math.min(MIN_HEIGHT, availableHeight),
    }
  }
  const notifyError = useCallback(
    (message) => {
      if (!message) return
      if (onError) {
        onError(message)
        return
      }
      console.error(message)
    },
    [onError]
  )

  const normalizeUser = (data) => ({
    nombres: data?.nombres ?? '',
    apellidos: data?.apellidos ?? '',
    correo: data?.correo ?? '',
    telefono: data?.telefono ?? '',
    cargo: data?.cargo ?? '',
    activo: Boolean(data?.activo),
    inspeccion_aleatoria: Boolean(data?.inspeccion_aleatoria),
    permisos_personalizados: Array.isArray(data?.permisos_personalizados)
      ? data.permisos_personalizados
      : [],
    sucursales: Array.isArray(data?.sucursales) ? data.sucursales : [],
    sucursales_por_modulo: Array.isArray(data?.sucursales_por_modulo)
      ? data.sucursales_por_modulo
      : [],
  })

  const handleChange = (event) => {
    if (!isEditing) return
    const { name, value, type, checked } = event.target
    setFormData((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }))
  }

  const isBranchScopedForModule = useCallback(
    (moduleKey, branchId) => {
      if (!branchScopedModules.includes(moduleKey)) return true
      if (!branchId) return false
      const scopedBranches = Array.isArray(moduleBranchMatrix[moduleKey]) ? moduleBranchMatrix[moduleKey] : []
      return scopedBranches.includes(branchId)
    },
    [branchScopedModules, moduleBranchMatrix]
  )

  const togglePermissionForBranch = (moduleKey, actionKey) => {
    if (!isActionAllowedForModule(moduleKey, actionKey)) return
    const moduleUsesBranchScope = branchScopedModules.includes(moduleKey)
    if (!isEditing || (moduleUsesBranchScope && !selectedBranchId)) return
    const allowedActions = getAllowedActionsForModule(moduleKey)

    setPermissionsMatrix((prevPermissions) => {
      const current = prevPermissions[moduleKey] || {
        puede_crear: false,
        puede_leer: false,
        puede_actualizar: false,
        puede_eliminar: false,
      }

      if (!moduleUsesBranchScope) {
        const updatedEntry = normalizePermissionEntry(
          moduleKey,
          current,
          actionKey,
          !current[actionKey]
        )
        const hasAction = allowedActions.some((action) => updatedEntry[action.key])

        if (!hasAction) {
          setModuleBranchMatrix((prevScopes) => {
            if (!(moduleKey in prevScopes)) return prevScopes
            const { [moduleKey]: _ignored, ...restScopes } = prevScopes
            return restScopes
          })
          const { [moduleKey]: _ignored, ...restPermissions } = prevPermissions
          return restPermissions
        }

        return {
          ...prevPermissions,
          [moduleKey]: updatedEntry,
        }
      }

      const moduleBranches = Array.isArray(moduleBranchMatrix[moduleKey]) ? moduleBranchMatrix[moduleKey] : []
      const branchScoped = moduleBranches.includes(selectedBranchId)
      const currentlyChecked = branchScoped && Boolean(current[actionKey])

      if (!currentlyChecked) {
        setModuleBranchMatrix((prevScopes) => {
          const currentScopes = Array.isArray(prevScopes[moduleKey]) ? prevScopes[moduleKey] : []
          if (currentScopes.includes(selectedBranchId)) return prevScopes
          return { ...prevScopes, [moduleKey]: [...currentScopes, selectedBranchId] }
        })
        return {
          ...prevPermissions,
          [moduleKey]: normalizePermissionEntry(moduleKey, current, actionKey, true),
        }
      }

      const otherScopedBranches = moduleBranches.filter((id) => id !== selectedBranchId)
      if (otherScopedBranches.length > 0) {
        setModuleBranchMatrix((prevScopes) => {
          const currentScopes = Array.isArray(prevScopes[moduleKey]) ? prevScopes[moduleKey] : []
          const nextScopes = currentScopes.filter((id) => id !== selectedBranchId)
          if (!nextScopes.length) {
            const { [moduleKey]: _ignored, ...rest } = prevScopes
            return rest
          }
          return { ...prevScopes, [moduleKey]: nextScopes }
        })
        return prevPermissions
      }

      const updatedEntry = normalizePermissionEntry(moduleKey, current, actionKey, false)
      const hasAction = allowedActions.some((action) => Boolean(updatedEntry[action.key]))

      if (!hasAction) {
        setModuleBranchMatrix((prevScopes) => {
          const { [moduleKey]: _ignored, ...restScopes } = prevScopes
          return restScopes
        })
        const { [moduleKey]: _ignored, ...restPermissions } = prevPermissions
        return restPermissions
      }

      return { ...prevPermissions, [moduleKey]: updatedEntry }
    })
  }

  const setColumnPermission = (actionKey, checked) => {
    if (!isEditing) return

    let nextPermissions = { ...permissionsMatrix }
    let nextModuleBranchMatrix = { ...moduleBranchMatrix }
    let changed = false

    permissionOptions.forEach((module) => {
      const moduleKey = module.key
      if (!isActionAllowedForModule(moduleKey, actionKey)) return

      const moduleUsesBranchScope = branchScopedModules.includes(moduleKey)
      if (moduleUsesBranchScope && !selectedBranchId) return

      const current = nextPermissions[moduleKey] || EMPTY_PERMISSION_ENTRY
      const allowedActions = getAllowedActionsForModule(moduleKey)

      if (!moduleUsesBranchScope) {
        const currentlyChecked = Boolean(current[actionKey])
        if (currentlyChecked === checked) return

        const updatedEntry = normalizePermissionEntry(moduleKey, current, actionKey, checked)
        const hasAction = allowedActions.some((action) => Boolean(updatedEntry[action.key]))
        if (hasAction) nextPermissions[moduleKey] = updatedEntry
        else delete nextPermissions[moduleKey]
        changed = true
        return
      }

      const moduleBranches = Array.isArray(nextModuleBranchMatrix[moduleKey]) ? nextModuleBranchMatrix[moduleKey] : []
      const branchScoped = moduleBranches.includes(selectedBranchId)
      const currentlyChecked = branchScoped && Boolean(current[actionKey])
      if (currentlyChecked === checked) return

      if (checked) {
        if (!branchScoped) {
          nextModuleBranchMatrix[moduleKey] = [...moduleBranches, selectedBranchId]
        }
        const updatedEntry = normalizePermissionEntry(moduleKey, current, actionKey, true)
        const hasAction = allowedActions.some((action) => Boolean(updatedEntry[action.key]))
        if (hasAction) nextPermissions[moduleKey] = updatedEntry
        else delete nextPermissions[moduleKey]
        changed = true
        return
      }

      const otherScopedBranches = moduleBranches.filter((id) => id !== selectedBranchId)
      if (otherScopedBranches.length > 0) {
        nextModuleBranchMatrix[moduleKey] = otherScopedBranches
        changed = true
        return
      }

      delete nextModuleBranchMatrix[moduleKey]
      const updatedEntry = normalizePermissionEntry(moduleKey, current, actionKey, false)
      const hasAction = allowedActions.some((action) => Boolean(updatedEntry[action.key]))
      if (hasAction) nextPermissions[moduleKey] = updatedEntry
      else delete nextPermissions[moduleKey]
      changed = true
    })

    if (!changed) return
    setPermissionsMatrix(nextPermissions)
    setModuleBranchMatrix(nextModuleBranchMatrix)
  }

  const getColumnSelectionState = (actionKey) => {
    let total = 0
    let selected = 0

    permissionOptions.forEach((module) => {
      const moduleKey = module.key
      if (!isActionAllowedForModule(moduleKey, actionKey)) return

      const moduleUsesBranchScope = branchScopedModules.includes(moduleKey)
      if (moduleUsesBranchScope && !selectedBranchId) return

      total += 1
      const current = permissionsMatrix[moduleKey] || EMPTY_PERMISSION_ENTRY
      const isInSelectedBranch = moduleUsesBranchScope
        ? isBranchScopedForModule(moduleKey, selectedBranchId)
        : true
      if (isInSelectedBranch && Boolean(current[actionKey])) selected += 1
    })

    return {
      disabled: total === 0,
      checked: total > 0 && selected === total,
      indeterminate: selected > 0 && selected < total,
    }
  }

  const renderPermissionRow = (module) => {
    const entryKey = module.key
    const current = permissionsMatrix[entryKey] || {}
    const moduleUsesBranchScope = branchScopedModules.includes(entryKey)
    const branchScoped = isBranchScopedForModule(entryKey, selectedBranchId)
    const isDisabled = !isEditing || loadingData || saving || deleteLoading || permissionsLoading || branchesLoading || (moduleUsesBranchScope && !selectedBranchId)

    return (
      <div
        key={entryKey}
        className="permissions-matrix__row"
      >
        <div className="permissions-matrix__cell permissions-matrix__cell--label">{module.label}</div>
        {ACTIONS.map((action) => {
          if (!isActionAllowedForModule(module.key, action.key)) {
            return (
              <div
                key={action.key}
                className="permissions-matrix__cell permissions-matrix__cell--action"
                aria-hidden="true"
              />
            )
          }

          return (
            <label key={action.key} className="permissions-matrix__cell permissions-matrix__cell--action">
              <input
                type="checkbox"
                checked={branchScoped && Boolean(current?.[action.key])}
                onChange={() => togglePermissionForBranch(module.key, action.key)}
                disabled={isDisabled}
              />
            </label>
          )
        })}
      </div>
    )
  }

  const loadPermissionOptions = useCallback(async () => {
    setPermissionsLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/usuarios/permisos/opciones/`,
        {},
        token
      )

      if (!response.ok) throw new Error('No se pudieron cargar los permisos disponibles.')

      const data = await response.json().catch(() => ({}))
      const modulos = Array.isArray(data?.modulos) ? data.modulos : []
      const scopedModules = Array.isArray(data?.modulos_con_sucursales) ? data.modulos_con_sucursales : []
      setPermissionOptions(modulos)
      setBranchScopedModules(
        scopedModules
          .map((module) => module?.key)
          .filter((key) => typeof key === 'string' && key.length > 0)
      )
    } catch (err) {
      notifyError(err.message || 'Ocurrió un problema al cargar los permisos.')
    } finally {
      setPermissionsLoading(false)
    }
  }, [notifyError, token])

  const fetchBranches = useCallback(async () => {
    setBranchesLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/inventario/sucursales/?modulo=usuarios`,
        {},
        token
      )

      if (!response.ok) throw new Error('No se pudieron cargar las sucursales.')

      const data = await response.json().catch(() => [])
      const items = Array.isArray(data) ? data : data?.results || []
      setBranches(items)
      setSelectedBranchId((prev) => {
        if (prev && items.some((branch) => branch.id === prev)) return prev
        return items[0]?.id ?? null
      })
    } catch (err) {
      notifyError(err.message || 'Ocurrió un problema al cargar las sucursales.')
    } finally {
      setBranchesLoading(false)
    }
  }, [notifyError, token])

  const fetchUser = useCallback(async () => {
    if (!userId) return
    setLoadingData(true)
    try {
      const response = await authFetch(
        `${API_URL}/usuarios/listado/${userId}/`,
        {},
        token
      )
      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        const detail = data?.detail || 'No se pudo cargar la información del usuario.'
        throw new Error(detail)
      }

      const normalized = normalizeUser(data)
      setFormData(normalized)
      setOriginalData(normalized)
      setPermissionsMatrix(buildMatrixFromList(normalized.permisos_personalizados))
      setModuleBranchMatrix(buildModuleBranchMatrixFromList(normalized.sucursales_por_modulo))
      setIsEditing(false)
      setPassword('')
      setConfirmPassword('')
      setPasswordCopied(false)
      setShowPassword(false)
      setShowConfirmPassword(false)
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al obtener la información del usuario.')
    } finally {
      setLoadingData(false)
    }
  }, [notifyError, token, userId])

  useEffect(() => {
    if (!open) return
    setIsEditing(false)
    setFormData(emptyForm)
    setOriginalData(emptyForm)
    setPassword('')
    setConfirmPassword('')
    setPasswordCopied(false)
    setShowPassword(false)
    setShowConfirmPassword(false)
    setPermissionsMatrix({})
    setModuleBranchMatrix({})
    setBranchScopedModules([])
    setBranches([])
    setSelectedBranchId(null)
    setShowPermissionsPopup(false)
    setSubmitAttempted(false)
    setActiveTab('general')
    setIsMaximized(false)
    restoreRef.current = null
    fetchUser()
    loadPermissionOptions()
    fetchBranches()
  }, [open, fetchUser, loadPermissionOptions, fetchBranches])

  useEffect(() => {
    if (!open) {
      setLoadingData(true)
    }
  }, [open])

  useEffect(() => {
    if (allowEdit || !isEditing) return
    setIsEditing(false)
  }, [allowEdit, isEditing])

  useEffect(() => {
    if (allowDelete || !showDeleteDialog) return
    setShowDeleteDialog(false)
  }, [allowDelete, showDeleteDialog])

  useLayoutEffect(() => {
    if (!open) return
    const { availableWidth, availableHeight } = getViewportMetrics()
    const nextWidth = Math.min(MIN_WIDTH, availableWidth)
    const nextHeight = Math.min(MIN_HEIGHT, availableHeight)
    setSize({ width: nextWidth, height: nextHeight })

    const centeredX = (window.innerWidth - nextWidth) / 2
    const centeredY = (window.innerHeight - nextHeight) / 2
    setPosition({ x: Math.max(centeredX, VIEWPORT_PADDING), y: Math.max(centeredY, VIEWPORT_PADDING) })
  }, [open])

  useEffect(() => {
    sizeRef.current = size
  }, [size])

  useEffect(() => {
    positionRef.current = position
  }, [position])

  const handleMouseDown = (event) => {
    if (isMaximized) {
      const restore = restoreRef.current
      const fallbackSize = sizeRef.current
      const restoredSize = restore?.size || fallbackSize
      const restoredPosition = restore?.position || {
        x: Math.max((window.innerWidth - restoredSize.width) / 2, VIEWPORT_PADDING),
        y: Math.max((window.innerHeight - restoredSize.height) / 2, VIEWPORT_PADDING),
      }

      sizeRef.current = restoredSize
      positionRef.current = restoredPosition
      setSize(restoredSize)
      setPosition(restoredPosition)
      setIsMaximized(false)

      const offsetX = Math.min(
        Math.max(event.clientX - restoredPosition.x, 24),
        Math.max(restoredSize.width - 24, 24)
      )
      const offsetY = Math.min(
        Math.max(event.clientY - restoredPosition.y, 12),
        56
      )
      dragData.current = {
        active: true,
        offsetX,
        offsetY,
      }
      return
    }

    if (!modalRef.current) return
    const rect = modalRef.current.getBoundingClientRect()
    dragData.current = {
      active: true,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    }
  }

  const handleResizeMouseDown = (event) => {
    if (isMaximized) return
    event.preventDefault()
    event.stopPropagation()
    const { minWidth, minHeight } = getViewportMetrics()
    resizeData.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: sizeRef.current.width,
      startHeight: sizeRef.current.height,
    }

    const handleResizeMove = (moveEvent) => {
      if (!resizeData.current.active) return
      const deltaX = moveEvent.clientX - resizeData.current.startX
      const deltaY = moveEvent.clientY - resizeData.current.startY
      const maxWidth = Math.max(minWidth, window.innerWidth - positionRef.current.x - VIEWPORT_PADDING)
      const maxHeight = Math.max(minHeight, window.innerHeight - positionRef.current.y - VIEWPORT_PADDING)
      const width = clamp(resizeData.current.startWidth + deltaX, minWidth, maxWidth)
      const height = clamp(resizeData.current.startHeight + deltaY, minHeight, maxHeight)
      setSize({ width, height })
    }

    const handleResizeUp = () => {
      resizeData.current.active = false
      window.removeEventListener('mousemove', handleResizeMove)
      window.removeEventListener('mouseup', handleResizeUp)
    }

    window.addEventListener('mousemove', handleResizeMove)
    window.addEventListener('mouseup', handleResizeUp)
  }

  useEffect(() => {
    const handleMouseMove = (event) => {
      if (!dragData.current.active) return
      event.preventDefault()
      const newX = event.clientX - dragData.current.offsetX
      const newY = event.clientY - dragData.current.offsetY
      const maxX = window.innerWidth - sizeRef.current.width - VIEWPORT_PADDING
      const maxY = window.innerHeight - sizeRef.current.height - VIEWPORT_PADDING
      setPosition({
        x: Math.min(Math.max(newX, VIEWPORT_PADDING), Math.max(maxX, VIEWPORT_PADDING)),
        y: Math.min(Math.max(newY, VIEWPORT_PADDING), Math.max(maxY, VIEWPORT_PADDING)),
      })
    }

    const handleMouseUp = () => {
      dragData.current.active = false
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  useEffect(() => {
    const handleWindowResize = () => {
      const { minWidth, minHeight, availableWidth, availableHeight } = getViewportMetrics()

      if (isMaximized) {
        setSize({ width: availableWidth, height: availableHeight })
        setPosition({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
        return
      }

      setSize((prev) => {
        const width = clamp(prev.width, minWidth, availableWidth)
        const height = clamp(prev.height, minHeight, availableHeight)

        setPosition((prevPosition) => ({
          x: Math.min(Math.max(prevPosition.x, VIEWPORT_PADDING), Math.max(window.innerWidth - width - VIEWPORT_PADDING, VIEWPORT_PADDING)),
          y: Math.min(Math.max(prevPosition.y, VIEWPORT_PADDING), Math.max(window.innerHeight - height - VIEWPORT_PADDING, VIEWPORT_PADDING)),
        }))

        return { width, height }
      })
    }

    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [isMaximized])

  const toggleMaximize = () => {
    if (isMaximized) {
      const restore = restoreRef.current
      if (restore) {
        setSize(restore.size)
        setPosition(restore.position)
      }
      setIsMaximized(false)
      return
    }

    restoreRef.current = {
      size: sizeRef.current,
      position: positionRef.current,
    }
    const { availableWidth, availableHeight } = getViewportMetrics()
    setSize({ width: availableWidth, height: availableHeight })
    setPosition({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
    setIsMaximized(true)
  }

  const handleToggleEdit = () => {
    if (!allowEdit) return
    if (loadingData || saving || deleteLoading) return
    setIsEditing((prev) => {
      const next = !prev
      if (!next) {
        setFormData(originalData)
        setPermissionsMatrix(buildMatrixFromList(originalData.permisos_personalizados))
        setModuleBranchMatrix(buildModuleBranchMatrixFromList(originalData.sucursales_por_modulo))
        setSubmitAttempted(false)
        setPassword('')
        setConfirmPassword('')
        setPasswordCopied(false)
        setShowPassword(false)
        setShowConfirmPassword(false)
        setShowPermissionsPopup(false)
      } else {
        setPassword('')
        setConfirmPassword('')
        setPasswordCopied(false)
        setShowPassword(false)
        setShowConfirmPassword(false)
        setShowPermissionsPopup(false)
      }
      return next
    })
  }

  const generatePassword = () => {
    if (!isEditing || loadingData || saving || deleteLoading) return
    const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789!@$%#?'
    let result = ''
    for (let i = 0; i < 12; i += 1) {
      result += charset.charAt(Math.floor(Math.random() * charset.length))
    }
    setPassword(result)
    setConfirmPassword(result)
    setPasswordCopied(false)
    setShowPassword(false)
    setShowConfirmPassword(false)
    setShowPermissionsPopup(false)
  }

  const copyPassword = async () => {
    if (!password) return
    try {
      await navigator.clipboard.writeText(password)
      setPasswordCopied(true)
      setTimeout(() => setPasswordCopied(false), 2500)
    } catch {
      notifyError('No se pudo copiar la contraseña. Intenta nuevamente.')
    }
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!isEditing || loadingData) return
    setSubmitAttempted(true)
    setSaving(true)

    const payload = {
      ...formData,
      nombres: formData.nombres.trim(),
      apellidos: formData.apellidos.trim(),
      correo: formData.correo.trim().toLowerCase(),
      telefono: formData.telefono.trim(),
      cargo: formData.cargo.trim(),
      permisos_personalizados: serializeMatrix(permissionsMatrix),
      sucursales_por_modulo: serializeModuleBranchMatrix(moduleBranchMatrix, branchScopedModules),
    }

    if (password || confirmPassword) {
      if (password.length < 8) {
        setSaving(false)
        notifyError('La nueva contraseña debe tener al menos 8 caracteres.')
        return
      }

      if (password !== confirmPassword) {
        setSaving(false)
        notifyError('La confirmación de la nueva contraseña no coincide.')
        return
      }

      payload.password = password
    }

    if (!payload.nombres || !payload.apellidos || !payload.correo) {
      setSaving(false)
      notifyError('Completa los campos de nombres, apellidos y correo para continuar.')
      return
    }

    try {
      const response = await authFetch(
        `${API_URL}/usuarios/listado/${userId}/`,
        {
          method: 'PATCH',
          body: JSON.stringify(payload),
        },
        token
      )

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail =
          data?.detail ||
          data?.correo?.[0] ||
          data?.password?.[0] ||
          data?.nombres?.[0] ||
          data?.roles?.[0] ||
          data?.sucursales_por_modulo?.[0] ||
          data?.permisos_personalizados?.[0] ||
          'No se pudo actualizar el usuario. Verifica la información enviada.'
        throw new Error(detail)
      }

      const normalized = normalizeUser(data)
      setFormData(normalized)
      setOriginalData(normalized)
      setPermissionsMatrix(buildMatrixFromList(normalized.permisos_personalizados))
      setModuleBranchMatrix(buildModuleBranchMatrixFromList(normalized.sucursales_por_modulo))
      setSubmitAttempted(false)
      setIsEditing(false)
      setPassword('')
      setConfirmPassword('')
      setPasswordCopied(false)
      setShowPassword(false)
      setShowConfirmPassword(false)
      setShowPermissionsPopup(false)
      onUpdated?.(data)
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al actualizar el usuario.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!allowDelete) return
    if (isProtectedAdministratorUser) {
      notifyError('No se puede eliminar el usuario Administrador.')
      return
    }
    if (!isEditing || deleteLoading || !userId) return
    setShowDeleteDialog(false)
    setDeleteLoading(true)
    try {
      const response = await authFetch(
        `${API_URL}/usuarios/listado/${userId}/`,
        {
          method: 'DELETE',
        },
        token
      )

      if (!response.ok && response.status !== 204) {
        const data = await response.json().catch(() => ({}))
        const detail = data?.detail || 'No se pudo eliminar el usuario.'
        throw new Error(detail)
      }

      onDeleted?.(userId)
      onClose?.()
    } catch (err) {
      notifyError(err.message || 'Ocurrió un error al eliminar el usuario.')
    } finally {
      setDeleteLoading(false)
    }
  }

  const handleClose = () => {
    onClose?.()
    setIsEditing(false)
    setSubmitAttempted(false)
    setShowDeleteDialog(false)
    setPassword('')
    setConfirmPassword('')
    setPasswordCopied(false)
    setShowPassword(false)
    setShowConfirmPassword(false)
  }
  const protectedUserName =
    normalizeIdentityValue(originalData.nombres) === 'administrador' &&
    normalizeIdentityValue(originalData.apellidos) === 'administrador'
  const protectedUserEmail = normalizeIdentityValue(originalData.correo) === 'administrador@mail.com'
  const isProtectedAdministratorUser = protectedUserName || protectedUserEmail
  const selectedBranch = branches.find((branch) => branch.id === selectedBranchId) || null
  const { shouldRender, isClosing } = useModalAnimation(open)

  if (!shouldRender) return null

  return (
    <div className={`create-user__overlay${isClosing ? ' create-user__overlay--closing' : ''}`} role="dialog" aria-modal="true">
      <div
        className={`create-user__modal${isClosing ? ' create-user__modal--closing' : ''}`}
        ref={modalRef}
        style={{ top: position.y, left: position.x, width: size.width, height: size.height }}
      >
      <header className="create-user__header" onMouseDown={handleMouseDown}>
        <div className="create-user__header-text">
          {/* Mostramos el ID y el nombre completo del estado originalData */}
          <h3>
            {userId && originalData.nombres
              ? `${userId} : ${originalData.nombres} ${originalData.apellidos}`
              : 'Cargando usuario...'}
          </h3>
        </div>
        <div className="create-user__header-actions">
          <button
            type="button"
            className="create-user__icon-button create-user__icon-button--maximize"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={toggleMaximize}
            aria-label={isMaximized ? 'Restaurar' : 'Maximizar'}
          >
            <i className={isMaximized ? 'pi pi-window-minimize' : 'pi pi-window-maximize'} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="create-user__icon-button"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={handleClose}
            aria-label="Cerrar"
          >
            <i className="pi pi-times" aria-hidden="true" />
          </button>
        </div>
      </header>

      <form className={`create-user__form${submitAttempted && isEditing ? ' create-user__form--submitted' : ''}`} noValidate onSubmitCapture={(event) => event.currentTarget.classList.add('create-user__form--submitted')} onSubmit={handleSubmit}>
        {loadingData && (
          <div className="create-user__loading-overlay" role="status" aria-live="polite">
            <i className="pi pi-spin pi-spinner" aria-hidden="true" />
            <span>Cargando datos...</span>
          </div>
        )}
        <div className="create-user__tabs" role="tablist" aria-label="Secciones del usuario">
          <button
            type="button"
            className={`create-user__tab${activeTab === 'general' ? ' create-user__tab--active' : ''}`}
            onClick={() => {
              setActiveTab('general')
              setShowPermissionsPopup(false)
            }}
            role="tab"
            aria-selected={activeTab === 'general'}
          >
            General
          </button>
          <button
            type="button"
            className={`create-user__tab${activeTab === 'accesos' ? ' create-user__tab--active' : ''}`}
            onClick={() => {
              setActiveTab('accesos')
              setShowPermissionsPopup(false)
            }}
            role="tab"
            aria-selected={activeTab === 'accesos'}
          >
            Sucursales y permisos
          </button>
        </div>

        <div className={`create-user__body${activeTab === 'accesos' ? ' create-user__body--permissions' : ''}`}>
          {activeTab === 'general' && (
            <section className="create-user__section">
              <div className="create-user__section-header">
                <div>
                  <p className="create-user__eyebrow">Perfil</p>
                  <h4>Información del usuario</h4>
                </div>
                {loadingData && <small className="muted">Cargando datos...</small>}
              </div>

              <div className="create-user__grid create-user__grid--two">
                <label className="create-user__field">
                  <span>Nombres</span>
                  <input
                    name="nombres"
                    type="text"
                    placeholder="Ana María"
                    value={formData.nombres}
                    onChange={handleChange}
                    disabled={!isEditing || loadingData || saving}
                    required
                  />
                </label>

                <label className="create-user__field">
                  <span>Apellidos</span>
                  <input
                    name="apellidos"
                    type="text"
                    placeholder="Pérez Ruiz"
                    value={formData.apellidos}
                    onChange={handleChange}
                    disabled={!isEditing || loadingData || saving}
                    required
                  />
                </label>

                <label className="create-user__field">
                  <span>Correo</span>
                  <input
                    name="correo"
                    type="email"
                    placeholder="usuario@empresa.com"
                    value={formData.correo}
                    onChange={handleChange}
                    disabled={!isEditing || loadingData || saving}
                    required
                  />
                </label>

                <label className="create-user__field">
                  <span>Teléfono</span>
                  <input
                    name="telefono"
                    type="tel"
                    placeholder="099 999 9999"
                    value={formData.telefono}
                    onChange={handleChange}
                    disabled={!isEditing || loadingData || saving}
                  />
                </label>

                <label className="create-user__field create-user__field--full">
                  <span>Cargo</span>
                  <input
                    name="cargo"
                    type="text"
                    placeholder="Coordinador de inventario"
                    value={formData.cargo}
                    onChange={handleChange}
                    disabled={!isEditing || loadingData || saving}
                  />
                </label>
              </div>

              <div className="create-user__section-header">
                <div>
                  <p className="create-user__eyebrow">Perfil</p>
                  <h4>Activación y contraseña</h4>
                </div>
                {loadingData && <small className="muted">Cargando datos...</small>}
              </div>

              <div className="create-user__access-grid">
                <div className="create-user__access-left">
                  <label className="create-user__field create-user__field--password">
                    <div className="create-user__field-label">
                      <span>Nueva contraseña</span>
                      <div className="create-user__password-actions">
                        <button
                          type="button"
                          className="create-user__ghost"
                          onClick={generatePassword}
                          disabled={!isEditing || loadingData || saving || deleteLoading}
                        >
                          Generar
                        </button>
                        <button
                          type="button"
                          className="create-user__ghost"
                          onClick={copyPassword}
                          disabled={!isEditing || loadingData || saving || deleteLoading || !password}
                        >
                          {passwordCopied ? 'Copiada' : 'Copiar'}
                        </button>
                      </div>
                    </div>
                    <div className="create-user__password-input">
                      <input
                        name="password"
                        type={showPassword ? 'text' : 'password'}
                        placeholder="Deja vacía para mantener la actual"
                        value={password}
                        onChange={(event) => {
                          if (!isEditing) return
                          setPassword(event.target.value)
                          setPasswordCopied(false)
                        }}
                        disabled={!isEditing || loadingData || saving || deleteLoading}
                      />
                      <button
                        type="button"
                        className="create-user__password-toggle"
                        onClick={() => setShowPassword((prev) => !prev)}
                        disabled={!isEditing || loadingData || saving || deleteLoading}
                        aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                      >
                        <i className={`pi ${showPassword ? 'pi-eye-slash' : 'pi-eye'}`} aria-hidden="true" />
                      </button>
                    </div>
                  </label>

                  <label className="create-user__field create-user__field--password-confirm">
                    <div className="create-user__field-label">
                      <span>Confirmar nueva contraseña</span>
                    </div>
                    <div className="create-user__password-input">
                      <input
                        name="confirmPassword"
                        type={showConfirmPassword ? 'text' : 'password'}
                        placeholder="Repite la nueva contraseña"
                        value={confirmPassword}
                        onChange={(event) => {
                          if (!isEditing) return
                          setConfirmPassword(event.target.value)
                        }}
                        disabled={!isEditing || loadingData || saving || deleteLoading}
                      />
                      <button
                        type="button"
                        className="create-user__password-toggle"
                        onClick={() => setShowConfirmPassword((prev) => !prev)}
                        disabled={!isEditing || loadingData || saving || deleteLoading}
                        aria-label={showConfirmPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                      >
                        <i className={`pi ${showConfirmPassword ? 'pi-eye-slash' : 'pi-eye'}`} aria-hidden="true" />
                      </button>
                    </div>
                  </label>
                </div>

                <div className="create-user__access-right">
                  <label className="create-user__checkbox">
                    <input type="checkbox" name="activo" checked={formData.activo} onChange={handleChange} disabled={!isEditing || loadingData || saving} />
                    <div>
                      <span>Cuenta activa</span>
                      <p>El usuario podrá iniciar sesión y operar el sistema.</p>
                    </div>
                  </label>
                  <label className="create-user__checkbox">
                    <input
                      type="checkbox"
                      name="inspeccion_aleatoria"
                      checked={Boolean(formData.inspeccion_aleatoria)}
                      onChange={handleChange}
                      disabled={!isEditing || loadingData || saving}
                    />
                    <div>
                      <span>Inspección aleatoria</span>
                      <p>Recibirá un recordatorio diario a las 09:00 para auditar 5 productos.</p>
                    </div>
                  </label>
                </div>
              </div>

            </section>
          )}

          {activeTab === 'accesos' && (
              <section className="create-user__section">
                {(branchesLoading || !branches.length) && (
                  <div className="create-user__section-header">
                    <small className="muted">
                      {branchesLoading ? 'Cargando sucursales...' : 'No hay sucursales registradas.'}
                    </small>
                  </div>
                )}

                <div className="create-user__branch-list create-user__branch-list--full">
                  {branches.map((branch) => {
                    const isSelected = branch.id === selectedBranchId
                    return (
                      <div key={branch.id} className={`create-user__branch-item${isSelected ? ' create-user__branch-item--active' : ''}`}>
                        <div className="create-user__branch-meta">
                          <strong>{branch.nombre}</strong>
                          {branch.direccion ? <small>{branch.direccion}</small> : null}
                        </div>
                        <button
                          type="button"
                          className="create-user__ghost create-user__branch-select"
                          onClick={() => {
                            setSelectedBranchId(branch.id)
                            setShowPermissionsPopup(true)
                          }}
                          disabled={!isEditing || loadingData || saving || deleteLoading || branchesLoading}
                        >
                          Ver permisos
                        </button>
                      </div>
                    )
                  })}
                </div>
              </section>
            )}
        </div>

          <div className="create-user__footer">
            <div className="user-details__footer-left">
              <button type="button" className="create-user__action create-user__action--cancel" onClick={handleClose}>
                Cancelar
              </button>
              {allowEdit && (
                <button
                  type="button"
                  className={`create-user__action create-user__action--edit user-details__edit-toggle${isEditing ? ' user-details__edit-toggle--active' : ''}`}
                  onClick={handleToggleEdit}
                  disabled={loadingData || saving || deleteLoading}
                >
                  {isEditing ? (
                    <>
                      <span className="user-details__toggle-icon" aria-hidden="true">
                        <Eye size={16} />
                      </span>
                      <span>Solo lectura</span>
                    </>
                  ) : (
                    <>
                      <span className="user-details__toggle-icon" aria-hidden="true">
                        <Pencil size={16} />
                      </span>
                      <span>Editar</span>
                    </>
                  )}
                </button>
              )}
            </div>

            <div className="user-details__footer-right">
              {isEditing && allowDelete && (
                <>
                  <button
                    type="button"
                    className="create-user__action user-details__delete"
                    onClick={() => setShowDeleteDialog(true)}
                    disabled={deleteLoading || saving || loadingData || isProtectedAdministratorUser}
                    title={isProtectedAdministratorUser ? 'El usuario Administrador no se puede eliminar.' : undefined}
                  >
                    {deleteLoading ? 'Eliminando...' : 'Eliminar'}
                  </button>

                  <button
                    type="submit"
                    className="create-user__action create-user__action--primary"
                    disabled={saving || loadingData}
                  >
                    {saving ? 'Guardando...' : 'Guardar'}
                  </button>
                </>
              )}
            </div>
          </div>
      </form>

      {showPermissionsPopup && selectedBranch && typeof document !== 'undefined' && createPortal(
        <div
          className="create-user__permissions-popup-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Permisos de ${selectedBranch.nombre}`}
          onClick={() => setShowPermissionsPopup(false)}
        >
          <div className="create-user__permissions-popup" onClick={(event) => event.stopPropagation()}>
            <div className="create-user__permissions-popup-head">
              <div>
                <p className="create-user__eyebrow">Permisos por sucursal</p>
                <h4>{selectedBranch.nombre}</h4>
              </div>
              <button
                type="button"
                className="create-user__icon-button"
                onClick={() => setShowPermissionsPopup(false)}
                aria-label="Cerrar permisos"
              >
                <i className="pi pi-times" aria-hidden="true" />
              </button>
            </div>

            {(permissionsLoading || !permissionOptions.length) && (
              <small className="muted">
                {permissionsLoading ? 'Cargando permisos...' : 'No hay módulos configurados.'}
              </small>
            )}

            <div className="create-user__permissions-popup-body">
              <div className="permissions-matrix__table" role="grid">
                <div className="permissions-matrix__row permissions-matrix__row--head">
                  <div className="permissions-matrix__cell permissions-matrix__cell--label">Módulo</div>
                  {ACTIONS.map((action) => {
                    const columnState = getColumnSelectionState(action.key)
                    const headerDisabled = !isEditing || loadingData || saving || deleteLoading || permissionsLoading || branchesLoading || columnState.disabled
                    return (
                      <div key={action.key} className="permissions-matrix__cell permissions-matrix__cell--action permissions-matrix__head-action">
                        <span>{action.label}</span>
                        <input
                          type="checkbox"
                          checked={columnState.checked}
                          ref={(node) => {
                            if (node) node.indeterminate = columnState.indeterminate
                          }}
                          onChange={(event) => setColumnPermission(action.key, event.target.checked)}
                          disabled={headerDisabled}
                          aria-label={`Seleccionar toda la columna ${action.label}`}
                        />
                      </div>
                    )
                  })}
                </div>

                {permissionOptions.map((module) => (
                  renderPermissionRow(module)
                ))}
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {allowDelete && showDeleteDialog && (
        <div className="user-details__confirm-overlay" role="alertdialog" aria-modal="true" aria-label="Confirmar eliminación">
          <div className="user-details__confirm-dialog">
            <div className="user-details__confirm-icon" aria-hidden="true">
              <Info size={22} />
            </div>
            <div className="user-details__confirm-content">
              <h4>¿Estás seguro?</h4>
              <p>Esta acción es irreversible</p>
            </div>
            <div className="user-details__confirm-actions">
              <button
                type="button"
                className="create-user__ghost create-user__cancel"
                onClick={() => setShowDeleteDialog(false)}
              >
                No
              </button>
              <button
                type="button"
                className="user-details__confirm-danger"
                onClick={handleDelete}
                disabled={deleteLoading}
              >
                Sí
              </button>
            </div>
          </div>
        </div>
      )}

      {allowDelete && showDeleteDialog && (
        <div className="user-details__confirm-overlay" role="alertdialog" aria-modal="true" aria-label="Confirmar eliminación">
          <div className="user-details__confirm-dialog">
            <div className="user-details__confirm-icon" aria-hidden="true">
              <Info size={22} />
            </div>
            <div className="user-details__confirm-content">
              <h4>¿Estás seguro?</h4>
              <p>Esta acción es irreversible</p>
            </div>
            <div className="user-details__confirm-actions">
              <button
                type="button"
                className="create-user__action create-user__action--cancel"
                onClick={() => setShowDeleteDialog(false)}
              >
                No
              </button>
              <button
                type="button"
                className="create-user__action user-details__confirm-danger"
                onClick={handleDelete}
                disabled={deleteLoading}
              >
                Sí
              </button>
            </div>
          </div>
        </div>
      )}

      <button
        type="button"
        aria-label="Cambiar tamaño de ventana"
        className="create-user__resize-handle"
          onMouseDown={handleResizeMouseDown}
        />
      </div>
    </div>
  )
}

export default UsersDetails




