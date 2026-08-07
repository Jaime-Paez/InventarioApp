import { useEffect, useRef } from 'react'

export const WORKSPACE_DROPDOWN_CLOSE_EVENT = 'workspace:close-dropdowns'

export const dispatchCloseAllDropdowns = () => {
  window.dispatchEvent(new Event(WORKSPACE_DROPDOWN_CLOSE_EVENT))
}

export function useCloseDropdownsOnTabSwitch(closeAllFn) {
  const closeAllRef = useRef(closeAllFn)
  closeAllRef.current = closeAllFn

  useEffect(() => {
    const handleClose = () => closeAllRef.current?.()
    window.addEventListener(WORKSPACE_DROPDOWN_CLOSE_EVENT, handleClose)
    return () => window.removeEventListener(WORKSPACE_DROPDOWN_CLOSE_EVENT, handleClose)
  }, [])
}
