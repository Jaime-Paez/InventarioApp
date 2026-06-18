/**
 * Column width utilities for PrimeReact DataTable.
 *
 * PrimeReact v10 manages column widths via CSS injection using:
 *   [data-pc-name="datatable"][pr_id_N] > ... > th:nth-child(N) { width: Xpx !important }
 *
 * Use makeWidthStateHandlers() to create customSaveState / customRestoreState handlers
 * that persist ONLY column widths (never filters or sort state).
 */

/**
 * Creates { save, restore } handlers for DataTable stateStorage="custom".
 * Persists columnWidths, tableWidth, first, and rows — never filters, sort, or selection.
 * The storageKey must match /-table-state/i so tableLayoutSync picks it up.
 *
 * NOTE: first and rows must be included in the restore result so PrimeReact does not call
 * setFirstState(undefined) / setRowsState(undefined) when the restored object is non-empty,
 * which would silently break pagination and show 0 rows.
 *
 * @param {string} storageKey - localStorage key (e.g. "productos-table-state")
 */
export const makeWidthStateHandlers = (storageKey) => {
  const save = (state) => {
    if (!storageKey || typeof localStorage === 'undefined') return
    try {
      const entry = {}
      if (state?.columnWidths != null) entry.columnWidths = state.columnWidths
      if (state?.tableWidth != null) entry.tableWidth = state.tableWidth
      if (state?.first != null) entry.first = state.first
      if (state?.rows != null) entry.rows = state.rows
      if (Object.keys(entry).length > 0) {
        localStorage.setItem(storageKey, JSON.stringify(entry))
      } else {
        localStorage.removeItem(storageKey)
      }
    } catch {}
  }

  const restore = () => {
    if (!storageKey || typeof localStorage === 'undefined') return null
    try {
      const raw = localStorage.getItem(storageKey)
      if (!raw) return null
      const parsed = JSON.parse(raw)
      const entry = {}
      if (parsed?.columnWidths != null) entry.columnWidths = parsed.columnWidths
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
 * Strips saved column widths from a DataTable's localStorage state entry.
 * Used by autoFitTableColumns to clear widths on auto-fit / reset.
 */
export const clearSavedColumnWidths = (stateKey) => {
  if (!stateKey || typeof localStorage === 'undefined') return
  try {
    const raw = localStorage.getItem(stateKey)
    if (!raw) return
    const state = JSON.parse(raw)
    if (state.columnWidths !== undefined || state.tableWidth !== undefined) {
      delete state.columnWidths
      delete state.tableWidth
      if (Object.keys(state).length === 0) {
        localStorage.removeItem(stateKey)
      } else {
        localStorage.setItem(stateKey, JSON.stringify(state))
      }
    }
  } catch {}
}

/**
 * Resets a DataTable to natural (browser auto-layout) column widths.
 * Clears PrimeReact's injected width CSS and removes the saved widths from localStorage.
 *
 * @param {HTMLElement} wrapperEl - The div wrapping the DataTable (ref target)
 * @param {string|null} stateKey  - localStorage key used for column widths
 */
export const autoFitTableColumns = (wrapperEl, stateKey = null) => {
  if (!wrapperEl || typeof window === 'undefined') return

  const dtRoot = wrapperEl.querySelector('[data-pc-name="datatable"]')
  if (!dtRoot) return

  // Find PrimeReact's unique attribute stamped on the root element (pr_id_N)
  const uniqueAttr = [...dtRoot.attributes]
    .map((a) => a.name)
    .find((name) => /^pr_id_\d+$/.test(name))
  if (!uniqueAttr) return

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

  // Clear saved widths so the next mount starts clean
  if (stateKey) clearSavedColumnWidths(stateKey)
}
