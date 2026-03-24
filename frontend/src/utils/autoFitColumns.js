/**
 * Column width utilities for PrimeReact DataTable.
 *
 * PrimeReact v10 manages column widths via CSS injection using:
 *   [data-pc-name="datatable"][pr_id_N] > ... > th:nth-child(N) { width: Xpx !important }
 *
 * "Natural layout" = no forced widths = browser distributes columns across available space.
 * This is the desired default state. clearSavedColumnWidths() + autoFitTableColumns()
 * together restore it both on mount and when the reset button is clicked.
 */

/**
 * Strips saved column widths from a DataTable's localStorage state entry.
 * Call this synchronously during component initialization (before PrimeReact reads the state).
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
      localStorage.setItem(stateKey, JSON.stringify(state))
    }
  } catch {}
}

/**
 * Resets a DataTable to natural (browser auto-layout) column widths.
 * Clears PrimeReact's injected width CSS and removes the saved widths from localStorage.
 *
 * @param {HTMLElement} wrapperEl - The div wrapping the DataTable (ref target)
 * @param {string|null} stateKey  - The DataTable's stateKey prop value (to clear localStorage)
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

  // Also clear saved widths so the next mount starts clean too
  if (stateKey) clearSavedColumnWidths(stateKey)
}
