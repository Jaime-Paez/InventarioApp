/**
 * Column width utilities for PrimeReact DataTable.
 *
 * PrimeReact v10 manages column widths via CSS injection using:
 *   [data-pc-name="datatable"][pr_id_N] > ... > th:nth-child(N) { width: Xpx !important }
 *
 * Use makeWidthStateHandlers() to create customSaveState / customRestoreState handlers
 * that persist ONLY column widths (never filters or sort state).
 */

import { tableLayoutStore } from './tableLayoutStore'

const MIN_COLUMN_WIDTH_PX = 80

function _clampColumnWidths(columnWidths) {
  if (!columnWidths) return columnWidths
  return String(columnWidths)
    .split(',')
    .map((w) => {
      const px = parseFloat(w)
      return isNaN(px) ? w : `${Math.max(px, MIN_COLUMN_WIDTH_PX)}px`
    })
    .join(',')
}

/**
 * Creates { save, restore } handlers for DataTable stateStorage="custom".
 * Persists columnWidths, tableWidth, first, and rows — never filters, sort, or selection.
 * The storageKey must match /-table-state/i so it syncs to the DB via tableLayoutStore.
 *
 * NOTE: first and rows must be included in the restore result so PrimeReact does not call
 * setFirstState(undefined) / setRowsState(undefined) when the restored object is non-empty,
 * which would silently break pagination and show 0 rows.
 *
 * @param {string} storageKey - storage key (e.g. "productos-table-state")
 */
export const makeWidthStateHandlers = (storageKey) => {
  const save = (state) => {
    if (!storageKey) return
    try {
      const entry = {}
      if (state?.columnWidths != null) entry.columnWidths = state.columnWidths
      if (state?.tableWidth != null) entry.tableWidth = state.tableWidth
      if (state?.first != null) entry.first = state.first
      if (state?.rows != null) entry.rows = state.rows
      if (Object.keys(entry).length > 0) {
        tableLayoutStore.setItem(storageKey, JSON.stringify(entry))
      } else {
        tableLayoutStore.removeItem(storageKey)
      }
    } catch {}
  }

  const restore = () => {
    if (!storageKey) return null
    try {
      const raw = tableLayoutStore.getItem(storageKey)
      if (!raw) return null
      const parsed = JSON.parse(raw)
      const entry = {}
      if (parsed?.columnWidths != null) entry.columnWidths = _clampColumnWidths(parsed.columnWidths)
      if (parsed?.tableWidth != null) entry.tableWidth = parsed.tableWidth
      if (parsed?.first != null) entry.first = parsed.first
      if (parsed?.rows != null) entry.rows = parsed.rows
      if (Object.keys(entry).length > 0) {
        return {
          ...entry,
          first: parsed?.first ?? 0,
          rows: parsed?.rows ?? 25,
        }
      }
      return null
    } catch {
      return null
    }
  }

  return { save, restore }
}

/**
 * Strips saved column widths from a DataTable's stored state entry.
 * Used by autoFitTableColumns to clear widths on auto-fit / reset.
 */
export const clearSavedColumnWidths = (stateKey) => {
  if (!stateKey) return
  try {
    const raw = tableLayoutStore.getItem(stateKey)
    if (!raw) return
    const state = JSON.parse(raw)
    if (state.columnWidths !== undefined || state.tableWidth !== undefined) {
      delete state.columnWidths
      delete state.tableWidth
      if (Object.keys(state).length === 0) {
        tableLayoutStore.removeItem(stateKey)
      } else {
        tableLayoutStore.setItem(stateKey, JSON.stringify(state))
      }
    }
  } catch {}
}

/**
 * Clears PrimeReact's injected per-column width CSS and the table's own
 * inline width/min-width, so the browser recomputes natural (table-layout:
 * auto) widths on next paint. Pure DOM mutation -- never touches storage.
 * Shared by autoFitTableColumns (manual, persistent reset) and
 * attachAutoExpandColumns (automatic, visual-only fill-the-container check).
 *
 * @returns {boolean} true if a DataTable was found and cleared
 */
const _clearLiveColumnWidthStyles = (wrapperEl) => {
  const dtRoot = wrapperEl.querySelector('[data-pc-name="datatable"]')
  if (!dtRoot) return false

  // Find PrimeReact's unique attribute stamped on the root element (pr_id_N)
  const uniqueAttr = [...dtRoot.attributes]
    .map((a) => a.name)
    .find((name) => /^pr_id_\d+$/.test(name))
  if (!uniqueAttr) return false

  // Clear PrimeReact's injected column-width CSS rules
  ;[...document.querySelectorAll('style')].forEach((s) => {
    if (s.textContent.includes(`[${uniqueAttr}]`)) {
      s.innerHTML = ''
    }
  })

  // Reset the table element's explicit width so the browser fills the container
  const tableEl = dtRoot.querySelector('[data-pc-section="table"]')
  if (tableEl) {
    tableEl.style.width = ''
    tableEl.style.minWidth = ''
  }
  return true
}

/**
 * Resets a DataTable to natural (browser auto-layout) column widths.
 * Clears PrimeReact's injected width CSS and removes the saved widths from the store.
 *
 * @param {HTMLElement} wrapperEl - The div wrapping the DataTable (ref target)
 * @param {string|null} stateKey  - storage key used for column widths
 */
export const autoFitTableColumns = (wrapperEl, stateKey = null) => {
  if (!wrapperEl || typeof window === 'undefined') return
  if (!_clearLiveColumnWidthStyles(wrapperEl)) return

  // Clear saved widths so the next mount starts clean
  if (stateKey) clearSavedColumnWidths(stateKey)
}

/**
 * Keeps a DataTable filling its wrapper on wide screens instead of leaving
 * blank space to the right. PrimeReact persists resized columns as an
 * absolute pixel table width (see makeWidthStateHandlers) -- restoring that
 * on a wider viewport than it was saved on leaves the table narrower than
 * its container. This watches the wrapper and, only when the table is
 * currently narrower than the available space (never the other way --
 * narrow screens keep their horizontal scroll untouched), clears the live
 * width overrides so table-layout:auto naturally expands columns to fill
 * it. Purely visual: it never touches the saved column widths, so a
 * narrower screen (or a manual resize afterwards) still restores/persists
 * normally.
 *
 * @param {HTMLElement} wrapperEl - the div wrapping the DataTable (ref target)
 * @returns {() => void} cleanup function
 */
export const attachAutoExpandColumns = (wrapperEl) => {
  if (!wrapperEl || typeof window === 'undefined' || typeof ResizeObserver === 'undefined') {
    return () => {}
  }

  const EXPAND_TOLERANCE_PX = 2
  let frame = null

  const checkAndExpand = () => {
    const dtRoot = wrapperEl.querySelector('[data-pc-name="datatable"]')
    const tableEl = dtRoot?.querySelector('[data-pc-section="table"]')
    if (!tableEl) return

    const wrapperWidth = wrapperEl.clientWidth
    const tableWidth = tableEl.getBoundingClientRect().width
    if (!wrapperWidth || !tableWidth) return
    if (tableWidth >= wrapperWidth - EXPAND_TOLERANCE_PX) return

    _clearLiveColumnWidthStyles(wrapperEl)
  }

  const scheduleCheck = () => {
    if (frame) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(checkAndExpand)
  }

  scheduleCheck()
  const observer = new ResizeObserver(scheduleCheck)
  observer.observe(wrapperEl)

  return () => {
    observer.disconnect()
    if (frame) cancelAnimationFrame(frame)
  }
}
