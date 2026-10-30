import { unzipSync, zipSync } from 'fflate'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import StaticFieldDisplay from '../movimientos/StaticFieldDisplay'
import { FilterMatchMode } from 'primereact/api'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Toast } from 'primereact/toast'
import { Button } from 'primereact/button'
import { Check, Info, PackagePlus, Plus, Search, Trash2, X } from 'lucide-react'
import { Checkbox } from 'primereact/checkbox'
import { API_URL, authFetch } from '../../../utils/api'
import { attachAutoExpandColumns, autoFitTableColumns, makeWidthStateHandlers } from '../../../utils/autoFitColumns'
import { tableLayoutStore } from '../../../utils/tableLayoutStore'
import { buildFileName, exportToExcel, exportToPdf } from '../../../utils/exportUtils'
import { formatDate } from '../../../utils/dateFormat'
import { toUpperCode } from '../../../utils/textInput'
import { getAppPortalRoot } from '../../../utils/portalRoot'
import { useCloseDropdownsOnTabSwitch } from '../../../hooks/useCloseDropdownsOnTabSwitch'
import '../admin/CreateUsuario/CreateUsuario.css'
import '../admin/UsersDetails/UsersDetails.css'
import '../admin/UsersTable/UsersTable.css'
import '../movimientos/CreateSalida.css'
import '../QuickActions/QuickActions.css'
import './ImportacionesTable.css'
import BlockerNotice from '../common/BlockerNotice'
import { matchesFirst } from '../common/productDetailMatches'
import useUnsavedChangesGuard, { useUnsavedChangesRegistration } from '../common/unsavedChanges/useUnsavedChangesGuard'
import { UnsavedChangesDialog } from '../common/unsavedChanges/unsavedChanges'
import { isPhoneViewport } from '../../../utils/viewport'
import { REMINDERS_TRANSFER_NOTIFICATION_EVENT } from '../common/reminders/remindersStorage'

const getPortalRoot = () => getAppPortalRoot()

const getProductoOem = (producto) =>
  (producto?.oem_productos || []).map((r) => r?.oem?.codigo).filter(Boolean).join(', ')

// Referencias del producto (la vieja y las varias) + las del propio detalle,
// para que los buscadores tambien encuentren por referencia.
const getReferenciasTexto = (producto, detalle = null) => [
  producto?.referencia,
  ...(producto?.referencias || []).map((r) => r?.valor),
  detalle?.referencia,
].filter(Boolean).join(' ')

const normalizeImportSearch = (value) =>
  String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

// Buscador de productos dentro de una importacion (todas las etapas): por
// codigo, descripcion, OEM y referencias; varias palabras = todas deben estar.
const importItemMatches = (item, query) => {
  const terms = normalizeImportSearch(query).split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const producto = item?.producto || {}
  const text = normalizeImportSearch([
    item?.codigo, item?.nombre, item?.oem, item?.referencia, item?.producto_busqueda,
    producto?.codigo, producto?.nombre, getProductoOem(producto), getReferenciasTexto(producto, item),
  ].join(' '))
  return terms.every((term) => text.includes(term))
}

// Precio que se escribe como un numero normal: "120", luego "." y los
// centavos. Guarda el valor en centavos (string de digitos, '' si queda
// vacio), igual que el resto de la verificacion/confirmacion.
const centavosToText = (centsStr) => {
  const digits = String(centsStr || '').replace(/\D/g, '')
  if (!digits) return ''
  return (parseInt(digits, 10) / 100).toFixed(2)
}

function PrecioCentavosInput({ value, onChange, disabled, title, onDoubleClick, invalid = false }) {
  const [draft, setDraft] = useState(null)
  return (
    <input
      type="text"
      inputMode="decimal"
      disabled={disabled}
      title={title}
      placeholder="0.00"
      style={invalid ? { borderColor: '#ef4444' } : undefined}
      value={draft ?? centavosToText(value)}
      onFocus={(e) => {
        const text = centavosToText(value)
        setDraft(text && Number(text) === 0 ? '' : text)
        e.target.select()
      }}
      onBlur={() => setDraft(null)}
      onDoubleClick={onDoubleClick}
      onChange={(e) => {
        const text = e.target.value.replace(',', '.').replace(/[^\d.]/g, '')
        if (!/^\d*(\.\d{0,2})?$/.test(text)) return
        setDraft(text)
        if (!text || text === '.') {
          onChange('')
          return
        }
        const [entero, dec = ''] = text.split('.')
        onChange(String(parseInt(entero || '0', 10) * 100 + parseInt(dec.padEnd(2, '0'), 10)))
      }}
    />
  )
}

function ImportProductSearch({ value, onChange, shown, total, children }) {
  return (
    <div className="imp-product-search">
      <div className="search-input-container">
        <input
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="search-input"
          placeholder="Buscar producto"
          title="Busca por código, descripción, OEM o referencia"
          aria-label="Buscar producto en esta importación"
        />
        <i className="pi pi-search search-input-icon" />
      </div>
      {children}
      {String(value || '').trim() && (
        <span className="imp-product-search__count">
          {shown ? `${shown} de ${total} coinciden (van primero)` : 'Ninguno coincide'}
          <button type="button" className="imp-product-search__clear" onClick={() => onChange('')}>Limpiar</button>
        </span>
      )}
    </div>
  )
}

// OEMProductoSerializer manda "producto" como su __str__ ("Nombre (Codigo)"),
// no como objeto — se separa el código (paréntesis al final) del nombre para
// poder mostrarlo en su propia columna en vez de mezclado en un solo texto.
const parseProductoLabel = (label) => {
  const str = String(label || '')
  const match = /^(.*)\s\(([^)]+)\)\s*$/.exec(str)
  if (!match) return { nombre: str, codigo: '' }
  return { nombre: match[1].trim(), codigo: match[2].trim() }
}

// Selector de un solo OEM: busca con debounce en el catálogo existente (para
// poder unir el producto nuevo al mismo grupo que ya usa ese OEM) y, si no
// hay coincidencia, permite agregar el código tal cual como uno nuevo. Al
// elegir un código ya vinculado a otro producto, ese producto queda marcado
// como "alterno" del nuevo al guardar (ver linkOemToProduct más abajo), lo
// que hace que el backend unifique automáticamente TODOS los códigos OEM
// del conglomerado entre ambos — por eso el ícono de info muestra tanto los
// productos existentes como esa lista completa de OEMs relacionados.
function OemAutocomplete({ value, onChange, token, disabled }) {
  const selectedCode = String(value || '').trim()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [options, setOptions] = useState([])
  const [panelRect, setPanelRect] = useState(null)
  const wrapRef = useRef(null)
  const panelRef = useRef(null)
  const timerRef = useRef(null)
  const seqRef = useRef(0)

  // El panel se posiciona con position:fixed vía portal (en vez de absolute
  // dentro de .imp-oem-input) para que pueda salirse del modal — que tiene
  // su propio scroll interno y lo recortaba — en lugar de quedar atrapado
  // ahí dentro con su propia barra de scroll.
  useLayoutEffect(() => {
    if (!open || !wrapRef.current) { setPanelRect(null); return }
    const rect = wrapRef.current.getBoundingClientRect()
    const estimatedPanelHeight = 240
    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top
    const openUpward = spaceBelow < estimatedPanelHeight && spaceAbove > spaceBelow
    const left = Math.min(Math.max(rect.left, 8), window.innerWidth - rect.width - 8)
    setPanelRect({
      left,
      width: rect.width,
      ...(openUpward
        ? { bottom: window.innerHeight - rect.top + 4 }
        : { top: rect.bottom + 4 }),
    })
  }, [open])

  useEffect(() => {
    const term = query.trim()
    if (!open || !term || !token) {
      setOptions([])
      setLoading(false)
      return undefined
    }
    if (timerRef.current) clearTimeout(timerRef.current)
    setLoading(true)
    const seq = ++seqRef.current
    timerRef.current = setTimeout(async () => {
      try {
        const [oemResp, linksResp] = await Promise.all([
          authFetch(`${API_URL}/productos/oem/?search=${encodeURIComponent(term)}&page_size=20`, {}, token),
          authFetch(`${API_URL}/productos/oem-producto/?search=${encodeURIComponent(term)}&page_size=50`, {}, token),
        ])
        if (seqRef.current !== seq) return
        const byCode = new Map()
        if (oemResp.ok) {
          const data = await oemResp.json()
          const list = Array.isArray(data) ? data : data?.results || []
          list.forEach((o) => {
            const codigo = String(o?.codigo || '').trim()
            if (codigo) byCode.set(codigo.toLowerCase(), { codigo, productos: [] })
          })
        }
        if (linksResp.ok) {
          const data = await linksResp.json()
          const list = Array.isArray(data) ? data : data?.results || []
          list.forEach((row) => {
            const codigo = String(row?.oem?.codigo || '').trim()
            if (!codigo || !codigo.toLowerCase().includes(term.toLowerCase())) return
            const key = codigo.toLowerCase()
            if (!byCode.has(key)) byCode.set(key, { codigo, productos: [] })
            if (row.producto) byCode.get(key).productos.push(String(row.producto))
          })
        }
        setOptions(Array.from(byCode.values()))
      } catch {
        if (seqRef.current !== seq) return
        setOptions([])
      } finally {
        if (seqRef.current === seq) setLoading(false)
      }
    }, 300)
    return () => clearTimeout(timerRef.current)
  }, [query, open, token])

  useEffect(() => {
    if (!open) return undefined
    const onDocMouseDown = (e) => {
      const inWrap = wrapRef.current?.contains(e.target)
      const inPanel = panelRef.current?.contains(e.target)
      if (!inWrap && !inPanel) setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [open])

  const selectCode = (raw) => {
    const clean = String(raw || '').trim()
    if (!clean) return
    onChange(clean)
    setQuery('')
    setOptions([])
    setOpen(false)
  }

  const term = query.trim()
  const exactMatch = options.some((o) => o.codigo.toLowerCase() === term.toLowerCase())

  // "Ya vinculado a: ..." recorta a los primeros 3 productos (con "…"); el
  // ícono de info de cada opción del dropdown muestra la lista completa
  // (código + nombre) en una tarjeta flotante, mismo patrón que el ícono "i"
  // de alternos/stock (imp-alternos-hover-card) más abajo en este archivo.
  const [productsHover, setProductsHover] = useState(null)
  const [productsHoverPos, setProductsHoverPos] = useState(null)
  const productsHoverCardRef = useRef(null)
  const productsHoverTimerRef = useRef(null)

  const showProductsHover = (event, productos) => {
    if (productsHoverTimerRef.current) clearTimeout(productsHoverTimerRef.current)
    const rect = event.currentTarget.getBoundingClientRect()
    productsHoverTimerRef.current = setTimeout(() => {
      productsHoverTimerRef.current = null
      setProductsHover({ triggerTop: rect.top, triggerBottom: rect.bottom, triggerLeft: rect.left, productos })
    }, 150)
  }
  const hideProductsHover = () => {
    if (productsHoverTimerRef.current) { clearTimeout(productsHoverTimerRef.current); productsHoverTimerRef.current = null }
    setProductsHover(null)
    setProductsHoverPos(null)
  }

  useLayoutEffect(() => {
    if (!productsHover || !productsHoverCardRef.current) return
    setProductsHoverPos(computeSmartPopoverPosition(productsHover, productsHoverCardRef.current))
  }, [productsHover])

  // Una vez elegido un código, se busca si ya pertenece a algún producto del
  // catálogo: si es así, este ícono muestra ese "conglomerado" (los
  // productos que ya lo usan + todos los códigos OEM que ellos tienen), ya
  // que al guardar se enlazan como alternos y el backend unifica esos OEMs
  // entre ambos productos (ver linkOemToProduct).
  const [groupInfo, setGroupInfo] = useState(null)
  const [groupHover, setGroupHover] = useState(null)
  const [groupHoverPos, setGroupHoverPos] = useState(null)
  const groupHoverCardRef = useRef(null)
  const groupHoverTimerRef = useRef(null)

  useEffect(() => {
    if (!selectedCode || !token) { setGroupInfo(null); return undefined }
    let cancelled = false
    setGroupInfo('loading')
    ;(async () => {
      try {
        const resp = await authFetch(`${API_URL}/productos/listado/?search=${encodeURIComponent(selectedCode)}&page_size=20`, {}, token)
        if (cancelled) return
        if (!resp.ok) { setGroupInfo(null); return }
        const data = await resp.json()
        const list = Array.isArray(data) ? data : data?.results || []
        const matches = list.filter((p) =>
          (p?.oem_productos || []).some((r) => String(r?.oem?.codigo || '').trim().toLowerCase() === selectedCode.toLowerCase())
        )
        if (!matches.length) { setGroupInfo(null); return }
        const oemSet = new Set()
        matches.forEach((p) => (p.oem_productos || []).forEach((r) => {
          const c = String(r?.oem?.codigo || '').trim()
          if (c) oemSet.add(c)
        }))
        setGroupInfo({
          productos: matches.map((p) => ({ codigo: p.codigo, nombre: p.nombre })),
          oemCodes: Array.from(oemSet),
        })
      } catch {
        if (!cancelled) setGroupInfo(null)
      }
    })()
    return () => { cancelled = true }
  }, [selectedCode, token])

  const showGroupHover = (event) => {
    if (groupHoverTimerRef.current) clearTimeout(groupHoverTimerRef.current)
    const rect = event.currentTarget.getBoundingClientRect()
    groupHoverTimerRef.current = setTimeout(() => {
      groupHoverTimerRef.current = null
      setGroupHover({ triggerTop: rect.top, triggerBottom: rect.bottom, triggerLeft: rect.left })
    }, 150)
  }
  const hideGroupHover = () => {
    if (groupHoverTimerRef.current) { clearTimeout(groupHoverTimerRef.current); groupHoverTimerRef.current = null }
    setGroupHover(null)
    setGroupHoverPos(null)
  }

  useLayoutEffect(() => {
    if (!groupHover || !groupHoverCardRef.current) return
    setGroupHoverPos(computeSmartPopoverPosition(groupHover, groupHoverCardRef.current))
  }, [groupHover])

  return (
    <div className="imp-oem-input" ref={wrapRef}>
      <div className="imp-oem-input__row">
        <button
          type="button"
          className="create-user__dropdown-trigger imp-oem-input__trigger"
          onClick={() => {
            setOpen((prev) => !prev)
            if (!open) setQuery('')
          }}
          disabled={disabled}
        >
          <span>{selectedCode || 'Buscar o agregar OEM'}</span>
          <i className={`pi pi-chevron-${open ? 'up' : 'down'}`} />
        </button>
        {selectedCode && (
          <Info
            size={14}
            className="imp-distribucion__info-icon imp-oem-input__group-icon"
            onMouseEnter={showGroupHover}
            onMouseLeave={hideGroupHover}
          />
        )}
      </div>
      {open && panelRect && createPortal(
        <div
          ref={panelRef}
          className="imp-oem-input__panel"
          style={{ top: panelRect.top, bottom: panelRect.bottom, left: panelRect.left, width: panelRect.width }}
        >
          <div className="create-user__dropdown-search">
            <i className="pi pi-search" />
            <input
              type="text"
              placeholder="Buscar o agregar OEM"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); if (term) selectCode(term) }
                else if (e.key === 'Escape') setOpen(false)
              }}
              autoFocus
              autoComplete="off"
            />
          </div>
          {loading && <small className="muted">Buscando OEM...</small>}
          {!loading && !term && <small className="muted">Escribe para buscar.</small>}
          {!loading && term && options.map((o) => (
            <button
              type="button"
              key={o.codigo}
              className="imp-oem-input__option"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => selectCode(o.codigo)}
            >
              <span className="imp-oem-input__option-code">{o.codigo}</span>
              <span className="imp-oem-input__option-meta-row">
                <span className="imp-oem-input__option-meta">
                  {o.productos.length
                    ? `Ya vinculado a: ${o.productos.slice(0, 3).map((p) => {
                        const { codigo, nombre } = parseProductoLabel(p)
                        return codigo ? `${codigo}: ${nombre}` : nombre
                      }).join(', ')}${o.productos.length > 3 ? '…' : ''}`
                    : 'Sin productos vinculados aún'}
                </span>
                {o.productos.length > 0 && (
                  <Info
                    size={13}
                    className="imp-distribucion__info-icon"
                    onMouseEnter={(e) => showProductsHover(e, o.productos)}
                    onMouseLeave={hideProductsHover}
                  />
                )}
              </span>
            </button>
          ))}
          {!loading && term && !exactMatch && (
            <button type="button" className="imp-oem-input__option imp-oem-input__option--new" onMouseDown={(e) => e.preventDefault()} onClick={() => selectCode(term)}>
              <Plus size={13} />
              Agregar &quot;{term}&quot; como OEM nuevo
            </button>
          )}
        </div>,
        getPortalRoot()
      )}
      {productsHover && createPortal(
        <div
          ref={productsHoverCardRef}
          className="imp-alternos-hover-card"
          style={{
            top: productsHoverPos?.top ?? productsHover.triggerBottom + 4,
            left: productsHoverPos?.left ?? productsHover.triggerLeft,
            visibility: productsHoverPos ? 'visible' : 'hidden',
          }}
        >
          <table className="imp-alternos-hover-card__table imp-alternos-hover-card__table--producto">
            <thead>
              <tr><th>Código</th><th>Producto</th></tr>
            </thead>
            <tbody>
              {productsHover.productos.map((p, i) => {
                const { codigo, nombre } = parseProductoLabel(p)
                return <tr key={i}><td title={codigo}>{codigo || '-'}</td><td title={nombre}>{nombre}</td></tr>
              })}
            </tbody>
          </table>
        </div>,
        getPortalRoot()
      )}
      {groupHover && createPortal(
        <div
          ref={groupHoverCardRef}
          className="imp-alternos-hover-card imp-alternos-hover-card--group"
          style={{
            top: groupHoverPos?.top ?? groupHover.triggerBottom + 4,
            left: groupHoverPos?.left ?? groupHover.triggerLeft,
            visibility: groupHoverPos ? 'visible' : 'hidden',
          }}
        >
          {groupInfo === 'loading' && (
            <div className="imp-alternos-hover-card__message">Buscando...</div>
          )}
          {!groupInfo && (
            <div className="imp-alternos-hover-card__message">No hay ningún producto ni OEM agregado.</div>
          )}
          {groupInfo && groupInfo !== 'loading' && (
            <>
              <div className="imp-alternos-hover-card__section-title">Productos alternos</div>
              <table className="imp-alternos-hover-card__table imp-alternos-hover-card__table--producto">
                <thead>
                  <tr><th>Código</th><th>Producto</th></tr>
                </thead>
                <tbody>
                  {groupInfo.productos.map((p, i) => (
                    <tr key={i}><td title={p.codigo}>{p.codigo || '-'}</td><td title={p.nombre}>{p.nombre}</td></tr>
                  ))}
                </tbody>
              </table>
              <div className="imp-alternos-hover-card__section-title">Lista de OEMs</div>
              <div className="imp-alternos-hover-card__oem-list">
                {groupInfo.oemCodes.join(', ')}
              </div>
            </>
          )}
        </div>,
        getPortalRoot()
      )}
    </div>
  )
}

const toNumberOrNull = (v) => (v === '' || v == null ? null : Number(v))

const getCantidadRecibidaCeiling = (row) => {
  const n = parseInt(row.cantidadRecibida, 10)
  return Number.isFinite(n) ? n : row.cantidad
}

const SPANISH_MONTH_ABBR = {
  enero: 'Ene', febrero: 'Feb', marzo: 'Mar', abril: 'Abr', mayo: 'May', junio: 'Jun',
  julio: 'Jul', agosto: 'Ago', septiembre: 'Sep', setiembre: 'Sep', octubre: 'Oct',
  noviembre: 'Nov', diciembre: 'Dic',
}

// Nombres de sucursal tipo "9 de Octubre" ocupan demasiado espacio como encabezado
// de columna en tablas angostas; se abrevia a "9 Oct" (el nombre completo sigue
// disponible via title/tooltip donde ya se mostraba).
const shortSucursalLabel = (nombre) => {
  const value = String(nombre || '').trim()
  if (!value) return '(Sin nombre)'
  const match = value.match(/^(\d{1,2})\s+de\s+([a-zñáéíóú]+)/i)
  if (!match) return value
  const abbr = SPANISH_MONTH_ABBR[match[2].toLowerCase()]
  return abbr ? `${match[1]} ${abbr}` : value
}

// El progreso del asistente de llegada se guarda SOLO en la base de datos
// (Importacion.borrador_llegada), automaticamente con cada cambio. La lectura de
// localStorage es solo para rescatar el avance que dejaron versiones anteriores
// de la app: se sube al servidor con el primer guardado y se borra del navegador.
const getSavedDraft = (impData) => {
  if (impData?.borrador_llegada) return impData.borrador_llegada
  try {
    return JSON.parse(localStorage.getItem(`imp-receive-${impData?.id}`) || 'null')
  } catch {
    return null
  }
}

// Posiciona un popover como un dropdown inteligente: abre hacia abajo del elemento
// que lo dispara salvo que no quepa y haya más espacio arriba, en cuyo caso se voltea.
const computeSmartPopoverPosition = (trigger, cardEl) => {
  const margin = 8
  const cardRect = cardEl.getBoundingClientRect()
  const spaceBelow = window.innerHeight - trigger.triggerBottom
  const spaceAbove = trigger.triggerTop
  const top = cardRect.height + margin > spaceBelow && spaceAbove > spaceBelow
    ? Math.max(margin, trigger.triggerTop - cardRect.height - 4)
    : trigger.triggerBottom + 4
  const maxLeft = Math.max(margin, window.innerWidth - cardRect.width - margin)
  const left = Math.min(Math.max(margin, trigger.triggerLeft), maxLeft)
  return { top, left }
}

// La sucursal matriz (nombre contiene "matriz") absorbe automáticamente el
// remanente de la distribución: recibe el total por defecto y se reduce a
// medida que se asignan unidades al resto de sucursales.
const findMatrizSucursal = (list) =>
  (list || []).find((s) => String(s?.nombre || '').toLowerCase().includes('matriz')) || null

// Salto de los contadores (vinculados, solo por OEM, nuevos, eliminados...),
// igual que el Paso 3 de "Sugerencia desde Excel": la fila queda arriba del
// contenedor que de verdad se desplaza (la tabla o, si la tabla no tiene alto
// propio, el modal), debajo de lo que queda fijo (encabezado y fila
// "Agregar"), y parpadea.
const scrollRowToTopAndFlash = (rowEl) => {
  if (!rowEl) return
  let container = rowEl.parentElement
  while (container && container !== document.body) {
    const { overflowY } = window.getComputedStyle(container)
    if (/(auto|scroll)/.test(overflowY) && container.scrollHeight > container.clientHeight + 1) break
    container = container.parentElement
  }
  if (container && container !== document.body) {
    const fijos = ['thead', '.imp-sticky-head', '.imp-sticky-form']
      .map((selector) => container.querySelector(selector))
      .filter((el) => el && window.getComputedStyle(el).position === 'sticky')
      .reduce((sum, el) => sum + el.offsetHeight, 0)
    const top = rowEl.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - fijos
    container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  } else {
    rowEl.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }
  rowEl.classList.remove('imp-excel-review__row--flash')
  void rowEl.offsetWidth
  rowEl.classList.add('imp-excel-review__row--flash')
}

// Tambien las filas <tr> de la tabla de la sugerencia (misma que el Paso 3).
const GRID_ROW_SELECTOR = '.create-user__locations-row, .imp-excel-review-table tbody tr'
const GRID_FOCUSABLE_SELECTOR = 'input, button:not(:disabled)'

const focusGridInput = (input) => {
  if (!input) return false
  input.focus()
  if (typeof input.select === 'function') {
    try { input.select() } catch { /* not selectable */ }
  }
  return true
}

// Spreadsheet-style arrow navigation between the inputs and action buttons (e.g. the
// Acciones check/x toggle) of a products table: Up/Down move to the same column in the
// previous/next row, Left/Right move to the adjacent control (only past the caret's
// start/end for free-text fields, since buttons have no caret to worry about).
const handleProductsGridKeyDown = (e) => {
  const key = e.key
  if (key !== 'ArrowUp' && key !== 'ArrowDown' && key !== 'ArrowLeft' && key !== 'ArrowRight') return
  const target = e.target
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLButtonElement)) return

  const row = target.closest(GRID_ROW_SELECTOR)
  const container = row?.parentElement
  if (!row || !container) return

  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    let atBoundary = true
    if (target instanceof HTMLInputElement && target.type === 'text' && !target.readOnly) {
      const pos = key === 'ArrowLeft' ? 0 : target.value.length
      atBoundary = target.selectionStart === pos && target.selectionEnd === pos
    }
    if (!atBoundary) return
    const controlsInRow = Array.from(row.querySelectorAll(GRID_FOCUSABLE_SELECTOR))
    const idx = controlsInRow.indexOf(target)
    const nextControl = controlsInRow[key === 'ArrowLeft' ? idx - 1 : idx + 1]
    if (focusGridInput(nextControl)) e.preventDefault()
    return
  }

  const controlsInRow = Array.from(row.querySelectorAll(GRID_FOCUSABLE_SELECTOR))
  const colIdx = controlsInRow.indexOf(target)
  const rows = Array.from(container.querySelectorAll(GRID_ROW_SELECTOR)).filter((r) => r.querySelector(GRID_FOCUSABLE_SELECTOR))
  const rowIdx = rows.indexOf(row)
  const nextRow = rows[key === 'ArrowUp' ? rowIdx - 1 : rowIdx + 1]
  if (!nextRow) return
  const nextRowControls = Array.from(nextRow.querySelectorAll(GRID_FOCUSABLE_SELECTOR))
  const nextControl = nextRowControls[colIdx] ?? nextRowControls[nextRowControls.length - 1]
  if (focusGridInput(nextControl)) e.preventDefault()
}

const DISTRIBUTION_FOCUSABLE_SELECTOR = 'input:not(:disabled)'

// Same spreadsheet-style arrow navigation as handleProductsGridKeyDown, but only
// counting enabled inputs — the matriz cell is read-only and must be skipped rather
// than silently swallow focus.
const handleDistributionGridKeyDown = (e) => {
  const key = e.key
  if (key !== 'ArrowUp' && key !== 'ArrowDown' && key !== 'ArrowLeft' && key !== 'ArrowRight') return
  const target = e.target
  if (!(target instanceof HTMLInputElement)) return

  const row = target.closest(GRID_ROW_SELECTOR)
  const container = row?.parentElement
  if (!row || !container) return

  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const controlsInRow = Array.from(row.querySelectorAll(DISTRIBUTION_FOCUSABLE_SELECTOR))
    const idx = controlsInRow.indexOf(target)
    const nextControl = controlsInRow[key === 'ArrowLeft' ? idx - 1 : idx + 1]
    if (focusGridInput(nextControl)) e.preventDefault()
    return
  }

  const controlsInRow = Array.from(row.querySelectorAll(DISTRIBUTION_FOCUSABLE_SELECTOR))
  const colIdx = controlsInRow.indexOf(target)
  const rowsEls = Array.from(container.querySelectorAll(GRID_ROW_SELECTOR)).filter((r) => r.querySelector(DISTRIBUTION_FOCUSABLE_SELECTOR))
  const rowIdx = rowsEls.indexOf(row)
  const nextRow = rowsEls[key === 'ArrowUp' ? rowIdx - 1 : rowIdx + 1]
  if (!nextRow) return
  const nextRowControls = Array.from(nextRow.querySelectorAll(DISTRIBUTION_FOCUSABLE_SELECTOR))
  const nextControl = nextRowControls[colIdx] ?? nextRowControls[nextRowControls.length - 1]
  if (focusGridInput(nextControl)) e.preventDefault()
}

// Shared across every mounted ImportacionesTable instance (Importaciones, En proceso,
// En camino and Importadas are each their own persistent tab/component instance), so a
// mutation made from one tab invalidates what every other tab has cached, not just its own.
const importacionesItemsCache = {}
const invalidateImportacionesItemsCache = () => {
  Object.keys(importacionesItemsCache).forEach((key) => delete importacionesItemsCache[key])
}
const IMPORTACIONES_STALE_MS = 5 * 60 * 1000
// La tabla se recarga sola (sin spinner) cada tanto mientras se está viendo, y
// al volver a ella si los datos tienen más de este tiempo.
const IMPORTACIONES_AUTO_REFRESH_MS = 30 * 1000

const STATUS_CONFIG = {
  borrador: { label: 'Sugerencia', empty: 'No hay importaciones en sugerencia.' },
  cotizacion: { label: 'Verificar', empty: 'No hay importaciones en verificación.' },
  confirmacion: { label: 'Confirmación', empty: 'No hay importaciones en confirmación.' },
  en_camino: { label: 'En camino', empty: 'No hay importaciones en camino.' },
  importada: { label: 'Importadas', empty: 'No hay importaciones importadas.' },
}

const IMP_HOVER_WIDTH = 560
const IMP_HOVER_MARGIN = 12
const IMP_HOVER_MAX_HEIGHT = 520

const STATUS_BADGE = {
  borrador: { label: 'Sugerencia', color: '#64748b', bg: 'rgba(100,116,139,0.1)' },
  cotizacion: { label: 'Verificar', color: '#92640c', bg: 'rgba(234,179,8,0.22)' },
  confirmacion: { label: 'Confirmación', color: '#6d28d9', bg: 'rgba(109,40,217,0.12)' },
  en_camino: { label: 'En camino', color: '#d97706', bg: 'rgba(217,119,6,0.1)' },
  importada: { label: 'Importada', color: '#16a34a', bg: 'rgba(22,163,74,0.1)' },
}

const parseApiList = (payload) => (Array.isArray(payload) ? payload : payload?.results || [])

const serializeDetailsForDirty = (detailsList) =>
  JSON.stringify(
    [...(detailsList || [])].sort((a, b) => String(a._key).localeCompare(String(b._key))).map((d) => [
      d._key,
      d.cantidad || '',
      d.comentario || '',
      d.precio_estimado || '',
      d.cantidad_aproximada || '',
      d.precio_confirmado || '',
      d.cantidad_confirmada || '',
    ])
  )

const serializeCheckStatesForDirty = (states) =>
  JSON.stringify(
    Object.entries(states || {})
      .filter(([, v]) => v === 'check' || v === 'x')
      .sort(([a], [b]) => a.localeCompare(b))
  )

const normId = (value) => (value == null ? null : String(value))
const isCheckboxSelection = (event) => {
  const type = event?.type
  if (type === 'checkbox' || type === 'all') return true
  const target = event?.originalEvent?.target
  if (!target) return true
  if (target.type === 'checkbox') return true
  return Boolean(
    target.closest?.('.p-checkbox, .p-checkbox-box, .p-checkbox-icon, .p-checkbox-input, .row-selection-column')
  )
}

const todayISO = () => {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const addOneDayISO = (isoDate) => {
  const [year, month, day] = String(isoDate).split('-').map(Number)
  const date = new Date(year, (month || 1) - 1, day || 1)
  date.setDate(date.getDate() + 1)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// Fecha de llegada por defecto: hoy, salvo que sea anterior a la fecha en que
// llegó a puerto (paso previo del tracker) — en ese caso se usa el día
// siguiente a esa llegada a puerto, ya que la mercadería no puede llegar a
// bodega el mismo día o antes de haber llegado al puerto.
const getDefaultFechaLlegada = (imp) => {
  const minDate = getTrackerMinDate(imp, 'fecha_llegada')
  const today = todayISO()
  if (minDate && today < minDate) return addOneDayISO(minDate)
  return today
}

const readErrorMessage = async (response, fallback) => {
  const payload = await response.json().catch(() => null)
  const visit = (value) => {
    if (!value) return ''
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.map(visit).find(Boolean) || ''
    if (typeof value === 'object') return Object.values(value).map(visit).find(Boolean) || ''
    return ''
  }
  return visit(payload?.detail) || visit(payload) || fallback
}

const getFlagUrl = (code) => {
  if (!code) return ''
  const clean = String(code).trim().toLowerCase()
  if (clean.length !== 2) return ''
  return `https://flagsapi.com/${clean.toUpperCase()}/flat/64.png`
}

const formatCasaLabel = (casa) => {
  if (!casa) return ''
  const codigo = String(casa?.codigo || '').trim()
  const nombre = String(casa?.nombre || '').trim()
  return [codigo, nombre].filter(Boolean).join(' - ')
}

// Seguimiento de una importación "en camino": Creación y Llegó son informativos
// (se fijan solos), Salida y Puerto se editan haciendo clic en su paso.
const IMPORT_TRACKER_STEPS = [
  { field: 'creado_en', label: 'Creación de sugerencia', editable: false, isDateTime: true },
  { field: 'fecha_importacion', label: 'Salida del proveedor', editable: true },
  { field: 'fecha_puerto', label: 'Llegada a puerto', editable: true },
  { field: 'fecha_llegada', label: 'Llegó', editable: false },
]

// Fecha del paso anterior del seguimiento con valor cargado (saltando pasos vacíos),
// para no permitir que un paso quede con una fecha menor a la del paso previo.
const getTrackerMinDate = (imp, field) => {
  const idx = IMPORT_TRACKER_STEPS.findIndex((s) => s.field === field)
  for (let i = idx - 1; i >= 0; i--) {
    const raw = imp?.[IMPORT_TRACKER_STEPS[i].field]
    if (raw) return String(raw).slice(0, 10)
  }
  return null
}

const formatProductLabel = (product) => {
  if (!product) return ''
  const codigo = String(product?.codigo || '').trim()
  const nombre = String(product?.nombre || '').trim()
  const referencia = String(product?.referencia || '').trim()
  return [codigo, nombre, referencia ? `Ref. ${referencia}` : ''].filter(Boolean).join(' - ')
}

const MIN_WIDTH = 700
// Ancho con el que abre una sugerencia (guardada y Paso 3).
const SUGERENCIA_MODAL_WIDTH = 1080
const MIN_HEIGHT = 520
const SELECTOR_WIDTH = 520
const SELECTOR_HEIGHT_EMPTY = 'auto'
const SELECTOR_HEIGHT_FULL = 'auto'
const VIEWPORT_PADDING = 12

// Mientras se lee un Excel subido se cubre el modal con el spinner (igual que
// al cargar datos). Se muestra al menos un instante para que no parpadee.
const MIN_EXCEL_LOADING_MS = 500
const withExcelLoading = async (setLoading, task) => {
  setLoading(true)
  const start = Date.now()
  try {
    return await task()
  } finally {
    const left = MIN_EXCEL_LOADING_MS - (Date.now() - start)
    if (left > 0) await new Promise((resolve) => setTimeout(resolve, left))
    setLoading(false)
  }
}

function ExcelLoadingOverlay() {
  return (
    <div className="spinner-container spinner-container--table imp-excel-loading" role="status" aria-live="polite">
      <div className="imp-excel-loading__content">
        <div className="spinner" />
        <span>Cargando Excel...</span>
      </div>
    </div>
  )
}
const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

// Vacío del buscador de casas comerciales (solo se buscan las de tipo Importación).
function CasaImportacionEmpty({ query }) {
  const q = (query || '').trim()
  return q ? (
    <BlockerNotice
      compact
      title={`No hay casas comerciales de tipo Importación que coincidan con "${q}".`}
      reason="Si el proveedor existe como Local, cámbiale el tipo en Casas comerciales."
      goTo="Proveedores"
    />
  ) : (
    <BlockerNotice
      compact
      title="No hay casas comerciales de importación registradas."
      reason="Créala en Casas comerciales con tipo Importación."
      goTo="Proveedores"
    />
  )
}

function ImportacionReceiveModal({ imp, token, onClose, onConfirmed }) {
  const isDark = Boolean(document.querySelector('.dashboard-shell')?.classList.contains('dark'))
  const mode = isDark ? 'dark' : 'light'
  const toastRef = useRef(null)
  const [isMaximized, setIsMaximized] = useState(false)

  const [showReceiveExcelDropdown, setShowReceiveExcelDropdown] = useState(false)
  const [uploadingExcel, setUploadingExcel] = useState(false)
  const receiveExcelDropdownRef = useRef(null)
  const receiveFileInputRef = useRef(null)
  useEffect(() => {
    if (!showReceiveExcelDropdown) return
    const handle = (e) => { if (!receiveExcelDropdownRef.current?.contains(e.target)) setShowReceiveExcelDropdown(false) }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [showReceiveExcelDropdown])

  const [cellHover, setCellHover] = useState(null)
  const cellHoverTimerRef = useRef(null)
  const showCellHover = useCallback((event, items, label) => {
    const list = (Array.isArray(items) ? items : [items]).filter(Boolean)
    if (!list.length) return
    if (cellHoverTimerRef.current) clearTimeout(cellHoverTimerRef.current)
    const rect = event.currentTarget.getBoundingClientRect()
    cellHoverTimerRef.current = setTimeout(() => {
      cellHoverTimerRef.current = null
      setCellHover({ top: rect.bottom + 4, left: rect.left, items: list, label })
    }, 400)
  }, [])
  const hideCellHover = useCallback(() => {
    if (cellHoverTimerRef.current) { clearTimeout(cellHoverTimerRef.current); cellHoverTimerRef.current = null }
    setCellHover(null)
  }, [])

  // Popover de stock por sucursal para un producto y sus alternos (Paso 3, icono "i").
  // Se posiciona como un dropdown inteligente: abre hacia abajo salvo que no quepa,
  // en cuyo caso se voltea hacia arriba del ícono.
  const [alternosHover, setAlternosHover] = useState(null)
  const [alternosHoverPos, setAlternosHoverPos] = useState(null)
  const alternosHoverCardRef = useRef(null)
  const alternosHoverTimerRef = useRef(null)
  const alternosCacheRef = useRef({})
  const showAlternosHover = useCallback((event, productoId) => {
    if (!productoId) return
    if (alternosHoverTimerRef.current) clearTimeout(alternosHoverTimerRef.current)
    const rect = event.currentTarget.getBoundingClientRect()
    const trigger = { triggerTop: rect.top, triggerBottom: rect.bottom, triggerLeft: rect.left }
    alternosHoverTimerRef.current = setTimeout(async () => {
      alternosHoverTimerRef.current = null
      if (alternosCacheRef.current[productoId]) {
        setAlternosHover({ ...trigger, data: alternosCacheRef.current[productoId] })
        return
      }
      setAlternosHover({ ...trigger, data: 'loading' })
      try {
        const resp = await authFetch(`${API_URL}/productos/listado/${productoId}/stock-alternos/`, {}, token)
        const data = resp.ok ? await resp.json() : null
        alternosCacheRef.current[productoId] = data
        setAlternosHover(prev => (prev ? { ...prev, data } : prev))
      } catch {
        setAlternosHover(prev => (prev ? { ...prev, data: null } : prev))
      }
    }, 300)
  }, [token])
  const hideAlternosHover = useCallback(() => {
    if (alternosHoverTimerRef.current) { clearTimeout(alternosHoverTimerRef.current); alternosHoverTimerRef.current = null }
    setAlternosHover(null)
    setAlternosHoverPos(null)
  }, [])

  useLayoutEffect(() => {
    if (!alternosHover || !alternosHoverCardRef.current) return
    setAlternosHoverPos(computeSmartPopoverPosition(alternosHover, alternosHoverCardRef.current))
  }, [alternosHover])

  // Popover de "qué se envía a esta sucursal" (Paso 4, icono "i" junto al nombre).
  const [envioItemsHover, setEnvioItemsHover] = useState(null)
  const [envioItemsHoverPos, setEnvioItemsHoverPos] = useState(null)
  const envioItemsHoverCardRef = useRef(null)
  const envioItemsHoverTimerRef = useRef(null)
  const showEnvioItemsHover = useCallback((event, suc) => {
    if (envioItemsHoverTimerRef.current) clearTimeout(envioItemsHoverTimerRef.current)
    const rect = event.currentTarget.getBoundingClientRect()
    const trigger = { triggerTop: rect.top, triggerBottom: rect.bottom, triggerLeft: rect.left }
    envioItemsHoverTimerRef.current = setTimeout(() => {
      envioItemsHoverTimerRef.current = null
      setEnvioItemsHover({ ...trigger, items: suc.items, sucursalNombre: suc.nombre })
    }, 250)
  }, [])
  const hideEnvioItemsHover = useCallback(() => {
    if (envioItemsHoverTimerRef.current) { clearTimeout(envioItemsHoverTimerRef.current); envioItemsHoverTimerRef.current = null }
    setEnvioItemsHover(null)
    setEnvioItemsHoverPos(null)
  }, [])

  useLayoutEffect(() => {
    if (!envioItemsHover || !envioItemsHoverCardRef.current) return
    setEnvioItemsHoverPos(computeSmartPopoverPosition(envioItemsHover, envioItemsHoverCardRef.current))
  }, [envioItemsHover])

  useCloseDropdownsOnTabSwitch(
    useCallback(() => {
      setShowReceiveExcelDropdown(false)
      hideCellHover()
      hideAlternosHover()
      hideEnvioItemsHover()
    }, [hideCellHover, hideAlternosHover, hideEnvioItemsHover])
  )

  const storageKey = `imp-receive-${imp.id}`
  // IDs de ítems que eran sinCat al abrir el modal (fijo, no cambia con el fetch fresco)
  const [originalSinCatIds] = useState(() =>
    new Set((imp.detalles || []).filter(d => !d.producto?.id).map(d => d.id))
  )

  const [rows, setRows] = useState(() => {
    const saved = getSavedDraft(imp)
    const checkedIds = new Set(saved?.checkedIds || [])
    const cantidadesRecibidas = saved?.cantidadesRecibidas || {}
    return (imp.detalles || []).map(d => ({
      id: d.id,
      orden: d.orden,
      productoId: d.producto?.id ?? null,
      codigo: d.producto?.codigo || d.codigo || '',
      nombre: d.producto?.nombre || d.nombre || '',
      oem: getProductoOem(d.producto) || d.oem || '',
      referencia: d.producto?.referencia || d.referencia || '',
      precio: d.precio_confirmado ?? d.precio_estimado ?? d.producto?.precio ?? null,
      cantidad: d.cantidad,
      cantidadRecibida: cantidadesRecibidas[d.id] ?? '',
      sinCat: !d.producto?.id,
      creadoAqui: Boolean(d.producto?.id) && d.producto?.creado_desde_importacion === imp.id,
      checked: checkedIds.has(d.id),
      newProducto: null,
    }))
  })
  const [filter, setFilter] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [showErrors, setShowErrors] = useState(false)

  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState({ codigo: '', nombre: '', precio: '', referencia: '', oem: '', descripcion: '' })
  const [formErrors, setFormErrors] = useState({})
  const [formSaving, setFormSaving] = useState(false)
  const [isKit, setIsKit] = useState(false)
  const [kitForms, setKitForms] = useState([])
  const [kitFormErrors, setKitFormErrors] = useState([])
  const [loadingData, setLoadingData] = useState(true)
  const [step, setStep] = useState(() => getSavedDraft(imp)?.step || 1)
  const [fechaLlegada, setFechaLlegada] = useState(() => getSavedDraft(imp)?.fechaLlegada || getDefaultFechaLlegada(imp))
  const [sucursales, setSucursales] = useState([])
  const [loadingSucursales, setLoadingSucursales] = useState(false)
  const [sucursalesError, setSucursalesError] = useState(false)
  const [distribution, setDistribution] = useState(() => getSavedDraft(imp)?.distribution || {})
  const [allUsers, setAllUsers] = useState([])
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [usersError, setUsersError] = useState(false)
  const [recipientsBySucursal, setRecipientsBySucursal] = useState(() => getSavedDraft(imp)?.recipientsBySucursal || {})

  // Fetch fresh importacion data on mount so already-linked products, and the latest
  // saved progress (borrador_llegada), are reflected even if the `imp` prop was stale.
  useEffect(() => {
    authFetch(`${API_URL}/importaciones/importaciones/${imp.id}/`, {}, token)
      .then(r => r.ok ? r.json() : null)
      .then(async fresh => {
        if (!fresh?.detalles) return
        const saved = getSavedDraft(fresh)
        const checkedIds = new Set(saved?.checkedIds || [])
        const cantidadesRecibidas = saved?.cantidadesRecibidas || {}
        const freshRows = fresh.detalles.map(d => ({
          id: d.id,
          orden: d.orden,
          productoId: d.producto?.id ?? null,
          codigo: d.producto?.codigo || d.codigo || '',
          nombre: d.producto?.nombre || d.nombre || '',
          oem: getProductoOem(d.producto) || d.oem || '',
          referencia: d.producto?.referencia || d.referencia || '',
          precio: d.precio_confirmado ?? d.precio_estimado ?? d.producto?.precio ?? null,
          cantidad: d.cantidad,
          cantidadRecibida: cantidadesRecibidas[d.id] ?? '',
          sinCat: !d.producto?.id,
          creadoAqui: Boolean(d.producto?.id) && d.producto?.creado_desde_importacion === fresh.id,
          checked: checkedIds.has(d.id),
          newProducto: null,
        }))
        setRows(freshRows)
        const restoredStep = saved?.step || 1
        setStep(restoredStep)
        if (saved?.fechaLlegada) setFechaLlegada(saved.fechaLlegada)
        if (saved?.recipientsBySucursal) setRecipientsBySucursal(saved.recipientsBySucursal)

        // Los pasos previos quedaron guardados sin normalizar sucursales/distribución
        // todavía (eso solo pasa al llegar al paso 4); si el borrador ya venía en
        // paso 4+, cárgalas aquí para que ese paso no se quede vacío al reabrir el modal.
        if (restoredStep >= 4) {
          setLoadingSucursales(true)
          setSucursalesError(false)
          try {
            const resp = await authFetch(`${API_URL}/inventario/sucursales/?modulo=movimientos_entradas`, {}, token)
            if (!resp.ok) throw new Error('sucursales')
            const data = await resp.json()
            const list = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : []
            setSucursales(list)
            const matriz = findMatrizSucursal(list)
            const nextDistribution = {}
            freshRows.forEach(row => {
              nextDistribution[row.id] = {}
              list.forEach(suc => { nextDistribution[row.id][suc.id] = saved?.distribution?.[row.id]?.[suc.id] ?? '' })
              if (matriz) {
                const ceiling = getCantidadRecibidaCeiling(row)
                const othersSum = list
                  .filter(suc => suc.id !== matriz.id)
                  .reduce((sum, suc) => sum + (parseInt(nextDistribution[row.id][suc.id]) || 0), 0)
                nextDistribution[row.id][matriz.id] = String(Math.max(0, ceiling - othersSum))
              }
            })
            setDistribution(nextDistribution)
          } catch {
            setSucursales([])
            setSucursalesError(true)
          } finally {
            setLoadingSucursales(false)
          }
        }
        if (restoredStep === 5) {
          await enterStep5()
        }
      })
      .catch(() => {})
      .finally(() => setLoadingData(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Reparte la cantidad recibida entre las sucursales: la matriz parte con el
  // total y absorbe lo que sobre a medida que se asigna a las demás.
  const seedDistribution = (list, prev) => {
    const matriz = findMatrizSucursal(list)
    const next = {}
    rows.forEach(row => {
      next[row.id] = {}
      list.forEach(suc => { next[row.id][suc.id] = prev[row.id]?.[suc.id] ?? '' })
      if (matriz) {
        const ceiling = getCantidadRecibidaCeiling(row)
        const othersSum = list
          .filter(suc => suc.id !== matriz.id)
          .reduce((sum, suc) => sum + (parseInt(next[row.id][suc.id]) || 0), 0)
        next[row.id][matriz.id] = String(Math.max(0, ceiling - othersSum))
      }
    })
    return next
  }

  // Nota: la carga de sucursales/usuarios al restaurar el modal en paso 3+/4 ya la
  // resuelve el efecto de "fetch fresh importacion data" de arriba (usa el borrador
  // recién llegado del servidor en vez del step inicial, que podría estar desactualizado).

  // Guardado automatico en el servidor con cada cambio (antes solo al cerrar el
  // modal, y mientras tanto el avance vivia unicamente en este navegador). Se
  // espera a que termine la carga inicial para no pisar el borrador del
  // servidor con datos viejos del listado.
  const draftAutosaveTimerRef = useRef(null)
  const draftAutosavePendingRef = useRef(null)
  useEffect(() => {
    if (loadingData || submitting) return undefined
    const run = ({ keepalive = false } = {}) => {
      draftAutosavePendingRef.current = null
      void saveDraftToServer(undefined, { keepalive })
    }
    draftAutosavePendingRef.current = run
    draftAutosaveTimerRef.current = setTimeout(run, 1500)
    return () => clearTimeout(draftAutosaveTimerRef.current)
  }, [rows, step, fechaLlegada, distribution, recipientsBySucursal, loadingData, submitting]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cerrar la pestana o mandar la app al fondo con un guardado pendiente: se
  // manda de inmediato.
  useEffect(() => {
    const flush = () => {
      const pending = draftAutosavePendingRef.current
      if (!pending) return
      clearTimeout(draftAutosaveTimerRef.current)
      pending({ keepalive: true })
    }
    const handleVisibility = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])

  const toggleRow = useCallback((id) => {
    setRows(prev => prev.map(r => r.id === id ? { ...r, checked: !r.checked } : r))
  }, [])
  const updateCantidadRecibida = useCallback((id, value) => {
    const sanitized = value.replace(/[^0-9]/g, '')
    setRows(prev => prev.map(r => r.id === id ? { ...r, cantidadRecibida: sanitized } : r))
  }, [])
  const toggleAll = useCallback((checked) => {
    setRows(prev => prev.map(r => ({ ...r, checked })))
  }, [])

  const handleDownloadReceiveExcel = async () => {
    try {
      const XLSXStyle = (await import('xlsx-js-style')).default
      const bt = { style: 'thin', color: { rgb: 'D1D5DB' } }
      const border = { top: bt, bottom: bt, left: bt, right: bt }
      const RO = 6 // columnas de solo lectura antes de Cant. Recibida
      const headers = ['Código', 'Descripción', 'Referencia', 'OEM', 'Precio', 'Cant. Esperada', 'Cant. Recibida', 'Revisado', '_key']
      const mkH = (fill, bot) => ({ font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 10 }, fill: { fgColor: { rgb: fill }, patternType: 'solid' }, alignment: { horizontal: 'center', vertical: 'center' }, border: { top: bt, bottom: { style: 'medium', color: { rgb: bot } }, left: bt, right: bt } })
      const hdrS = headers.map((_, ci) => ci < RO ? mkH('1e3a5f', '2563EB') : ci < RO + 2 ? mkH('15803d', '166534') : { font: { sz: 8, color: { rgb: 'AAAAAA' } } })

      // Mismo orden que en la importacion (row.orden); al subir el Excel cada
      // fila se empareja por _key, asi que reordenarlo no afecta.
      const sortedRows = [...rows].sort((a, b) => (Number(a.orden) || 0) - (Number(b.orden) || 0))
      const dataRows = sortedRows.map((row) => {
        const precio = row.precio != null ? +Number(row.precio).toFixed(2) : null
        const cantRecibida = row.cantidadRecibida !== '' ? +Number(row.cantidadRecibida) : null
        return [row.codigo || '', row.nombre || '', row.referencia || '', row.oem || '', precio, +Number(row.cantidad || 0), cantRecibida, row.checked ? 'SI' : 'NO', row.id]
      })

      const NROWS = dataRows.length; const NCOLS = headers.length
      const worksheet = { '!ref': XLSXStyle.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: NROWS, c: NCOLS - 1 } }) }
      const setCell = (r, c, val, s) => {
        const ref = XLSXStyle.utils.encode_cell({ r, c })
        if (val == null) { worksheet[ref] = { t: 's', v: '', s }; return }
        if (typeof val === 'number') { worksheet[ref] = { t: 'n', v: val, s }; return }
        worksheet[ref] = { t: 's', v: String(val), s }
      }

      headers.forEach((h, ci) => setCell(0, ci, h, hdrS[ci]))

      dataRows.forEach((row, ri) => {
        const isEven = (ri + 1) % 2 === 0
        row.forEach((val, ci) => {
          const isEditable = ci === RO || ci === RO + 1
          const bg = isEditable ? (isEven ? 'FFFFFF' : 'F9FAFB') : (isEven ? 'EFF6FF' : 'FFFFFF')
          const numFmt = ci === 4 ? '0.00' : ci === 5 || ci === RO ? '0' : null
          const s = { fill: { fgColor: { rgb: bg }, patternType: 'solid' }, alignment: { vertical: 'center' }, border, ...(numFmt ? { numFmt } : {}) }
          setCell(ri + 1, ci, val, s)
        })
      })

      worksheet['!cols'] = [{ wch: 14 }, { wch: 32 }, { wch: 16 }, { wch: 14 }, { wch: 10 }, { wch: 13 }, { wch: 13 }, { wch: 10 }, { wch: 0, hidden: true }]
      worksheet['!rows'] = [{ hpt: 22 }]
      const workbook = XLSXStyle.utils.book_new()
      XLSXStyle.utils.book_append_sheet(workbook, worksheet, 'Revisión')
      const rawOut = XLSXStyle.write(workbook, { bookType: 'xlsx', type: 'array' })

      // Inyecta formato condicional nativo de Excel: así la celda se repinta sola
      // en blanco al escribir un valor, sin necesidad de volver a descargar el archivo.
      const unzipped = unzipSync(new Uint8Array(rawOut))
      const dec = new TextDecoder(); const enc = new TextEncoder()

      let stylesXml = dec.decode(unzipped['xl/styles.xml'])
      stylesXml = stylesXml.replace(/<dxfs[^>]*\/>/,
        '<dxfs count="1"><dxf><fill><patternFill><bgColor rgb="FFfef9c3"/></patternFill></fill></dxf></dxfs>')
      unzipped['xl/styles.xml'] = enc.encode(stylesXml)

      const gCol = XLSXStyle.utils.encode_col(RO)       // G - Cant. Recibida
      const hCol = XLSXStyle.utils.encode_col(RO + 1)   // H - Revisado
      const last = NROWS + 1
      const cfXml =
        `<conditionalFormatting sqref="${gCol}2:${gCol}${last}">` +
        `<cfRule type="cellIs" dxfId="0" priority="1" operator="equal"><formula>""</formula></cfRule>` +
        `</conditionalFormatting>` +
        `<conditionalFormatting sqref="${hCol}2:${hCol}${last}">` +
        `<cfRule type="cellIs" dxfId="0" priority="1" operator="notEqual"><formula>"SI"</formula></cfRule>` +
        `</conditionalFormatting>`

      let sheetXml = dec.decode(unzipped['xl/worksheets/sheet1.xml'])
      sheetXml = sheetXml.includes('<ignoredErrors')
        ? sheetXml.replace('<ignoredErrors', cfXml + '<ignoredErrors')
        : sheetXml.replace('</worksheet>', cfXml + '</worksheet>')
      unzipped['xl/worksheets/sheet1.xml'] = enc.encode(sheetXml)

      const zippable = {}
      for (const [zpath, data] of Object.entries(unzipped)) {
        if (!zpath.endsWith('/')) zippable[zpath] = [data, { level: 0 }]
      }
      const finalOut = zipSync(zippable)
      const blob = new Blob([finalOut], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `revision-llegada-${imp?.codigo || imp?.id}.xlsx`
      document.body.appendChild(link); link.click(); document.body.removeChild(link)
      URL.revokeObjectURL(link.href)
    } catch (e) {
      console.error(e)
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'No se pudo generar el Excel.', life: 3500 })
    }
  }

  const handleUploadReceiveExcel = async (file) => {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'El archivo debe ser .xlsx', life: 3500 })
      return
    }
    try {
      const xlsxMod = await import('xlsx')
      const xlsx = xlsxMod?.default ?? xlsxMod
      const buffer = await file.arrayBuffer()
      const workbook = xlsx.read(buffer, { type: 'array' })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' })
      if (rawRows.length < 2) {
        toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'El archivo no contiene datos.', life: 3500 })
        return
      }
      const fileHeaders = rawRows[0].map(h => String(h || '').trim())
      const keyIdx = fileHeaders.indexOf('_key')
      const cantIdx = fileHeaders.indexOf('Cant. Recibida')
      const revisadoIdx = fileHeaders.indexOf('Revisado')
      if (keyIdx === -1 || cantIdx === -1) {
        toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'El archivo no corresponde a esta revisión. Descárgalo desde este modal.', life: 4500 })
        return
      }
      const dataRows = rawRows.slice(1).filter(row => row.some(c => c !== ''))
      const keyToRow = {}
      dataRows.forEach(row => {
        const k = String(row[keyIdx] || '').trim()
        if (k) keyToRow[k] = row
      })
      const missing = rows.filter(row => !keyToRow[String(row.id)])
      if (missing.length > 0) {
        toastRef.current?.show({ severity: 'error', summary: 'Error', detail: `El Excel no corresponde: faltan ${missing.length} producto(s). Descarga de nuevo desde este modal.`, life: 4500 })
        return
      }
      const updatedRows = rows.map(row => {
        const fileRow = keyToRow[String(row.id)]
        if (!fileRow) return row
        let cantidadRecibida = row.cantidadRecibida
        const rawCant = fileRow[cantIdx]
        if (rawCant !== '' && rawCant != null) {
          cantidadRecibida = String(rawCant).replace(/[^0-9]/g, '')
        }
        let checked = row.checked
        if (revisadoIdx !== -1) {
          const rawRevisado = String(fileRow[revisadoIdx] || '').trim().toLowerCase()
          if (rawRevisado !== '') checked = ['si', 'sí', 'yes', 'true', '1', 'x'].includes(rawRevisado)
        }
        return { ...row, cantidadRecibida, checked }
      })
      setRows(updatedRows)
      await saveDraftToServer(updatedRows)
      toastRef.current?.show({ severity: 'success', summary: 'Datos cargados', detail: 'Tabla actualizada desde Excel y guardada.', life: 4000 })
    } catch (e) {
      console.error(e)
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'No se pudo leer el Excel.', life: 3500 })
    }
  }

  // Lo que coincide va primero; el resto sigue visible debajo.
  const rowMatchCount = useMemo(
    () => (filter.trim() ? rows.filter((r) => importItemMatches(r, filter)).length : rows.length),
    [rows, filter]
  )
  const filteredRows = useMemo(
    () => (filter.trim() ? matchesFirst(rows, (r) => importItemMatches(r, filter)) : rows),
    [rows, filter]
  )

  const checkedCount = rows.filter(r => r.checked).length
  const allChecked = checkedCount === rows.length && rows.length > 0
  const someChecked = checkedCount > 0 && checkedCount < rows.length
  const sinCatRows = rows.filter(r => r.sinCat)
  const sinCatFilled = sinCatRows.filter(r => r.newProducto !== null).length
  const canConfirm = allChecked && sinCatFilled === sinCatRows.length
  // Todos los ítems que originalmente no tenían producto (incluye los ya vinculados en sesiones anteriores)
  const step1Rows = rows.filter(r => originalSinCatIds.has(r.id))
  const step1Pending = step1Rows.filter(r => r.sinCat && !r.newProducto)
  const canGoNext = step1Pending.length === 0
  const fechaLlegadaMinDate = getTrackerMinDate(imp, 'fecha_llegada')
  const fechaLlegadaValid = !fechaLlegadaMinDate || fechaLlegada >= fechaLlegadaMinDate
  const canFinish = !loadingSucursales && sucursales.length > 0 && rows.every(row => {
    const assigned = Object.values(distribution[row.id] || {}).reduce((s, v) => s + (parseInt(v) || 0), 0)
    return assigned === getCantidadRecibidaCeiling(row)
  })

  const sucursalesWithDistribution = useMemo(() =>
    sucursales
      .map(suc => ({
        ...suc,
        items: rows
          .filter(row => parseInt(distribution[row.id]?.[suc.id]) > 0)
          .map(row => ({ ...row, qty: parseInt(distribution[row.id][suc.id]) })),
      }))
      .filter(suc => suc.items.length > 0),
    [sucursales, rows, distribution]
  )

  const canConfirmStep4 = useMemo(() =>
    sucursalesWithDistribution.length > 0 &&
    sucursalesWithDistribution.every(suc => (recipientsBySucursal[suc.id] || []).length > 0),
    [sucursalesWithDistribution, recipientsBySucursal]
  )

  const getUsersForSucursal = (sucId) => allUsers.filter(u => {
    if (u.es_admin) return false
    if (!u.puede_entradas) return false
    return u.entradas_sucursales_ids.includes(sucId) || u.sucursales_ids.includes(sucId)
  })

  const confirmBlockReason = (() => {
    if (step !== 5 || loadingUsers || canConfirmStep4) return ''
    if (usersError) return 'No se puede confirmar: no se cargaron los usuarios destinatarios.'
    if (!sucursalesWithDistribution.length) return 'No se puede confirmar: no hay productos asignados a ninguna sucursal. Vuelve al paso 4.'
    const sinUsuarios = sucursalesWithDistribution.filter(suc => getUsersForSucursal(suc.id).length === 0)
    if (sinUsuarios.length) {
      const names = sinUsuarios.map(suc => suc.nombre).join(', ')
      return `No se puede confirmar: ${names} ${sinUsuarios.length === 1 ? 'no tiene' : 'no tienen'} destinatarios (ver el aviso de arriba).`
    }
    const sinSeleccion = sucursalesWithDistribution.filter(suc => !(recipientsBySucursal[suc.id] || []).length)
    return `Para confirmar, escoge al menos un destinatario para: ${sinSeleccion.map(suc => suc.nombre).join(', ')}.`
  })()

  const makeKitItemKey = () => `kit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  const openProductForm = (row) => {
    setEditingId(row.id)
    setForm({
      codigo: toUpperCode(row.codigo || ''),
      nombre: row.nombre || '',
      precio: row.precio != null ? String(row.precio) : '',
      referencia: row.referencia || '',
      oem: row.oem || '',
      descripcion: '',
    })
    setIsKit(false)
    setKitForms([])
    setKitFormErrors([])
    setFormErrors({})
    Object.values(dupCheckTimersRef.current).forEach(clearTimeout)
    dupCheckTimersRef.current = {}
    setDupStatus({})
    setShowLinkExistingConfirm(false)
  }

  const emptyKitItem = () => ({ _key: makeKitItemKey(), codigo: '', nombre: '', precio: '', referencia: '', oem: '', descripcion: '' })

  // "Es Kit": lo que llegó como 1 ítem en realidad son varios productos distintos
  // (cada uno con su propio código), así que se crean todos por separado.
  const toggleKit = () => {
    setIsKit(prev => {
      const next = !prev
      if (next) setKitForms(kf => (kf.length >= 2 ? kf : [{ ...form, _key: makeKitItemKey() }, emptyKitItem()]))
      return next
    })
    setFormErrors({})
    setKitFormErrors([])
  }

  const addKitRow = () => setKitForms(prev => [...prev, emptyKitItem()])
  const removeKitRow = (idx) => setKitForms(prev => {
    if (prev.length <= 2) return prev
    const removed = prev[idx]
    if (removed) {
      const keys = [`kit-${removed._key}-codigo`, `kit-${removed._key}-referencia`]
      keys.forEach(k => { if (dupCheckTimersRef.current[k]) { clearTimeout(dupCheckTimersRef.current[k]); delete dupCheckTimersRef.current[k] } })
      setDupStatus(ds => { const next = { ...ds }; keys.forEach(k => delete next[k]); return next })
    }
    return prev.filter((_, i) => i !== idx)
  })
  const updateKitForm = (idx, field, value) => setKitForms(prev => prev.map((item, i) => (i === idx ? { ...item, [field]: value } : item)))

  // Valida en vivo que el código/referencia no estén ya en uso: por otro producto
  // del catálogo, o por otra fila del mismo kit.
  const [dupStatus, setDupStatus] = useState({})
  const dupCheckTimersRef = useRef({})
  const dupCheckSeqRef = useRef({})
  const [showLinkExistingConfirm, setShowLinkExistingConfirm] = useState(false)

  const scheduleDupCheck = useCallback((key, field, value, siblingValues = []) => {
    if (dupCheckTimersRef.current[key]) clearTimeout(dupCheckTimersRef.current[key])
    const term = String(value ?? '').trim()
    const fieldLabel = field === 'codigo' ? 'código' : 'referencia'
    if (!term) {
      setDupStatus(prev => ({ ...prev, [key]: { checking: false, error: '', checked: false } }))
      return
    }
    const dupInKit = siblingValues.some(v => String(v ?? '').trim().toLowerCase() === term.toLowerCase())
    if (dupInKit) {
      setDupStatus(prev => ({ ...prev, [key]: { checking: false, error: `Este ${fieldLabel} se repite en el kit.`, checked: true } }))
      return
    }
    if (!token) { setDupStatus(prev => ({ ...prev, [key]: { checking: false, error: '', checked: false } })); return }
    const seq = (dupCheckSeqRef.current[key] = (dupCheckSeqRef.current[key] || 0) + 1)
    setDupStatus(prev => ({ ...prev, [key]: { checking: true, error: '', checked: false } }))
    dupCheckTimersRef.current[key] = setTimeout(async () => {
      try {
        const resp = await authFetch(`${API_URL}/productos/listado/?search=${encodeURIComponent(term)}&page_size=25`, {}, token)
        if (dupCheckSeqRef.current[key] !== seq) return
        if (!resp.ok) { setDupStatus(prev => ({ ...prev, [key]: { checking: false, error: '', checked: false } })); return }
        const data = await resp.json()
        const list = Array.isArray(data) ? data : data?.results || []
        const existingProduct = list.find(p => String(p?.[field] ?? '').trim().toLowerCase() === term.toLowerCase()) || null
        setDupStatus(prev => ({
          ...prev,
          [key]: { checking: false, error: existingProduct ? `Este ${fieldLabel} ya existe.` : '', checked: true, existingProduct },
        }))
      } catch {
        if (dupCheckSeqRef.current[key] !== seq) return
        setDupStatus(prev => ({ ...prev, [key]: { checking: false, error: '', checked: false } }))
      }
    }, 350)
  }, [token])

  const renderDupIcon = (status, fieldLabel) => {
    if (status?.checking) {
      return (
        <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', display: 'inline-flex', color: 'var(--color-text-secondary, #64748b)', pointerEvents: 'none' }}>
          <svg style={{ animation: 'spin 0.8s linear infinite', width: 16, height: 16 }} viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.2" />
            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        </span>
      )
    }
    if (!status?.checked) return null
    const isError = Boolean(status.error)
    return (
      <span
        onMouseEnter={(e) => showCellHover(e, [status.error || 'Disponible'], fieldLabel)}
        onMouseLeave={hideCellHover}
        style={{
          position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
          display: 'inline-flex', color: isError ? '#dc2626' : '#16a34a', cursor: 'default', pointerEvents: 'auto',
        }}
      >
        {isError ? <X size={16} /> : <Check size={16} />}
      </span>
    )
  }

  // Enlaza un único código OEM al producto recién creado. Si ese código ya
  // pertenece a otro producto del catálogo, en vez de solo copiar el código
  // se crea la relación de "alterno" con ese producto: el backend
  // (ProductoAlternoViewSet.perform_create) propaga automáticamente TODOS
  // los códigos OEM de ese conglomerado a ambos productos, no solo el que se
  // buscó — por eso no hace falta enlazar el OEM manualmente en ese caso.
  const linkOemToProduct = async (productId, oemText) => {
    const codigo = String(oemText || '').trim()
    if (!codigo) return
    try {
      const matchResp = await authFetch(`${API_URL}/productos/listado/?search=${encodeURIComponent(codigo)}&page_size=20`, {}, token)
      if (matchResp.ok) {
        const matchData = await matchResp.json()
        const matchList = Array.isArray(matchData) ? matchData : matchData?.results || []
        const matched = matchList.find((p) =>
          p.id !== productId &&
          (p.oem_productos || []).some((r) => String(r?.oem?.codigo || '').trim().toLowerCase() === codigo.toLowerCase())
        )
        if (matched) {
          await authFetch(
            `${API_URL}/productos/alternos/`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ producto_id: productId, alterno_id: matched.id }) },
            token
          )
          return
        }
      }

      let oemId = null
      const searchResp = await authFetch(`${API_URL}/productos/oem/?search=${encodeURIComponent(codigo)}`, {}, token)
      if (searchResp.ok) {
        const searchData = await searchResp.json()
        const results = searchData?.results ?? searchData ?? []
        const existing = Array.isArray(results) && results.find(o => String(o.codigo || '').trim().toLowerCase() === codigo.toLowerCase())
        if (existing) oemId = existing.id
      }
      if (!oemId) {
        const createResp = await authFetch(
          `${API_URL}/productos/oem/`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codigo }) },
          token
        )
        if (createResp.ok) oemId = (await createResp.json()).id
      }
      if (oemId) {
        await authFetch(
          `${API_URL}/productos/oem-producto/`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ producto_id: productId, oem_id: oemId }) },
          token
        )
      }
    } catch {
      // No debe bloquear el guardado del producto si el enlace de OEM falla.
    }
  }

  // Crea el producto en el catálogo, o lo vincula si el código ya existe.
  // Devuelve el producto creado/existente, o null si falló (deja el detalle en formErrors).
  const createOrLinkProduct = async (item, casaId) => {
    try {
      const payload = {
        codigo: toUpperCode(item.codigo).trim(),
        nombre: item.nombre.trim(),
        precio: parseFloat(item.precio),
        referencia: item.referencia.trim(),
        casas_comerciales_ids: [casaId],
      }
      if (item.descripcion.trim()) payload.descripcion = item.descripcion.trim()

      const resp = await authFetch(`${API_URL}/productos/listado/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, token)
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}))
        // Si el código ya existe, buscar el producto y linkarlo en vez de fallar
        const codigoErr = Array.isArray(data?.codigo) ? data.codigo.join(' ') : String(data?.codigo || '')
        if (codigoErr.toLowerCase().includes('ya existe')) {
          const searchResp = await authFetch(`${API_URL}/productos/listado/?search=${encodeURIComponent(item.codigo.trim())}`, {}, token)
          if (searchResp.ok) {
            const searchData = await searchResp.json()
            const results = searchData?.results ?? searchData ?? []
            const existing = Array.isArray(results) && results.find(p => p.codigo?.toLowerCase() === item.codigo.trim().toLowerCase())
            if (existing) return existing
          }
        }
        const fe = {}
        Object.entries(typeof data === 'object' && data !== null ? data : {}).forEach(([k, v]) => {
          fe[k] = Array.isArray(v) ? v.join(' ') : String(v)
        })
        setFormErrors(Object.keys(fe).length ? fe : { _general: 'Error al crear el producto.' })
        return null
      }
      const created = await resp.json()
      if (item.oem.trim()) await linkOemToProduct(created.id, item.oem)
      return { ...created, __wasCreated: true }
    } catch (e) {
      setFormErrors({ _general: e.message || 'Error al crear el producto.' })
      return null
    }
  }

  const saveProductForm = async (confirmedLinkExisting = false) => {
    const items = isKit ? kitForms : [form]

    const errsList = items.map(item => {
      const e = {}
      if (!item.codigo.trim()) e.codigo = 'Requerido'
      if (!item.nombre.trim()) e.nombre = 'Requerido'
      if (!item.precio || isNaN(parseFloat(item.precio))) e.precio = 'Requerido'
      if (!item.referencia.trim()) e.referencia = 'Requerido'
      return e
    })
    if (errsList.some(e => Object.keys(e).length)) {
      if (isKit) setKitFormErrors(errsList)
      else setFormErrors(errsList[0])
      return
    }
    const codigoKeys = isKit ? items.map(item => `kit-${item._key}-codigo`) : ['single-codigo']
    const referenciaKeys = isKit ? items.map(item => `kit-${item._key}-referencia`) : ['single-referencia']
    if ([...codigoKeys, ...referenciaKeys].some(k => dupStatus[k]?.checking)) return
    // La referencia repetida sigue bloqueando el envío. El código repetido ya
    // no bloquea: en vez de fallar, se le pregunta al usuario si quiere
    // vincular esta línea al producto existente (createOrLinkProduct ya sabe
    // buscarlo y usarlo en vez de crear uno nuevo cuando el código ya existe).
    if (referenciaKeys.some(k => dupStatus[k]?.error)) return
    if (codigoKeys.some(k => dupStatus[k]?.error) && !confirmedLinkExisting) {
      setShowLinkExistingConfirm(true)
      return
    }
    setShowLinkExistingConfirm(false)
    const casaId = imp.casa_comercial?.id
    if (!casaId) { setFormErrors({ _general: 'La importación no tiene casa comercial asignada.' }); return }

    setFormSaving(true)
    setFormErrors({})
    setKitFormErrors([])
    try {
      const createdProducts = []
      for (const item of items) {
        const producto = await createOrLinkProduct(item, casaId)
        if (!producto) return
        createdProducts.push(producto)
      }
      // La línea de importación solo admite un producto vinculado: en un kit se
      // enlaza el primero (así el paso 1 lo marca como resuelto) y el resto queda
      // creado en el catálogo aunque sin vínculo directo a esta línea.
      authFetch(
        `${API_URL}/importaciones/importaciones/${imp.id}/detalles/${editingId}/`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ producto_id: createdProducts[0].id, nuevo: Boolean(createdProducts[0].__wasCreated) }) },
        token
      ).catch(() => {})
      setRows(prev => prev.map(r => r.id === editingId
        ? {
            ...r,
            productoId: createdProducts[0].id,
            codigo: createdProducts[0].codigo,
            nombre: createdProducts[0].nombre,
            referencia: createdProducts[0].referencia,
            precio: createdProducts[0].precio,
            sinCat: false,
            creadoAqui: Boolean(createdProducts[0].__wasCreated),
            newProducto: createdProducts[0],
            kitProductos: isKit ? createdProducts : null,
          }
        : r))
      setEditingId(null)
    } finally {
      setFormSaving(false)
    }
  }

  const enterStep4 = async () => {
    setStep(4)
    setLoadingSucursales(true)
    setSucursalesError(false)
    try {
      const resp = await authFetch(`${API_URL}/inventario/sucursales/?modulo=movimientos_entradas`, {}, token)
      if (!resp.ok) throw new Error('sucursales')
      const data = await resp.json()
      const list = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : []
      setSucursales(list)
      setDistribution(prev => seedDistribution(list, prev))
    } catch {
      setSucursales([])
      setSucursalesError(true)
    } finally {
      setLoadingSucursales(false)
    }
  }

  const updateDistribution = useCallback((row, sucursalId, value) => {
    setDistribution(prev => {
      const matriz = findMatrizSucursal(sucursales)
      const prevRowDist = prev[row.id] || {}
      const wasAnyOtherFilled = sucursales.some(suc =>
        suc.id !== matriz?.id && suc.id !== sucursalId && String(prevRowDist[suc.id] ?? '').trim() !== ''
      )
      const rowDist = { ...prevRowDist, [sucursalId]: value }
      // Al escribir el primer número de la fila, el resto de sucursales vacías pasan a 0.
      if (!wasAnyOtherFilled && value.trim() !== '') {
        sucursales.forEach(suc => {
          if (matriz && suc.id === matriz.id) return
          if (suc.id === sucursalId) return
          if (String(rowDist[suc.id] ?? '').trim() === '') rowDist[suc.id] = '0'
        })
      }
      if (matriz && sucursalId !== matriz.id) {
        const ceiling = getCantidadRecibidaCeiling(row)
        const othersSum = sucursales
          .filter(suc => suc.id !== matriz.id)
          .reduce((sum, suc) => sum + (parseInt(rowDist[suc.id]) || 0), 0)
        rowDist[matriz.id] = String(Math.max(0, ceiling - othersSum))
      }
      return { ...prev, [row.id]: rowDist }
    })
  }, [sucursales])

  const enterStep5 = async () => {
    setStep(5)
    if (allUsers.length > 0) return
    setLoadingUsers(true)
    setUsersError(false)
    try {
      const collected = []
      let url = `${API_URL}/usuarios/listado/destinatarios/?page_size=200`
      while (url) {
        const resp = await authFetch(url, {}, token)
        if (!resp.ok) {
          if (!collected.length) setUsersError(true)
          break
        }
        const data = await resp.json().catch(() => ({}))
        const items = Array.isArray(data) ? data : (data.results || [])
        collected.push(...items)
        url = Array.isArray(data) ? null : (data.next || null)
      }
      setAllUsers(collected.map(u => ({
        id: u.id,
        name: [u.nombres || u.nombre, u.apellidos || u.apellido].filter(Boolean).join(' ').trim() || u.correo || 'Usuario',
        es_admin: Boolean(u.es_administrador),
        sucursales_ids: (u.sucursales || []).map(s => s.id),
        entradas_sucursales_ids: (u.sucursales_por_modulo || [])
          .filter(scope => scope.modulo === 'movimientos_entradas')
          .flatMap(scope => scope.sucursales_ids || []),
        puede_entradas: (u.permisos_resumen || []).some(p =>
          p.modulo === 'movimientos_entradas' && (p.puede_crear || p.puede_actualizar || p.puede_leer)
        ),
      })))
    } catch {
      setUsersError(true)
    }
    setLoadingUsers(false)
  }

  const toggleRecipient = useCallback((sucursalId, userId) => {
    setRecipientsBySucursal(prev => {
      const current = prev[sucursalId] || []
      const has = current.includes(userId)
      return { ...prev, [sucursalId]: has ? current.filter(id => id !== userId) : [...current, userId] }
    })
  }, [])

  const handleConfirm = async () => {
    if (!canFinish) { setShowErrors(true); return }
    setSubmitting(true)
    try {
      const distribuciones = rows.flatMap(row =>
        Object.entries(distribution[row.id] || {})
          .filter(([, v]) => parseInt(v) > 0)
          .map(([sucursalId, qty]) => ({ detalle_id: row.id, sucursal_id: parseInt(sucursalId), cantidad: parseInt(qty) }))
      )
      const destinatarios_por_sucursal = Object.entries(recipientsBySucursal)
        .filter(([, ids]) => ids.length > 0)
        .map(([sucursalId, ids]) => ({ sucursal_id: parseInt(sucursalId), user_ids: ids }))
      const revisiones = rows.map(row => ({ detalle_id: row.id, cantidad_recibida: getCantidadRecibidaCeiling(row) }))
      const resp = await authFetch(
        `${API_URL}/importaciones/importaciones/${imp.id}/marcar-llegada/`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ distribuciones, destinatarios_por_sucursal, revisiones, fecha_llegada: fechaLlegada }) },
        token
      )
      if (!resp.ok) throw new Error(await readErrorMessage(resp, 'No se pudo marcar la llegada.'))
      clearTimeout(draftAutosaveTimerRef.current)
      draftAutosavePendingRef.current = null
      try { localStorage.removeItem(storageKey) } catch { /* noop */ }
      onConfirmed?.(await resp.json())
    } catch (e) {
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: e.message, life: 4000 })
    } finally {
      setSubmitting(false)
    }
  }

  // Guarda el progreso actual en la base de datos para que sobreviva a cerrar el
  // modal, recargar la página o reabrirlo en otro dispositivo.
  const saveDraftToServer = async (rowsOverride, { keepalive = false } = {}) => {
    const source = rowsOverride || rows
    const checkedIds = source.filter(r => r.checked).map(r => r.id)
    const cantidadesRecibidas = Object.fromEntries(source.map(r => [r.id, r.cantidadRecibida]))
    const borrador = { step, fechaLlegada, checkedIds, cantidadesRecibidas, distribution, recipientsBySucursal }
    try {
      const resp = await authFetch(
        `${API_URL}/importaciones/importaciones/${imp.id}/guardar-borrador-llegada/`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ borrador }), keepalive },
        token
      )
      if (resp.ok) {
        // Ya esta en el servidor: se borra el respaldo de versiones anteriores.
        try { localStorage.removeItem(storageKey) } catch { /* noop */ }
      }
    } catch {
      // Sin conexion: se reintenta con el siguiente cambio o al cerrar.
    }
  }

  const handleClose = () => {
    if (submitting) return
    clearTimeout(draftAutosaveTimerRef.current)
    draftAutosavePendingRef.current = null
    // Si se cierra antes de que termine la carga inicial no se guarda: el
    // estado aun no refleja el borrador del servidor y lo pisaria.
    if (!loadingData) saveDraftToServer()
    onClose()
  }

  return createPortal(
    <>
      <Toast ref={toastRef} baseZIndex={2200} />
      <div
        className={`quick-actions__receive-overlay ${mode}`}
        style={{ zIndex: 2100 }}
        onMouseDown={(e) => { if (e.target === e.currentTarget && !submitting) handleClose() }}
      >
        <div
          className={`quick-actions__receive-dialog ${mode}`}
          style={{
            width: isMaximized ? 'min(1600px, 95vw)' : step === 3 ? 'min(950px, 95vw)' : step === 4 ? 'min(860px, 95vw)' : step === 5 ? 'min(700px, 95vw)' : 'min(640px, 90vw)',
            maxHeight: isMaximized ? '95dvh' : undefined,
            gridTemplateRows: 'auto 1fr auto',
            transition: 'width .25s, max-height .25s',
            position: 'relative',
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {uploadingExcel && <ExcelLoadingOverlay />}
          <header className="quick-actions__receive-head">
            <div>
              <h4>{imp.codigo}</h4>
              <p>{imp.casa_comercial?.nombre || '-'} · Recepción de productos</p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                className="create-user__icon-button create-user__icon-button--maximize"
                onClick={() => setIsMaximized((p) => !p)}
                aria-label={isMaximized ? 'Restaurar' : 'Maximizar'}
              >
                <i className={isMaximized ? 'pi pi-window-minimize' : 'pi pi-window-maximize'} aria-hidden="true" />
              </button>
              <button type="button" className="quick-actions__receive-close" onClick={handleClose} disabled={submitting}>
                <X size={16} />
              </button>
            </div>
          </header>

          {/* Step indicator */}
          {!loadingData && (
            <div style={{ padding: '12px 20px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', gap: 5 }}>
                {[1,2,3,4,5].map(n => (
                  <div key={n} style={{ flex: 1, height: 3, borderRadius: 2, background: step >= n ? 'var(--color-primary, #2563eb)' : 'var(--color-border, #e2e8f0)', transition: 'background .3s' }} />
                ))}
              </div>
              <span style={{ fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>
                Paso {step} de 5 — {step === 1 ? 'Productos nuevos' : step === 2 ? 'Fecha de llegada' : step === 3 ? 'Revisión de llegada' : step === 4 ? 'Distribución a sucursales' : 'Destinatarios del envío'}
              </span>
            </div>
          )}

          <div className="quick-actions__receive-body">
            {loadingData ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 0', gap: 12 }}>
                <svg style={{ animation: 'spin 0.8s linear infinite', width: 22, height: 22, flexShrink: 0 }} viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.2" />
                  <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                </svg>
                <span style={{ fontSize: '0.9rem', color: 'var(--color-text-secondary)' }}>Cargando productos...</span>
              </div>
            ) : step === 1 ? (
              /* ── PASO 1: registrar productos sin catálogo ── */
              <div className="quick-actions__receive-step quick-actions__receive-step--list" style={{ '--receive-list-received-column': '0px' }}>
                <article className="quick-actions__receive-stage quick-actions__receive-stage--list">
                  <div className="quick-actions__receive-stage-copy">
                    <p className="quick-actions__receive-stage-kicker">Paso 1 — Productos nuevos</p>
                    <h5>Registra los productos que no están en el catálogo</h5>
                    <p className="quick-actions__receive-stage-name">
                      Estos ítems llegaron en esta importación pero aún no tienen un producto asignado. Completa sus datos antes de continuar.
                    </p>
                  </div>
                  {step1Rows.length > 0 && (
                    <div className="quick-actions__receive-stage-stats" style={{ marginTop: 10 }}>
                      <span className="quick-actions__receive-stage-stat">Pendientes <strong>{step1Pending.length}</strong></span>
                      <span className="quick-actions__receive-stage-stat">Completados <strong>{step1Rows.length - step1Pending.length}</strong></span>
                    </div>
                  )}
                </article>

                {step1Rows.length === 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '40px 20px', textAlign: 'center' }}>
                    <svg viewBox="0 0 24 24" fill="none" style={{ width: 40, height: 40, color: 'var(--color-success, #16a34a)' }}>
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" />
                      <path d="M7.5 12l3 3 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <p style={{ fontWeight: 600, fontSize: '0.95rem' }}>Todos los productos ya están en el catálogo</p>
                    <p style={{ fontSize: '0.82rem', color: 'var(--color-text-secondary)' }}>Puedes continuar al siguiente paso.</p>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 16px 8px' }}>
                    {step1Rows.map(row => {
                      const isDone = !row.sinCat || row.newProducto
                      const productCode = row.newProducto?.codigo || (!row.sinCat ? row.codigo : null)
                      return (
                        <div key={row.id} style={{ display: 'flex', alignItems: 'center', gap: 12, background: isDone ? 'var(--color-success-bg, #f0fdf4)' : 'var(--color-surface, #f8fafc)', border: `1px solid ${isDone ? 'var(--color-success-border, #bbf7d0)' : 'var(--color-border, #e2e8f0)'}`, borderRadius: 10, padding: '10px 14px', transition: 'background .2s, border-color .2s' }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: '0.85rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.nombre || row.codigo || '-'}</div>
                            {row.nombre && row.codigo && <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>{row.codigo}</div>}
                          </div>
                          {isDone ? (
                            <span style={{ fontWeight: 700, fontSize: '0.82rem', color: 'var(--color-success, #16a34a)', whiteSpace: 'nowrap' }}>
                              {row.kitProductos?.length > 1
                                ? `${row.kitProductos.length} productos (kit)`
                                : productCode}
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="quick-actions__receive-btn quick-actions__receive-btn--primary"
                              style={{ fontSize: '0.8rem', minHeight: 30, padding: '0 12px', whiteSpace: 'nowrap', flexShrink: 0 }}
                              onClick={() => openProductForm(row)}
                            >
                              Completar datos
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            ) : step === 2 ? (
              /* ── PASO 2: fecha de llegada ── */
              <div className="quick-actions__receive-step quick-actions__receive-step--list" style={{ '--receive-list-received-column': '0px' }}>
                <article className="quick-actions__receive-stage quick-actions__receive-stage--list">
                  <div className="quick-actions__receive-stage-copy">
                    <p className="quick-actions__receive-stage-kicker">Paso 2 — Fecha de llegada</p>
                    <h5>¿Cuándo llegó la importación?</h5>
                    <p className="quick-actions__receive-stage-name">
                      Por defecto se usa la fecha de hoy. Puedes editarla si la mercadería llegó en otro momento.
                    </p>
                  </div>
                </article>
                <div style={{ padding: '4px 16px 8px', maxWidth: 260 }}>
                  <label className="create-user__field create-user__field--required">
                    <span>Fecha de llegada</span>
                    <input
                      type="date"
                      value={fechaLlegada}
                      onChange={(e) => setFechaLlegada(e.target.value)}
                      min={fechaLlegadaMinDate || undefined}
                    />
                    {fechaLlegadaMinDate && (
                      <small style={{ color: 'var(--color-text-secondary)' }}>
                        No puede ser anterior a {formatDate(fechaLlegadaMinDate)}.
                      </small>
                    )}
                  </label>
                </div>
              </div>
            ) : step === 3 ? (
              /* ── PASO 3: verificar cantidades recibidas ── */
              <div
                className="quick-actions__receive-step quick-actions__receive-step--list"
                style={{ '--receive-list-locations-column': 'minmax(120px, 1.1fr)', '--receive-list-received-column': '0px' }}
              >
                <article className="quick-actions__receive-stage quick-actions__receive-stage--list">
                  <div className="quick-actions__receive-stage-head">
                    <div className="quick-actions__receive-stage-copy">
                      <p className="quick-actions__receive-stage-kicker">Paso 3 — Revisión de llegada</p>
                      <h5>Confirma los productos recibidos</h5>
                      <p className="quick-actions__receive-stage-name">Marca cada producto cuando confirmes físicamente haberlo recibido.</p>
                    </div>
                    <div className="quick-actions__receive-stage-toolbar">
                      <label className="quick-actions__receive-check quick-actions__receive-check--bulk">
                        <input type="checkbox" checked={allChecked} ref={(el) => { if (el) el.indeterminate = someChecked }} onChange={(e) => toggleAll(e.target.checked)} />
                        <span>Marcar todo</span>
                      </label>
                    </div>
                  </div>
                  <div className="quick-actions__receive-stage-meta quick-actions__receive-stage-meta--split">
                    {imp.casa_comercial?.nombre && (
                      <div className="quick-actions__receive-stage-meta-block">
                        <small className="quick-actions__receive-destination-label">Casa comercial</small>
                        <strong>{imp.casa_comercial.nombre}</strong>
                      </div>
                    )}
                    <div className="quick-actions__receive-stage-stats">
                      <span className="quick-actions__receive-stage-stat">Productos <strong>{rows.length}</strong></span>
                      <span className="quick-actions__receive-stage-stat">Revisados <strong>{checkedCount}</strong></span>
                    </div>
                  </div>
                </article>

                <ImportProductSearch value={filter} onChange={setFilter} shown={rowMatchCount} total={rows.length} />

                <div className="create-user__locations-table importaciones-modal__products-table imp-receive__table" onKeyDown={handleProductsGridKeyDown}>
                  <div className="create-user__locations-row create-user__locations-row--head imp-receive__productos-row">
                    <span>Código</span>
                    <span>Descripción</span>
                    <span>Referencia</span>
                    <span>OEM</span>
                    <span>Precio</span>
                    <span>Cant. Esperada</span>
                    <span
                      onDoubleClick={() => setRows(prev => prev.map(r => ({ ...r, cantidadRecibida: String(r.cantidad) })))}
                      title="Doble click: llenar todas con la cantidad esperada"
                      style={{ cursor: 'pointer' }}
                    >
                      Cant. Recibida
                    </span>
                    <span
                      onDoubleClick={() => toggleAll(!allChecked)}
                      title="Doble click: marcar/desmarcar todas"
                      style={{ cursor: 'pointer' }}
                    >
                      Acciones
                    </span>
                  </div>
                  {filteredRows.length === 0 ? (
                    <div className="create-user__locations-row create-user__locations-row--empty" style={{ gridTemplateColumns: '1fr' }}><span>Sin productos.</span></div>
                  ) : filteredRows.map((row) => {
                    const hasError = showErrors && !row.checked
                    const precioLabel = row.precio != null ? `$${Number(row.precio).toFixed(2)}` : '-'
                    const ceiling = getCantidadRecibidaCeiling(row)
                    const diff = ceiling - row.cantidad
                    const diffClass = diff < 0 ? ' imp-receive__cantidad-input--faltante' : diff > 0 ? ' imp-receive__cantidad-input--sobrante' : ''
                    const diffTitle = diff < 0
                      ? `Se registrará un inconveniente por faltante de ${-diff} unidad${-diff === 1 ? '' : 'es'}.`
                      : diff > 0
                        ? `Se registrará un inconveniente por sobrante de ${diff} unidad${diff === 1 ? '' : 'es'}.`
                        : ''
                    return (
                      <div key={row.id} className={`create-user__locations-row imp-receive__productos-row${hasError ? ' has-validation-error' : ''}${row.creadoAqui ? ' importaciones-aceptados__row--nuevo' : ''}`}>
                        <span
                          className="imp-table-cell-tip"
                          onMouseEnter={(e) => showCellHover(e, row.codigo, 'Código')}
                          onMouseLeave={hideCellHover}
                        >
                          <span className="imp-table-cell-text imp-table-cell-text--full">{row.codigo || '-'}</span>
                        </span>
                        <span
                          className="imp-table-cell-tip"
                          onMouseEnter={(e) => showCellHover(e, row.nombre, 'Descripción')}
                          onMouseLeave={hideCellHover}
                        >
                          <span className="imp-table-cell-text">{row.nombre || '-'}</span>
                        </span>
                        <span
                          className="imp-table-cell-tip"
                          onMouseEnter={(e) => showCellHover(e, row.referencia, 'Referencia')}
                          onMouseLeave={hideCellHover}
                        >
                          <span className="imp-table-cell-text">{row.referencia || '-'}</span>
                        </span>
                        <span
                          className="imp-table-cell-tip"
                          onMouseEnter={(e) => showCellHover(e, row.oem, 'OEM')}
                          onMouseLeave={hideCellHover}
                        >
                          <span className="imp-table-cell-text">{row.oem || '-'}</span>
                        </span>
                        <span
                          className="imp-table-cell-tip"
                          onMouseEnter={(e) => showCellHover(e, precioLabel !== '-' ? precioLabel : null, 'Precio')}
                          onMouseLeave={hideCellHover}
                        >
                          <span className="imp-table-cell-text">{precioLabel}</span>
                        </span>
                        <span
                          className="imp-table-cell-text"
                          style={{ textAlign: 'center', fontWeight: 600, cursor: 'pointer' }}
                          onDoubleClick={() => updateCantidadRecibida(row.id, String(row.cantidad))}
                          title="Doble click: usar cantidad esperada"
                        >
                          {row.cantidad}
                        </span>
                        <span>
                          <input
                            type="text"
                            inputMode="numeric"
                            maxLength={6}
                            className={`imp-receive__cantidad-input${diffClass}`}
                            value={row.cantidadRecibida}
                            title={diffTitle || 'Doble click: usar cantidad esperada'}
                            onChange={(e) => updateCantidadRecibida(row.id, e.target.value)}
                            onDoubleClick={() => updateCantidadRecibida(row.id, String(row.cantidad))}
                            disabled={submitting}
                          />
                        </span>
                        <span className="imp-receive__check-cell">
                          <Checkbox binary checked={row.checked} onChange={() => toggleRow(row.id)} disabled={submitting} />
                        </span>
                      </div>
                    )
                  })}
                </div>
                {showErrors && filteredRows.some(row => !row.checked) && (
                  <p className="quick-actions__receive-item-hint quick-actions__receive-item-hint--warning" style={{ padding: '0 16px' }}>
                    Confirma haber revisado todos los productos antes de continuar.
                  </p>
                )}
              </div>
            ) : step === 4 ? (
              /* ── PASO 4: distribución a sucursales ── */
              <div className="quick-actions__receive-step quick-actions__receive-step--list" style={{ '--receive-list-received-column': '0px' }}>
                <article className="quick-actions__receive-stage quick-actions__receive-stage--list">
                  <div className="quick-actions__receive-stage-copy">
                    <p className="quick-actions__receive-stage-kicker">Paso 4 — Distribución</p>
                    <h5>Envía los productos a las sucursales</h5>
                    <p className="quick-actions__receive-stage-name">Indica cuántas unidades de cada producto van a cada sucursal. El total debe coincidir con la cantidad recibida.</p>
                  </div>
                  {!loadingSucursales && sucursales.length > 0 && (
                    <div className="quick-actions__receive-stage-stats" style={{ marginTop: 10 }}>
                      <span className="quick-actions__receive-stage-stat">Productos <strong>{rows.length}</strong></span>
                      <span className="quick-actions__receive-stage-stat">Listos <strong>{rows.filter(row => Object.values(distribution[row.id] || {}).reduce((s, v) => s + (parseInt(v) || 0), 0) === getCantidadRecibidaCeiling(row)).length}</strong></span>
                    </div>
                  )}
                </article>

                {loadingSucursales ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 0', gap: 12 }}>
                    <svg style={{ animation: 'spin 0.8s linear infinite', width: 20, height: 20, flexShrink: 0 }} viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.2" />
                      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                    </svg>
                    <span style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>Cargando sucursales...</span>
                  </div>
                ) : sucursalesError ? (
                  <div style={{ padding: 16 }}>
                    <BlockerNotice
                      title="No se pudieron cargar las sucursales"
                      reason="Hubo un problema de conexión o del servidor al traer las sucursales, así que todavía no puedes distribuir los productos. Tu avance está guardado; vuelve a intentarlo."
                      actionLabel="Reintentar"
                      onAction={enterStep4}
                    />
                  </div>
                ) : sucursales.length === 0 ? (
                  <div style={{ padding: 16 }}>
                    <BlockerNotice
                      title="No se puede distribuir: no tienes sucursales con permiso de Entradas"
                      reason="Para repartir la mercadería necesitas permiso de Entradas en al menos una sucursal. Pide a un administrador que lo asigne en Administrar › Usuarios › editar tu usuario › Permisos (Entradas) y vuelve a abrir este paso."
                      goTo="Administrar"
                    />
                  </div>
                ) : (() => {
                  const matrizSucursal = findMatrizSucursal(sucursales)
                  const gridCols = `minmax(72px, 0.4fr) minmax(140px, 1.6fr) 56px repeat(${sucursales.length}, 62px)`
                  return (
                    <>
                    <ImportProductSearch value={filter} onChange={setFilter} shown={rowMatchCount} total={rows.length} />
                    <div className="create-user__locations-table importaciones-modal__products-table imp-distribucion__table" onKeyDown={handleDistributionGridKeyDown}>
                      <div className="create-user__locations-row create-user__locations-row--head imp-distribucion__productos-row" style={{ gridTemplateColumns: gridCols }}>
                        <span style={{ justifyContent: 'flex-start' }}>Código</span>
                        <span style={{ justifyContent: 'flex-start' }}>Descripción</span>
                        <span style={{ justifyContent: 'center' }}>Total</span>
                        {sucursales.map(suc => (
                          <span key={suc.id} title={suc.nombre}>{shortSucursalLabel(suc.nombre)}</span>
                        ))}
                      </div>
                                            {filteredRows.map((row) => {
                        const rowDist = distribution[row.id] || {}
                        const assigned = Object.values(rowDist).reduce((s, v) => s + (parseInt(v) || 0), 0)
                        const ceiling = getCantidadRecibidaCeiling(row)
                        const isOver = assigned > ceiling
                        const isComplete = assigned === ceiling
                        return (
                          <div key={row.id} className="create-user__locations-row imp-distribucion__productos-row" style={{ gridTemplateColumns: gridCols }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-start', minWidth: 0, overflow: 'hidden' }}>
                              <span
                                className="imp-table-cell-tip"
                                style={{ justifyContent: 'flex-start' }}
                                onMouseEnter={(e) => showCellHover(e, row.codigo, 'Código')}
                                onMouseLeave={hideCellHover}
                              >
                                <span className="imp-table-cell-text imp-table-cell-text--full">{row.codigo || '-'}</span>
                              </span>
                              {row.productoId != null && (
                                <Info
                                  size={13}
                                  className="imp-distribucion__info-icon"
                                  onMouseEnter={(e) => showAlternosHover(e, row.productoId)}
                                  onMouseLeave={hideAlternosHover}
                                />
                              )}
                            </span>
                            <span
                              className="imp-table-cell-tip"
                              style={{ justifyContent: 'flex-start' }}
                              onMouseEnter={(e) => showCellHover(e, row.nombre, 'Descripción')}
                              onMouseLeave={hideCellHover}
                            >
                              <span className="imp-table-cell-text">{row.nombre || '-'}</span>
                            </span>
                            <span className="imp-table-cell-text" style={{ justifyContent: 'center', textAlign: 'center', fontWeight: 700, color: isOver ? '#dc2626' : isComplete ? '#16a34a' : 'var(--color-text-secondary)' }}>
                              {ceiling}
                            </span>
                            {sucursales.map(suc => {
                              const isMatriz = Boolean(matrizSucursal && suc.id === matrizSucursal.id)
                              return (
                                <span
                                  key={suc.id}
                                  onMouseEnter={row.productoId != null ? (e) => showAlternosHover(e, row.productoId) : undefined}
                                  onMouseLeave={row.productoId != null ? hideAlternosHover : undefined}
                                >
                                  <input
                                    type="number" min="0" max={ceiling}
                                    value={rowDist[suc.id] ?? ''}
                                    disabled={isMatriz || submitting}
                                    readOnly={isMatriz}
                                    onChange={(e) => !isMatriz && updateDistribution(row, suc.id, e.target.value)}
                                    onFocus={row.productoId != null ? (e) => showAlternosHover(e, row.productoId) : undefined}
                                    onBlur={row.productoId != null ? hideAlternosHover : undefined}
                                    title={isMatriz ? 'Calculado automáticamente: total menos lo asignado a otras sucursales' : undefined}
                                    className={`imp-distribucion__cantidad-input${isMatriz ? ' imp-distribucion__cantidad-input--matriz' : ''}`}
                                  />
                                </span>
                              )
                            })}
                          </div>
                        )
                      })}
                    </div>
                    </>
                  )
                })()}
              </div>
            ) : (
              /* ── PASO 5: destinatarios por sucursal ── */
              <div className="quick-actions__receive-step quick-actions__receive-step--list" style={{ '--receive-list-received-column': '0px' }}>
                <article className="quick-actions__receive-stage quick-actions__receive-stage--list">
                  <div className="quick-actions__receive-stage-copy">
                    <p className="quick-actions__receive-stage-kicker">Paso 5 — Destinatarios del envío</p>
                    <h5>Vas a enviar productos a varias sucursales</h5>
                    <p className="quick-actions__receive-stage-name">Escoge a quién debe llegarle el recordatorio de cada envío. Pasa el mouse sobre el ícono junto al nombre de la sucursal para ver qué productos le llegarán. Cada sucursal que recibe productos necesita al menos un destinatario.</p>
                  </div>
                </article>

                {loadingUsers ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 0', gap: 12 }}>
                    <svg style={{ animation: 'spin 0.8s linear infinite', width: 20, height: 20, flexShrink: 0 }} viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.2" />
                      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                    </svg>
                    <span style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>Cargando usuarios...</span>
                  </div>
                ) : usersError ? (
                  <div style={{ padding: '4px 16px 8px' }}>
                    <BlockerNotice
                      title="No se pudieron cargar los usuarios destinatarios"
                      reason="Hubo un problema de conexión o del servidor, así que no se puede saber a quién enviar cada envío. Tu avance está guardado; vuelve a intentarlo."
                      actionLabel="Reintentar"
                      onAction={enterStep5}
                    />
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 16px 8px' }}>
                    {sucursalesWithDistribution.map(suc => {
                      const usersForSuc = getUsersForSucursal(suc.id)
                      const selectedIds = recipientsBySucursal[suc.id] || []
                      return (
                        <div key={suc.id} style={{ background: 'var(--color-surface, #f8fafc)', border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 10, padding: '12px 14px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontWeight: 700, fontSize: '1rem' }}>{suc.nombre}</span>
                            <Info
                              size={16}
                              className="imp-distribucion__info-icon"
                              onMouseEnter={(e) => showEnvioItemsHover(e, suc)}
                              onMouseLeave={hideEnvioItemsHover}
                            />
                          </div>
                          <p style={{ fontSize: '0.88rem', color: 'var(--color-text-secondary)', margin: '3px 0 10px' }}>
                            Vas a enviar {suc.items.length} producto{suc.items.length === 1 ? '' : 's'} a esta sucursal.
                          </p>
                          {usersForSuc.length === 0 ? (
                            <BlockerNotice
                              compact
                              title={`No se puede enviar a ${suc.nombre}: no tiene destinatarios`}
                              reason="Ningún usuario (que no sea administrador) tiene permiso de Entradas en esta sucursal. Para resolverlo: Administrar › Usuarios › editar el usuario › Permisos de Entradas en esta sucursal. Luego vuelve a abrir este paso."
                              goTo="Administrar"
                            />
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                              {usersForSuc.map(u => (
                                <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.92rem' }}>
                                  <input type="checkbox" checked={selectedIds.includes(u.id)} onChange={() => toggleRecipient(suc.id, u.id)} style={{ width: 17, height: 17, cursor: 'pointer' }} />
                                  <span>{u.name}</span>
                                </label>
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          <footer className="quick-actions__receive-actions">
            {step === 1 ? (
              <>
                <button type="button" className="quick-actions__receive-btn quick-actions__receive-btn--cancel" onClick={handleClose}>Cancelar</button>
                <button type="button" className={`quick-actions__receive-btn${canGoNext ? ' quick-actions__receive-btn--success' : ' quick-actions__receive-btn--primary'}`} onClick={() => setStep(2)} disabled={loadingData || !canGoNext}>Siguiente</button>
              </>
            ) : step === 2 ? (
              <>
                <button type="button" className="quick-actions__receive-btn quick-actions__receive-btn--cancel" onClick={() => setStep(1)}>Atrás</button>
                <button type="button" className="quick-actions__receive-btn quick-actions__receive-btn--success" onClick={() => setStep(3)} disabled={loadingData || !fechaLlegada || !fechaLlegadaValid}>Siguiente</button>
              </>
            ) : step === 3 ? (
              <>
                <button type="button" className="quick-actions__receive-btn quick-actions__receive-btn--cancel" onClick={() => setStep(2)}>Atrás</button>
                <div className="imp-verificar-excel-dropdown" ref={receiveExcelDropdownRef}>
                  <button
                    type="button"
                    className="users-circle users-circle--excel"
                    title="Excel"
                    onClick={() => setShowReceiveExcelDropdown((p) => !p)}
                  >
                    <i className="pi pi-file-excel" />
                  </button>
                  {showReceiveExcelDropdown && (
                    <div className="imp-verificar-excel-menu" style={{ right: 0, left: 'auto' }}>
                      <button type="button" onClick={() => { handleDownloadReceiveExcel(); setShowReceiveExcelDropdown(false) }}>
                        <i className="pi pi-download" /> Descargar Excel
                      </button>
                      <button type="button" onClick={() => { receiveFileInputRef.current?.click(); setShowReceiveExcelDropdown(false) }}>
                        <i className="pi pi-upload" /> Subir Excel
                      </button>
                    </div>
                  )}
                  <input
                    ref={receiveFileInputRef}
                    type="file"
                    accept=".xlsx"
                    style={{ display: 'none' }}
                    onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) withExcelLoading(setUploadingExcel, () => handleUploadReceiveExcel(file)) }}
                  />
                </div>
                <button type="button" className={`quick-actions__receive-btn${allChecked ? ' quick-actions__receive-btn--success' : ' quick-actions__receive-btn--primary'}`} onClick={enterStep4} disabled={!allChecked}>Siguiente</button>
              </>
            ) : step === 4 ? (
              <>
                {!loadingSucursales && !canFinish && (
                  <span className="imp-receive-footer-hint">
                    {sucursalesError
                      ? 'No se puede continuar: no se cargaron las sucursales.'
                      : sucursales.length === 0
                        ? 'No se puede continuar: no tienes sucursales con permiso de Entradas.'
                        : 'Para continuar, reparte el total de cada producto entre las sucursales.'}
                  </span>
                )}
                <button type="button" className="quick-actions__receive-btn quick-actions__receive-btn--cancel" onClick={() => setStep(3)} disabled={submitting}>Atrás</button>
                <button type="button" className={`quick-actions__receive-btn${canFinish ? ' quick-actions__receive-btn--success' : ' quick-actions__receive-btn--primary'}`} onClick={enterStep5} disabled={!canFinish}>Siguiente</button>
              </>
            ) : (
              <>
                {confirmBlockReason && <span className="imp-receive-footer-hint">{confirmBlockReason}</span>}
                <button type="button" className="quick-actions__receive-btn quick-actions__receive-btn--cancel" onClick={() => setStep(4)} disabled={submitting}>Atrás</button>
                <button type="button" title={confirmBlockReason || undefined} className={`quick-actions__receive-btn${canConfirmStep4 ? ' quick-actions__receive-btn--success' : ' quick-actions__receive-btn--primary'}`} onClick={handleConfirm} disabled={submitting || !canConfirmStep4}>
                  {submitting ? 'Confirmando...' : 'Confirmar llegada y enviar a sucursales'}
                </button>
              </>
            )}
          </footer>
        </div>
      </div>

      {editingId !== null && (() => {
        const row = rows.find(r => r.id === editingId)
        const dupCheckKeys = isKit
          ? kitForms.flatMap(item => [`kit-${item._key}-codigo`, `kit-${item._key}-referencia`])
          : ['single-codigo', 'single-referencia']
        // Un código repetido ya no bloquea el envío: se le pregunta al usuario
        // si quiere vincular esta línea al producto existente en vez de crear
        // uno nuevo (ver saveProductForm/showLinkExistingConfirm). La
        // referencia repetida sí sigue bloqueando, sin cambios.
        const referenciaCheckKeys = dupCheckKeys.filter(k => k.endsWith('-referencia'))
        const codigoCheckKeys = dupCheckKeys.filter(k => k.endsWith('-codigo'))
        const codigoConflicts = codigoCheckKeys
          .map(k => ({ key: k, status: dupStatus[k] }))
          .filter(({ status }) => status?.error)
        return createPortal(
          <>
          <div
            className={`quick-actions__receive-overlay ${mode}`}
            style={{ zIndex: 2200 }}
            onMouseDown={(e) => { if (e.target === e.currentTarget && !formSaving) setEditingId(null) }}
          >
            <div
              className={`quick-actions__receive-dialog ${mode}`}
              style={{ width: isKit ? 'min(640px, 92vw)' : 'min(520px, 90vw)', height: 'auto', maxHeight: '90dvh', gridTemplateRows: 'auto 1fr auto' }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <header className="quick-actions__receive-head">
                <div>
                  <h4>Completar datos del producto</h4>
                  <p>{row?.nombre || row?.codigo || 'Sin catálogo'}</p>
                </div>
                <button type="button" className="quick-actions__receive-close" onClick={() => setEditingId(null)} disabled={formSaving}>
                  <X size={16} />
                </button>
              </header>

              <div className="quick-actions__receive-body" style={{ padding: '16px 20px' }}>
                {formErrors._general && (
                  <p style={{ color: '#dc2626', fontSize: '0.875rem', marginBottom: 12 }}>{formErrors._general}</p>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
                  <button
                    type="button"
                    className={`quick-actions__receive-btn${isKit ? ' quick-actions__receive-btn--success' : ' quick-actions__receive-btn--cancel'}`}
                    style={{ fontSize: '0.78rem', minHeight: 30, padding: '0 12px', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                    onClick={toggleKit}
                    disabled={formSaving}
                  >
                    <PackagePlus size={14} />
                    {isKit ? 'Es Kit ✓' : 'Es Kit'}
                  </button>
                </div>

                {!isKit ? (
                  <div className="create-user__grid create-user__grid--two">
                    <label className={`create-user__field create-user__field--required${formErrors.nombre ? ' create-user__field--invalid' : ''}`}>
                      <span>Descripción</span>
                      <input type="text" value={form.nombre} onChange={(e) => setForm(f => ({ ...f, nombre: e.target.value }))} />
                      {formErrors.nombre && <small style={{ color: '#dc2626' }}>{formErrors.nombre}</small>}
                    </label>
                    <label className={`create-user__field create-user__field--required${(formErrors.codigo || dupStatus['single-codigo']?.error) ? ' create-user__field--invalid' : ''}`}>
                      <span>Código JP</span>
                      <div style={{ position: 'relative' }}>
                        <input type="text" autoCapitalize="characters" spellCheck={false} style={{ paddingRight: 34 }} value={form.codigo} onChange={(e) => {
                          const v = toUpperCode(e.target.value)
                          setForm(f => ({ ...f, codigo: v }))
                          scheduleDupCheck('single-codigo', 'codigo', v)
                        }} />
                        {renderDupIcon(dupStatus['single-codigo'], 'Código JP')}
                      </div>
                      {formErrors.codigo && <small style={{ color: '#dc2626' }}>{formErrors.codigo}</small>}
                    </label>
                    <label className={`create-user__field create-user__field--required${formErrors.precio ? ' create-user__field--invalid' : ''}`}>
                      <span>Precio</span>
                      <input type="number" min="0" step="0.01" placeholder="0.00" value={form.precio} onChange={(e) => setForm(f => ({ ...f, precio: e.target.value }))} />
                      {formErrors.precio && <small style={{ color: '#dc2626' }}>{formErrors.precio}</small>}
                    </label>
                    <label className={`create-user__field create-user__field--required${(formErrors.referencia || dupStatus['single-referencia']?.error) ? ' create-user__field--invalid' : ''}`}>
                      <span>Referencia</span>
                      <div style={{ position: 'relative' }}>
                        <input type="text" style={{ paddingRight: 34 }} value={form.referencia} onChange={(e) => {
                          const v = e.target.value
                          setForm(f => ({ ...f, referencia: v }))
                          scheduleDupCheck('single-referencia', 'referencia', v)
                        }} />
                        {renderDupIcon(dupStatus['single-referencia'], 'Referencia')}
                      </div>
                      {formErrors.referencia && <small style={{ color: '#dc2626' }}>{formErrors.referencia}</small>}
                    </label>
                    <div className="create-user__field">
                      <span>OEMs</span>
                      <OemAutocomplete value={form.oem} onChange={(v) => setForm(f => ({ ...f, oem: v }))} token={token} disabled={formSaving} />
                    </div>
                    <label className="create-user__field create-user__field--full">
                      <span>Nota</span>
                      <input type="text" placeholder="Opcional" value={form.descripcion} onChange={(e) => setForm(f => ({ ...f, descripcion: e.target.value }))} />
                    </label>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <p style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', margin: 0 }}>
                      Este ítem llegó como kit: crea un producto de catálogo distinto por cada componente, con su propio código.
                    </p>
                    {kitForms.map((item, idx) => (
                      <div key={item._key} style={{ border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 10, padding: '12px 14px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                          <strong style={{ fontSize: '0.82rem' }}>Producto {idx + 1}</strong>
                          <button
                            type="button"
                            className="quick-actions__receive-close"
                            style={{ width: 24, height: 24 }}
                            onClick={() => removeKitRow(idx)}
                            disabled={formSaving || kitForms.length <= 2}
                            title="Quitar producto"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                        <div className="create-user__grid create-user__grid--two">
                          <label className={`create-user__field create-user__field--required${kitFormErrors[idx]?.nombre ? ' create-user__field--invalid' : ''}`}>
                            <span>Descripción</span>
                            <input type="text" value={item.nombre} onChange={(e) => updateKitForm(idx, 'nombre', e.target.value)} />
                            {kitFormErrors[idx]?.nombre && <small style={{ color: '#dc2626' }}>{kitFormErrors[idx].nombre}</small>}
                          </label>
                          <label className={`create-user__field create-user__field--required${(kitFormErrors[idx]?.codigo || dupStatus[`kit-${item._key}-codigo`]?.error) ? ' create-user__field--invalid' : ''}`}>
                            <span>Código JP</span>
                            <div style={{ position: 'relative' }}>
                              <input type="text" autoCapitalize="characters" spellCheck={false} style={{ paddingRight: 34 }} value={item.codigo} onChange={(e) => {
                                const v = toUpperCode(e.target.value)
                                updateKitForm(idx, 'codigo', v)
                                scheduleDupCheck(`kit-${item._key}-codigo`, 'codigo', v, kitForms.filter((_, i) => i !== idx).map(k => k.codigo))
                              }} />
                              {renderDupIcon(dupStatus[`kit-${item._key}-codigo`], 'Código JP')}
                            </div>
                            {kitFormErrors[idx]?.codigo && <small style={{ color: '#dc2626' }}>{kitFormErrors[idx].codigo}</small>}
                          </label>
                          <label className={`create-user__field create-user__field--required${kitFormErrors[idx]?.precio ? ' create-user__field--invalid' : ''}`}>
                            <span>Precio</span>
                            <input type="number" min="0" step="0.01" placeholder="0.00" value={item.precio} onChange={(e) => updateKitForm(idx, 'precio', e.target.value)} />
                            {kitFormErrors[idx]?.precio && <small style={{ color: '#dc2626' }}>{kitFormErrors[idx].precio}</small>}
                          </label>
                          <label className={`create-user__field create-user__field--required${(kitFormErrors[idx]?.referencia || dupStatus[`kit-${item._key}-referencia`]?.error) ? ' create-user__field--invalid' : ''}`}>
                            <span>Referencia</span>
                            <div style={{ position: 'relative' }}>
                              <input type="text" style={{ paddingRight: 34 }} value={item.referencia} onChange={(e) => {
                                const v = e.target.value
                                updateKitForm(idx, 'referencia', v)
                                scheduleDupCheck(`kit-${item._key}-referencia`, 'referencia', v, kitForms.filter((_, i) => i !== idx).map(k => k.referencia))
                              }} />
                              {renderDupIcon(dupStatus[`kit-${item._key}-referencia`], 'Referencia')}
                            </div>
                            {kitFormErrors[idx]?.referencia && <small style={{ color: '#dc2626' }}>{kitFormErrors[idx].referencia}</small>}
                          </label>
                          <div className="create-user__field">
                            <span>OEMs</span>
                            <OemAutocomplete value={item.oem} onChange={(v) => updateKitForm(idx, 'oem', v)} token={token} disabled={formSaving} />
                          </div>
                          <label className="create-user__field create-user__field--full">
                            <span>Nota</span>
                            <input type="text" placeholder="Opcional" value={item.descripcion} onChange={(e) => updateKitForm(idx, 'descripcion', e.target.value)} />
                          </label>
                        </div>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="quick-actions__receive-btn quick-actions__receive-btn--cancel"
                      style={{ alignSelf: 'flex-start', fontSize: '0.8rem', minHeight: 30, padding: '0 12px', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                      onClick={addKitRow}
                      disabled={formSaving}
                    >
                      <Plus size={14} />
                      Agregar producto
                    </button>
                  </div>
                )}

                {imp.casa_comercial && (
                  <p style={{ fontSize: '0.8rem', color: 'var(--color-muted,#64748b)', marginTop: 14 }}>
                    Casa comercial: <strong>{imp.casa_comercial.nombre}</strong> (asignada automáticamente)
                  </p>
                )}
              </div>

              <div className="quick-actions__receive-actions">
                <button type="button" className="quick-actions__receive-btn quick-actions__receive-btn--cancel" onClick={() => setEditingId(null)} disabled={formSaving}>
                  Cancelar
                </button>
                <button
                  type="button"
                  className="quick-actions__receive-btn quick-actions__receive-btn--primary"
                  onClick={() => saveProductForm()}
                  disabled={formSaving || dupCheckKeys.some(k => dupStatus[k]?.checking) || referenciaCheckKeys.some(k => dupStatus[k]?.error)}
                >
                  {formSaving ? 'Guardando...' : (isKit ? `Crear ${kitForms.length} productos` : 'Crear producto')}
                </button>
              </div>
            </div>
          </div>
          {showLinkExistingConfirm && (
            <div
              className={`quick-actions__receive-overlay ${mode}`}
              style={{ zIndex: 2400 }}
              onMouseDown={(e) => { if (e.target === e.currentTarget) setShowLinkExistingConfirm(false) }}
            >
              <div
                className={`quick-actions__receive-dialog ${mode}`}
                style={{ width: 'min(440px, 90vw)', height: 'auto', gridTemplateRows: 'auto 1fr auto' }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <header className="quick-actions__receive-head">
                  <div>
                    <h4>¿Vincular con producto existente?</h4>
                  </div>
                  <button type="button" className="quick-actions__receive-close" onClick={() => setShowLinkExistingConfirm(false)} disabled={formSaving}>
                    <X size={16} />
                  </button>
                </header>
                <div style={{ padding: '4px 20px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--color-text, inherit)' }}>
                    {codigoConflicts.length === 1
                      ? 'Este código ya pertenece a un producto existente:'
                      : 'Estos códigos ya pertenecen a productos existentes:'}
                  </p>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.9rem', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {codigoConflicts.map(({ key, status }) => (
                      <li key={key}>
                        <strong>{status.existingProduct?.codigo || '—'}</strong>
                        {status.existingProduct?.nombre ? `: ${status.existingProduct.nombre}` : ''}
                      </li>
                    ))}
                  </ul>
                  <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--color-muted,#64748b)' }}>
                    Si continúas, esta línea de la importación se vinculará al producto que ya existe en el catálogo (sin cambiar su nombre, precio ni referencia actuales) en vez de crear uno nuevo. ¿Estás seguro?
                  </p>
                </div>
                <div className="quick-actions__receive-actions">
                  <button type="button" className="quick-actions__receive-btn quick-actions__receive-btn--cancel" onClick={() => setShowLinkExistingConfirm(false)} disabled={formSaving}>
                    Cancelar
                  </button>
                  <button type="button" className="quick-actions__receive-btn quick-actions__receive-btn--primary" onClick={() => saveProductForm(true)} disabled={formSaving}>
                    {formSaving ? 'Guardando...' : 'Sí, vincular'}
                  </button>
                </div>
              </div>
            </div>
          )}
          </>,
          getPortalRoot()
        )
      })()}

      {cellHover && createPortal(
        <div
          className="imp-cell-hover-card"
          style={{ top: cellHover.top, left: cellHover.left }}
        >
          <div className="imp-cell-hover-card__title">{cellHover.label}</div>
          {cellHover.items.map((value, i) => (
            <div key={i} className="imp-cell-hover-card__row">{value}</div>
          ))}
        </div>,
        getPortalRoot()
      )}

      {alternosHover && createPortal(
        <div
          ref={alternosHoverCardRef}
          className="imp-alternos-hover-card"
          style={{
            top: alternosHoverPos?.top ?? alternosHover.triggerBottom + 4,
            left: alternosHoverPos?.left ?? alternosHover.triggerLeft,
            visibility: alternosHoverPos ? 'visible' : 'hidden',
          }}
        >
          {alternosHover.data === 'loading' ? (
            <div className="imp-alternos-hover-card__message">Cargando stock...</div>
          ) : !alternosHover.data ? (
            <div className="imp-alternos-hover-card__message">No se pudo cargar la información.</div>
          ) : alternosHover.data.sucursales.length === 0 ? (
            <div className="imp-alternos-hover-card__message">Sin stock registrado en ninguna sucursal.</div>
          ) : (
            <table className="imp-alternos-hover-card__table imp-alternos-hover-card__table--stock">
              <thead>
                <tr>
                  <th>Producto</th>
                  {alternosHover.data.sucursales.map(suc => <th key={suc.id} title={suc.nombre}>{shortSucursalLabel(suc.nombre)}</th>)}
                </tr>
              </thead>
              <tbody>
                {alternosHover.data.productos.map(p => (
                  <tr key={p.id} className={p.es_principal ? 'imp-alternos-hover-card__row--principal' : undefined}>
                    <td title={p.nombre}>{p.codigo}</td>
                    {alternosHover.data.sucursales.map(suc => (
                      <td key={suc.id}>{alternosHover.data.stock?.[String(p.id)]?.[String(suc.id)] ?? 0}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>,
        getPortalRoot()
      )}

      {envioItemsHover && createPortal(
        <div
          ref={envioItemsHoverCardRef}
          className="imp-alternos-hover-card"
          style={{
            top: envioItemsHoverPos?.top ?? envioItemsHover.triggerBottom + 4,
            left: envioItemsHoverPos?.left ?? envioItemsHover.triggerLeft,
            visibility: envioItemsHoverPos ? 'visible' : 'hidden',
          }}
        >
          <div className="imp-cell-hover-card__title">Productos para {envioItemsHover.sucursalNombre}</div>
          {envioItemsHover.items.length === 0 ? (
            <div className="imp-alternos-hover-card__message">Sin productos asignados.</div>
          ) : (
            <table className="imp-alternos-hover-card__table imp-alternos-hover-card__table--envio">
              <thead>
                <tr>
                  <th>Código</th>
                  <th>Producto</th>
                  <th>Cantidad</th>
                </tr>
              </thead>
              <tbody>
                {envioItemsHover.items.map(item => (
                  <tr key={item.id}>
                    <td title={item.codigo || ''}>{item.codigo || '-'}</td>
                    <td style={{ textAlign: 'left' }} title={item.nombre || ''}>{item.nombre || '-'}</td>
                    <td>{item.qty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>,
        getPortalRoot()
      )}
    </>,
    getPortalRoot()
  )
}

const DETAILS_VIEWPORT_PADDING = 12

function ImportacionDetailsModal({ imp: impProp, token, onClose, onSaved, moduleActions, onOpenOrigen }) {
  // Buscador de productos de esta importacion.
  const [productSearch, setProductSearch] = useState('')
  const canMarcarLlegada = moduleActions?.puede_marcar_llegada === true
  const [showReceive, setShowReceive] = useState(false)
  const [showHistorial, setShowHistorial] = useState(false)
  const [showHistorialVerificacion, setShowHistorialVerificacion] = useState(false)
  const [activeTab, setActiveTab] = useState('productos')
  const toastRef = useRef(null)

  // Copia local que se actualiza al editar las fechas del seguimiento en camino,
  // sin depender de que el padre vuelva a pedir la lista completa. También se
  // usa para traer los detalles frescos del servidor al abrir: impProp viene
  // de la fila ya cargada en la lista de la tabla, que puede estar
  // desactualizada (por ejemplo, si un guardado anterior cambió precios,
  // cantidades u orden) -- igual que en EditImportacionModal/
  // ImportacionReceiveModal, se reemplaza en cuanto llega la versión fresca.
  const [impOverride, setImpOverride] = useState(null)
  const imp = impOverride && impProp && impOverride.id === impProp.id ? impOverride : impProp
  // La "i" del OEM: coincidencias del catalogo de cada producto.
  const coincidenciaItems = useMemo(() => (imp?.detalles || []).map((d) => ({
    key: d.id,
    oem: getProductoOem(d.producto) || d.oem || '',
    referencia: d.producto?.referencia || d.referencia || '',
  })), [imp?.detalles])
  const coincidenciasByKey = useCoincidencias(token, imp?.casa_comercial?.id, coincidenciaItems)
  const [loadingImp, setLoadingImp] = useState(true)
  useEffect(() => {
    if (!impProp?.id || !token) { setLoadingImp(false); return }
    let cancelled = false
    setLoadingImp(true)
    authFetch(`${API_URL}/importaciones/importaciones/${impProp.id}/`, {}, token)
      .then((r) => (r.ok ? r.json() : null))
      .then((fresh) => { if (!cancelled && fresh) setImpOverride(fresh) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingImp(false) })
    return () => { cancelled = true }
  }, [impProp?.id, token])
  const [trackerEditingField, setTrackerEditingField] = useState(null)
  const [trackerDateDraft, setTrackerDateDraft] = useState('')
  const [trackerMinDate, setTrackerMinDate] = useState(null)
  const [trackerSaving, setTrackerSaving] = useState(false)

  const openTrackerEditor = (field, currentValue) => {
    setTrackerEditingField(field)
    setTrackerDateDraft(currentValue || todayISO())
    setTrackerMinDate(getTrackerMinDate(imp, field))
  }
  const closeTrackerEditor = () => {
    setTrackerEditingField(null)
    setTrackerDateDraft('')
    setTrackerMinDate(null)
  }
  const saveTrackerDate = async () => {
    if (!trackerEditingField || !imp) return
    if (trackerMinDate && trackerDateDraft < trackerMinDate) {
      toastRef.current?.show({
        severity: 'warn',
        summary: 'Fecha inválida',
        detail: `La fecha no puede ser anterior a ${formatDate(trackerMinDate)}.`,
        life: 4000,
      })
      return
    }
    setTrackerSaving(true)
    try {
      const resp = await authFetch(
        `${API_URL}/importaciones/importaciones/${imp.id}/actualizar-fecha-tracker/`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campo: trackerEditingField, fecha: trackerDateDraft }) },
        token
      )
      if (!resp.ok) throw new Error(await readErrorMessage(resp, 'No se pudo guardar la fecha.'))
      const updated = await resp.json()
      setImpOverride(updated)
      closeTrackerEditor()
    } catch (e) {
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: e.message, life: 4000 })
    } finally {
      setTrackerSaving(false)
    }
  }
  const [cellHover, setCellHover] = useState(null)
  const cellHoverTimerRef = useRef(null)
  const showCellHover = useCallback((event, items, label) => {
    const list = (Array.isArray(items) ? items : [items]).filter(Boolean)
    if (!list.length) return
    if (cellHoverTimerRef.current) clearTimeout(cellHoverTimerRef.current)
    const rect = event.currentTarget.getBoundingClientRect()
    cellHoverTimerRef.current = setTimeout(() => {
      cellHoverTimerRef.current = null
      setCellHover({ top: rect.bottom + 4, left: rect.left, items: list, label })
    }, 400)
  }, [])
  const hideCellHover = useCallback(() => {
    if (cellHoverTimerRef.current) { clearTimeout(cellHoverTimerRef.current); cellHoverTimerRef.current = null }
    setCellHover(null)
  }, [])

  useCloseDropdownsOnTabSwitch(
    useCallback(() => {
      hideCellHover()
      setTrackerEditingField(null)
    }, [hideCellHover])
  )

  // A qué sucursales se envió cada producto y en qué cantidad, derivado de los
  // envíos generados al confirmar la llegada (solo existen una vez "importada").
  const enviosDistribucion = useMemo(() => {
    const envios = Array.isArray(imp?.envios) ? imp.envios : []
    const porProducto = new Map()
    const sucursalesMap = new Map()
    envios.forEach((envio) => {
      const sucursalId = envio.sucursal_id
      const sucursalNombre = envio.sucursal_nombre || (sucursalId != null ? `Sucursal ${sucursalId}` : 'Sucursal')
      if (sucursalId != null) sucursalesMap.set(sucursalId, sucursalNombre)
      ;(envio.detalles || []).forEach((det) => {
        const productoId = det.producto_id
        if (productoId == null) return
        if (!porProducto.has(productoId)) porProducto.set(productoId, [])
        porProducto.get(productoId).push({ sucursalId, sucursalNombre, cantidad: Number(det.cantidad || 0) })
      })
    })
    const sucursales = Array.from(sucursalesMap.entries())
      .map(([id, nombre]) => ({ id, nombre }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
    return { porProducto, sucursales }
  }, [imp?.envios])

  const handleDownloadExcel = useCallback(async () => {
    const { sucursales, porProducto } = enviosDistribucion
    const detallesList = imp?.detalles || []
    const columns = [
      { key: 'codigo', header: 'Código' },
      { key: 'nombre', header: 'Descripción' },
      { key: 'oem', header: 'OEM' },
      { key: 'referencia', header: 'Referencia' },
      { key: 'precio', header: 'Precio' },
      { key: 'cantidad', header: 'Cantidad' },
      ...sucursales.map((s) => ({ key: `suc_${s.id}`, header: s.nombre })),
      { key: 'comentario', header: 'Comentario' },
    ]
    // Mismo orden que en la importacion (d.orden).
    const sortedDetallesList = [...detallesList].sort((a, b) => (Number(a.orden) || 0) - (Number(b.orden) || 0))
    const rows = sortedDetallesList.map((d) => {
      const productoId = d.producto?.id
      const envios = productoId != null ? (porProducto.get(productoId) || []) : []
      const row = {
        codigo: d.producto?.codigo || d.codigo || '-',
        nombre: d.producto?.nombre || d.nombre || '-',
        oem: getProductoOem(d.producto) || d.oem || '-',
        referencia: d.producto?.referencia || d.referencia || '-',
        precio: d.precio_confirmado != null ? Number(d.precio_confirmado).toFixed(2) : '-',
        cantidad: d.cantidad_confirmada ?? d.cantidad ?? '-',
        comentario: d.comentario || '',
      }
      sucursales.forEach((s) => {
        const found = envios.find((e) => e.sucursalId === s.id)
        row[`suc_${s.id}`] = found ? found.cantidad : ''
      })
      return row
    })
    await exportToExcel({
      rows,
      columns,
      valueGetter: (row, key) => row[key],
      fileName: buildFileName(`importacion-${imp?.codigo || imp?.id}`),
    })
  }, [enviosDistribucion, imp?.detalles, imp?.codigo, imp?.id])

  const modalRef = useRef(null)
  const dragData = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const resizeData = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const modalRestoreRef = useRef(null)
  const [position, setPosition] = useState(() => {
    const w = Math.min(680, window.innerWidth - 56)
    const h = Math.min(700, window.innerHeight * 0.88)
    return {
      x: Math.max((window.innerWidth - w) / 2, DETAILS_VIEWPORT_PADDING + 28),
      y: Math.max((window.innerHeight - h) / 2, DETAILS_VIEWPORT_PADDING),
    }
  })
  const [modalSize, setModalSize] = useState(() => ({
    width: Math.min(720, window.innerWidth - 56),
    height: Math.min(700, window.innerHeight * 0.88),
  }))
  const [isMaximized, setIsMaximized] = useState(false)
  const [isResizingModal, setIsResizingModal] = useState(false)
  const positionRef = useRef(position)
  const modalSizeRef = useRef(modalSize)
  useEffect(() => { positionRef.current = position }, [position])
  useEffect(() => { modalSizeRef.current = modalSize }, [modalSize])

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!dragData.current.active) return
      e.preventDefault()
      const modalW = modalRef.current?.offsetWidth || 680
      const modalH = modalRef.current?.offsetHeight || 600
      setPosition({
        x: Math.min(Math.max(e.clientX - dragData.current.offsetX, DETAILS_VIEWPORT_PADDING + 28), window.innerWidth - modalW - DETAILS_VIEWPORT_PADDING),
        y: Math.min(Math.max(e.clientY - dragData.current.offsetY, DETAILS_VIEWPORT_PADDING), window.innerHeight - modalH - DETAILS_VIEWPORT_PADDING),
      })
    }
    const handleMouseUp = () => { dragData.current.active = false }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  useEffect(() => {
    const handleWindowResize = () => {
      const availableWidth = Math.max(0, window.innerWidth - DETAILS_VIEWPORT_PADDING * 2)
      const availableHeight = Math.max(0, window.innerHeight - DETAILS_VIEWPORT_PADDING * 2)
      if (isMaximized) {
        setModalSize({ width: availableWidth, height: availableHeight })
        setPosition({ x: DETAILS_VIEWPORT_PADDING, y: DETAILS_VIEWPORT_PADDING })
        return
      }
      setModalSize((prev) => ({
        width: clamp(prev.width, MIN_WIDTH, availableWidth),
        height: clamp(prev.height, MIN_HEIGHT, availableHeight),
      }))
    }
    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [isMaximized])

  const handleHeaderMouseDown = (e) => {
    if (isMaximized) return
    if (!modalRef.current) return
    const rect = modalRef.current.getBoundingClientRect()
    dragData.current = { active: true, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top }
  }

  const handleResizeMouseDown = (event) => {
    if (isMaximized) return
    event.preventDefault()
    event.stopPropagation()
    setIsResizingModal(true)
    resizeData.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: modalSizeRef.current.width,
      startHeight: modalSizeRef.current.height,
    }
    const handleResizeMove = (moveEvent) => {
      if (!resizeData.current.active) return
      const deltaX = moveEvent.clientX - resizeData.current.startX
      const deltaY = moveEvent.clientY - resizeData.current.startY
      const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - positionRef.current.x - DETAILS_VIEWPORT_PADDING)
      const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - positionRef.current.y - DETAILS_VIEWPORT_PADDING)
      setModalSize({
        width: clamp(resizeData.current.startWidth + deltaX, MIN_WIDTH, maxWidth),
        height: clamp(resizeData.current.startHeight + deltaY, MIN_HEIGHT, maxHeight),
      })
    }
    const handleResizeUp = () => {
      resizeData.current.active = false
      setIsResizingModal(false)
      window.removeEventListener('mousemove', handleResizeMove)
      window.removeEventListener('mouseup', handleResizeUp)
    }
    window.addEventListener('mousemove', handleResizeMove)
    window.addEventListener('mouseup', handleResizeUp)
  }

  const toggleMaximize = () => {
    dragData.current.active = false
    resizeData.current.active = false
    setIsResizingModal(false)
    if (isMaximized) {
      const restore = modalRestoreRef.current
      if (restore) {
        setModalSize(restore.size)
        setPosition(restore.position)
      }
      setIsMaximized(false)
      return
    }
    modalRestoreRef.current = {
      size: { ...modalSizeRef.current },
      position: { ...positionRef.current },
    }
    const availableWidth = Math.max(0, window.innerWidth - DETAILS_VIEWPORT_PADDING * 2)
    const availableHeight = Math.max(0, window.innerHeight - DETAILS_VIEWPORT_PADDING * 2)
    setModalSize({ width: availableWidth, height: availableHeight })
    setPosition({ x: DETAILS_VIEWPORT_PADDING, y: DETAILS_VIEWPORT_PADDING })
    setIsMaximized(true)
  }

  if (!imp) return null
  const detalles = imp.detalles || []
  const sucursalesCols = enviosDistribucion.sucursales
  // Columnas con minmax(px, fr): crecen para llenar el modal, pero nunca por
  // debajo de su mínimo en px. El mínimo es un número fijo (no depende del
  // contenido de cada celda), así que la fila y el header siempre calculan
  // exactamente el mismo ancho total y las columnas quedan alineadas entre
  // filas — para eso la fila usa width:100% + un min-width en px (ver
  // productosMinWidth más abajo) en vez de width:max-content: eso evitaría
  // que el navegador use el contenido real de cada celda para repartir el
  // espacio de las columnas fr, lo que sí desalinearía filas con distinto
  // contenido (comentarios largos, etc.).
  const productosCols = [
    { min: 72, fr: 0.7 }, // Código
    { min: 100, fr: 1 }, // Descripción
    { min: 72, fr: 0.7 }, // OEM
    { min: 82, fr: 0.8 }, // Referencia
    { min: 60, fr: 0.55 }, // Precio
    { min: 70, fr: 0.5 }, // Cantidad
    ...sucursalesCols.map(() => ({ min: 70, fr: 0.5 })),
    { min: 120, fr: 1.2 }, // Comentario
  ]
  const productosGridTemplate = productosCols.map((c) => `minmax(${c.min}px, ${c.fr}fr)`).join(' ')
  const productosMinWidth = productosCols.reduce((sum, c) => sum + c.min, 0)
  const badge = STATUS_BADGE[imp.estado] || { label: imp.estado, color: '#64748b', bg: 'rgba(100,116,139,0.1)' }

  const ribbonClass = imp.estado === 'importada'
    ? 'entrada-details__pending-ribbon--accepted'
    : imp.estado === 'en_camino'
      ? 'entrada-details__pending-ribbon--pending'
      : ''
  const ribbonLabel = imp.estado === 'importada' ? 'Importada' : imp.estado === 'en_camino' ? 'En\ncamino' : badge.label

  const modal = createPortal(
    <div className="create-user__overlay" role="dialog" aria-modal="true" style={{ padding: '16px' }}>
      <Toast ref={toastRef} />
      <div
        ref={modalRef}
        className={`create-user__modal create-salida__modal entrada-details__modal--pending${isResizingModal ? ' create-salida__modal--resizing' : ''}`}
        style={{
          top: position.y,
          left: position.x,
          width: modalSize.width,
          height: modalSize.height,
          minWidth: MIN_WIDTH,
          minHeight: MIN_HEIGHT,
          maxWidth: `calc(100vw - ${DETAILS_VIEWPORT_PADDING * 2}px)`,
          maxHeight: `calc(100dvh - ${DETAILS_VIEWPORT_PADDING * 2}px)`,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div className={`entrada-details__pending-ribbon${ribbonClass ? ` ${ribbonClass}` : ''}`}>
          <span className="entrada-details__pending-ribbon-label">{ribbonLabel}</span>
        </div>
          <header className="create-user__header" onMouseDown={handleHeaderMouseDown}>
            <div className="create-user__header-text">
              <h3>{imp.codigo}</h3>
            </div>
            <div className="create-user__header-actions">
              <button
                type="button"
                className="create-user__icon-button create-user__icon-button--maximize"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={toggleMaximize}
                aria-label={isMaximized ? 'Restaurar' : 'Maximizar'}
              >
                <i className={isMaximized ? 'pi pi-window-minimize' : 'pi pi-window-maximize'} aria-hidden="true" />
              </button>
              <button type="button" className="create-user__icon-button" onMouseDown={(e) => e.stopPropagation()} onClick={onClose} aria-label="Cerrar">
                <i className="pi pi-times" />
              </button>
            </div>
          </header>

          {/* Igual que en EditImportacionModal: mientras se confirma la
              versión más reciente de la importación (fetch al abrir, arriba),
              se tapa el contenido para no mostrar precios/cantidades
              potencialmente desactualizados de la fila que ya tenía la tabla. */}
          {loadingImp && (
            <div className="spinner-container spinner-container--table" style={{ position: 'absolute', inset: 0, zIndex: 20 }}>
              <div className="spinner" />
            </div>
          )}

          <div className="create-user__tabs create-salida__tabs" role="tablist">
            <button type="button" className={`create-user__tab${activeTab === 'general' ? ' create-user__tab--active' : ''}`} onClick={() => setActiveTab('general')}>
              General
            </button>
            <button type="button" className={`create-user__tab${activeTab === 'productos' ? ' create-user__tab--active' : ''}`} onClick={() => setActiveTab('productos')}>
              Productos {detalles.length > 0 && `(${detalles.length})`}
            </button>
          </div>

          <div className="create-user__content create-salida__content">
            <div className="create-user__body">

              {activeTab === 'general' && (
                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">General</p>
                      <h4>Información de la importación</h4>
                    </div>
                  </div>

                  {(imp.estado === 'en_camino' || imp.estado === 'importada') && (
                    <div style={{ marginBottom: 22 }}>
                      <p className="create-user__eyebrow" style={{ marginBottom: 10 }}>
                        {imp.estado === 'importada' ? 'Historial del envío' : 'Seguimiento del envío'}
                      </p>
                      <div className="imp-tracker">
                        {IMPORT_TRACKER_STEPS.map((trackerStep, idx) => {
                          const rawValue = imp[trackerStep.field]
                          const value = trackerStep.isDateTime ? String(rawValue || '').slice(0, 10) : (rawValue || '')
                          const filled = Boolean(value)
                          const isEditable = trackerStep.editable && imp.estado !== 'importada'
                          return (
                            <div key={trackerStep.field} className={`imp-tracker__step${filled ? ' is-filled' : ''}`}>
                              <button
                                type="button"
                                className={`imp-tracker__dot${filled ? ' is-filled' : ''}${isEditable ? ' is-editable' : ''}`}
                                onClick={() => isEditable && openTrackerEditor(trackerStep.field, value)}
                                disabled={!isEditable}
                                title={isEditable ? 'Clic para editar la fecha' : undefined}
                              >
                                {filled ? <Check size={14} /> : idx + 1}
                              </button>
                              <span className="imp-tracker__label">{trackerStep.label}</span>
                              <span className="imp-tracker__date">{value ? formatDate(value) : (trackerStep.editable ? 'Sin definir' : 'Pendiente')}</span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  <div className="create-salida__field-groups">
                    <div className="create-salida__field-group create-salida__field-group--defined">
                      <div className="create-user__grid create-user__grid--two">
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                          <StaticFieldDisplay label="Código" value={imp.codigo} />
                          <StaticFieldDisplay label="Factura" value={imp.numero_factura || '-'} />
                          <StaticFieldDisplay label="Casa comercial" value={formatCasaLabel(imp.casa_comercial)} />
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                          {imp.casa_comercial?.pais?.nombre ? (
                            <div className="create-user__field create-salida__static-field">
                              <span>País</span>
                              <div className="create-salida__static-value" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                {(() => {
                                  const flagUrl = getFlagUrl(imp.casa_comercial.pais?.codigo_pais)
                                  return (
                                    <span className={`create-user__flag${flagUrl ? '' : ' is-empty'}`} aria-hidden="true" style={{ flexShrink: 0 }}>
                                      {flagUrl ? <img src={flagUrl} alt="" /> : '□'}
                                    </span>
                                  )
                                })()}
                                {String(imp.casa_comercial.pais.nombre).trim()}
                              </div>
                            </div>
                          ) : (
                            <StaticFieldDisplay label="País" value="-" />
                          )}
                          {imp.estado === 'importada' ? (
                            <StaticFieldDisplay label="Tiempo de entrega" value={imp.dias_reales_entrega != null ? `${imp.dias_reales_entrega} días` : '-'} />
                          ) : (
                            <StaticFieldDisplay label="Días estimados" value={imp.dias_entrega_estimados != null ? `${imp.dias_entrega_estimados} días` : '-'} />
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </section>
              )}

              {activeTab === 'productos' && (
                <section className="create-user__section">
                  <div className="create-user__section-header">
                    <div>
                      <p className="create-user__eyebrow">Productos</p>
                      <h4>Listado de productos</h4>
                    </div>
                  </div>
                  <ImportProductSearch
                    value={productSearch}
                    onChange={setProductSearch}
                    shown={detalles.filter((d) => importItemMatches(d, productSearch)).length}
                    total={detalles.length}
                  />
                  <div className="imp-details__productos-table-wrap">
                  <div className="create-user__locations-table importaciones-modal__products-table imp-details__productos-table">
                    <div className="create-user__locations-row create-user__locations-row--head imp-details__productos-row" style={{ gridTemplateColumns: productosGridTemplate, width: '100%', minWidth: productosMinWidth }}>
                      <span>Código</span><span>Descripción</span><span>OEM</span><span>Referencia</span><span>Precio</span><span>Cantidad</span>
                      {sucursalesCols.map((s) => <span key={s.id} title={s.nombre}>{shortSucursalLabel(s.nombre)}</span>)}
                      <span>Comentario</span>
                    </div>
                    {!detalles.length ? (
                      <div className="create-user__locations-row create-user__locations-row--empty imp-details__productos-row" style={{ gridTemplateColumns: '1fr' }}><span>Sin productos.</span></div>
                    ) : (productSearch.trim() ? matchesFirst(detalles, (d) => importItemMatches(d, productSearch)) : detalles).map((d, i) => {
                      const sinCat = !d.producto?.id
                      const creadoAqui = !sinCat && d.producto?.creado_desde_importacion === imp.id
                      const codigo = d.producto?.codigo || d.codigo || '-'
                      const nombre = d.producto?.nombre || d.nombre || '-'
                      const oem = String(getProductoOem(d.producto) || d.oem || '').trim() || '-'
                      const oemList = oem !== '-' ? oem.split(',').map((s) => s.trim()).filter(Boolean) : []
                      const referencia = String(d.producto?.referencia || d.referencia || '').trim() || '-'
                      const precio = d.precio_confirmado != null ? `$${Number(d.precio_confirmado).toFixed(2)}` : '-'
                      const cantidad = d.cantidad_confirmada ?? d.cantidad ?? '-'
                      const comentario = d.comentario || '-'
                      const envios = d.producto?.id != null ? (enviosDistribucion.porProducto.get(d.producto.id) || []) : []
                      return (
                        <div key={d.id ?? i} className={`create-user__locations-row imp-details__productos-row${sinCat ? ' importaciones-aceptados__row--no-catalogo' : creadoAqui ? ' importaciones-aceptados__row--nuevo' : ''}`} style={{ gridTemplateColumns: productosGridTemplate, width: '100%', minWidth: productosMinWidth }}>
                          <span
                            className="imp-table-cell-tip"
                            onMouseEnter={(e) => !sinCat && showCellHover(e, codigo, 'Código')}
                            onMouseLeave={hideCellHover}
                          >
                            {sinCat
                              ? <span className="importaciones-aceptados__no-catalogo-badge">Sin catálogo</span>
                              : <span className="imp-table-cell-text imp-table-cell-text--full">{codigo}</span>}
                          </span>
                          <span
                            className="imp-table-cell-tip"
                            onMouseEnter={(e) => showCellHover(e, nombre !== '-' ? nombre : null, 'Descripción')}
                            onMouseLeave={hideCellHover}
                          >
                            <span className="imp-table-cell-text">{nombre}</span>
                          </span>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                            <span
                              className="imp-table-cell-tip"
                              style={{ flex: '1 1 auto', minWidth: 0 }}
                              onMouseEnter={(e) => showCellHover(e, oemList, 'OEM')}
                              onMouseLeave={hideCellHover}
                            >
                              <span className="imp-table-cell-text">{oem}</span>
                            </span>
                            <CoincidenciasInfo matches={coincidenciasByKey[d.id]} />
                          </span>
                          <span
                            className="imp-table-cell-tip"
                            onMouseEnter={(e) => showCellHover(e, referencia !== '-' ? referencia : null, 'Referencia')}
                            onMouseLeave={hideCellHover}
                          >
                            <span className="imp-table-cell-text">{referencia}</span>
                          </span>
                          <span
                            className="imp-table-cell-tip"
                            onMouseEnter={(e) => showCellHover(e, precio !== '-' ? precio : null, 'Precio')}
                            onMouseLeave={hideCellHover}
                          >
                            <span className="imp-table-cell-text">{precio}</span>
                          </span>
                          <span
                            className="imp-table-cell-tip"
                            onMouseEnter={(e) => showCellHover(e, String(cantidad ?? ''), 'Cantidad')}
                            onMouseLeave={hideCellHover}
                          >
                            <span className="imp-table-cell-text" style={{ textAlign: 'center', fontWeight: 600 }}>{cantidad}</span>
                          </span>
                          {sucursalesCols.map((s) => {
                            const found = envios.find((e) => e.sucursalId === s.id)
                            return (
                              <span key={s.id} className="imp-table-cell-text" style={{ textAlign: 'center', fontWeight: 600 }}>
                                {found ? found.cantidad : '-'}
                              </span>
                            )
                          })}
                          <span
                            className="imp-table-cell-tip"
                            onMouseEnter={(e) => showCellHover(e, comentario !== '-' ? comentario : null, 'Comentario')}
                            onMouseLeave={hideCellHover}
                          >
                            <span className="imp-table-cell-text">{comentario}</span>
                          </span>
                        </div>
                      )
                    })}
                  </div>
                  </div>
                </section>
              )}

            </div>
          </div>

          <div className="create-user__footer">
            {Array.isArray(imp.historial_verificacion) && imp.historial_verificacion.length > 0 && (
              <button
                type="button"
                className="create-user__action create-user__action--cancel"
                onClick={() => setShowHistorialVerificacion(true)}
              >
                Verificación
              </button>
            )}
            {(imp.estado === 'en_camino' || imp.estado === 'importada') && Array.isArray(imp.historial_confirmacion) && imp.historial_confirmacion.length > 0 && (
              <button
                type="button"
                className="create-user__action create-user__action--cancel"
                onClick={() => setShowHistorial(true)}
              >
                Historial
              </button>
            )}
            {imp.estado === 'en_camino' && imp.origen_id && (
              <button
                type="button"
                className="create-user__action create-user__action--cancel"
                onClick={() => onOpenOrigen?.(imp.origen_id)}
              >
                Ver confirmación
              </button>
            )}
            {imp.estado === 'en_camino' && canMarcarLlegada && (
              <button
                type="button"
                className="create-user__action create-user__action--primary"
                onClick={() => {
                  if (!imp.fecha_puerto) {
                    toastRef.current?.show({
                      severity: 'warn',
                      summary: 'Falta la fecha de llegada a puerto',
                      detail: 'Registra la fecha de llegada a puerto en el seguimiento del envío antes de marcar la llegada al local.',
                      life: 5000,
                    })
                    return
                  }
                  setShowReceive(true)
                }}
              >
                Llegó importación
              </button>
            )}
            {imp.estado === 'importada' && (
              <button type="button" className="users-circle users-circle--excel" style={{ marginLeft: 'auto' }} title="Descargar Excel" onClick={handleDownloadExcel}>
                <i className="pi pi-file-excel" />
              </button>
            )}
          </div>
          <button
            type="button"
            aria-label="Cambiar tamaño de ventana"
            className="create-user__resize-handle"
            onMouseDown={handleResizeMouseDown}
          />
        </div>
    </div>,
    getPortalRoot()
  )


  return (
    <>
      {modal}
      {cellHover && createPortal(
        <div
          className="imp-cell-hover-card"
          style={{ top: cellHover.top, left: cellHover.left }}
        >
          <div className="imp-cell-hover-card__title">{cellHover.label}</div>
          {cellHover.items.map((value, i) => (
            <div key={i} className="imp-cell-hover-card__row">{value}</div>
          ))}
        </div>,
        getPortalRoot()
      )}
      {showReceive && (
        <ImportacionReceiveModal
          imp={imp}
          token={token}
          onClose={() => setShowReceive(false)}
          onConfirmed={(payload) => { onSaved?.(payload); onClose?.() }}
        />
      )}
      {showHistorial && (
        <HistorialConfirmacionModal imp={imp} onClose={() => setShowHistorial(false)} />
      )}
      {showHistorialVerificacion && (
        <HistorialVerificacionModal imp={imp} onClose={() => setShowHistorialVerificacion(false)} />
      )}
      {trackerEditingField && createPortal(
        <div
          className="create-user__overlay"
          role="dialog"
          aria-modal="true"
          style={{ zIndex: 3000, pointerEvents: 'auto', background: 'rgba(15, 23, 42, 0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onMouseDown={(e) => { if (e.target === e.currentTarget && !trackerSaving) closeTrackerEditor() }}
        >
          <div
            className="create-user__modal"
            style={{ position: 'relative', top: 'auto', left: 'auto', transform: 'none', width: 320, minWidth: 320, height: 'auto', minHeight: 'auto' }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <header className="create-user__header">
              <div className="create-user__header-text">
                <h3>{IMPORT_TRACKER_STEPS.find((s) => s.field === trackerEditingField)?.label || 'Editar fecha'}</h3>
              </div>
              <div className="create-user__header-actions">
                <button type="button" className="create-user__icon-button" onClick={closeTrackerEditor} disabled={trackerSaving} aria-label="Cerrar">
                  <i className="pi pi-times" />
                </button>
              </div>
            </header>
            <div className="create-user__form" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <label className="create-user__field">
                <span>Fecha</span>
                <input
                  type="date"
                  value={trackerDateDraft}
                  onChange={(e) => setTrackerDateDraft(e.target.value)}
                  min={trackerMinDate || undefined}
                  autoFocus
                />
                {trackerMinDate && (
                  <small style={{ color: 'var(--color-text-secondary)' }}>
                    No puede ser anterior a {formatDate(trackerMinDate)}.
                  </small>
                )}
              </label>
              <div className="create-user__footer" style={{ padding: 0, border: 'none' }}>
                <button type="button" className="create-user__action create-user__action--cancel" onClick={closeTrackerEditor} disabled={trackerSaving}>Cancelar</button>
                <button type="button" className="create-user__action create-user__action--primary" onClick={saveTrackerDate} disabled={trackerSaving}>
                  {trackerSaving ? 'Guardando...' : 'Guardar'}
                </button>
              </div>
            </div>
          </div>
        </div>,
        getPortalRoot()
      )}
    </>
  )
}

// Lo que se pidio y lo que no en la verificacion: se guarda al pedir la
// confirmacion (historial_verificacion) porque ahi los quitados se sacan de
// la importacion.
const VERIFICACION_ESTADOS = {
  pedido: { label: 'Pedido', className: '' },
  agregado: { label: 'Agregado', className: ' imp-verificar__row--agregado' },
  quitado: { label: 'No se pidió', className: ' imp-verificar__row--quitado' },
}

function HistorialVerificacionModal({ imp, onClose }) {
  const [productSearch, setProductSearch] = useState('')
  const [filtro, setFiltro] = useState('todos')
  const historial = Array.isArray(imp.historial_verificacion) ? imp.historial_verificacion : []
  const conteo = historial.reduce((acc, row) => ({ ...acc, [row.estado]: (acc[row.estado] || 0) + 1 }), {})
  const visibles = historial.filter((row) => filtro === 'todos' || row.estado === filtro)
  const gridTemplate = '120px minmax(160px, 1fr) 110px 80px 90px 100px minmax(140px, 1fr)'
  const precio = (value) => (value != null && value !== '' ? `$${Number(value).toFixed(2)}` : '-')

  return createPortal(
    <div className="imp-aceptados-popup__overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="imp-aceptados-popup__dialog" style={{ width: 'min(980px, calc(100vw - 32px))' }} onMouseDown={(e) => e.stopPropagation()}>
        <header className="imp-aceptados-popup__header">
          <div>
            <h3>Historial de verificación</h3>
            <p>Qué se pidió y qué no en {imp.codigo}</p>
          </div>
          <button type="button" className="imp-aceptados-popup__close" onClick={onClose} aria-label="Cerrar">
            <i className="pi pi-times" />
          </button>
        </header>

        <div className="imp-aceptados-popup__body">
          <div className="imp-verificar__grupos" role="group" aria-label="Filtrar">
            {[
              ['todos', 'Todos', historial.length, ''],
              ['pedido', 'Pedidos', conteo.pedido || 0, ''],
              ['agregado', 'Agregados', conteo.agregado || 0, ' imp-verificar__grupo--nuevos'],
              ['quitado', 'No se pidieron', conteo.quitado || 0, ' imp-verificar__grupo--eliminados'],
            ].map(([key, label, n, mod]) => (
              <button
                key={key}
                type="button"
                className={`imp-verificar__grupo${mod}${filtro === key ? ' is-active' : ''}`}
                onClick={() => setFiltro(key)}
                aria-pressed={filtro === key}
              >
                {label} <strong>{n}</strong>
              </button>
            ))}
          </div>
          {historial.length > 0 && (
            <ImportProductSearch
              value={productSearch}
              onChange={setProductSearch}
              shown={visibles.filter((row) => importItemMatches(row, productSearch)).length}
              total={visibles.length}
            />
          )}
          <div className="imp-historial__table-wrap">
            <div className="create-user__locations-table importaciones-modal__products-table imp-historial__table">
              <div className="create-user__locations-row create-user__locations-row--head imp-historial__row" style={{ gridTemplateColumns: gridTemplate }}>
                <span>Código</span><span>Descripción</span><span>Referencia</span><span>Cant. aprox.</span><span>PVP Aprox.</span><span>Estado</span><span>Comentario</span>
              </div>
              {visibles.length === 0 ? (
                <div className="create-user__locations-row create-user__locations-row--empty" style={{ gridTemplateColumns: '1fr' }}>
                  <span>{historial.length === 0 ? 'Esta importación no tiene historial de verificación.' : 'No hay productos en este grupo.'}</span>
                </div>
              ) : (productSearch.trim() ? matchesFirst(visibles, (row) => importItemMatches(row, productSearch)) : visibles).map((row, i) => {
                const estado = VERIFICACION_ESTADOS[row.estado] || VERIFICACION_ESTADOS.pedido
                return (
                  <div key={i} className={`create-user__locations-row imp-historial__row${estado.className}`} style={{ gridTemplateColumns: gridTemplate }}>
                    <span><span className="imp-table-cell-text imp-table-cell-text--full">{row.codigo || '-'}</span></span>
                    <span><span className="imp-table-cell-text">{row.nombre || '-'}</span></span>
                    <span><span className="imp-table-cell-text">{row.referencia || '-'}</span></span>
                    <span>{row.estado === 'quitado' ? '-' : (row.cantidad_aproximada ?? '-')}</span>
                    <span>{row.estado === 'quitado' ? '-' : precio(row.precio_estimado)}</span>
                    <span style={{ fontWeight: 600 }}>{estado.label}</span>
                    <span><span className="imp-table-cell-text">{row.comentario || '-'}</span></span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </div>,
    getPortalRoot()
  )
}

function HistorialConfirmacionModal({ imp, onClose }) {
  // Buscador de productos de esta importacion.
  const [productSearch, setProductSearch] = useState('')
  const historial = Array.isArray(imp.historial_confirmacion) ? imp.historial_confirmacion : []
  // A qué sucursales se envió cada producto y en qué cantidad, indexado por
  // código (historial_confirmacion no guarda producto_id, solo el código).
  const distribucion = useMemo(() => {
    const envios = Array.isArray(imp.envios) ? imp.envios : []
    const sucursalesMap = new Map()
    const porCodigo = new Map()
    envios.forEach(envio => {
      const sucursalId = envio.sucursal_id
      const sucursalNombre = envio.sucursal_nombre || (sucursalId != null ? `Sucursal ${sucursalId}` : 'Sucursal')
      if (sucursalId != null) sucursalesMap.set(sucursalId, sucursalNombre)
      ;(envio.detalles || []).forEach(det => {
        const codigo = det.producto_codigo
        if (!codigo) return
        if (!porCodigo.has(codigo)) porCodigo.set(codigo, [])
        porCodigo.get(codigo).push({ sucursalId, sucursalNombre, cantidad: Number(det.cantidad || 0) })
      })
    })
    const sucursales = Array.from(sucursalesMap.entries())
      .map(([id, nombre]) => ({ id, nombre }))
      .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es'))
    return { sucursales, porCodigo }
  }, [imp.envios])
  const historialGridTemplate = [
    '220px', '110px', '70px', '100px', '70px',
    ...distribucion.sucursales.map(() => '90px'),
    '140px',
  ].join(' ')
  const [cellHover, setCellHover] = useState(null)
  const cellHoverTimerRef = useRef(null)
  const showCellHover = useCallback((event, items, label) => {
    const list = (Array.isArray(items) ? items : [items]).filter(Boolean)
    if (!list.length) return
    if (cellHoverTimerRef.current) clearTimeout(cellHoverTimerRef.current)
    const rect = event.currentTarget.getBoundingClientRect()
    cellHoverTimerRef.current = setTimeout(() => {
      cellHoverTimerRef.current = null
      setCellHover({ top: rect.bottom + 4, left: rect.left, items: list, label })
    }, 400)
  }, [])
  const hideCellHover = useCallback(() => {
    if (cellHoverTimerRef.current) { clearTimeout(cellHoverTimerRef.current); cellHoverTimerRef.current = null }
    setCellHover(null)
  }, [])

  useCloseDropdownsOnTabSwitch(hideCellHover)

  return createPortal(
    <>
      <div className="imp-aceptados-popup__overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
        <div className="imp-aceptados-popup__dialog" style={{ width: 'min(920px, calc(100vw - 32px))' }} onMouseDown={(e) => e.stopPropagation()}>
          <header className="imp-aceptados-popup__header">
            <div>
              <h3>Historial de confirmación</h3>
              <p>Revisión guardada al importar {imp.codigo}</p>
            </div>
            <button type="button" className="imp-aceptados-popup__close" onClick={onClose} aria-label="Cerrar">
              <i className="pi pi-times" />
            </button>
          </header>

          <div className="imp-aceptados-popup__body">
            {historial.length > 0 && (
              <ImportProductSearch
                value={productSearch}
                onChange={setProductSearch}
                shown={historial.filter((row) => importItemMatches(row, productSearch)).length}
                total={historial.length}
              />
            )}
            <div className="imp-historial__table-wrap">
            <div className="create-user__locations-table importaciones-modal__products-table imp-historial__table">
              <div className="create-user__locations-row create-user__locations-row--head imp-historial__row" style={{ gridTemplateColumns: historialGridTemplate }}>
                <span>Descripción</span><span>Referencia</span><span>Cant.</span><span>Precio conf.</span><span>Estado</span>
                {distribucion.sucursales.map((suc) => <span key={suc.id} title={suc.nombre}>{shortSucursalLabel(suc.nombre)}</span>)}
                <span>Comentario</span>
              </div>
              {historial.length === 0 ? (
                <div className="create-user__locations-row create-user__locations-row--empty" style={{ gridTemplateColumns: '1fr' }}>
                  <span>No hay historial de confirmación para esta importación.</span>
                </div>
              ) : (productSearch.trim() ? matchesFirst(historial, (row) => importItemMatches(row, productSearch)) : historial).map((row, i) => {
                const envios = distribucion.porCodigo.get(row.codigo) || []
                return (
                <div key={i} className="create-user__locations-row imp-historial__row" style={{ gridTemplateColumns: historialGridTemplate }}>
                  <span
                    className="imp-table-cell-tip"
                    onMouseEnter={(e) => showCellHover(e, row.nombre, 'Descripción')}
                    onMouseLeave={hideCellHover}
                  >
                    <span className="imp-table-cell-text">{row.nombre || '-'}</span>
                  </span>
                  <span
                    className="imp-table-cell-tip"
                    onMouseEnter={(e) => showCellHover(e, row.referencia, 'Referencia')}
                    onMouseLeave={hideCellHover}
                  >
                    <span className="imp-table-cell-text">{row.referencia || '-'}</span>
                  </span>
                  <span className="imp-table-cell-text" style={{ textAlign: 'center', fontWeight: 600 }}>{row.cantidad_confirmada ?? row.cantidad ?? '-'}</span>
                  <span className="imp-table-cell-text" style={{ textAlign: 'right', fontWeight: 600 }}>{row.precio_confirmado != null ? `$${Number(row.precio_confirmado).toFixed(2)}` : '-'}</span>
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {row.estado === 'check' ? (
                      <Check size={15} style={{ color: '#16a34a' }} />
                    ) : row.estado === 'x' ? (
                      <X size={15} style={{ color: '#dc2626' }} />
                    ) : (
                      <span style={{ color: '#94a3b8' }}>-</span>
                    )}
                  </span>
                  {distribucion.sucursales.map((suc) => {
                    const found = envios.find((e) => e.sucursalId === suc.id)
                    return (
                      <span key={suc.id} className="imp-table-cell-text" style={{ textAlign: 'center', fontWeight: 600 }}>
                        {found ? found.cantidad : '-'}
                      </span>
                    )
                  })}
                  <span
                    className="imp-table-cell-tip"
                    onMouseEnter={(e) => showCellHover(e, row.comentario, 'Comentario')}
                    onMouseLeave={hideCellHover}
                  >
                    <span className="imp-table-cell-text">{row.comentario || '-'}</span>
                  </span>
                </div>
                )
              })}
            </div>
            </div>
          </div>

          <div className="imp-aceptados-popup__footer" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="create-user__action create-user__action--cancel" onClick={onClose}>Cerrar</button>
          </div>
        </div>
      </div>
      {cellHover && createPortal(
        <div
          className="imp-cell-hover-card"
          style={{ top: cellHover.top, left: cellHover.left }}
        >
          <div className="imp-cell-hover-card__title">{cellHover.label}</div>
          {cellHover.items.map((value, i) => (
            <div key={i} className="imp-cell-hover-card__row">{value}</div>
          ))}
        </div>,
        getPortalRoot()
      )}
    </>,
    getPortalRoot()
  )
}

// Si el OEM de una fila sin catálogo ya está registrado en un producto que
// pertenece a la MISMA casa comercial de este import, no es un producto
// nuevo: el backend solo no lo detectó porque el Excel no traía código ni
// una referencia que calzara. Se usa ese producto ya existente tal cual.
// También se revisan sus "alternos" (ProductoAlterno): si el match directo
// por OEM es de otra casa pero uno de sus alternos ya es de la casa
// actual, ese alterno ES el producto existente — no hay que sugerir un
// código nuevo, hay que usar el que ya existe.
const findExistingMatchForCasa = (row, casaCodigo) => {
  const targetSuffix = (casaCodigo || '').trim().toUpperCase()
  if (!targetSuffix) return null
  const belongsToCasa = (candidate) =>
    (candidate.casas_comerciales_codigos || []).some(
      (c) => (c || '').trim().toUpperCase() === targetSuffix
    )
  for (const match of row.oem_matches || []) {
    if (belongsToCasa(match)) return match
    const alterno = (match.alternos || []).find(belongsToCasa)
    if (alterno) return alterno
  }
  return null
}

// Los códigos JP se arman como <base><sufijo de casa comercial>. Si el OEM
// de una fila sin catálogo ya está registrado en un producto de OTRA casa
// comercial (y ninguno pertenece ya a la casa actual), se toma su código,
// se le quita el sufijo de esa otra casa (buscando cuál de sus casas
// comerciales calza como terminación) y se le pega el sufijo de la casa
// comercial seleccionada en este import — así el producto pendiente nace
// con el código que le correspondería en esta casa.
// Además del match directo por OEM, también se revisan sus "alternos"
// (ProductoAlterno): son la misma pieza física en otra casa aunque no
// compartan el OEM en el catálogo, así que sirven igual como fuente del
// patrón <base><sufijo>.
// Largo fijo del "base" de un código JP (p. ej. "C1130" o "P1631": una
// letra + 4 dígitos). Se usa como respaldo cuando el código no termina
// limpiamente en el sufijo de casa conocido (p. ej. "C1130CL-L" no
// termina en "CL", termina en "-L" — un calificador extra tipo lado
// izq./der. que no es parte del sufijo de casa).
const CODIGO_BASE_LENGTH = 5

// Calificador de lado (izq./der.) que va DESPUÉS del sufijo de casa, p. ej.
// "C1130CL-L". Se separa del código antes de buscar el sufijo de casa y se
// vuelve a pegar al final del código sugerido ("C1130" + casa + "-L").
const LADO_SUFFIX_RE = /\s*-\s*([LR])$/

const splitLado = (codigo) => {
  const m = codigo.match(LADO_SUFFIX_RE)
  if (!m) return { codigo, lado: '' }
  return { codigo: codigo.slice(0, m.index), lado: `-${m[1]}` }
}

// Devuelve { codigo, fuente } (fuente = el producto del que salió la
// sugerencia, para mostrar su precio como PVP JP) o null.
const deriveSuggestedCodigo = (row, casaCodigo) => {
  const targetSuffix = (casaCodigo || '').trim().toUpperCase()
  if (!targetSuffix) return null
  const allCandidates = []
  for (const match of row.oem_matches || []) {
    allCandidates.push(match, ...(match.alternos || []))
  }
  for (const candidate of allCandidates) {
    const { codigo: candidateCodigo, lado } = splitLado((candidate.codigo || '').trim().toUpperCase())
    if (!candidateCodigo) continue
    for (const otherSuffix of candidate.casas_comerciales_codigos || []) {
      const suffix = (otherSuffix || '').trim().toUpperCase()
      if (!suffix || suffix === targetSuffix) continue
      if (candidateCodigo.endsWith(suffix)) {
        const base = candidateCodigo.slice(0, candidateCodigo.length - suffix.length)
        if (base) return { codigo: `${base}${targetSuffix}${lado}`, fuente: candidate }
      }
    }
  }
  // Respaldo: si ningún candidato termina limpiamente en un sufijo de
  // casa conocido (p. ej. porque el código trae un calificador extra
  // después del sufijo, o porque la casa del producto no tiene código
  // registrado), se usa el largo fijo del base en vez de intentar
  // adivinar dónde termina el sufijo.
  for (const candidate of allCandidates) {
    const { codigo: candidateCodigo, lado } = splitLado((candidate.codigo || '').trim().toUpperCase())
    if (candidateCodigo.length > CODIGO_BASE_LENGTH) {
      const base = candidateCodigo.slice(0, CODIGO_BASE_LENGTH)
      return { codigo: `${base}${targetSuffix}${lado}`, fuente: candidate }
    }
  }
  return null
}

// Completa una fila que devolvió el parser del Excel (parse-excel-*) igual que
// en la sugerencia: si el OEM ya es de un producto de esta casa se usa ese
// producto; si es de otra casa se sugiere el código con el sufijo de esta casa
// (amarillo) y su precio/casa quedan como PVP JP. Si no trae descripción se
// precarga con la de la primera coincidencia por OEM.
// Contadores de la vista previa del Excel y de la sugerencia guardada (los
// mismos en las dos): "N encontrados" (vinculados al catalogo, coinciden solo
// por OEM, coinciden por referencia o codigo) y "N no encontrados" (sin
// catalogo) con "Quitar todos". chipProps(grupo, texto) hace clicable cada
// contador para ir a sus filas.
// Contadores de la verificacion, con el mismo formato que los de la
// sugerencia (ImportGroupsSummary) y los colores de las filas. Cada chip lleva
// a la siguiente fila de ese grupo. conteo: { catalogo, noExiste,
// agregadoExiste, agregadoNuevo, quitado }.
function VerificacionGroupsSummary({ conteo, chipProps }) {
  const enLista = (conteo.catalogo || 0) + (conteo.noExiste || 0) + (conteo.agregadoExiste || 0) + (conteo.agregadoNuevo || 0)
  const quitados = conteo.quitado || 0
  if (!enLista && !quitados) return null
  const caja = { display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 12px', border: '1px solid var(--color-border)', borderRadius: 10, background: 'var(--color-surface)' }
  const titulo = { fontSize: 'var(--font-size-sm)', fontWeight: 700, color: 'var(--color-text-primary)' }
  const chip = { borderRadius: 20, padding: '2px 10px', fontSize: 'var(--font-size-sm)', fontWeight: 600 }
  const plural = (n, uno, varios) => `${n} ${n !== 1 ? varios : uno}`
  const chips = [
    ['catalogo', plural(conteo.catalogo || 0, 'del catálogo', 'del catálogo'), 'los productos del catálogo', { background: '#ffffff', color: '#334155', border: '1px solid #cbd5e1' }],
    ['noExiste', plural(conteo.noExiste || 0, 'no existe en el catálogo', 'no existen en el catálogo'), 'los que no existen en el catálogo', { background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d' }],
    ['agregadoExiste', plural(conteo.agregadoExiste || 0, 'agregado (ya existe)', 'agregados (ya existen)'), 'los agregados que ya existen', { background: '#dcfce7', color: '#15803d', border: '1px solid #86efac' }],
    ['agregadoNuevo', plural(conteo.agregadoNuevo || 0, 'agregado (nuevo)', 'agregados (nuevos)'), 'los agregados nuevos', { background: '#ccfbf1', color: '#0f766e', border: '1px solid #5eead4' }],
  ]
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'stretch' }}>
      {enLista > 0 && (
        <div style={{ ...caja, flex: '1 1 auto' }}>
          <span style={titulo}>{enLista} en la lista</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {chips.filter(([key]) => conteo[key] > 0).map(([key, texto, label, colores]) => (
              <span key={key} {...chipProps(key, label)} title={`Clic: ir a ${label}`} style={{ ...chip, ...colores }}>
                {texto}
              </span>
            ))}
          </div>
        </div>
      )}
      {quitados > 0 && (
        <div style={caja}>
          <span style={titulo}>{plural(quitados, 'quitado', 'quitados')}</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span {...chipProps('quitado', 'los quitados')} title="Clic: ir a los quitados (no pasan a confirmación)" style={{ ...chip, background: '#fee2e2', color: '#b91c1c', border: '1px solid #fca5a5' }}>
              {plural(quitados, 'no pasa a confirmación', 'no pasan a confirmación')}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function ImportGroupsSummary({ vinculados = 0, oem = 0, otraCasa = 0, codigoNuevo = 0, sinCatalogo = 0, chipProps, onQuitarTodos }) {
  const [confirmarQuitar, setConfirmarQuitar] = useState(false)
  // Completos: los del catalogo, los sugeridos y los que ya traen un codigo
  // nuevo (del Excel o escrito). Sin codigo: lo unico que falta completar.
  const completos = vinculados + oem + otraCasa + codigoNuevo
  const noEncontrados = sinCatalogo
  if (!completos && !noEncontrados) return null
  const caja = { display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 12px', border: '1px solid var(--color-border)', borderRadius: 10, background: 'var(--color-surface)' }
  const titulo = { fontSize: 'var(--font-size-sm)', fontWeight: 700, color: 'var(--color-text-primary)' }
  const chip = { borderRadius: 20, padding: '2px 10px', fontSize: 'var(--font-size-sm)', fontWeight: 600 }
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'stretch' }}>
      {completos > 0 && (
        <div style={{ ...caja, flex: '1 1 auto' }}>
          <span style={titulo} title="Vinculados al catálogo + coinciden por OEM o referencia + con código nuevo">
            {completos} completo{completos !== 1 ? 's' : ''}
          </span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {vinculados > 0 && (
              <span {...chipProps('vinculados', 'los vinculados al catálogo')} title="Clic: ir a los vinculados al catálogo" style={{ ...chip, background: '#dcfce7', color: '#15803d' }}>
                {vinculados} vinculado{vinculados !== 1 ? 's' : ''} al catálogo
              </span>
            )}
            {oem > 0 && (
              <span {...chipProps('oem', 'los productos con código sugerido')} title="Clic: ir a ellos." style={{ ...chip, background: '#fef9c3', color: '#854d0e', border: '1px solid #fde047' }}>
                {oem} coinciden solo por OEM
              </span>
            )}
            {otraCasa > 0 && (
              <span {...chipProps('otraCasa', 'los que ya existen en otra casa')} title="Clic: ir a ellos." style={{ ...chip, background: '#ffedd5', color: '#9a3412', border: '1px solid #fdba74' }}>
                {otraCasa} coinciden por referencia o código
              </span>
            )}
            {codigoNuevo > 0 && (
              <span {...chipProps('codigoNuevo', 'los productos nuevos con código')} title="Clic: ir a los productos nuevos que ya tienen código (todavía no están en el sistema)" style={{ ...chip, background: '#e0e7ff', color: '#3730a3', border: '1px solid #a5b4fc' }}>
                {codigoNuevo} nuevo{codigoNuevo !== 1 ? 's' : ''} con código
              </span>
            )}
          </div>
        </div>
      )}
      {noEncontrados > 0 && (
        <div style={caja}>
          <span style={titulo}>{noEncontrados} sin código</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {sinCatalogo > 0 && (
              <span {...chipProps('sinCatalogo', 'los productos sin código')} title="Clic: ir a los productos sin código" style={{ ...chip, background: '#f1f5f9', color: '#64748b' }}>
                {sinCatalogo} sin código
              </span>
            )}
            {onQuitarTodos && (
              <button
                type="button"
                className="imp-excel-review__quitar-todos"
                onClick={() => setConfirmarQuitar(true)}
                title="Quita de la sugerencia todos los productos que no tienen código"
              >
                <X size={13} /> Quitar todos
              </button>
            )}
          </div>
        </div>
      )}
      {confirmarQuitar && createPortal(
        <div className="user-details__confirm-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirmarQuitar(false) }}>
          <div className="user-details__confirm-dialog">
            <div className="user-details__confirm-icon">
              <Info size={18} />
            </div>
            <div className="user-details__confirm-content">
              <h4>Quitar productos sin código</h4>
              <p>¿Estás seguro que quieres quitar los <strong>{noEncontrados}</strong> producto{noEncontrados !== 1 ? 's' : ''} sin código de la lista?</p>
            </div>
            <div className="user-details__confirm-actions">
              <button type="button" className="create-user__action create-user__action--cancel" onClick={() => setConfirmarQuitar(false)}>
                Cancelar
              </button>
              <button
                type="button"
                className="create-user__action user-details__confirm-danger"
                onClick={() => { setConfirmarQuitar(false); onQuitarTodos() }}
              >
                Quitar todos
              </button>
            </div>
          </div>
        </div>,
        getPortalRoot()
      )}
    </div>
  )
}

// Excel de revision de una sugerencia: el mismo del Paso 3 de "Sugerencia
// desde Excel" y el que se descarga desde una sugerencia guardada. Cada fila:
// { codigo, referencia, oem, descripcion, cantidad, pvpJp, pvpJpCasa, pvp,
// pvpCasa, nota, isConflict, isSuggested, key? }. Si las filas traen key se
// agrega una columna _key oculta al final (para emparejar al subirlo).
// Encabezados con los mismos nombres (y orden) que el Excel de Verificacion.
const SUGERENCIA_EXCEL_HEADERS = [
  'Código', 'Descripción', 'OEM', 'Referencia', 'PVP JP', 'Cantidad',
  'PVP APROX.', 'Casa PVP JP', 'Casa PVP APROX.', 'Nota',
]

const downloadSugerenciaExcel = async (rows, fileName) => {
  const XLSXStyle = (await import('xlsx-js-style')).default
  const withKey = rows.some((r) => r.key != null)
  const headers = withKey ? [...SUGERENCIA_EXCEL_HEADERS, '_key'] : SUGERENCIA_EXCEL_HEADERS
  const headerStyle = {
    font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 },
    fill: { fgColor: { rgb: '1A1A2E' }, patternType: 'solid' },
    alignment: { horizontal: 'center', vertical: 'center' },
    border: {
      top: { style: 'thin', color: { rgb: '2563EB' } },
      bottom: { style: 'medium', color: { rgb: '2563EB' } },
      left: { style: 'thin', color: { rgb: '2563EB' } },
      right: { style: 'thin', color: { rgb: '2563EB' } },
    },
  }
  const borderStyle = { style: 'thin', color: { rgb: 'DBEAFE' } }
  const border = { top: borderStyle, bottom: borderStyle, left: borderStyle, right: borderStyle }
  const yellowFill = { fgColor: { rgb: 'FEF08A' }, patternType: 'solid' }
  const orangeFill = { fgColor: { rgb: 'FFEDD5' }, patternType: 'solid' }
  const aoa = [
    headers,
    ...rows.map((r) => [
      r.codigo, r.descripcion, r.oem, r.referencia, r.pvpJp, r.cantidad,
      r.pvp, r.pvpJpCasa, r.pvpCasa, r.nota,
      ...(withKey ? [r.key ?? ''] : []),
    ]),
  ]
  const worksheet = XLSXStyle.utils.aoa_to_sheet(aoa)
  headers.forEach((_, ci) => {
    const ref = XLSXStyle.utils.encode_cell({ r: 0, c: ci })
    if (worksheet[ref]) worksheet[ref].s = ci < SUGERENCIA_EXCEL_HEADERS.length ? headerStyle : { font: { sz: 8, color: { rgb: 'AAAAAA' } } }
  })
  rows.forEach((r, i) => {
    const ri = i + 1
    for (let ci = 0; ci < SUGERENCIA_EXCEL_HEADERS.length; ci++) {
      const ref = XLSXStyle.utils.encode_cell({ r: ri, c: ci })
      if (!worksheet[ref]) worksheet[ref] = { t: 's', v: '' }
      worksheet[ref].s = {
        border,
        alignment: { vertical: 'center' },
        // Mismos colores de fila que en pantalla: naranja = otra casa,
        // amarillo = código sugerido por OEM.
        ...(r.isConflict ? { fill: orangeFill } : r.isSuggested ? { fill: yellowFill } : {}),
      }
    }
  })
  worksheet['!cols'] = [
    { wch: 14 }, { wch: 32 }, { wch: 16 }, { wch: 16 }, { wch: 11 }, { wch: 10 },
    { wch: 12 }, { wch: 20 }, { wch: 20 }, { wch: 34 },
    ...(withKey ? [{ wch: 0, hidden: true }] : []),
  ]
  worksheet['!rows'] = [{ hpt: 22 }]
  const workbook = XLSXStyle.utils.book_new()
  XLSXStyle.utils.book_append_sheet(workbook, worksheet, 'Revisión')
  const out = XLSXStyle.write(workbook, { bookType: 'xlsx', type: 'array' })
  const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = fileName
  document.body.appendChild(link); link.click(); document.body.removeChild(link)
  URL.revokeObjectURL(link.href)
}

// Popup "Aceptados de solicitudes": un aceptado ya esta en la lista si su
// producto (o, sin catalogo, su solicitud) ya esta en los detalles.
const isAceptadoAgregado = (item, addedIds, addedSolIds) => (item.producto_id
  ? addedIds.has(String(item.producto_id))
  : addedSolIds.has(String(item.solicitud_id)))

const getAceptadosCambios = (items, selected, addedIds, addedSolIds) => {
  const toAdd = []
  const toRemove = []
  for (const item of items) {
    const agregado = isAceptadoAgregado(item, addedIds, addedSolIds)
    const marcado = selected.has(item.solicitud_id)
    if (agregado && !marcado) toRemove.push(item)
    else if (!agregado && marcado) toAdd.push(item)
  }
  return { toAdd, toRemove }
}

const getAceptadosConfirmLabel = ({ toAdd, toRemove }) => {
  if (toAdd.length && toRemove.length) return `Guardar (+${toAdd.length} / −${toRemove.length})`
  if (toRemove.length) return `Quitar (${toRemove.length})`
  if (toAdd.length) return `Agregar (${toAdd.length})`
  return 'Sin cambios'
}

// Estado de un aceptado frente a la lista actual: ya agregado, se agregara,
// se quitara o no agregado (segun lo marcado en el popup).
function AceptadoEstadoChip({ agregado, marcado }) {
  const [texto, mod] = agregado
    ? (marcado ? ['Agregado', 'agregado'] : ['Se quitará', 'quitar'])
    : (marcado ? ['Se agregará', 'agregar'] : ['No agregado', 'no'])
  return <span className={`importaciones-aceptados__estado importaciones-aceptados__estado--${mod}`}>{texto}</span>
}

const enrichParsedRow = (row, casaCodigo) => {
  const withFirstMatchDescripcion = (r) => {
    if (String(r.descripcion || '').trim()) return r
    const firstMatchName = (r.oem_matches || [])[0]?.nombre || ''
    return firstMatchName ? { ...r, descripcion: firstMatchName } : r
  }
  // Naranja (ya existe en otra casa) recibe codigo sugerido igual que
  // amarillo: si el Excel no trae codigo, o si el que trae es el del
  // producto de la otra casa (crearlo asi repetiria su codigo).
  const codigoDeOtraCasa = Boolean(row.conflicto_casa && row.codigo) && (row.oem_matches || []).some(
    (match) => String(match.codigo || '').trim().toUpperCase() === String(row.codigo).trim().toUpperCase()
  )
  if (row.matched_producto_id || (row.codigo && !codigoDeOtraCasa)) return withFirstMatchDescripcion(row)
  const existing = findExistingMatchForCasa(row, casaCodigo)
  if (existing) {
    // El OEM ya está vinculado a un producto de esta misma casa: es el
    // mismo producto, el backend solo no lo detectó porque el Excel no
    // traía código ni una referencia que calzara.
    return withFirstMatchDescripcion({
      ...row,
      codigo: existing.codigo,
      referencia: row.referencia || existing.referencia || '',
      descripcion: row.descripcion || existing.nombre || '',
      matched_producto_id: existing.producto_id,
      matched_producto_codigo: existing.codigo,
      matched_producto_nombre: existing.nombre,
      matched_producto_referencia: existing.referencia,
      matched_producto_precio: existing.precio ?? null,
    })
  }
  const suggested = deriveSuggestedCodigo(row, casaCodigo)
  if (suggested) {
    return withFirstMatchDescripcion({
      ...row,
      codigo: suggested.codigo,
      codigo_sugerido: true,
      sugerido_precio: suggested.fuente?.precio ?? null,
      sugerido_desde: suggested.fuente?.codigo || '',
      sugerido_casa: (suggested.fuente?.casas_comerciales_nombres || []).join(', '),
    })
  }
  return withFirstMatchDescripcion(row)
}

// Manda un Excel al backend para buscar cada fila en el catálogo (por código,
// referencia u OEM). El backend lo procesa en segundo plano y reporta el
// progreso (0-100); se hace polling hasta que quede listo o falle. Devuelve
// null si se cancela.
const runParseExcelJob = async ({ file, fileName, casaId, token, onProgress, isCancelled = () => false }) => {
  const formData = new FormData()
  if (fileName) formData.append('file', file, fileName)
  else formData.append('file', file)
  formData.append('casa_comercial_id', casaId)
  const startResp = await fetch(`${API_URL}/importaciones/importaciones/parse-excel-iniciar/`, {
    method: 'POST',
    headers: { Authorization: `Token ${token}` },
    body: formData,
  })
  const startData = await startResp.json().catch(() => ({}))
  if (!startResp.ok) throw new Error(startData.detail || 'Error al procesar el archivo.')
  const jobId = startData.job_id
  while (true) {
    if (isCancelled()) return null
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (isCancelled()) return null
    const statusResp = await fetch(`${API_URL}/importaciones/importaciones/parse-excel-estado/${jobId}/`, {
      headers: { Authorization: `Token ${token}` },
    })
    const statusData = await statusResp.json().catch(() => ({}))
    if (!statusResp.ok) throw new Error(statusData.detail || 'Error al procesar el archivo.')
    onProgress?.(statusData.progreso || 0)
    if (statusData.estado === 'listo') return statusData
    if (statusData.estado === 'error') throw new Error(statusData.detail || 'Error al procesar el archivo.')
  }
}

// Fila "Agregar" de la tabla de una sugerencia: buscador de productos del
// catalogo de la casa. Lo que ya esta en la lista sale arriba para ir a su
// fila. `listed` = [{ key, codigo, nombre, cantidad, productoId, texto }].
function SugerenciaProductPicker({ token, casaNombre, value, onSelect, listed = [], onJumpTo }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState([])
  const [loading, setLoading] = useState(false)
  const [panelStyle, setPanelStyle] = useState(null)
  const triggerRef = useRef(null)
  const panelRef = useRef(null)
  const requestIdRef = useRef(0)

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) { setPanelStyle(null); return }
    const rect = triggerRef.current.getBoundingClientRect()
    const panelMaxHeight = Math.min(280, window.innerHeight - rect.bottom - 8)
    const panelWidth = Math.min(Math.max(rect.width, 520), window.innerWidth - VIEWPORT_PADDING * 2)
    const panelLeft = clamp(rect.left, VIEWPORT_PADDING, Math.max(window.innerWidth - panelWidth - VIEWPORT_PADDING, VIEWPORT_PADDING))
    setPanelStyle({ position: 'fixed', top: rect.bottom + 4, left: panelLeft, width: panelWidth, maxHeight: Math.max(panelMaxHeight, 120), zIndex: 12000 })
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const handleMouseDown = (event) => {
      if (triggerRef.current?.contains(event.target) || panelRef.current?.contains(event.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [open])

  useEffect(() => {
    if (!open || !token) return undefined
    const handle = setTimeout(() => {
      const requestId = ++requestIdRef.current
      setLoading(true)
      const params = new URLSearchParams()
      params.set('page_size', '10')
      params.set('modulo', 'solicitudes')
      if (query.trim()) params.set('search', query.trim())
      if (casaNombre) params.set('casa_comercial', casaNombre)
      authFetch(`${API_URL}/productos/listado/?${params.toString()}`, {}, token)
        .then((r) => (r.ok ? r.json() : null))
        .then((payload) => { if (requestId === requestIdRef.current) setOptions(parseApiList(payload)) })
        .catch(() => { if (requestId === requestIdRef.current) setOptions([]) })
        .finally(() => { if (requestId === requestIdRef.current) setLoading(false) })
    }, 280)
    return () => clearTimeout(handle)
  }, [open, query, token, casaNombre])

  const term = query.trim().toLowerCase()
  const listedMatches = term.length < 2 ? [] : listed.filter((item) => String(item.texto || '').toLowerCase().includes(term)).slice(0, 6)
  const listedIds = new Set(listed.map((item) => item.productoId).filter(Boolean).map(String))
  const close = () => { setOpen(false); setQuery(''); setOptions([]) }

  return (
    <div className="create-user__dropdown create-salida__product-dropdown" ref={triggerRef}>
      <button type="button" className="create-user__dropdown-trigger" onClick={() => { setOpen((prev) => !prev); setQuery('') }}>
        <span>{value ? String(value.codigo || '').trim() : 'Selecciona un código'}</span>
        <i className={`pi pi-chevron-${open ? 'up' : 'down'}`} />
      </button>
      {open && panelStyle && createPortal(
        <div ref={panelRef} className="create-user__dropdown-panel" style={panelStyle}>
          <div className="create-user__dropdown-search">
            <i className="pi pi-search" />
            <input type="text" placeholder="Buscar código o nombre" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus autoComplete="off" />
          </div>
          <div className="create-user__dropdown-results">
            {loading && <small className="muted">Buscando productos...</small>}
            {listedMatches.length > 0 && (
              <div className="imp-listed-matches">
                <small className="imp-listed-matches__title">Ya en la lista — toca para ir a la fila</small>
                {listedMatches.map((item) => (
                  <button key={`listed-${item.key}`} type="button" className="create-salida__result-row imp-listed-matches__row" onMouseDown={(e) => e.preventDefault()} onClick={() => { close(); onJumpTo?.(item.key) }}>
                    <span className="result-codigo">{item.codigo}</span>
                    <span className="result-nombre">{item.nombre}</span>
                    <span className="result-stock">{`Cant. ${Number(item.cantidad || 0)}`}</span>
                  </button>
                ))}
              </div>
            )}
            {!loading && term && !options.length && !listedMatches.length && <small className="muted">Sin resultados.</small>}
            {options.length > 0 && (
              <div className="create-salida__results-header"><span>Código</span><span>Descripción</span><span>Stock</span></div>
            )}
            {options.map((product) => {
              const isAlreadyAdded = listedIds.has(String(product.id))
              return (
                <button
                  key={product.id}
                  type="button"
                  className={`create-salida__result-row${isAlreadyAdded ? ' is-added' : ''}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    close()
                    if (isAlreadyAdded) {
                      const existing = listed.find((item) => String(item.productoId) === String(product.id))
                      onJumpTo?.(existing?.key)
                      return
                    }
                    onSelect(product)
                  }}
                  data-title={isAlreadyAdded ? 'Ya está en la lista: ir a la fila' : undefined}
                >
                  <span className="result-codigo">{String(product.codigo || '').trim()}</span>
                  <span className="result-nombre">{String(product.nombre || '').trim()}</span>
                  <span className="result-stock">{Number(product.total_stock ?? 0)}</span>
                </button>
              )
            })}
          </div>
        </div>,
        getPortalRoot()
      )}
    </div>
  )
}

const NUEVO_PRODUCTO_VACIO = { oem: '', referencia: '', nombre: '', precio: '' }

// Popup "+ Agregar nuevo producto" de una sugerencia. Basta con el OEM o la
// referencia (al menos uno); descripcion y precio son opcionales. Al
// agregarlo se busca en el catalogo, como una fila del Excel, y de ahi sale el
// codigo JP sugerido y la descripcion. onAdd(producto) es async y devuelve los
// errores por campo ({ referencia: '...' }) si no se puede agregar.
function SugerenciaNuevoProductoPopup({ onClose, onAdd, notify }) {
  const [draft, setDraft] = useState(NUEVO_PRODUCTO_VACIO)
  const [errors, setErrors] = useState({})
  const [adding, setAdding] = useState(false)

  const setCampo = (field, value) => {
    setDraft((prev) => ({ ...prev, [field]: value }))
    setErrors((prev) => ({ ...prev, [field]: undefined, identificador: undefined }))
  }

  const handleAdd = async () => {
    const oem = draft.oem.trim()
    const referencia = draft.referencia.trim()
    if (!oem && !referencia) {
      setErrors({ identificador: 'Escribe el OEM o la referencia (al menos uno).' })
      notify?.('error', 'Falta OEM o referencia', 'Escribe el OEM o la referencia del producto (al menos uno).')
      return
    }
    const precio = draft.precio !== '' ? Number(draft.precio) : null
    if (precio != null && (!Number.isFinite(precio) || precio < 0)) {
      setErrors({ precio: 'El precio no puede ser negativo' })
      return
    }
    setAdding(true)
    try {
      const fieldErrors = await onAdd({ oem, referencia, nombre: draft.nombre.trim(), precio })
      if (fieldErrors) setErrors(fieldErrors)
    } finally {
      setAdding(false)
    }
  }

  const sinIdentificador = Boolean(errors.identificador)
  const campo = (field, label, { placeholder = '', type = 'text', autoFocus = false, invalid = false } = {}) => {
    const error = errors[field]
    return (
      <label className={`create-user__field${error || invalid ? ' create-user__field--invalid' : ''}`}>
        <span>{label}</span>
        <input
          type={type}
          {...(type === 'number' ? { min: '0', step: '0.01' } : {})}
          value={draft[field]}
          onChange={(e) => setCampo(field, e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAdd() } }}
          placeholder={placeholder}
          autoComplete="off"
          autoFocus={autoFocus}
        />
        {error && <small style={{ color: '#dc2626' }}>{error}</small>}
      </label>
    )
  }

  return createPortal(
    <div className="imp-aceptados-popup__overlay" style={{ zIndex: 2200 }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="imp-aceptados-popup__dialog imp-nuevo-producto-popup__dialog">
        <header className="imp-aceptados-popup__header">
          <div>
            <h3>Agregar nuevo producto</h3>
            <p>Con el OEM o la referencia se busca en el catálogo y se sugiere el código JP y la descripción.</p>
          </div>
          <button type="button" className="imp-aceptados-popup__close" onClick={onClose} aria-label="Cerrar">
            <i className="pi pi-times" />
          </button>
        </header>
        <div className="imp-aceptados-popup__body">
          <div className="create-user__grid create-user__grid--two" style={{ padding: '4px 0' }}>
            {campo('oem', 'OEM', { placeholder: 'Código OEM', autoFocus: true, invalid: sinIdentificador })}
            {campo('referencia', 'Referencia', { placeholder: 'Referencia del producto', invalid: sinIdentificador })}
            {sinIdentificador && (
              <small style={{ color: '#dc2626', gridColumn: '1 / -1', marginTop: -6 }}>{errors.identificador}</small>
            )}
            {campo('nombre', 'Descripción (opcional)', { placeholder: 'Se sugiere desde el catálogo si la dejas vacía' })}
            {campo('precio', 'Precio (opcional)', { type: 'number', placeholder: '0.00' })}
          </div>
        </div>
        <div className="imp-aceptados-popup__footer">
          <button type="button" className="create-user__action create-user__action--cancel" onClick={onClose}>Cancelar</button>
          <button type="button" className="create-user__action create-user__action--primary" onClick={handleAdd} disabled={adding}>
            {adding ? 'Buscando en el catálogo...' : 'Agregar producto'}
          </button>
        </div>
      </div>
    </div>,
    getPortalRoot()
  )
}

// Popup "+ Aceptados de solicitudes" de una sugerencia: marca/desmarca los
// productos aceptados de la casa. onConfirm({ toAdd, toRemove }).
function SugerenciaAceptadosPopup({ token, casa, alreadyAddedIds, alreadyAddedSolIds, onConfirm, onClose }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(new Set())
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (!casa?.id || !token) return undefined
    let cancelled = false
    authFetch(`${API_URL}/solicitudes/solicitudes/aceptados-por-casa/?casa_comercial_id=${casa.id}`, {}, token)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((payload) => {
        if (cancelled) return
        const loaded = parseApiList(payload)
        setItems(loaded)
        setSelected(new Set(loaded.filter((item) => isAceptadoAgregado(item, alreadyAddedIds, alreadyAddedSolIds)).map((item) => item.solicitud_id)))
      })
      .catch(() => { if (!cancelled) setItems([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // Solo al abrir: lo ya agregado se toma una vez como punto de partida.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [casa?.id, token])

  const q = search.trim().toLowerCase()
  const filtered = !q ? items : items.filter((item) =>
    String(item.codigo || '').toLowerCase().includes(q) ||
    String(item.nombre || '').toLowerCase().includes(q) ||
    String(item.solicitud_codigo || '').toLowerCase().includes(q) ||
    String(item.referencia || '').toLowerCase().includes(q) ||
    (item.oem_codigos || []).some((oem) => String(oem).toLowerCase().includes(q))
  )
  const allSelected = filtered.length > 0 && filtered.every((item) => selected.has(item.solicitud_id))
  const cambios = getAceptadosCambios(items, selected, alreadyAddedIds, alreadyAddedSolIds)
  const agregadosCount = items.filter((item) => isAceptadoAgregado(item, alreadyAddedIds, alreadyAddedSolIds)).length
  const toggle = (solId) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(solId)) next.delete(solId)
    else next.add(solId)
    return next
  })

  return createPortal(
    <div className="imp-aceptados-popup__overlay" style={{ zIndex: 2200 }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="imp-aceptados-popup__dialog">
        <header className="imp-aceptados-popup__header">
          <div>
            <h3>Aceptados de solicitudes</h3>
            {casa?.nombre && <p>{formatCasaLabel(casa)}</p>}
            {!loading && items.length > 0 && (
              <p className="importaciones-aceptados__resumen">{agregadosCount} de {items.length} ya agregado{items.length !== 1 ? 's' : ''} a la lista</p>
            )}
          </div>
          <button type="button" className="imp-aceptados-popup__close" onClick={onClose} aria-label="Cerrar">
            <i className="pi pi-times" />
          </button>
        </header>
        <div className="imp-aceptados-popup__search">
          <i className="pi pi-search" />
          <input type="text" placeholder="Buscar por código, nombre, OEM o solicitud..." value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" />
        </div>
        <div className="imp-aceptados-popup__body">
          <div className="create-user__locations-table importaciones-aceptados__table">
            <div className="create-user__locations-row create-user__locations-row--head">
              <span>
                <input type="checkbox" checked={allSelected} disabled={filtered.length === 0} onChange={() => setSelected(allSelected ? new Set() : new Set(filtered.map((i) => i.solicitud_id)))} aria-label="Seleccionar todos" />
              </span>
              <span>Solicitud</span><span>Código JP</span><span>Descripción</span><span>Referencia</span><span>Precio</span><span>OEMs</span><span>Cant.</span><span>Estado</span>
            </div>
            {loading && <div className="create-user__locations-row create-user__locations-row--empty"><span>Cargando...</span></div>}
            {!loading && filtered.length === 0 && (
              <div className="create-user__locations-row create-user__locations-row--empty">
                <span>{items.length === 0 ? 'No hay productos aceptados.' : 'Sin resultados.'}</span>
              </div>
            )}
            {!loading && filtered.map((item) => {
              const noProducto = !item.producto_id
              const isSelected = selected.has(item.solicitud_id)
              return (
                <div
                  key={item.solicitud_id}
                  className={`create-user__locations-row importaciones-aceptados__row${isSelected ? ' importaciones-aceptados__row--selected' : ''}${noProducto ? ' importaciones-aceptados__row--no-catalogo' : ''}`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => toggle(item.solicitud_id)}
                >
                  <span><input type="checkbox" checked={isSelected} onChange={() => toggle(item.solicitud_id)} onClick={(e) => e.stopPropagation()} style={{ cursor: 'pointer' }} /></span>
                  <span style={{ fontSize: '0.79rem', color: 'var(--color-muted, #888)' }}><span className="imp-cell-text">{item.solicitud_codigo || '-'}</span></span>
                  <span>
                    <span className="imp-cell-text">
                      {noProducto ? <span className="importaciones-aceptados__no-catalogo-badge">Sin catálogo</span> : (item.codigo || '-')}
                    </span>
                  </span>
                  <span><span className="imp-cell-text">{item.nombre || '-'}</span></span>
                  <span style={{ fontSize: '0.8rem' }}><span className="imp-cell-text">{item.referencia || '-'}</span></span>
                  <span style={{ fontSize: '0.8rem' }}><span className="imp-cell-text">{item.precio != null ? `$${Number(item.precio).toFixed(2)}` : '-'}</span></span>
                  <span style={{ fontSize: '0.8rem' }}><span className="imp-cell-text">{(item.oem_codigos || []).join(', ') || '-'}</span></span>
                  <span>{item.cantidad ?? '-'}</span>
                  <span><AceptadoEstadoChip agregado={isAceptadoAgregado(item, alreadyAddedIds, alreadyAddedSolIds)} marcado={isSelected} /></span>
                </div>
              )
            })}
          </div>
        </div>
        <div className="imp-aceptados-popup__footer">
          <button type="button" className="create-user__action create-user__action--cancel" onClick={onClose}>Regresar</button>
          <button
            type="button"
            className="create-user__action create-user__action--primary"
            disabled={!cambios.toAdd.length && !cambios.toRemove.length}
            onClick={() => { onConfirm(cambios); onClose() }}
          >
            {getAceptadosConfirmLabel(cambios)}
          </button>
        </div>
      </div>
    </div>,
    getPortalRoot()
  )
}

// Coincidencias del catalogo para filas sueltas de una sugerencia (producto
// agregado a mano o sugerencia ya guardada), igual que las de una fila del
// Excel. rows = [{ key, codigo, referencia, oem, descripcion }].
// soloCoincidencias: solo la lista de la "i" (sin vincular cada fila), mucho
// mas rapido para tablas grandes.
const fetchCoincidencias = async (token, casaId, rows, { soloCoincidencias = false } = {}) => {
  const resp = await authFetch(
    `${API_URL}/importaciones/importaciones/coincidencias/`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ casa_comercial_id: casaId, rows, solo_coincidencias: soloCoincidencias }) },
    token
  )
  if (!resp.ok) throw new Error(await readErrorMessage(resp, 'No se pudo buscar en el catálogo.'))
  const data = await resp.json()
  return Array.isArray(data?.rows) ? data.rows : []
}

// Filas de una sugerencia (las del Excel y las agregadas a mano): orden de la
// tabla, del Excel descargado y de la sugerencia creada. 1) codigo/referencia
// en otra casa (necesitan revision), 2) codigo sugerido (amarillo), 3) ya
// vinculados al catalogo, 4) el resto (sin catalogo). sort es estable: dentro
// de cada grupo se conserva el orden original.
// Los no encontrados: primero los que traen codigo y al final, juntos, los
// que no tienen codigo.
const sugerenciaRowRank = (row) => (
  row.conflicto_casa ? 0 : row.codigo_sugerido ? 1 : row.matched_producto_id ? 2 : String(row.codigo || '').trim() ? 3 : 4
)
const sortSugerenciaRows = (rows) => [...rows].sort((a, b) => sugerenciaRowRank(a) - sugerenciaRowRank(b))

// La referencia del Excel no es ninguna de las que ya tiene el producto
// vinculado: hay que elegir cual se guarda.
const hasReferenciaConflict = (row) => {
  if (!row.matched_producto_id) return false
  const excelRef = (row.referencia || '').trim().toLowerCase()
  if (!excelRef) return false
  const dbRefs = Array.isArray(row.matched_producto_referencias) && row.matched_producto_referencias.length
    ? row.matched_producto_referencias
    : [row.matched_producto_referencia]
  return !dbRefs.some((ref) => (ref || '').trim().toLowerCase() === excelRef)
}

// PVP JP: el precio registrado en el sistema (el del producto vinculado o, si
// el codigo/referencia es de otra casa, el de ese producto).
const sugerenciaSistemaPrecio = (row) => row.matched_producto_precio ?? row.conflicto_precio ?? row.sugerido_precio ?? null
// Casa del PVP JP (misma prioridad que sugerenciaSistemaPrecio).
const sugerenciaSistemaCasa = (row, casaNombre) => (
  row.matched_producto_precio != null ? (casaNombre || '')
    : row.conflicto_precio != null ? (row.conflicto_casa_nombre || '')
      : (row.sugerido_casa || '')
)
// PVP Aprox.: el precio que se guarda. Elegir una coincidencia por OEM
// (precio_nuevo, en centavos) tiene prioridad sobre el que trae el Excel.
const sugerenciaPrecioGuardado = (row, casaNombre) => {
  if (parseInt(row.precio_nuevo || '0', 10) > 0) return { valor: parseInt(row.precio_nuevo, 10) / 100, casa: row.precio_casa || '' }
  if (Number(row.pvp) > 0) return { valor: Number(row.pvp), casa: casaNombre || '' }
  return null
}

// El backend rechaza la sugerencia si el mismo producto del catalogo esta en
// mas de una fila: se detecta antes para bloquear la tabla de una vez.
const getDuplicateProductGroups = (rows) => {
  const byProductId = new Map()
  rows.forEach((row) => {
    if (!row.matched_producto_id) return
    const key = String(row.matched_producto_id)
    if (!byProductId.has(key)) byProductId.set(key, [])
    byProductId.get(key).push(row)
  })
  return [...byProductId.values()].filter((group) => group.length > 1)
}

// Sugerencia guardada <-> filas de SugerenciaTabla: los detalles guardados se
// muestran con la misma tabla que el Paso 3 y los cambios vuelven a ser
// detalles (el detalle original va en _detalle para no perder sus campos).
const detalleToSugerenciaRow = (item, oemMatches) => {
  const producto = item.producto?.id ? item.producto : null
  const otraCasa = !producto && item.coincidencia === 'otra_casa'
  const porOem = !producto && item.coincidencia === 'oem'
  const precioCoincidencia = item.coincidencia_precio != null && item.coincidencia_precio !== '' ? Number(item.coincidencia_precio) : null
  return {
    fila_excel: item._key,
    orden: item.orden,
    codigo: producto?.codigo || item.codigo || '',
    descripcion: producto?.nombre || item.nombre || '',
    oem: getProductoOem(producto) || item.oem || '',
    referencia: producto?.referencia || item.referencia || '',
    cantidad: item.cantidad ?? '',
    comentario: item.comentario || '',
    solicitud_id: item._solId || null,
    matched_producto_id: producto?.id || null,
    matched_producto_codigo: producto?.codigo || null,
    matched_producto_nombre: producto?.nombre || null,
    matched_producto_referencia: producto?.referencia || null,
    matched_producto_referencias: (producto?.referencias || []).map((r) => r?.valor).filter(Boolean),
    matched_producto_precio: producto?.precio != null ? Number(producto.precio) : null,
    codigo_sugerido: porOem,
    sugerido_desde: porOem ? (item._sugeridoDesde || '') : '',
    sugerido_casa: porOem ? (item._sugeridoCasa || '') : '',
    sugerido_precio: porOem ? precioCoincidencia : null,
    conflicto_casa: otraCasa,
    conflicto_casa_nombre: otraCasa ? (item._sugeridoCasa || '') : '',
    conflicto_precio: otraCasa ? precioCoincidencia : null,
    precio_nuevo: String(item.precio_estimado || '').replace(/\D/g, ''),
    precio_casa: item.precio_casa || '',
    oem_matches: oemMatches ?? item._oemMatches ?? [],
    _editando_referencia: item._editando_referencia,
    _detalle: item,
  }
}

const sugerenciaRowToDetalle = (row) => {
  const base = row._detalle || {}
  const producto = !row.matched_producto_id ? null
    : String(base.producto?.id) === String(row.matched_producto_id) ? base.producto
      : (row._producto || { id: row.matched_producto_id, codigo: row.codigo, nombre: row.descripcion, referencia: row.referencia, precio: row.matched_producto_precio })
  const centavos = parseInt(row.precio_nuevo || '0', 10)
  return {
    ...base,
    _key: row.fila_excel,
    orden: row.orden,
    producto,
    codigo: row.codigo || '',
    nombre: row.descripcion || '',
    oem: row.oem || '',
    referencia: row.referencia || '',
    cantidad: String(row.cantidad ?? ''),
    comentario: row.comentario || '',
    _solId: row.solicitud_id || null,
    coincidencia: producto ? '' : row.conflicto_casa ? 'otra_casa' : row.codigo_sugerido ? 'oem' : '',
    coincidencia_precio: row.conflicto_casa ? row.conflicto_precio : row.codigo_sugerido ? row.sugerido_precio : null,
    _sugeridoDesde: row.sugerido_desde || '',
    _sugeridoCasa: row.conflicto_casa ? (row.conflicto_casa_nombre || '') : (row.sugerido_casa || ''),
    precio_estimado: centavos > 0 ? String(centavos) : Number(row.pvp) > 0 ? String(Math.round(Number(row.pvp) * 100)) : '',
    precio_casa: row.precio_casa || '',
    _oemMatches: row.oem_matches,
    _editando_referencia: row._editando_referencia,
  }
}

// Tabla de una sugerencia: la misma en "Sugerencia desde Excel" (paso 3), en
// la creacion manual y en la sugerencia ya guardada. Trabaja con filas como
// las del Excel procesado (fila_excel, codigo, descripcion, oem, referencia,
// cantidad, comentario, matched_producto_*, oem_matches, ...); quien la usa
// guarda `rows` y las convierte a detalles al crear o guardar.
// referenciaDecisions: { [fila_excel]: 'keep' | 'excel' }.
// viewStateRef: guarda el buscador y el scroll al cambiar de pestana.
function SugerenciaTabla({ token, casa, rows, setRows, referenciaDecisions = {}, setReferenciaDecisions = () => {}, compact = false, viewStateRef, notify, invalidFields, jumpRef, readOnly = false, wrapStyle, wrapClassName = '' }) {
  // Un Excel puede traer miles de filas (cada una con varios inputs):
  // dibujarlas todas hacia lento todo. Se dibujan por tandas y se agregan mas
  // al acercarse al final del scroll.
  const REVIEW_ROWS_BATCH = 150
  const REVIEW_ROWS_PRELOAD_PX = 800
  const savedView = viewStateRef?.current || {}
  const saveView = (patch) => { if (viewStateRef) viewStateRef.current = { ...viewStateRef.current, ...patch } }

  // La tabla debe scrollear 1 a 1 con la rueda/trackpad, sin la animacion de
  // "smooth scroll" que Chrome/Windows aplica por defecto al wheel.
  const reviewTableWrapRef = useRef(null)
  useEffect(() => {
    const el = reviewTableWrapRef.current
    if (!el) return undefined
    const handleWheel = (e) => {
      e.preventDefault()
      el.scrollTop += e.deltaY
      el.scrollLeft += e.deltaX
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [])

  // Buscador (como en las demas etapas): lo que coincide va primero.
  const [reviewQuery, setReviewQueryState] = useState(savedView.query || '')
  const setReviewQuery = (value) => { setReviewQueryState(value); saveView({ query: value }) }
  const [reviewRenderCount, setReviewRenderCount] = useState(savedView.renderCount || REVIEW_ROWS_BATCH)
  const firstRenderRef = useRef(true)
  useEffect(() => {
    if (firstRenderRef.current) { firstRenderRef.current = false; return }
    setReviewRenderCount(REVIEW_ROWS_BATCH)
    saveView({ top: 0, left: 0, renderCount: REVIEW_ROWS_BATCH })
    if (reviewTableWrapRef.current) reviewTableWrapRef.current.scrollTop = 0
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewQuery])
  // Al volver de otra pestana la tabla vuelve a donde estaba.
  useLayoutEffect(() => {
    const el = reviewTableWrapRef.current
    if (!el) return
    el.scrollTop = savedView.top || 0
    el.scrollLeft = savedView.left || 0
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const handleReviewTableScroll = (event) => {
    const el = event.currentTarget
    saveView({ top: el.scrollTop, left: el.scrollLeft })
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - REVIEW_ROWS_PRELOAD_PX) {
      setReviewRenderCount((count) => {
        saveView({ renderCount: count + REVIEW_ROWS_BATCH })
        return count + REVIEW_ROWS_BATCH
      })
    }
  }

  // Clic en un contador de arriba (vinculados, sin catalogo, amarillo...):
  // salta a la siguiente fila de ese grupo en cuanto este dibujada.
  const [reviewJump, setReviewJump] = useState(null)
  useLayoutEffect(() => {
    if (!reviewJump) return
    const wrap = reviewTableWrapRef.current
    const rowEl = wrap?.querySelector(`[data-review-pos="${reviewJump.pos}"]`)
    if (!wrap || !rowEl) return
    const headHeight = wrap.querySelector('thead')?.offsetHeight || 0
    wrap.scrollTo({ top: Math.max(0, rowEl.offsetTop - headHeight), behavior: 'smooth' })
    rowEl.classList.remove('imp-excel-review__row--flash')
    void rowEl.offsetWidth
    rowEl.classList.add('imp-excel-review__row--flash')
    setReviewJump(null)
  }, [reviewJump, reviewRenderCount])

  // Tarjeta para valores truncados y explicaciones de cada celda.
  const [cellHover, setCellHover] = useState(null)
  const cellHoverTimerRef = useRef(null)
  const showCellHover = (event, value, label) => {
    if (!value) return
    if (cellHoverTimerRef.current) clearTimeout(cellHoverTimerRef.current)
    const rect = event.currentTarget.getBoundingClientRect()
    cellHoverTimerRef.current = setTimeout(() => {
      cellHoverTimerRef.current = null
      setCellHover({ top: rect.bottom + 4, left: rect.left, value, label })
    }, 300)
  }
  const hideCellHover = () => {
    if (cellHoverTimerRef.current) { clearTimeout(cellHoverTimerRef.current); cellHoverTimerRef.current = null }
    setCellHover(null)
  }

  // Los title de la tarjeta de coincidencias se muestran con la misma tarjeta
  // blanca (el tooltip nativo esta desactivado, ver utils/nativeTooltips).
  const titleHoverRef = useRef(null)
  const handleTitleMouseOver = (event) => {
    const el = event.target.closest?.('[data-title]')
    if (!el || titleHoverRef.current === el) return
    titleHoverRef.current = el
    const cell = el.closest('td')
    const header = cell?.closest('table')?.tHead?.rows[0]?.cells[cell.cellIndex]
    showCellHover({ currentTarget: el }, el.getAttribute('data-title'), header?.textContent.trim() || '')
  }
  const handleTitleMouseOut = (event) => {
    const current = titleHoverRef.current
    if (!current || current.contains(event.relatedTarget)) return
    titleHoverRef.current = null
    hideCellHover()
  }

  // Icono "i" junto al OEM: que productos del catalogo ya tienen ese OEM o
  // esa referencia. Sin coincidencias el icono se ve opaco.
  const [oemMatchesHover, setOemMatchesHover] = useState(null)
  const [oemMatchesHoverPos, setOemMatchesHoverPos] = useState(null)
  const oemMatchesHoverCardRef = useRef(null)
  const oemMatchesHoverTimerRef = useRef(null)
  const showOemMatchesHover = (event, matches, filaExcel) => {
    if (oemMatchesHoverTimerRef.current) clearTimeout(oemMatchesHoverTimerRef.current)
    const rect = event.currentTarget.getBoundingClientRect()
    oemMatchesHoverTimerRef.current = setTimeout(() => {
      oemMatchesHoverTimerRef.current = null
      setOemMatchesHover({ triggerTop: rect.top, triggerBottom: rect.bottom, triggerLeft: rect.left, matches, filaExcel })
    }, 150)
  }
  // Se oculta con un pequeno retraso para poder pasar del icono a la tarjeta.
  const hideOemMatchesHover = () => {
    if (oemMatchesHoverTimerRef.current) { clearTimeout(oemMatchesHoverTimerRef.current); oemMatchesHoverTimerRef.current = null }
    oemMatchesHoverTimerRef.current = setTimeout(() => {
      oemMatchesHoverTimerRef.current = null
      setOemMatchesHover(null)
      setOemMatchesHoverPos(null)
    }, 250)
  }
  const cancelHideOemMatchesHover = () => {
    if (oemMatchesHoverTimerRef.current) { clearTimeout(oemMatchesHoverTimerRef.current); oemMatchesHoverTimerRef.current = null }
  }
  useLayoutEffect(() => {
    if (!oemMatchesHover || !oemMatchesHoverCardRef.current) return
    setOemMatchesHoverPos(computeSmartPopoverPosition(oemMatchesHover, oemMatchesHoverCardRef.current))
  }, [oemMatchesHover])
  useCloseDropdownsOnTabSwitch(
    useCallback(() => {
      if (cellHoverTimerRef.current) { clearTimeout(cellHoverTimerRef.current); cellHoverTimerRef.current = null }
      setCellHover(null)
      if (oemMatchesHoverTimerRef.current) { clearTimeout(oemMatchesHoverTimerRef.current); oemMatchesHoverTimerRef.current = null }
      setOemMatchesHover(null)
      setOemMatchesHoverPos(null)
    }, [])
  )

  // Productos agregados a mano (fila "Agregar", "+ Agregar nuevo producto" y
  // "+ Aceptados de solicitudes").
  const [addDraft, setAddDraft] = useState({ producto: null, cantidad: '' })
  const [showNuevoProducto, setShowNuevoProducto] = useState(false)
  const [showAceptados, setShowAceptados] = useState(false)
  const manualFilaRef = useRef(0)

  const validRows = sortSugerenciaRows(rows)
  const reviewMatches = (row) => importItemMatches(
    { codigo: row.codigo, nombre: row.descripcion, oem: row.oem, referencia: row.referencia, producto_busqueda: row.matched_producto_codigo },
    reviewQuery
  )
  const reviewHasQuery = Boolean(reviewQuery.trim())
  const reviewRows = validRows.map((row, i) => ({ row, i, hit: !reviewHasQuery || reviewMatches(row) }))
  if (reviewHasQuery) reviewRows.sort((a, b) => Number(b.hit) - Number(a.hit))
  const reviewHitCount = reviewHasQuery ? reviewRows.filter((entry) => entry.hit).length : validRows.length
  const conflictoRows = validRows.filter((r) => r.conflicto_casa)
  const matchedCount = validRows.filter((r) => r.matched_producto_id).length
  const unmatchedCount = validRows.filter((r) => !r.matched_producto_id).length
  const suggestedCount = validRows.filter((r) => r.codigo_sugerido && !r.conflicto_casa).length
  const referenciaConflictCount = validRows.filter((r) => hasReferenciaConflict(r)).length
  // No encontrados (ni vinculados, ni amarillos, ni naranjas): los que traen
  // un codigo nuevo y los que no tienen codigo, cada grupo junto (ver
  // sugerenciaRowRank).
  const esNoEncontrado = (r) => !r.matched_producto_id && !r.codigo_sugerido && !r.conflicto_casa
  const tieneCodigo = (r) => Boolean(String(r.codigo || '').trim())
  const codigoNuevoCount = validRows.filter((r) => esNoEncontrado(r) && tieneCodigo(r)).length
  const sinCodigoCount = validRows.filter((r) => esNoEncontrado(r) && !tieneCodigo(r)).length
  const REVIEW_GROUPS = {
    vinculados: (r) => Boolean(r.matched_producto_id),
    codigoNuevo: (r) => esNoEncontrado(r) && tieneCodigo(r),
    sinCatalogo: (r) => esNoEncontrado(r) && !tieneCodigo(r),
    sugeridos: (r) => Boolean(r.codigo_sugerido) && !r.conflicto_casa,
    otraCasa: (r) => Boolean(r.conflicto_casa),
    referencia: (r) => hasReferenciaConflict(r),
  }
  // Clic en un contador: lleva al inicio de ese grupo (los grupos van juntos).
  const jumpToReviewGroup = (key) => {
    const test = REVIEW_GROUPS[key]
    const pos = reviewRows.findIndex(({ row }) => test(row))
    if (pos === -1) return
    if (pos >= reviewRenderCount) setReviewRenderCount(pos + REVIEW_ROWS_BATCH)
    setReviewJump({ pos })
  }
  const reviewGroupChipProps = (key, label) => ({
    role: 'button',
    tabIndex: 0,
    onClick: () => jumpToReviewGroup(key),
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        jumpToReviewGroup(key)
      }
    },
    className: 'imp-excel-review__group-chip',
    'aria-label': `Ir a ${label}`,
  })
  const getSistemaPrecio = sugerenciaSistemaPrecio
  const getPrecioGuardado = (row) => sugerenciaPrecioGuardado(row, casa?.nombre)
  const duplicateProductGroups = getDuplicateProductGroups(validRows)

  const selectAllDecision = (decision) => {
    const updates = {}
    validRows.forEach((row) => { if (hasReferenciaConflict(row)) updates[row.fila_excel] = decision })
    setReferenciaDecisions((prev) => ({ ...prev, ...updates }))
  }

  const removeReviewRow = (filaExcel) => {
    setRows((prev) => prev.filter((r) => r.fila_excel !== filaExcel))
    setReferenciaDecisions((prev) => {
      if (!(filaExcel in prev)) return prev
      const next = { ...prev }
      delete next[filaExcel]
      return next
    })
  }

  // Quita de una vez todos los no encontrados (ni vinculados, ni sugeridos
  // por OEM, ni de otra casa).
  // "Quitar todos": solo los que no tienen codigo (los nuevos con codigo ya
  // estan completos).
  const removeNoEncontrados = () => {
    setRows((prev) => prev.filter((r) => r.matched_producto_id || r.codigo_sugerido || r.conflicto_casa || String(r.codigo || '').trim()))
  }

  const updateRowCampo = (filaExcel, field, value) => {
    setRows((prev) => prev.map((r) => (r.fila_excel === filaExcel ? { ...r, [field]: value } : r)))
  }
  // Editar el codigo de un sugerido no le quita la marca (si no, la fila
  // saltaba de grupo y el input perdia el foco).
  const updateRowCodigo = (filaExcel, value) => updateRowCampo(filaExcel, 'codigo', value)
  // Descripcion de un producto sin catalogo: a mano o con un clic en una
  // coincidencia por OEM.
  const updateRowDescripcion = (filaExcel, value) => updateRowCampo(filaExcel, 'descripcion', value)
  // Precio tomado de una coincidencia por OEM (centavos) y la casa de la que
  // salio; va al lado del precio en el Excel de la sugerencia.
  const updateRowPrecioCentavos = (filaExcel, centavosDigits, casaPrecio = '') => {
    setRows((prev) => prev.map((r) => (r.fila_excel === filaExcel ? { ...r, precio_nuevo: centavosDigits, precio_casa: casaPrecio } : r)))
  }

  // Fila del Excel a partir de un producto del catalogo (vinculada).
  const catalogRow = (producto, extra = {}) => ({
    codigo: producto.codigo || '',
    referencia: producto.referencia || '',
    oem: getProductoOem(producto) || producto.oem || '',
    descripcion: producto.nombre || '',
    matched_producto_id: producto.id,
    matched_producto_codigo: producto.codigo || '',
    matched_producto_nombre: producto.nombre || '',
    matched_producto_referencia: producto.referencia || '',
    matched_producto_referencias: (producto.referencias || []).map((r) => r?.valor).filter(Boolean),
    matched_producto_precio: producto.precio != null ? Number(producto.precio) : null,
    oem_matches: [],
    // El producto completo, para la sugerencia guardada.
    _producto: producto,
    ...extra,
  })

  // Agrega filas al final (orden = despues de la ultima). La clave lleva la
  // hora para no repetirse si la tabla se vuelve a montar.
  const appendRows = (nuevas) => {
    if (!nuevas.length) return
    setRows((prev) => {
      let orden = prev.reduce((max, r) => Math.max(max, Number(r.orden) || 0), 0)
      return [...prev, ...nuevas.map((row) => {
        manualFilaRef.current += 1
        orden += 1
        return { cantidad: '', ...row, fila_excel: `m${Date.now().toString(36)}${manualFilaRef.current}`, orden }
      })]
    })
  }

  const jumpToFila = (filaExcel) => {
    const pos = reviewRows.findIndex(({ row }) => row.fila_excel === filaExcel)
    if (pos === -1) return
    if (pos >= reviewRenderCount) setReviewRenderCount(pos + REVIEW_ROWS_BATCH)
    setReviewJump({ pos })
  }

  // Quien usa la tabla puede llevar a una fila (p. ej. "Ir al primero").
  if (jumpRef) jumpRef.current = (filaExcel) => { setReviewQuery(''); jumpToFila(filaExcel) }

  // La cantidad es opcional; solo no puede ser negativa.
  const addDraftQty = Number(addDraft.cantidad || 0)
  const canAddDraft = Boolean(addDraft.producto && Number.isFinite(addDraftQty) && addDraftQty >= 0)
  const handleAddDraft = () => {
    if (!canAddDraft) return
    appendRows([catalogRow(addDraft.producto, { cantidad: addDraftQty > 0 ? String(addDraftQty) : '' })])
    setAddDraft({ producto: null, cantidad: '' })
  }

  // "+ Agregar nuevo producto": se busca en el catalogo igual que una fila
  // del Excel (vinculado, codigo sugerido, otra casa o sin catalogo).
  const handleAddNuevoProducto = async (producto) => {
    const mismo = (a, b) => Boolean(String(b || '').trim()) && String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()
    if (rows.some((r) => mismo(r.referencia, producto.referencia))) return { referencia: 'Ya hay un producto con esta referencia en el listado.' }
    if (rows.some((r) => mismo(r.oem, producto.oem))) return { oem: 'Ya hay un producto con este OEM en el listado.' }
    let encontrada
    try {
      [encontrada] = await fetchCoincidencias(token, casa?.id, [{ key: 'nuevo', oem: producto.oem, referencia: producto.referencia, descripcion: producto.nombre }])
    } catch (e) {
      notify?.('error', 'Error', e.message)
      return {}
    }
    const row = enrichParsedRow({
      ...(encontrada || { oem: producto.oem, referencia: producto.referencia, oem_matches: [] }),
      descripcion: producto.nombre || encontrada?.descripcion || '',
      pvp: producto.precio ?? 0,
      cantidad: '',
    }, casa?.codigo)
    const yaEsta = row.matched_producto_id && rows.find((r) => String(r.matched_producto_id) === String(row.matched_producto_id))
    if (yaEsta) {
      notify?.('warn', 'Ya está en la lista', `${row.matched_producto_codigo || row.codigo} ya está en esta sugerencia.`)
      setShowNuevoProducto(false)
      setReviewQuery('')
      jumpToFila(yaEsta.fila_excel)
      return null
    }
    appendRows([row])
    setShowNuevoProducto(false)
    return null
  }

  const addedProductIds = new Set(rows.filter((r) => r.matched_producto_id).map((r) => String(r.matched_producto_id)))
  const addedSolIds = new Set(rows.filter((r) => !r.matched_producto_id && r.solicitud_id).map((r) => String(r.solicitud_id)))

  const handleAceptadosConfirm = ({ toAdd, toRemove }) => {
    const quitar = (row) => toRemove.some((item) => (item.producto_id
      ? String(item.producto_id) === String(row.matched_producto_id)
      : !row.matched_producto_id && String(item.solicitud_id) === String(row.solicitud_id)))
    // Un aceptado cuyo producto ya esta en la lista suma su cantidad a esa fila.
    const sumar = new Map()
    const nuevas = []
    for (const item of toAdd) {
      const existente = item.producto_id && rows.find((r) => String(r.matched_producto_id) === String(item.producto_id) && !quitar(r))
      if (existente) {
        sumar.set(existente.fila_excel, (sumar.get(existente.fila_excel) || 0) + Number(item.cantidad || 0))
        continue
      }
      const base = { cantidad: String(item.cantidad || ''), solicitud_id: item.solicitud_id }
      nuevas.push(item.producto_id
        ? catalogRow({ id: item.producto_id, codigo: item.codigo, nombre: item.nombre, referencia: item.referencia, oem: (item.oem_codigos || []).join(', '), precio: item.precio }, base)
        : { codigo: item.codigo || '', descripcion: item.nombre || '', oem: (item.oem_codigos || []).join(', '), referencia: item.referencia || '', oem_matches: [], ...base })
    }
    setRows((prev) => prev
      .filter((row) => !quitar(row))
      .map((row) => (sumar.has(row.fila_excel) ? { ...row, cantidad: String(Number(row.cantidad || 0) + sumar.get(row.fila_excel)) } : row)))
    appendRows(nuevas)
  }

  return (
    <>
                {duplicateProductGroups.length > 0 ? (
                  <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <i className="pi pi-exclamation-triangle" style={{ color: '#dc2626', fontSize: 'var(--font-size-base)' }} />
                      <strong style={{ fontSize: 'var(--font-size-sm)', color: '#7f1d1d' }}>
                        {duplicateProductGroups.length} producto{duplicateProductGroups.length !== 1 ? 's' : ''} repetido{duplicateProductGroups.length !== 1 ? 's' : ''} en la misma sugerencia
                      </strong>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {duplicateProductGroups.map((rows, gi) => (
                        <div key={gi} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 'var(--font-size-sm)', padding: '4px 6px', background: '#fee2e2', borderRadius: 4, flexWrap: 'wrap' }}>
                          <span style={{ color: '#7f1d1d', fontWeight: 700, whiteSpace: 'nowrap' }}>
                            Filas {rows.map((r) => r.fila_excel).join(', ')}
                          </span>
                          <span style={{ color: '#7f1d1d', minWidth: 160 }}>
                            {rows[0]?.matched_producto_codigo || rows[0]?.codigo || '—'} — {rows[0]?.matched_producto_nombre || rows[0]?.descripcion || ''}
                          </span>
                        </div>
                      ))}
                    </div>
                    <p style={{ margin: 0, fontSize: 'var(--font-size-sm)', color: '#7f1d1d' }}>
                      No puedes pedir el mismo producto dos veces. Combina esas filas en una sola (sumando la cantidad) o elimina la repetida.
                    </p>
                  </div>
                ) : (
                  <>
                    {!readOnly && (
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                      <button type="button" className="create-user__ghost" onClick={() => setShowNuevoProducto(true)} style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
                        + Agregar nuevo producto
                      </button>
                      <button type="button" className="create-user__ghost" onClick={() => setShowAceptados(true)} style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
                        + Aceptados de solicitudes
                      </button>
                    </div>
                    )}
                    <ImportGroupsSummary
                      vinculados={matchedCount}
                      oem={suggestedCount}
                      otraCasa={conflictoRows.length}
                      codigoNuevo={codigoNuevoCount}
                      sinCatalogo={sinCodigoCount}
                      chipProps={(key, label) => reviewGroupChipProps(key === 'oem' ? 'sugeridos' : key, label)}
                      onQuitarTodos={readOnly ? undefined : removeNoEncontrados}
                    />


                    {referenciaConflictCount > 0 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8 }}>
                        <span {...reviewGroupChipProps('referencia', 'los que tienen referencia diferente')} title="Clic: ir a los que tienen referencia diferente" style={{ background: '#ffedd5', color: '#c2410c', border: '1px solid #fdba74', borderRadius: 20, padding: '2px 10px', fontSize: 'var(--font-size-sm)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                          {referenciaConflictCount} con referencia diferente
                        </span>
                        <span style={{ fontSize: 'var(--font-size-sm)', color: '#9a3412', flex: 1 }}>
                          Debes seleccionar la referencia a guardar para cada conflicto antes de continuar.
                        </span>
                        <span style={{ fontSize: 'var(--font-size-sm)', color: '#9a3412', fontWeight: 600, whiteSpace: 'nowrap' }}>Seleccionar todas:</span>
                        <button
                          type="button"
                          onClick={() => selectAllDecision('keep')}
                          style={{ fontSize: 'var(--font-size-sm)', padding: '2px 8px', borderRadius: 4, cursor: 'pointer', border: '1px solid #1e40af', background: '#1e40af', color: '#fff', fontFamily: 'inherit', whiteSpace: 'nowrap' }}
                        >
                          Actuales (BD)
                        </button>
                        <button
                          type="button"
                          onClick={() => selectAllDecision('excel')}
                          style={{ fontSize: 'var(--font-size-sm)', padding: '2px 8px', borderRadius: 4, cursor: 'pointer', border: '1px solid #c2410c', background: '#c2410c', color: '#fff', fontFamily: 'inherit', whiteSpace: 'nowrap' }}
                        >
                          Del Excel
                        </button>
                      </div>
                    )}

                    <ImportProductSearch
                      value={reviewQuery}
                      onChange={setReviewQuery}
                      shown={reviewHitCount}
                      total={validRows.length}
                    />

                    <div ref={reviewTableWrapRef} onScroll={handleReviewTableScroll} className={`imp-excel-review-table-wrap ${wrapClassName}`.trim()} style={{ border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 8, overflow: 'auto', flex: '1 1 auto', minHeight: 160, maxHeight: compact ? 'min(360px, 45dvh)' : 'none', ...wrapStyle }}>
                      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
                      <table className="imp-excel-review-table" style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 'var(--font-size-base)', minWidth: 880 }}>
                        {/* "Eliminar" con sus 88px (con 40 el titulo quedaba cortado). */}
                        <colgroup>
                          <col style={{ width: 130 }} />
                          <col style={{ width: 120 }} />
                          <col style={{ width: 130 }} />
                          <col />
                          <col style={{ width: 80 }} />
                          <col style={{ width: 90 }} />
                          <col style={{ width: 100 }} />
                          <col style={{ width: 88 }} />
                        </colgroup>
                        <thead style={{ position: 'sticky', top: 0, zIndex: 2 }}>
                          <tr style={{ background: '#1A1A2E', color: '#fff', fontSize: 'var(--font-size-sm)' }}>
                            <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600 }}>Código</th>
                            <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600 }}>Referencia</th>
                            <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600 }}>OEM</th>
                            <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600 }}>Descripción</th>
                            <th style={{ padding: '8px 12px', textAlign: 'center', fontWeight: 600 }}>Cant.</th>
                            <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600 }} title="Precio registrado en el sistema">PVP JP</th>
                            <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600 }} title="PVP que trae el Excel (promoción). Una importación sin precios queda vacía">PVP Aprox.</th>
                            <th style={{ padding: '8px 8px', textAlign: 'center', fontWeight: 600 }}>Eliminar</th>


                          </tr>
                          {/* Fila "Agregar" (como en la sugerencia guardada): fija
                              arriba con los titulos al desplazar la tabla. */}
                          {!readOnly && (
                          <tr style={{ borderBottom: '2px solid var(--color-border, #e2e8f0)', background: 'var(--color-surface, #f8fafc)' }}>
                            <td style={{ padding: '4px 8px' }}>
                              <span className="create-salida__product-picker create-salida__product-code-cell">
                                <SugerenciaProductPicker
                                  token={token}
                                  casaNombre={casa?.nombre}
                                  value={addDraft.producto}
                                  onSelect={(producto) => setAddDraft({ producto, cantidad: '' })}
                                  listed={rows.map((r) => ({
                                    key: r.fila_excel,
                                    codigo: r.codigo || '',
                                    nombre: r.descripcion || '',
                                    cantidad: r.cantidad,
                                    productoId: r.matched_producto_id,
                                    texto: [r.codigo, r.descripcion, r.oem, r.referencia].join(' '),
                                  }))}
                                  onJumpTo={(fila) => { setReviewQuery(''); jumpToFila(fila) }}
                                />
                              </span>
                            </td>
                            <td style={{ padding: '7px 12px', color: 'var(--color-text-secondary)' }}>{addDraft.producto ? String(addDraft.producto.referencia || '').trim() || '—' : '—'}</td>
                            <td style={{ padding: '7px 12px', color: 'var(--color-text-secondary)' }}>{addDraft.producto ? getProductoOem(addDraft.producto) || '—' : '—'}</td>
                            <td style={{ padding: '7px 12px', color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{addDraft.producto ? String(addDraft.producto.nombre || '').trim() : '—'}</td>
                            <td style={{ padding: '4px 8px' }}>
                              <input
                                type="number"
                                min="1"
                                step="1"
                                className="imp-excel-review__codigo-input imp-sugerencia__cant-input"
                                value={addDraft.cantidad}
                                onChange={(e) => setAddDraft((prev) => ({ ...prev, cantidad: e.target.value }))}
                                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddDraft() } }}
                                disabled={!addDraft.producto}
                                aria-label="Cantidad del producto a agregar"
                              />
                            </td>
                            <td style={{ padding: '7px 12px', textAlign: 'right', fontWeight: 600 }}>{addDraft.producto?.precio != null ? `$${Number(addDraft.producto.precio).toFixed(2)}` : '—'}</td>
                            <td style={{ padding: '7px 12px', textAlign: 'right', color: 'var(--color-text-secondary)' }}>—</td>
                            <td style={{ padding: '4px', textAlign: 'center' }}>
                              <button type="button" className="create-user__ghost" disabled={!canAddDraft} onClick={handleAddDraft}>Agregar</button>
                            </td>


                          </tr>
                          )}
                        </thead>
                        <tbody>
                          {!validRows.length && (
                            <tr>
                              <td colSpan={8} style={{ padding: '12px', textAlign: 'center', color: 'var(--color-text-secondary)' }}>Sin productos agregados.</td>
                            </tr>
                          )}
                          {reviewRows.slice(0, reviewRenderCount).map(({ row, i }, pos) => {
                            const conflict = hasReferenciaConflict(row)
                            const decision = referenciaDecisions[row.fila_excel]
                            const isSuggested = Boolean(row.codigo_sugerido)
                            const isCasaConflict = Boolean(row.conflicto_casa)
                            // Todo producto que no está vinculado a uno ya existente del
                            // catálogo (sugerido, con código propio del Excel, o
                            // completamente sin catálogo) debe permitir asignarle un
                            // código a mano desde el inicio, no solo mostrar "Sin catálogo".
                            const isEditableCodigo = !row.matched_producto_id
                            // Lo que le falta para pedir la cotizacion (sugerencia guardada).
                            const invalidos = invalidFields ? invalidFields(row) : []
                            const claseInput = (label) => `imp-excel-review__codigo-input${invalidos.includes(label) ? ' imp-excel-review__codigo-input--invalid' : ''}`
                            return (
                              <tr
                                key={row.fila_excel}
                                data-review-pos={pos}
                                style={{
                                  borderBottom: '1px solid var(--color-border, #e2e8f0)',
                                  background: isCasaConflict
                                    ? '#ffedd5'
                                    : isSuggested
                                      ? '#fef08a'
                                      : conflict && decision === undefined
                                        ? '#fffbeb'
                                        // Nuevo con codigo: completo, aunque todavia no este en el sistema.
                                        : REVIEW_GROUPS.codigoNuevo(row)
                                          ? '#e0e7ff'
                                          : i % 2 === 0 ? 'var(--color-surface, #f8fafc)' : 'var(--color-bg)',
                                }}
                              >
                                <td
                                  style={{ padding: isEditableCodigo ? '4px 8px' : '7px 12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                                >
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                    {isEditableCodigo ? (
                                      <input
                                        type="text"
                                        className={claseInput('Código')}
                                        value={row.codigo || ''}
                                        onChange={(e) => updateRowCodigo(row.fila_excel, e.target.value.toUpperCase())}
                                        placeholder="Sin catálogo"
                                        title={row.codigo_sugerido
                                          ? `Código sugerido a partir de ${row.sugerido_desde || 'un producto de otra casa comercial'} (${isCasaConflict ? 'misma referencia' : 'mismo OEM'}), con el sufijo de ${casa?.nombre || 'esta casa'}. Puedes corregirlo.`
                                          : row.codigo
                                            ? 'Código nuevo tomado del Excel. Puedes corregirlo.'
                                            : 'Este producto no tiene código en el catálogo. Puedes asignarle uno.'}
                                        style={{ fontSize: 'inherit', fontFamily: 'inherit' }}
                                      />
                                    ) : (
                                      <span title={row.codigo || ''}>{row.codigo || '—'}</span>
                                    )}
                                    {isCasaConflict && (
                                      <Info
                                        size={13}
                                        style={{ flexShrink: 0, color: '#c2410c' }}
                                        onMouseEnter={(e) => showCellHover(e, `Coincide por referencia o código con un producto de ${row.conflicto_casa_nombre || 'otra casa comercial'}. Se creará un producto nuevo con esta misma referencia para ${casa?.nombre || 'esta casa'}${row.codigo_sugerido ? `, con el código sugerido ${row.codigo}` : ''}.`, 'Ya existe en otra casa')}
                                        onMouseLeave={hideCellHover}
                                      />
                                    )}
                                  </div>
                                </td>
                                <td style={{ padding: '7px 12px' }}>
                                  {conflict ? (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                      <span style={{ fontSize: 'var(--font-size-sm)', color: decision === undefined ? '#c2410c' : '#6b7280', fontWeight: 600 }}>
                                        {decision === undefined ? '⚠ Sin seleccionar' : '✓ Seleccionado'}
                                      </span>
                                      <div style={{ display: 'flex', gap: 4, flexWrap: 'nowrap' }}>
                                        <button
                                          type="button"
                                          onClick={() => setReferenciaDecisions(p => ({ ...p, [row.fila_excel]: 'keep' }))}
                                          onMouseEnter={(e) => showCellHover(e, row.matched_producto_referencia, 'Actual (BD)')}
                                          onMouseLeave={hideCellHover}
                                          style={{
                                            flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1,
                                            fontSize: 'var(--font-size-sm)', padding: '3px 6px', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
                                            border: `1px solid ${decision === 'keep' ? '#1e40af' : '#cbd5e1'}`,
                                            background: decision === 'keep' ? '#1e40af' : 'transparent',
                                            color: decision === 'keep' ? '#fff' : '#64748b',
                                          }}
                                        >
                                          <span style={{ fontSize: '0.85em', opacity: 0.85 }}>Actual</span>
                                          <span style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
                                            {row.matched_producto_referencia || '—'}
                                          </span>
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => setReferenciaDecisions(p => ({ ...p, [row.fila_excel]: 'excel' }))}
                                          onMouseEnter={(e) => showCellHover(e, row.referencia, 'Excel')}
                                          onMouseLeave={hideCellHover}
                                          style={{
                                            flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1,
                                            fontSize: 'var(--font-size-sm)', padding: '3px 6px', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
                                            border: `1px solid ${decision === 'excel' ? '#c2410c' : '#cbd5e1'}`,
                                            background: decision === 'excel' ? '#c2410c' : 'transparent',
                                            color: decision === 'excel' ? '#fff' : '#64748b',
                                          }}
                                        >
                                          <span style={{ fontSize: '0.85em', opacity: 0.85 }}>Excel</span>
                                          <span style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
                                            {row.referencia || '—'}
                                          </span>
                                        </button>
                                      </div>
                                    </div>
                                  ) : !row.matched_producto_id && (invalidos.includes('Referencia') || row._editando_referencia) ? (
                                    // Sin referencia no se puede pedir la cotizacion: se escribe aqui.
                                    <input
                                      type="text"
                                      className={claseInput('Referencia')}
                                      value={row.referencia || ''}
                                      onChange={(e) => setRows((prev) => prev.map((r) => (r.fila_excel === row.fila_excel ? { ...r, referencia: e.target.value, _editando_referencia: true } : r)))}
                                      placeholder="Falta referencia"
                                      aria-label="Referencia del producto nuevo"
                                      autoComplete="off"
                                      style={{ fontSize: 'inherit', fontFamily: 'inherit' }}
                                    />
                                  ) : (
                                    <span
                                      title={row.referencia || ''}
                                      style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                    >
                                      {row.referencia || '—'}
                                    </span>
                                  )}
                                </td>
                                <td style={{ padding: '7px 12px' }}>
                                  {/* Sin OEM igual va el ícono si hay coincidencias (por
                                      referencia, p. ej. un producto agregado a mano), para
                                      ver sus descripciones y precios. */}
                                  {row.oem || (row.oem_matches || []).length ? (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                                      <span
                                        title={row.oem || undefined}
                                        style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                      >
                                        {row.oem || '—'}
                                      </span>
                                      <Info
                                        size={13}
                                        style={{ flexShrink: 0 }}
                                        className={`imp-distribucion__info-icon${(row.oem_matches || []).length ? '' : ' imp-distribucion__info-icon--empty'}`}
                                        onMouseEnter={(e) => showOemMatchesHover(e, row.oem_matches || [], row.fila_excel)}
                                        onMouseLeave={hideOemMatchesHover}
                                      />
                                    </div>
                                  ) : '—'}
                                </td>
                                <td style={{ padding: row.matched_producto_id ? '7px 12px' : '4px 8px' }}>
                                  {row.matched_producto_id ? (
                                    row.descripcion || '—'
                                  ) : (() => {
                                    return (
                                      <input
                                        type="text"
                                        className={claseInput('Descripción')}
                                        value={row.descripcion || ''}
                                        onChange={(e) => updateRowDescripcion(row.fila_excel, e.target.value)}
                                        placeholder={row.codigo_sugerido ? 'Descripción' : 'Descripción (opcional)'}
                                        title={
                                          row.codigo_sugerido
                                            ? 'Nombre del producto nuevo. Escríbelo o pasa el mouse sobre el ícono del OEM y haz clic en una de las coincidencias.'
                                            : 'Opcional: este producto no tiene código asignado, se creará como pendiente y se puede completar más tarde al vincularlo con el catálogo.'
                                        }
                                        style={{ fontSize: 'inherit', fontFamily: 'inherit' }}
                                      />
                                    )
                                  })()}
                                </td>
                                <td style={{ padding: '4px 8px', textAlign: 'center' }}>
                                  <input
                                    type="number"
                                    min="0"
                                    step="1"
                                    className="imp-excel-review__codigo-input imp-sugerencia__cant-input"
                                    value={row.cantidad ?? ''}
                                    onChange={(e) => updateRowCampo(row.fila_excel, 'cantidad', e.target.value.replace(/[^\d]/g, ''))}
                                    aria-label={`Cantidad de ${row.codigo || 'producto'}`}
                                  />
                                </td>
                                <td style={{ padding: '7px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                                  {(() => {
                                    const sistema = getSistemaPrecio(row)
                                    if (sistema == null) return <span style={{ color: 'var(--color-text-secondary)' }}>—</span>
                                    const otraCasa = !row.matched_producto_id && row.conflicto_casa
                                    const desdeSugerido = !row.matched_producto_id && !row.conflicto_casa && row.sugerido_desde
                                    return (
                                      <span
                                        style={{ fontWeight: 600, color: otraCasa ? '#c2410c' : desdeSugerido ? '#a16207' : undefined }}
                                        title={`${(otraCasa ? row.conflicto_casa_nombre : desdeSugerido ? row.sugerido_casa : casa?.nombre) || 'Casa comercial'}: $${Number(sistema).toFixed(2)}`}
                                      >
                                        ${Number(sistema).toFixed(2)}
                                      </span>
                                    )
                                  })()}
                                </td>
                                <td style={{ padding: '7px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                                  {(() => {
                                    const precio = getPrecioGuardado(row)
                                    if (!precio) return <span style={{ color: 'var(--color-text-secondary)' }}>—</span>
                                    const sistema = getSistemaPrecio(row)
                                    const difiere = sistema != null && Math.abs(precio.valor - Number(sistema)) >= 0.005
                                    return (
                                      <span
                                        style={{ fontWeight: 600, color: difiere ? '#b45309' : undefined }}
                                        title={`${parseInt(row.precio_nuevo || '0', 10) > 0 ? 'Precio ingresado' : 'Precio subido desde el Excel'}: $${precio.valor.toFixed(2)}`}
                                      >
                                        ${precio.valor.toFixed(2)}
                                      </span>
                                    )
                                  })()}
                                </td>
                                <td style={{ padding: '4px', textAlign: 'center' }}>
                                  <button
                                    type="button"
                                    className="imp-excel-review__quitar"
                                    onClick={() => removeReviewRow(row.fila_excel)}
                                    aria-label={`Quitar ${row.codigo || row.referencia || 'producto'} de la sugerencia`}
                                    title="Quitar de la sugerencia"
                                  >
                                    <X size={15} />
                                  </button>
                                </td>


                              </tr>
                            )
                          })}
                          {reviewRows.length > reviewRenderCount && (
                            <tr>
                              <td colSpan={8} style={{ padding: '10px 12px', textAlign: 'center', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                                {`Mostrando ${reviewRenderCount} de ${reviewRows.length} productos — baja para ver más`}
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                      </fieldset>
                    </div>

                    {unmatchedCount > 0 && (
                      <p style={{ margin: 0, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Info size={13} />
                        Los productos sin catálogo se crearán como pendientes. Podrás vincularlos al confirmar la llegada.
                      </p>
                    )}

                  </>
                )}
      {showNuevoProducto && (
        <SugerenciaNuevoProductoPopup onClose={() => setShowNuevoProducto(false)} onAdd={handleAddNuevoProducto} notify={notify} />
      )}
      {showAceptados && (
        <SugerenciaAceptadosPopup
          token={token}
          casa={casa}
          alreadyAddedIds={addedProductIds}
          alreadyAddedSolIds={addedSolIds}
          onConfirm={handleAceptadosConfirm}
          onClose={() => setShowAceptados(false)}
        />
      )}
      {cellHover && createPortal(
        // Por encima de la tarjeta de coincidencias OEM (también muestra títulos)
        // y sin salirse por la derecha en las columnas finales.
        <div className="imp-cell-hover-card" style={{ top: cellHover.top, left: Math.max(8, Math.min(cellHover.left, window.innerWidth - 388)), zIndex: 11001 }}>
          {cellHover.label && <div className="imp-cell-hover-card__title">{cellHover.label}</div>}
          <div className="imp-cell-hover-card__row">{cellHover.value}</div>
        </div>,
        getPortalRoot()
      )}
      {oemMatchesHover && createPortal(
        <div
          ref={oemMatchesHoverCardRef}
          className={`imp-alternos-hover-card${oemMatchesHover.matches.length ? ' imp-alternos-hover-card--oem' : ''}`}
          style={{
            top: oemMatchesHoverPos?.top ?? oemMatchesHover.triggerBottom + 4,
            left: oemMatchesHoverPos?.left ?? oemMatchesHover.triggerLeft,
            visibility: oemMatchesHoverPos ? 'visible' : 'hidden',
          }}
          onMouseEnter={cancelHideOemMatchesHover}
          onMouseLeave={hideOemMatchesHover}
          onMouseOver={handleTitleMouseOver}
          onMouseOut={handleTitleMouseOut}
        >
          {oemMatchesHover.matches.length ? (
            <table className="imp-alternos-hover-card__table imp-alternos-hover-card__table--oem">
              <thead>
                <tr><th>Código</th><th>Nombre</th><th>Referencia</th><th>OEM</th><th>Casa comercial</th><th>PVP</th><th>PVP + IVA</th></tr>
              </thead>
              <tbody>
                {oemMatchesHover.matches.map((p, i) => {
                  const canPick = Boolean(oemMatchesHover.filaExcel) && (p.precio != null || p.nombre)
                  return (
                    <tr
                      key={i}
                      title={canPick ? 'Clic para usar la descripción y el PVP (sin IVA) de este producto' : undefined}
                      onClick={canPick ? () => {
                        if (p.nombre) updateRowDescripcion(oemMatchesHover.filaExcel, p.nombre)
                        if (p.precio != null) updateRowPrecioCentavos(oemMatchesHover.filaExcel, String(Math.round(Number(p.precio) * 100)), (p.casas_comerciales_nombres || []).join(', '))
                        hideOemMatchesHover()
                      } : undefined}
                      className={canPick ? 'imp-alternos-hover-card__row--pickable' : undefined}
                    >
                      <td title={p.codigo || ''}>{p.codigo || '-'}</td>
                      <td>{p.nombre || '-'}</td>
                      <td title={(p.referencias?.length ? p.referencias : [p.referencia]).filter(Boolean).join(', ')}>
                        {(p.referencias?.length ? p.referencias : [p.referencia]).filter(Boolean).join(', ') || '-'}
                      </td>
                      <td title={(p.oems || []).join(', ')}>{(p.oems || []).join(', ') || '-'}</td>
                      <td title={(p.casas_comerciales_nombres || []).join(', ')}>{(p.casas_comerciales_nombres || []).join(', ') || '-'}</td>
                      <td>{p.precio != null ? `$${Number(p.precio).toFixed(2)}` : '-'}</td>
                      <td>{p.precio_con_iva != null ? `$${Number(p.precio_con_iva).toFixed(2)}` : '-'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : (
            <div className="imp-alternos-hover-card__message">Ningún producto del catálogo tiene este OEM o esta referencia registrados.</div>
          )}
        </div>,
        getPortalRoot()
      )}
    </>
  )
}

// "Sugerencia desde Excel" y tambien "Crear sugerencia" a mano (modo
// "manual": de la casa comercial pasa directo a la tabla, vacia). Las dos
// usan la misma tabla (SugerenciaTabla) que la sugerencia ya guardada.
// Coincidencias del catalogo de las filas de una importacion (para la "i"
// del OEM), pedidas una sola vez por fila. items = [{ key, oem, referencia }].
// Devuelve { [key]: matches }; una fila sin OEM ni referencia queda en [].
const useCoincidencias = (token, casaId, items) => {
  const [byKey, setByKey] = useState({})
  const pedidasRef = useRef(new Set())
  useEffect(() => {
    pedidasRef.current = new Set()
    setByKey({})
  }, [casaId])
  useEffect(() => {
    if (!token || !casaId) return
    const nuevas = items.filter((it) => it.key != null && !pedidasRef.current.has(String(it.key)))
    if (!nuevas.length) return
    nuevas.forEach((it) => pedidasRef.current.add(String(it.key)))
    const sinDatos = nuevas.filter((it) => !String(it.oem || '').trim() && !String(it.referencia || '').trim())
    const conDatos = nuevas.filter((it) => !sinDatos.includes(it))
    if (sinDatos.length) {
      setByKey((prev) => ({ ...prev, ...Object.fromEntries(sinDatos.map((it) => [String(it.key), []])) }))
    }
    if (!conDatos.length) return
    fetchCoincidencias(token, casaId, conDatos.map((it) => ({ key: String(it.key), oem: it.oem || '', referencia: it.referencia || '' })), { soloCoincidencias: true })
      .then((rows) => setByKey((prev) => {
        const next = { ...prev }
        rows.forEach((r) => { next[String(r.fila_excel)] = r.oem_matches || [] })
        return next
      }))
      .catch(() => {})
  }, [token, casaId, items])
  return byKey
}

// Icono "i" junto al OEM en las tablas de importaciones: que productos del
// catalogo tienen ese OEM o esa referencia (la misma tarjeta que en la
// sugerencia). Sin coincidencias el icono se ve opaco.
function CoincidenciasInfo({ matches }) {
  const [hover, setHover] = useState(null)
  const [pos, setPos] = useState(null)
  const cardRef = useRef(null)
  const timerRef = useRef(null)
  const lista = Array.isArray(matches) ? matches : null
  const cancelar = () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null } }
  const mostrar = (event) => {
    cancelar()
    const rect = event.currentTarget.getBoundingClientRect()
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setHover({ triggerTop: rect.top, triggerBottom: rect.bottom, triggerLeft: rect.left })
    }, 150)
  }
  // Con un pequeno retraso, para poder pasar del icono a la tarjeta.
  const ocultar = () => {
    cancelar()
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setHover(null)
      setPos(null)
    }, 250)
  }
  useEffect(() => cancelar, [])
  useLayoutEffect(() => {
    if (!hover || !cardRef.current) return
    setPos(computeSmartPopoverPosition(hover, cardRef.current))
  }, [hover, lista?.length])
  return (
    <>
      <Info
        size={13}
        style={{ flexShrink: 0 }}
        className={`imp-distribucion__info-icon${lista?.length ? '' : ' imp-distribucion__info-icon--empty'}`}
        onMouseEnter={mostrar}
        onMouseLeave={ocultar}
      />
      {hover && createPortal(
        <div
          ref={cardRef}
          className={`imp-alternos-hover-card${lista?.length ? ' imp-alternos-hover-card--oem' : ''}`}
          style={{ top: pos?.top ?? hover.triggerBottom + 4, left: pos?.left ?? hover.triggerLeft, visibility: pos ? 'visible' : 'hidden' }}
          onMouseEnter={cancelar}
          onMouseLeave={ocultar}
        >
          {lista == null ? (
            <div className="imp-alternos-hover-card__message">Buscando coincidencias en el catálogo...</div>
          ) : lista.length ? (
            <table className="imp-alternos-hover-card__table imp-alternos-hover-card__table--oem">
              <thead>
                <tr><th>Código</th><th>Nombre</th><th>Referencia</th><th>OEM</th><th>Casa comercial</th><th>PVP</th><th>PVP + IVA</th></tr>
              </thead>
              <tbody>
                {lista.map((p, i) => (
                  <tr key={i}>
                    <td>{p.codigo || '-'}</td>
                    <td>{p.nombre || '-'}</td>
                    <td>{(p.referencias?.length ? p.referencias : [p.referencia]).filter(Boolean).join(', ') || '-'}</td>
                    <td>{(p.oems || []).join(', ') || '-'}</td>
                    <td>{(p.casas_comerciales_nombres || []).join(', ') || '-'}</td>
                    <td>{p.precio != null ? `$${Number(p.precio).toFixed(2)}` : '-'}</td>
                    <td>{p.precio_con_iva != null ? `$${Number(p.precio_con_iva).toFixed(2)}` : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="imp-alternos-hover-card__message">Ningún producto del catálogo tiene este OEM o esta referencia registrados.</div>
          )}
        </div>,
        getPortalRoot()
      )}
    </>
  )
}

function ImportacionExcelModal({ token, onClose, onCreated, isTabActive, modo = 'excel' }) {
  const esManual = modo === 'manual'
  const toastRef = useRef(null)

  const [step, setStep] = useState('casa')
  const [downloading, setDownloading] = useState(false)
  const [downloadingReview, setDownloadingReview] = useState(false)

  // Casa step
  const [casaDraft, setCasaDraft] = useState(null)
  const [selectedCasa, setSelectedCasa] = useState(null)
  const [casaQuery, setCasaQuery] = useState('')
  const [casaOptions, setCasaOptions] = useState([])
  const [casaLoading, setCasaLoading] = useState(false)
  const [showCasaDropdown, setShowCasaDropdown] = useState(false)
  const casaTimerRef = useRef(null)
  const casaDropdownRef = useRef(null)
  const isCasaStep = step === 'casa'

  // Modal arrastrable/redimensionable/maximizable, igual que el resto de
  // modales de la app (p. ej. EditImportacionModal más abajo en este mismo
  // archivo): antes este wizard usaba un popup estático sin estas opciones.
  // El ancho preferido varía por paso (paso 3 necesita más espacio para la
  // tabla) y el alto siempre se ajusta al contenido en vez de forzar un
  // mínimo grande — este wizard es mucho más corto que otros modales.
  const EXCEL_MODAL_MIN_WIDTH = 460
  const EXCEL_MODAL_MIN_HEIGHT = 260
  const EXCEL_STEP_WIDTH = 820
  // El paso 3 necesita suficiente ancho para que la tabla de revisión (870px
  // de minWidth) entre completa sin scroll horizontal, contando el padding
  // del modal y el scrollbar vertical de la tabla cuando hay muchas filas.
  const EXCEL_STEP3_WIDTH = 950
  const [modalPosition, setModalPosition] = useState({ x: 0, y: 0 })
  const [modalSize, setModalSize] = useState({ width: EXCEL_STEP_WIDTH, height: SELECTOR_HEIGHT_EMPTY })
  const [isMaximized, setIsMaximized] = useState(false)
  const modalRef = useRef(null)
  const modalDrag = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const modalSizeRef = useRef(modalSize)
  const modalPositionRef = useRef(modalPosition)
  const modalRestoreRef = useRef(null)
  const resizeData = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const [casaPanelStyle, setCasaPanelStyle] = useState(null)

  // Step 2: file upload
  const fileInputRef = useRef(null)
  const [selectedFile, setSelectedFile] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const [parsing, setParsing] = useState(false)
  const [parsingProgress, setParsingProgress] = useState(0)
  const [parseError, setParseError] = useState('')
  const parsingCancelledRef = useRef(false)
  useEffect(() => () => { parsingCancelledRef.current = true }, [])

  // Step 3
  const [parsedRows, setParsedRows] = useState([])
  // Buscador y scroll de la tabla, para volver a donde estaba al cambiar de
  // pestana (la tabla se desmonta mientras tanto).
  const sugerenciaViewRef = useRef({})
  const [referenciaDecisions, setReferenciaDecisions] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  // Tooltip simple para valores truncados con "...", como el código dentro
  // de los botones "Actual"/"Excel" del conflicto de referencia.
  const [cellHover, setCellHover] = useState(null)
  const cellHoverTimerRef = useRef(null)
  const showCellHover = (event, value, label) => {
    if (!value) return
    if (cellHoverTimerRef.current) clearTimeout(cellHoverTimerRef.current)
    const rect = event.currentTarget.getBoundingClientRect()
    cellHoverTimerRef.current = setTimeout(() => {
      cellHoverTimerRef.current = null
      setCellHover({ top: rect.bottom + 4, left: rect.left, value, label })
    }, 300)
  }
  const hideCellHover = () => {
    if (cellHoverTimerRef.current) { clearTimeout(cellHoverTimerRef.current); cellHoverTimerRef.current = null }
    setCellHover(null)
  }

  // Los `title` del modal se muestran con la misma tarjeta blanca (el
  // tooltip nativo está desactivado en todo el sistema y el texto queda en
  // data-title, ver utils/nativeTooltips). Dentro de una tabla, el encabezado
  // de la columna sirve de título de la tarjeta.
  const titleHoverRef = useRef(null)
  const handleTitleMouseOver = (event) => {
    const el = event.target.closest?.('[data-title]')
    if (!el || titleHoverRef.current === el) return
    titleHoverRef.current = el
    const cell = el.closest('td')
    const header = cell?.closest('table')?.tHead?.rows[0]?.cells[cell.cellIndex]
    showCellHover({ currentTarget: el }, el.getAttribute('data-title'), header?.textContent.trim() || '')
  }
  const handleTitleMouseOut = (event) => {
    const current = titleHoverRef.current
    if (!current || current.contains(event.relatedTarget)) return
    titleHoverRef.current = null
    hideCellHover()
  }

  useCloseDropdownsOnTabSwitch(
    useCallback(() => {
      setShowCasaDropdown(false)
      hideCellHover()
    }, [])
  )

  // Solo el paso 3 (la tabla) se beneficia de maximizar — los pasos 1/2 son
  // contenido corto y fijo que no crece con el modal, así que no ofrecen esa
  // opción.
  const isMaximizableStep = step === 3

  useLayoutEffect(() => {
    // Si se vuelve a un paso que no permite maximizar (p. ej. con "Atrás"
    // desde el paso 3 estando maximizado), hay que forzar el tamaño
    // compacto normal en vez de quedarse con el ancho de pantalla completa.
    const forceRestore = !isMaximizableStep && isMaximized
    if (isMaximized && !forceRestore) return
    if (forceRestore) setIsMaximized(false)
    const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2)
    const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2)
    // La selección de casa y los pasos 1 y 2 comparten el mismo ancho fijo
    // (a diferencia de un "fit-content" que se mide después de renderizar,
    // esto evita que el modal se recentre con una medida vieja y se vea
    // saltar de lugar al pasar de un paso a otro). Solo el paso 3 es más
    // ancho, porque necesita espacio real para la tabla de revisión.
    // El paso 3 abre al mismo ancho que la sugerencia guardada, para que la
    // tabla de revision se vea igual (EXCEL_STEP3_WIDTH queda de minimo).
    const preferredWidth = step === 3 ? Math.max(Math.min(SUGERENCIA_MODAL_WIDTH, Math.round(window.innerWidth * 0.9)), EXCEL_STEP3_WIDTH) : EXCEL_STEP_WIDTH
    const measuredWidth = Math.min(preferredWidth, availableWidth)
    const nextWidth = measuredWidth
    const measuredHeight = modalRef.current?.offsetHeight || (isCasaStep ? (casaDraft ? 380 : 200) : 300)
    const nextHeight = Math.min(measuredHeight, availableHeight)
    setModalSize({ width: nextWidth, height: SELECTOR_HEIGHT_EMPTY })
    setModalPosition({
      x: Math.max((window.innerWidth - measuredWidth) / 2, VIEWPORT_PADDING),
      y: Math.max((window.innerHeight - nextHeight) / 2, VIEWPORT_PADDING),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, casaDraft])

  useLayoutEffect(() => {
    if (!showCasaDropdown || !casaDropdownRef.current) { setCasaPanelStyle(null); return }
    const rect = casaDropdownRef.current.getBoundingClientRect()
    setCasaPanelStyle({
      position: 'fixed',
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
      maxHeight: Math.min(260, window.innerHeight - rect.bottom - 8),
      zIndex: 9999,
    })
  }, [showCasaDropdown, modalPosition])

  useEffect(() => { modalSizeRef.current = modalSize }, [modalSize])
  useEffect(() => { modalPositionRef.current = modalPosition }, [modalPosition])

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!modalDrag.current.active) return
      e.preventDefault()
      const maxX = Math.max(window.innerWidth - modalSizeRef.current.width - VIEWPORT_PADDING, VIEWPORT_PADDING)
      const modalHeight = typeof modalSizeRef.current.height === 'number'
        ? modalSizeRef.current.height
        : (modalRef.current?.offsetHeight || 0)
      const maxY = Math.max(window.innerHeight - modalHeight - VIEWPORT_PADDING, VIEWPORT_PADDING)
      setModalPosition({
        x: clamp(e.clientX - modalDrag.current.offsetX, VIEWPORT_PADDING, maxX),
        y: clamp(e.clientY - modalDrag.current.offsetY, VIEWPORT_PADDING, maxY),
      })
    }
    const handleMouseUp = () => { modalDrag.current.active = false }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => { window.removeEventListener('mousemove', handleMouseMove); window.removeEventListener('mouseup', handleMouseUp) }
  }, [])

  useEffect(() => {
    const handleWindowResize = () => {
      const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2)
      const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2)
      if (isMaximized) {
        setModalSize({ width: availableWidth, height: availableHeight })
        setModalPosition({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
        return
      }
      setModalSize((prev) => {
        const width = typeof prev.width === 'number' ? clamp(prev.width, EXCEL_MODAL_MIN_WIDTH, availableWidth) : prev.width
        const height = typeof prev.height === 'number' ? clamp(prev.height, EXCEL_MODAL_MIN_HEIGHT, availableHeight) : prev.height
        const widthForBounds = typeof width === 'number' ? width : (modalRef.current?.offsetWidth || EXCEL_MODAL_MIN_WIDTH)
        const heightForBounds = typeof height === 'number' ? height : (modalRef.current?.offsetHeight || EXCEL_MODAL_MIN_HEIGHT)
        setModalPosition((prevPos) => ({
          x: clamp(prevPos.x, VIEWPORT_PADDING, Math.max(window.innerWidth - widthForBounds - VIEWPORT_PADDING, VIEWPORT_PADDING)),
          y: clamp(prevPos.y, VIEWPORT_PADDING, Math.max(window.innerHeight - heightForBounds - VIEWPORT_PADDING, VIEWPORT_PADDING)),
        }))
        return { width, height }
      })
    }
    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [isMaximized])

  const toggleMaximize = () => {
    modalDrag.current.active = false
    if (isMaximized) {
      const restore = modalRestoreRef.current
      if (restore) {
        setModalSize(restore.size)
        setModalPosition(restore.position)
      }
      setIsMaximized(false)
      return
    }
    modalRestoreRef.current = { size: { ...modalSizeRef.current }, position: { ...modalPositionRef.current } }
    const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2)
    const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2)
    setModalSize({ width: availableWidth, height: availableHeight })
    setModalPosition({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
    setIsMaximized(true)
  }

  const handleModalMouseDown = (e) => {
    if (isMaximized) return
    if (!modalRef.current) return
    const rect = modalRef.current.getBoundingClientRect()
    modalDrag.current = { active: true, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top }
  }

  const handleResizeMouseDown = (e) => {
    if (isMaximized) return
    e.preventDefault()
    e.stopPropagation()
    resizeData.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      // El ancho/alto pueden no ser números (contenido ajustado) hasta el
      // primer resize manual: en ese caso se parte del tamaño ya renderizado.
      startWidth: typeof modalSizeRef.current.width === 'number'
        ? modalSizeRef.current.width
        : (modalRef.current?.offsetWidth || EXCEL_STEP3_WIDTH),
      startHeight: typeof modalSizeRef.current.height === 'number'
        ? modalSizeRef.current.height
        : (modalRef.current?.offsetHeight || EXCEL_MODAL_MIN_HEIGHT),
    }
    const handleResizeMove = (moveEvent) => {
      if (!resizeData.current.active) return
      const deltaX = moveEvent.clientX - resizeData.current.startX
      const deltaY = moveEvent.clientY - resizeData.current.startY
      // El resize handle solo se muestra en el paso 3 (ver isMaximizableStep),
      // así que el mínimo acá siempre debe ser el ancho que necesita la tabla
      // de revisión para no requerir scroll horizontal.
      const maxWidth = Math.max(EXCEL_STEP3_WIDTH, window.innerWidth - modalPositionRef.current.x - VIEWPORT_PADDING)
      const maxHeight = Math.max(EXCEL_MODAL_MIN_HEIGHT, window.innerHeight - modalPositionRef.current.y - VIEWPORT_PADDING)
      setModalSize({
        width: clamp(resizeData.current.startWidth + deltaX, EXCEL_STEP3_WIDTH, maxWidth),
        height: clamp(resizeData.current.startHeight + deltaY, EXCEL_MODAL_MIN_HEIGHT, maxHeight),
      })
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
    const handleMouseDown = (e) => {
      const inCasa = casaDropdownRef.current?.contains(e.target) || e.target.closest?.('[data-casa-portal]')
      if (!inCasa) setShowCasaDropdown(false)
    }
    const handleKeyDown = (e) => { if (e.key === 'Escape') excelRequestCloseRef.current?.() }
    document.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  useEffect(() => {
    if (!showCasaDropdown && step !== 'casa') return
    clearTimeout(casaTimerRef.current)
    setCasaLoading(true)
    casaTimerRef.current = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ page_size: '10', tipo: 'importacion' })
        if (casaQuery.trim()) params.set('search', casaQuery.trim())
        const resp = await authFetch(`${API_URL}/casa-comercial/casas/?${params}`, {}, token)
        const data = resp.ok ? await resp.json().catch(() => ({})) : {}
        setCasaOptions(Array.isArray(data.results) ? data.results : [])
      } catch {}
      setCasaLoading(false)
    }, 280)
    return () => clearTimeout(casaTimerRef.current)
  }, [casaQuery, token, showCasaDropdown, step])

  const handleDownloadTemplate = async () => {
    setDownloading(true)
    try {
      const XLSXStyle = (await import('xlsx-js-style')).default
      // Sugerencia template: no sucursal columns
      const headers = ['CODIGO JP', 'REFERENCIA', 'OEM', 'DESCRIPCIÓN', 'CANTIDAD', 'PVP']
      const colCount = headers.length
      // 0-3 = text (@), 4 = integer (0), 5 = decimal (0.00)
      const colFormat = (ci) => ci === 4 ? '0' : ci === 5 ? '0.00' : '@'
      const headerStyle = {
        font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 },
        fill: { fgColor: { rgb: '1A1A2E' }, patternType: 'solid' },
        alignment: { horizontal: 'center', vertical: 'center' },
        border: {
          top: { style: 'thin', color: { rgb: '2563EB' } },
          bottom: { style: 'medium', color: { rgb: '2563EB' } },
          left: { style: 'thin', color: { rgb: '2563EB' } },
          right: { style: 'thin', color: { rgb: '2563EB' } },
        },
      }
      const ROWS = 2000
      const borderStyle = { style: 'thin', color: { rgb: 'DBEAFE' } }
      const border = { top: borderStyle, bottom: borderStyle, left: borderStyle, right: borderStyle }
      const baseEven = { fill: { fgColor: { rgb: 'EFF6FF' }, patternType: 'solid' }, alignment: { vertical: 'center' }, border }
      const baseOdd  = { fill: { fgColor: { rgb: 'FFFFFF' }, patternType: 'solid' }, alignment: { vertical: 'center' }, border }
      const aoa = [headers, ...Array.from({ length: ROWS }, () => Array(colCount).fill(''))]
      const worksheet = XLSXStyle.utils.aoa_to_sheet(aoa)
      headers.forEach((_, ci) => {
        const ref = XLSXStyle.utils.encode_cell({ r: 0, c: ci })
        if (worksheet[ref]) worksheet[ref].s = headerStyle
      })
      for (let ri = 1; ri <= ROWS; ri++) {
        const base = ri % 2 === 0 ? baseEven : baseOdd
        for (let ci = 0; ci < colCount; ci++) {
          const ref = XLSXStyle.utils.encode_cell({ r: ri, c: ci })
          if (!worksheet[ref]) worksheet[ref] = { t: 's', v: '' }
          worksheet[ref].s = { ...base, numFmt: colFormat(ci) }
        }
      }
      worksheet['!cols'] = [{ wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 32 }, { wch: 11 }, { wch: 10 }]
      worksheet['!rows'] = [{ hpt: 22 }]
      const workbook = XLSXStyle.utils.book_new()
      XLSXStyle.utils.book_append_sheet(workbook, worksheet, 'Importación')
      const out = XLSXStyle.write(workbook, { bookType: 'xlsx', type: 'array' })
      const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = 'plantilla-sugerencia.xlsx'
      document.body.appendChild(link); link.click(); document.body.removeChild(link)
      URL.revokeObjectURL(link.href)
    } catch (e) { console.error(e) }
    setDownloading(false)
  }

  const handleDownloadReviewExcel = async () => {
    setDownloadingReview(true)
    try {
      // Mismas columnas (y en el mismo orden) que la tabla de revisión en
      // pantalla: PVP JP (sistema) y su casa, y PVP (el que se guarda) y su
      // casa. NOTA es extra del Excel; la casa de la sugerencia va en el
      // nombre del archivo.
      // Se ordena por la fila que tenia cada producto en el Excel ORIGINAL
      // subido (row.orden), no por el orden en que se muestran en pantalla
      // (que agrupa por revisión pendiente/sugeridos/vinculados/sin-catalogo)
      // -- asi el Excel descargado sale en el mismo orden en que se subio.
      const rows = [...validRows]
        .sort((a, b) => (Number(a.orden) || 0) - (Number(b.orden) || 0))
        .map((row) => {
          const isConflict = Boolean(row.conflicto_casa)
          return {
            codigo: row.codigo || '',
            referencia: row.referencia || '',
            oem: row.oem || '',
            descripcion: row.descripcion || '',
            cantidad: row.cantidad ?? '',
            pvpJp: getSistemaPrecio(row) != null ? Number(getSistemaPrecio(row)) : '',
            // Casa del producto del que sale el PVP JP (esta, otra casa con el
            // mismo código/referencia o la del código sugerido).
            pvpJpCasa: getSistemaPrecio(row) != null ? getSistemaCasa(row) : '',
            pvp: getPrecioGuardado(row)?.valor ?? '',
            pvpCasa: getPrecioGuardado(row)?.casa ?? '',
            nota: isConflict
              ? `Ya existe en ${row.conflicto_casa_nombre || 'otra casa'} — se creará como nuevo`
              : (row.codigo_sugerido ? 'Sugerido (nuevo)' : ''),
            isConflict,
            isSuggested: Boolean(row.codigo_sugerido),
          }
        })
      await downloadSugerenciaExcel(rows, `revision-sugerencia-${selectedCasa?.nombre || 'excel'}.xlsx`)
    } catch (e) { console.error(e) }
    setDownloadingReview(false)
  }

  const handleFileSelect = (file) => {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.xlsx')) { setParseError('El archivo debe ser formato .xlsx'); return }
    setSelectedFile(file)
    setParseError('')
  }

  const handleProcess = async () => {
    setParseError('')
    setParsing(true)
    setParsingProgress(0)
    parsingCancelledRef.current = false
    try {
      const data = await runParseExcelJob({
        file: selectedFile,
        casaId: selectedCasa.id,
        token,
        onProgress: setParsingProgress,
        isCancelled: () => parsingCancelledRef.current,
      })
      if (!data) return
      const rowsWithSuggestions = (data.rows || []).map((row) => enrichParsedRow(row, selectedCasa?.codigo))
      setParsedRows(rowsWithSuggestions)
      sugerenciaViewRef.current = {}
      setReferenciaDecisions({})
      setSubmitError('')
      setStep(3)
    } catch (e) {
      if (!parsingCancelledRef.current) setParseError(e.message)
    } finally {
      if (!parsingCancelledRef.current) setParsing(false)
    }
  }

  const handleCreate = async () => {
    // La descripcion o la referencia/OEM que falten no impiden crear la
    // sugerencia: se completan en ella antes de pedir la cotizacion.
    if (!allConflictsResolved || duplicateProductGroups.length > 0) {
      const reasons = []
      if (!allConflictsResolved) reasons.push('hay conflictos de referencia sin resolver')
      if (duplicateProductGroups.length > 0) reasons.push('hay productos repetidos dentro del mismo Excel')
      toastRef.current?.show({
        severity: 'warn',
        summary: 'Faltan datos',
        detail: `No se puede crear la sugerencia: ${reasons.join(' y ')}.`,
        life: 4500,
      })
      return
    }
    setSubmitError('')
    setSubmitting(true)
    try {
      // Mismo orden que la vista previa (validRows ya viene ordenado por
      // rowSortRank): la sugerencia guardada sale identica. Antes los del
      // catalogo iban primero y los grupos quedaban en otro orden.
      const detalles = validRows.map((row, pos) => {
        const precio = getPrecioGuardado(row)
        // Lo agregado desde "Aceptados de solicitudes" queda ligado a su
        // solicitud; el comentario se escribe en la tabla.
        const extra = {
          ...(row.solicitud_id ? { solicitud_id: Number(row.solicitud_id) } : {}),
          ...(String(row.comentario || '').trim() ? { comentario: String(row.comentario).trim() } : {}),
        }
        return row.matched_producto_id
          ? {
              ...extra,
              producto_id: row.matched_producto_id,
              referencia: row.referencia,
              cantidad: row.cantidad,
              orden: pos + 1,
              ...(precio ? { precio_estimado: precio.valor.toFixed(2), precio_casa: precio.casa } : {}),
              ...(hasReferenciaConflict(row) && referenciaDecisions[row.fila_excel] === 'excel'
                ? { update_referencia: true, nueva_referencia: row.referencia }
                : {}),
            }
          // Producto sin producto_id (código sugerido por OEM o realmente sin
          // catálogo): se crea como pendiente, sin vincular todavía a un
          // Producto real, pero con la cantidad que trae el Excel — el
          // producto recién se crea en el catálogo al importar.
          : {
              ...extra,
              codigo: row.codigo, nombre: row.descripcion, referencia: row.referencia, oem: row.oem, cantidad: row.cantidad, precio_estimado: (precio?.valor ?? 0).toFixed(2), precio_casa: precio?.casa || '', orden: pos + 1,
              // Amarillo/naranja de esta vista previa, para que la sugerencia
              // guardada se vea igual. Solo referencia: no crea el producto.
              coincidencia: row.conflicto_casa ? 'otra_casa' : row.codigo_sugerido ? 'oem' : '',
              coincidencia_codigo: row.conflicto_casa ? '' : (row.sugerido_desde || ''),
              coincidencia_casa: row.conflicto_casa ? (row.conflicto_casa_nombre || '') : (row.sugerido_casa || ''),
              coincidencia_precio: getSistemaPrecio(row) != null ? Number(getSistemaPrecio(row)).toFixed(2) : null,
            }
      })
      const resp = await authFetch(
        `${API_URL}/importaciones/importaciones/`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ casa_comercial_id: selectedCasa.id, detalles }) },
        token
      )
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(data.detail || 'No se pudo crear la importación.')
      onCreated?.(data)
      excelSavedRef.current = true
      onClose()
    } catch (e) {
      setSubmitError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleRetry = () => {
    setSelectedFile(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
    setParsedRows([])
    setReferenciaDecisions({})
    setSubmitError('')
    setParseError('')
    setStep(2)
  }

  const canProcess = Boolean(selectedFile && selectedCasa)
  // Mismo orden que la tabla (ver sortSugerenciaRows): en pantalla, en el
  // Excel descargado y en la sugerencia creada.
  const validRows = sortSugerenciaRows(parsedRows)
  const allConflictsResolved = validRows.every((row) => !hasReferenciaConflict(row) || referenciaDecisions[row.fila_excel] !== undefined)
  const duplicateProductGroups = getDuplicateProductGroups(validRows)
  const getSistemaPrecio = sugerenciaSistemaPrecio
  const getSistemaCasa = (row) => sugerenciaSistemaCasa(row, selectedCasa?.nombre)
  const getPrecioGuardado = (row) => sugerenciaPrecioGuardado(row, selectedCasa?.nombre)

  const stepLabel = step === 1 ? 'Descarga la plantilla' : step === 2 ? 'Sube el archivo' : 'Revisa los productos'
  const portalRoot = getAppPortalRoot()
  // Mientras el usuario no haya redimensionado ni maximizado manualmente,
  // el alto sigue siendo 'auto' (ajustado al contenido) — apenas resize o
  // maximize se disparan, modalSize.height pasa a ser un número concreto y
  // el modal queda libre para crecer de verdad.
  const isCompactHeight = typeof modalSize.height !== 'number'

  // No se desmonta al cambiar de pestaña del workspace (eso perdería el
  // progreso del wizard) — solo deja de pintarse mientras esa pestaña no
  // está activa, igual que ImportacionDetailsModal más abajo en este archivo.
  // "¿Guardar cambios?" al cerrar con un Excel ya procesado (tambien al
  // cerrar la pestana). Guardar = crear la importacion.
  const excelSavedRef = useRef(false)
  const unsavedGuard = useUnsavedChangesGuard({
    watch: {
      casa: selectedCasa?.id || null,
      archivo: selectedFile?.name || '',
      filas: parsedRows.length,
      decisiones: referenciaDecisions,
    },
    enabled: true,
    onSave: async () => {
      excelSavedRef.current = false
      await handleCreate()
      return excelSavedRef.current
    },
    onClose,
    label: esManual ? 'Nueva sugerencia de importación' : 'Importación desde Excel',
  })
  const excelRequestCloseRef = useRef(unsavedGuard.requestClose)
  excelRequestCloseRef.current = unsavedGuard.requestClose

  if (isTabActive === false) return null

  return createPortal(
    <>
      <Toast ref={toastRef} />
      <div
        className="create-user__overlay"
        role="dialog"
        aria-modal="true"
        style={{ padding: `${VIEWPORT_PADDING}px`, zIndex: 2100 }}
        onMouseOver={handleTitleMouseOver}
        onMouseOut={handleTitleMouseOut}
      >
        {unsavedGuard.dialog}
        <div
          ref={modalRef}
          {...unsavedGuard.interactionProps}
          className={`create-user__modal${isCompactHeight ? ' importaciones-modal--wizard' : ''}${isCasaStep ? ' importaciones-modal--selector' : ''}`}
          style={{
            top: modalPosition.y,
            left: modalPosition.x,
            width: modalSize.width,
            height: modalSize.height,
            minWidth: isCasaStep ? undefined : step === 3 ? EXCEL_STEP3_WIDTH : EXCEL_MODAL_MIN_WIDTH,
            minHeight: isCasaStep ? undefined : EXCEL_MODAL_MIN_HEIGHT,
            maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
            maxHeight: `calc(100dvh - ${VIEWPORT_PADDING * 2}px)`,
          }}
        >
          <header className="create-user__header" onMouseDown={handleModalMouseDown}>
            <div className="create-user__header-text">
              <h3>{esManual ? 'Crear sugerencia' : 'Sugerencia desde Excel'}</h3>
            </div>
            {!isCasaStep && !esManual && (
              <p className="importaciones-modal__step-label">Paso {step}: {stepLabel}</p>
            )}
            <div className="create-user__header-actions">
              {isMaximizableStep && (
                <button
                  type="button"
                  className="create-user__icon-button create-user__icon-button--maximize"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={toggleMaximize}
                  aria-label={isMaximized ? 'Restaurar' : 'Maximizar'}
                >
                  <i className={isMaximized ? 'pi pi-window-minimize' : 'pi pi-window-maximize'} aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                className="create-user__icon-button"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={unsavedGuard.requestClose}
                aria-label="Cerrar"
              >
                <i className="pi pi-times" aria-hidden="true" />
              </button>
            </div>
          </header>

          {isCasaStep ? (
            <form className="create-user__form importaciones-modal__selector-form" noValidate onSubmit={(e) => e.preventDefault()}>
              <div className="create-salida__selector-shell" style={{ flex: 'none', overflow: 'visible' }}>
                <section className="create-user__section create-salida__selector-card">
                  <div className="create-user__section-header">
                    <div>
                      <h4>Selecciona la casa comercial</h4>
                    </div>
                  </div>
                  <div className="create-salida__selector-inner">
                    <div className="create-user__field create-salida__selector-field">
                      <div className="create-user__dropdown" ref={casaDropdownRef} style={{ width: '100%' }}>
                        <div
                          className="create-user__dropdown-trigger"
                          style={{ cursor: 'text', display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px' }}
                          onClick={() => setShowCasaDropdown(true)}
                        >
                          <i className="pi pi-search" style={{ color: 'var(--color-muted, #888)', flexShrink: 0 }} />
                          <input
                            type="text"
                            placeholder="Busca por nombre, código o país..."
                            value={casaQuery}
                            onChange={(e) => { setCasaQuery(e.target.value); setCasaDraft(null); setShowCasaDropdown(true) }}
                            onFocus={() => setShowCasaDropdown(true)}
                            style={{ border: 'none', outline: 'none', flex: 1, background: 'transparent', fontSize: 'inherit', color: 'inherit' }}
                            autoComplete="off"
                          />
                          {casaLoading && <i className="pi pi-spin pi-spinner" style={{ flexShrink: 0 }} />}
                        </div>
                      </div>

                      {showCasaDropdown && casaPanelStyle && createPortal(
                        <div data-casa-portal className="create-user__dropdown-panel" style={casaPanelStyle}>
                          <div className="create-user__dropdown-results">
                            {casaLoading && <small className="muted">Buscando...</small>}
                            {!casaLoading && !casaOptions.length && <CasaImportacionEmpty query={casaQuery} />}
                            {casaOptions.map((casa) => (
                              <button
                                key={casa.id}
                                type="button"
                                className="create-user__result-option"
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => { setCasaDraft(casa); setCasaQuery(''); setShowCasaDropdown(false); setCasaOptions([]) }}
                              >
                                <div className="create-user__result-info">
                                  <strong>{String(casa?.nombre || '').trim()}</strong>
                                  <small>
                                    {[String(casa?.codigo || '').trim(), String(casa?.pais?.nombre || '').trim()].filter(Boolean).join(' · ')}
                                  </small>
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>,
                        portalRoot
                      )}
                    </div>

                    {casaDraft && (
                      <div className="create-salida__field-group create-salida__field-group--defined" style={{ marginTop: '14px' }}>
                        <div className="create-user__grid create-user__grid--two">
                          <StaticFieldDisplay label="Código" value={casaDraft.codigo} />
                          <StaticFieldDisplay label="Descripción" value={casaDraft.nombre} />
                          <div className="create-user__field create-salida__static-field">
                            <span>País</span>
                            <div className="create-salida__static-value" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              {(() => {
                                const flagUrl = getFlagUrl(casaDraft.pais?.codigo_pais)
                                return (
                                  <span className={`create-user__flag${flagUrl ? '' : ' is-empty'}`} aria-hidden="true" style={{ flexShrink: 0 }}>
                                    {flagUrl ? <img src={flagUrl} alt="" /> : '□'}
                                  </span>
                                )
                              })()}
                              {String(casaDraft.pais?.nombre || '—').trim()}
                            </div>
                          </div>
                          <StaticFieldDisplay
                            label="Días de entrega"
                            value={casaDraft.dias_entrega != null ? `${casaDraft.dias_entrega} días` : ''}
                          />
                          {casaDraft.descripcion && (
                            <StaticFieldDisplay label="Nota" value={casaDraft.descripcion} fullWidth />
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </section>
              </div>

              <div className="create-user__footer">
                <div className="user-details__footer-left">
                  <button type="button" className="create-user__action create-user__action--cancel" onClick={unsavedGuard.requestClose}>Cancelar</button>
                </div>
                <div className="user-details__footer-right">
                  <button
                    type="button"
                    className="create-user__action create-user__action--primary"
                    disabled={!casaDraft}
                    onClick={() => { setSelectedCasa(casaDraft); setStep(esManual ? 3 : 1) }}
                  >
                    Siguiente
                  </button>
                </div>
              </div>
            </form>
          ) : (
          <form className="create-user__form" noValidate onSubmit={(e) => e.preventDefault()}>
          <div className="create-user__content">
          <div className="create-user__body" style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 18, paddingBottom: 14 }}>

            {/* ── PASO 1: Descargar ── */}
            {step === 1 && (
              <>
                <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', margin: 0 }}>
                  Descarga la plantilla y rellénala con los productos a sugerir. No incluye columnas de sucursales.
                </p>
                <div style={{ background: 'var(--color-surface, #f8fafc)', border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 10, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <strong style={{ fontSize: 'var(--font-size-md)' }}>Columnas de la plantilla</strong>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8, minWidth: 0 }}>
                    {[
                      { label: 'CODIGO JP', type: 'texto' }, { label: 'REFERENCIA', type: 'texto' }, { label: 'OEM', type: 'texto' },
                      { label: 'DESCRIPCIÓN', type: 'texto' }, { label: 'CANTIDAD', type: 'número' }, { label: 'PVP', type: 'opcional' },
                    ].map(col => (
                      <span key={col.label} style={{ background: '#1A1A2E', color: '#fff', borderRadius: 6, padding: '6px 4px', fontSize: '0.68rem', fontWeight: 600, whiteSpace: 'nowrap', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {col.label} <span style={{ opacity: 0.55, fontWeight: 400 }}>({col.type})</span>
                      </span>
                    ))}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={downloading}
                  onClick={handleDownloadTemplate}
                  style={{ alignSelf: 'center', display: 'inline-flex', alignItems: 'center', gap: 8, background: '#16a34a', border: '1px solid #16a34a', borderRadius: 6, padding: '7px 16px', color: '#fff', fontSize: 'var(--font-size-md)', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  <i className="pi pi-download" />
                  {downloading ? 'Descargando...' : 'Descargar plantilla'}
                </button>
              </>
            )}

            {/* ── PASO 2: Subir archivo ── */}
            {step === 2 && (
              <>
                <div
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFileSelect(e.dataTransfer.files[0]) }}
                  style={{
                    width: '100%',
                    marginTop: 6,
                    border: `2px dashed ${dragOver ? 'var(--color-primary, #2563eb)' : selectedFile ? '#16a34a' : 'var(--color-border, #e2e8f0)'}`,
                    borderRadius: 10, padding: '28px 20px', textAlign: 'center', cursor: 'pointer',
                    background: dragOver ? 'var(--color-primary-light, #eff6ff)' : selectedFile ? '#f0fdf4' : 'var(--color-surface, #f8fafc)',
                    transition: 'all .2s',
                    boxSizing: 'border-box',
                  }}
                >
                  <input ref={fileInputRef} type="file" accept=".xlsx" hidden onChange={(e) => handleFileSelect(e.target.files[0])} />
                  {selectedFile ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                      <i className="pi pi-file-excel" style={{ fontSize: '1.8rem', color: '#16a34a' }} />
                      <strong style={{ fontSize: 'var(--font-size-md)', color: '#15803d' }}>{selectedFile.name}</strong>
                      <span style={{ fontSize: 'var(--font-size-md)', color: 'var(--color-text-secondary)' }}>Haz clic para cambiar el archivo</span>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                      <i className="pi pi-upload" style={{ fontSize: '1.8rem', color: 'var(--color-text-secondary)' }} />
                      <strong style={{ fontSize: 'var(--font-size-md)' }}>Arrastra el archivo aquí</strong>
                      <span style={{ fontSize: 'var(--font-size-md)', color: 'var(--color-text-secondary)' }}>o haz clic para seleccionar · Solo .xlsx</span>
                    </div>
                  )}
                </div>
                {parsing && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
                    <div style={{ width: '100%', height: 8, borderRadius: 6, background: 'var(--color-border, #e2e8f0)', overflow: 'hidden' }}>
                      <div
                        style={{
                          width: `${parsingProgress}%`,
                          height: '100%',
                          borderRadius: 6,
                          background: 'var(--color-primary, #2563eb)',
                          transition: 'width .3s ease',
                        }}
                      />
                    </div>
                    <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', textAlign: 'right' }}>
                      {parsingProgress}%
                    </span>
                  </div>
                )}
                {parseError && <p style={{ margin: 0, fontSize: 'var(--font-size-md)', color: '#dc2626' }}>{parseError}</p>}
              </>
            )}

            {/* ── PASO 3: Revisar productos ── */}
            {step === 3 && (
              <>
                {/* Los datos incompletos no se marcan en la vista previa: no
                    impiden crearla y se completan dentro de la sugerencia,
                    antes de pedir la cotizacion. */}
                <SugerenciaTabla
                  token={token}
                  casa={selectedCasa}
                  rows={parsedRows}
                  setRows={setParsedRows}
                  referenciaDecisions={referenciaDecisions}
                  setReferenciaDecisions={setReferenciaDecisions}
                  compact={isCompactHeight}
                  viewStateRef={sugerenciaViewRef}
                  notify={(severity, summary, detail) => toastRef.current?.show({ severity, summary, detail, life: 4500 })}
                />
                    {submitError && <p style={{ margin: 0, fontSize: 'var(--font-size-sm)', color: '#dc2626' }}>{submitError}</p>}
              </>
            )}
          </div>
          </div>

          <div className="create-user__footer">
            <div className="user-details__footer-left">
              {step === 1 && (
                <button type="button" className="create-user__action create-user__action--cancel" onClick={() => setStep('casa')}>Atrás</button>
              )}
              {step === 2 && (
                <button type="button" className="create-user__action create-user__action--cancel" onClick={() => setStep(1)} disabled={parsing}>Atrás</button>
              )}
              {step === 3 && !duplicateProductGroups.length && (
                <button type="button" className="create-user__action create-user__action--cancel" onClick={() => setStep(esManual ? 'casa' : 2)} disabled={submitting}>Atrás</button>
              )}
            </div>
            <div className="user-details__footer-right">
              {step === 1 && (
                <button type="button" className="create-user__action create-user__action--primary" onClick={() => setStep(2)}>Siguiente</button>
              )}
              {step === 2 && (
                <button
                  type="button"
                  className="create-user__action create-user__action--primary"
                  onClick={handleProcess}
                  disabled={!canProcess || parsing}
                >
                  {parsing ? 'Procesando...' : 'Procesar archivo'}
                </button>
              )}
              {step === 3 && (
                duplicateProductGroups.length > 0 ? (
                  <button type="button" className="create-user__action create-user__action--primary" onClick={handleRetry}>Volver a intentar</button>
                ) : (
                  <>
                    {validRows.length > 0 && (
                      <button
                        type="button"
                        className="create-user__action create-user__action--cancel"
                        onClick={handleDownloadReviewExcel}
                        disabled={downloadingReview}
                      >
                        <i className="pi pi-download" style={{ marginRight: 6 }} />
                        {downloadingReview ? 'Descargando...' : 'Descargar Excel'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="create-user__action create-user__action--primary"
                      onClick={handleCreate}
                      disabled={submitting || validRows.length === 0}
                      title={
                        validRows.length === 0 ? 'No hay productos válidos para crear la sugerencia'
                          : !allConflictsResolved ? 'Debes seleccionar la referencia a guardar para todos los conflictos'
                          : undefined
                      }
                    >
                      {submitting ? 'Creando sugerencia...' : `Crear sugerencia${validRows.length > 0 ? ` (${validRows.length} productos)` : ''}`}
                    </button>
                  </>
                )
              )}
            </div>
          </div>
          </form>
          )}

          {isMaximizableStep && (
            <button
              type="button"
              aria-label="Cambiar tamaño de ventana"
              className="create-user__resize-handle"
              onMouseDown={handleResizeMouseDown}
            />
          )}
        </div>
      </div>
      {cellHover && createPortal(
        // Por encima de la tarjeta de coincidencias OEM (también muestra títulos)
        // y sin salirse por la derecha en las columnas finales.
        <div className="imp-cell-hover-card" style={{ top: cellHover.top, left: Math.max(8, Math.min(cellHover.left, window.innerWidth - 388)), zIndex: 11001 }}>
          {cellHover.label && <div className="imp-cell-hover-card__title">{cellHover.label}</div>}
          <div className="imp-cell-hover-card__row">{cellHover.value}</div>
        </div>,
        getPortalRoot()
      )}
    </>,
    portalRoot
  )
}

// Notas automaticas en el comentario de un producto de la verificacion: se
// agregan al quitarlo/agregarlo (a mano o al subir el Excel) sin borrar lo
// que ya tuviera escrito, y se sacan al restaurarlo.
const NOTA_QUITADO_VERIFICACION = 'Borrado de la verificación'
const NOTA_AGREGADO_VERIFICACION = 'Agregado en la verificación'
const withNotaVerificacion = (comentario, nota) => {
  const actual = String(comentario || '').trim()
  if (actual.startsWith(nota)) return actual
  return actual ? `${nota} - ${actual}` : nota
}
const withoutNotaVerificacion = (comentario, nota) => {
  const actual = String(comentario || '').trim()
  if (!actual.startsWith(nota)) return actual
  return actual.slice(nota.length).replace(/^\s*-\s*/, '').trim()
}

function EditImportacionModal({ open, imp: impProp, token, onClose, onSaved, onOpenBorrador, onOpenEnCamino, moduleActions }) {
  // Buscador de productos de esta importacion.
  const [productSearch, setProductSearch] = useState('')
  const canEdit = moduleActions?.puede_actualizar !== false
  const canDelete = moduleActions?.puede_eliminar !== false
  const canImportar = moduleActions?.puede_importar === true
  // impProp es la fila que ya tenía cargada la lista de la tabla, que puede
  // estar desactualizada (por ejemplo, si un guardado anterior --Guardar,
  // Confirmar, Importar-- cambió precios, cantidades u orden y la lista no
  // se refrescó a tiempo todavía). Al abrir se pide la importación completa
  // y fresca al servidor y se usa esa en cuanto llega -- de ahí en más TODO
  // el modal (no solo `details`) lee de `imp`, que siempre es la versión más
  // reciente conocida. Esto es lo que evita que, p. ej., un precio
  // confirmado ya guardado se revierta al reabrir el modal más tarde.
  const [freshImp, setFreshImp] = useState(null)
  const imp = freshImp && impProp && freshImp.id === impProp.id ? freshImp : impProp
  const [loadingImp, setLoadingImp] = useState(true)
  const [uploadingExcel, setUploadingExcel] = useState(false)
  useEffect(() => {
    if (!open || !impProp?.id) { setLoadingImp(false); return }
    let cancelled = false
    setFreshImp(null)
    setLoadingImp(true)
    authFetch(`${API_URL}/importaciones/importaciones/${impProp.id}/`, {}, token)
      .then((r) => (r.ok ? r.json() : null))
      .then((fresh) => { if (!cancelled && fresh) setFreshImp(fresh) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingImp(false) })
    return () => { cancelled = true }
  }, [open, impProp?.id, token])
  const [activeTab, setActiveTab] = useState('general')
  const [detailDraft, setDetailDraft] = useState({ producto: null, cantidad: '', comentario: '' })
  const [productQuery, setProductQuery] = useState('')
  const [productOptions, setProductOptions] = useState([])
  const [productLoading, setProductLoading] = useState(false)
  const [showProductDropdown, setShowProductDropdown] = useState(false)
  const [details, setDetails] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [invalidQtyKeys, setInvalidQtyKeys] = useState(new Set())
  // Verificacion: productos a los que les falta PVP Aprox. o Cant. aprox. al
  // pedir la confirmacion (se marcan en rojo hasta completarlos).
  const [faltanConfirmar, setFaltanConfirmar] = useState(new Set())
  const [codigosInvalidos, setCodigosInvalidos] = useState([])
  const [showAceptadosView, setShowAceptadosView] = useState(false)
  const [aceptadosCount, setAceptadosCount] = useState(null)
  const [showImportarModal, setShowImportarModal] = useState(false)
  const [facturaInput, setFacturaInput] = useState('')
  const [fechaImportar, setFechaImportar] = useState('')
  const [importarSubmitting, setImportarSubmitting] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleteSubmitting, setDeleteSubmitting] = useState(false)
  const [modalPosition, setModalPosition] = useState({ x: 0, y: 0 })
  const [modalSize, setModalSize] = useState({ width: MIN_WIDTH, height: MIN_HEIGHT })
  const [isMaximized, setIsMaximized] = useState(false)
  const [cellHover, setCellHover] = useState(null)
  const cellHoverTimerRef = useRef(null)
  const [fechaSalidaInfoPos, setFechaSalidaInfoPos] = useState(null)
  const showFechaSalidaInfo = useCallback((event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    setFechaSalidaInfoPos({ top: rect.top, left: rect.right + 8 })
  }, [])
  const hideFechaSalidaInfo = useCallback(() => setFechaSalidaInfoPos(null), [])
  const showCellHover = useCallback((event, items, label) => {
    const list = (Array.isArray(items) ? items : [items]).filter(Boolean)
    if (!list.length) return
    if (cellHoverTimerRef.current) clearTimeout(cellHoverTimerRef.current)
    const rect = event.currentTarget.getBoundingClientRect()
    cellHoverTimerRef.current = setTimeout(() => {
      cellHoverTimerRef.current = null
      setCellHover({ top: rect.bottom + 4, left: rect.left, items: list, label })
    }, 400)
  }, [])
  const hideCellHover = useCallback(() => {
    if (cellHoverTimerRef.current) { clearTimeout(cellHoverTimerRef.current); cellHoverTimerRef.current = null }
    setCellHover(null)
  }, [])
  const [itemCheckStates, setItemCheckStates] = useState({})
  const handleCycleCheckState = (key) => {
    setItemCheckStates((prev) => {
      const cur = prev[key]
      if (!cur) return { ...prev, [key]: 'check' }
      if (cur === 'check') return { ...prev, [key]: 'x' }
      const next = { ...prev }; delete next[key]; return next
    })
  }
  const handleCycleAllCheckStates = () => {
    setItemCheckStates((prev) => {
      const allCheck = details.every((d) => prev[d._key] === 'check')
      const allX = details.every((d) => prev[d._key] === 'x')
      if (allCheck) {
        const next = {}
        details.forEach((d) => { next[d._key] = 'x' })
        return next
      }
      if (allX) return {}
      const next = {}
      details.forEach((d) => { next[d._key] = 'check' })
      return next
    })
  }
  const [showVerificarExcelDropdown, setShowVerificarExcelDropdown] = useState(false)
  const [showSaveOnCloseModal, setShowSaveOnCloseModal] = useState(false)
  const [showNuevoProductoView, setShowNuevoProductoView] = useState(false)

  useCloseDropdownsOnTabSwitch(
    useCallback(() => {
      setShowProductDropdown(false)
      hideCellHover()
      hideFechaSalidaInfo()
      setShowVerificarExcelDropdown(false)
    }, [hideCellHover, hideFechaSalidaInfo])
  )

  const modalRef = useRef(null)
  const toastRef = useRef(null)
  const verificarExcelDropdownRef = useRef(null)
  const verificarFileInputRef = useRef(null)
  const modalDrag = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const modalSizeRef = useRef(modalSize)
  const modalPositionRef = useRef(modalPosition)
  const modalRestoreRef = useRef(null)
  const resizeData = useRef({ active: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const productTimerRef = useRef(null)
  const productSearchIdRef = useRef(0)
  const productDropdownRef = useRef(null)
  const isFirstOpenRef = useRef(true)
  const detailsRef = useRef([])
  detailsRef.current = details
  const initialDetailsRef = useRef(null)
  const initialItemCheckStatesRef = useRef({})
  const [productPanelStyle, setProductPanelStyle] = useState(null)

  const selectedCasa = imp?.casa_comercial || null
  const isSugerencia = imp?.estado === 'borrador'
  const [showHistorialVerificacion, setShowHistorialVerificacion] = useState(false)
  const isVerificar = imp?.estado === 'cotizacion'
  const isConfirmacion = imp?.estado === 'confirmacion'
  const isVerificarOrConfirmacion = isVerificar || isConfirmacion
  const isImportRealizada = isConfirmacion && Boolean(imp?.numero_factura)
  // Verificacion: lo agregado (nota en el comentario) y lo quitado se pintan
  // y se agrupan arriba para encontrarlos rapido.
  const esAgregadoVerificacion = (item) => isVerificar && !item.quitado && String(item.comentario || '').includes(NOTA_AGREGADO_VERIFICACION)
  const detailDraftQuantity = Number(detailDraft.cantidad)
  // La cantidad es opcional (se completa despues); solo no puede ser negativa.
  const canAddDetailDraft = Boolean(
    detailDraft.producto && Number.isFinite(detailDraftQuantity) && detailDraftQuantity >= 0
  )

  useEffect(() => { modalSizeRef.current = modalSize }, [modalSize])
  useEffect(() => { modalPositionRef.current = modalPosition }, [modalPosition])

  useEffect(() => {
    if (!showVerificarExcelDropdown) return
    const handle = (e) => { if (!verificarExcelDropdownRef.current?.contains(e.target)) setShowVerificarExcelDropdown(false) }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [showVerificarExcelDropdown])

  useLayoutEffect(() => {
    if (!open) { isFirstOpenRef.current = true; return }
    const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2)
    const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2)
    // Verificacion y confirmacion abren en el ancho minimo donde caben todas
    // las columnas: min-width de la tabla en ImportacionesTable.css (866 /
    // 854) + 40 de padding del modal + 16 por si la tabla muestra scroll
    // vertical.
    // Sugerencia abre mas grande que 700 x 520 (ahi la tabla quedaba cortada y
    // con solo 4 filas a la vista), pero sin llenar la pantalla: 1080 x 680 o
    // el 90% / 88% de la ventana. La tabla necesita ~940 de ancho.
    const isSugerenciaOpen = imp?.estado === 'borrador'
    const sugerenciaWidth = Math.max(Math.min(SUGERENCIA_MODAL_WIDTH, Math.round(window.innerWidth * 0.9)), 960)
    const targetWidth = isSugerenciaOpen ? sugerenciaWidth : imp?.estado === 'cotizacion' ? 922 : imp?.estado === 'confirmacion' ? 910 : MIN_WIDTH
    const targetHeight = isSugerenciaOpen ? Math.min(680, Math.round(window.innerHeight * 0.88)) : MIN_HEIGHT
    const nextWidth = Math.min(targetWidth, availableWidth)
    const nextHeight = Math.min(targetHeight, availableHeight)
    const centerX = Math.max((window.innerWidth - nextWidth) / 2, VIEWPORT_PADDING)
    const centerY = Math.max((window.innerHeight - nextHeight) / 2, VIEWPORT_PADDING)
    setModalSize({ width: nextWidth, height: nextHeight })
    if (isFirstOpenRef.current) isFirstOpenRef.current = false
    setModalPosition({ x: centerX, y: centerY })
  }, [open])

  useLayoutEffect(() => {
    if (!showProductDropdown || !productDropdownRef.current) { setProductPanelStyle(null); return }
    const rect = productDropdownRef.current.getBoundingClientRect()
    const panelMaxHeight = Math.min(280, window.innerHeight - rect.bottom - 8)
    const panelWidth = Math.min(Math.max(rect.width, 520), window.innerWidth - VIEWPORT_PADDING * 2)
    const panelLeft = clamp(rect.left, VIEWPORT_PADDING, Math.max(window.innerWidth - panelWidth - VIEWPORT_PADDING, VIEWPORT_PADDING))
    setProductPanelStyle({
      position: 'fixed', top: rect.bottom + 4, left: panelLeft, width: panelWidth,
      maxHeight: Math.max(panelMaxHeight, 120), zIndex: 9999,
    })
  }, [showProductDropdown, modalPosition])

  useEffect(() => {
    const handleMouseMove = (event) => {
      if (!modalDrag.current.active) return
      event.preventDefault()
      const newX = event.clientX - modalDrag.current.offsetX
      const newY = event.clientY - modalDrag.current.offsetY
      const maxX = Math.max(window.innerWidth - modalSizeRef.current.width - VIEWPORT_PADDING, VIEWPORT_PADDING)
      const modalHeight = typeof modalSizeRef.current.height === 'number'
        ? modalSizeRef.current.height : (modalRef.current?.offsetHeight || 0)
      const maxY = Math.max(window.innerHeight - modalHeight - VIEWPORT_PADDING, VIEWPORT_PADDING)
      setModalPosition({ x: clamp(newX, VIEWPORT_PADDING, maxX), y: clamp(newY, VIEWPORT_PADDING, maxY) })
    }
    const handleMouseUp = () => { modalDrag.current.active = false }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => { window.removeEventListener('mousemove', handleMouseMove); window.removeEventListener('mouseup', handleMouseUp) }
  }, [])

  useEffect(() => {
    const handleWindowResize = () => {
      const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2)
      const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2)
      if (isMaximized) {
        setModalSize({ width: availableWidth, height: availableHeight })
        setModalPosition({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
        return
      }
      setModalSize((prev) => {
        const width = clamp(prev.width, MIN_WIDTH, availableWidth)
        const height = clamp(prev.height, MIN_HEIGHT, availableHeight)
        setModalPosition((prevPos) => ({
          x: clamp(prevPos.x, VIEWPORT_PADDING, Math.max(window.innerWidth - width - VIEWPORT_PADDING, VIEWPORT_PADDING)),
          y: clamp(prevPos.y, VIEWPORT_PADDING, Math.max(window.innerHeight - height - VIEWPORT_PADDING, VIEWPORT_PADDING)),
        }))
        return { width, height }
      })
    }
    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [isMaximized])

  const handleModalMouseDown = (event) => {
    if (isMaximized) return
    if (!modalRef.current) return
    const rect = modalRef.current.getBoundingClientRect()
    modalDrag.current = { active: true, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top }
  }

  const handleResizeMouseDown = (event) => {
    if (isMaximized) return
    event.preventDefault()
    event.stopPropagation()
    resizeData.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: modalSizeRef.current.width,
      startHeight: modalSizeRef.current.height,
    }
    const handleResizeMove = (moveEvent) => {
      if (!resizeData.current.active) return
      const deltaX = moveEvent.clientX - resizeData.current.startX
      const deltaY = moveEvent.clientY - resizeData.current.startY
      const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - modalPositionRef.current.x - VIEWPORT_PADDING)
      const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - modalPositionRef.current.y - VIEWPORT_PADDING)
      setModalSize({
        width: clamp(resizeData.current.startWidth + deltaX, MIN_WIDTH, maxWidth),
        height: clamp(resizeData.current.startHeight + deltaY, MIN_HEIGHT, maxHeight),
      })
    }
    const handleResizeUp = () => {
      resizeData.current.active = false
      window.removeEventListener('mousemove', handleResizeMove)
      window.removeEventListener('mouseup', handleResizeUp)
    }
    window.addEventListener('mousemove', handleResizeMove)
    window.addEventListener('mouseup', handleResizeUp)
  }

  const toggleMaximize = () => {
    modalDrag.current.active = false
    if (isMaximized) {
      const restore = modalRestoreRef.current
      if (restore) {
        setModalSize(restore.size)
        setModalPosition(restore.position)
      }
      setIsMaximized(false)
      return
    }
    modalRestoreRef.current = {
      size: { ...modalSizeRef.current },
      position: { ...modalPositionRef.current },
    }
    const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2)
    const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2)
    setModalSize({ width: availableWidth, height: availableHeight })
    setModalPosition({ x: VIEWPORT_PADDING, y: VIEWPORT_PADDING })
    setIsMaximized(true)
  }

  useEffect(() => {
    if (!open || !imp) return
    setCodigosInvalidos([])
    const toCentavos = (val) => {
      if (val == null || val === '') return ''
      return String(Math.round(parseFloat(val) * 100))
    }
    const loaded = (imp.detalles || []).map((d, i) => {
      const solId = d.solicitud_id ? String(d.solicitud_id) : null
      const confirmed = {
        precio_estimado: toCentavos(d.precio_estimado), cantidad_aproximada: d.cantidad_aproximada != null ? String(d.cantidad_aproximada) : '',
        precio_confirmado: toCentavos(d.precio_confirmado), cantidad_confirmada: d.cantidad_confirmada != null ? String(d.cantidad_confirmada) : '',
        // Amarillo (oem) / naranja (otra_casa) de la vista previa del Excel.
        coincidencia: d.coincidencia || '',
        coincidencia_precio: d.coincidencia_precio ?? null,
        ...(d.coincidencia_codigo || d.coincidencia_casa ? { _sugeridoDesde: d.coincidencia_codigo || '', _sugeridoCasa: d.coincidencia_casa || '' } : {}),
      }
      if (d.producto?.id) {
        return { _key: String(d.producto.id), _detalleId: d.id ?? null, orden: d.orden, producto: d.producto, cantidad: String(d.cantidad ?? ''), comentario: d.comentario || '', _solId: solId, seleccionado: d.seleccionado, quitado: Boolean(d.quitado), precio_pvp_snapshot: d.precio_pvp_snapshot, precio_casa: d.precio_casa || '', ...confirmed }
      }
      return {
        _key: 'sc_' + (d.id ?? i), _detalleId: d.id ?? null, orden: d.orden, producto: null,
        codigo: d.codigo || '', nombre: d.nombre || '', oem: d.oem || '', referencia: d.referencia || '',
        cantidad: String(d.cantidad ?? ''), comentario: d.comentario || '', _solId: solId, seleccionado: d.seleccionado, quitado: Boolean(d.quitado), precio_pvp_snapshot: d.precio_pvp_snapshot, precio_casa: d.precio_casa || '', ...confirmed,
      }
    })
    setDetails(loaded)
    initialDetailsRef.current = loaded
    const hydratedCheckStates = Object.fromEntries(
      loaded.filter((item) => item.seleccionado === true || item.seleccionado === false).map((item) => [item._key, item.seleccionado ? 'check' : 'x'])
    )
    setItemCheckStates(hydratedCheckStates)
    initialItemCheckStatesRef.current = hydratedCheckStates
    setDetailDraft({ producto: null, cantidad: '', comentario: '' })
    setActiveTab('general')
    setInvalidQtyKeys(new Set())
    setFaltanConfirmar(new Set())
    setShowAceptadosView(false)
    setIsMaximized(false)
    modalRestoreRef.current = null
  }, [open, imp])

  useEffect(() => {
    if (!open) return undefined
    const handleMouseDown = (event) => {
      const inProduct = productDropdownRef.current?.contains(event.target) || event.target.closest?.('[data-product-portal-edit]')
      if (!inProduct) setShowProductDropdown(false)
    }
    const handleKeyDown = (event) => { if (event.key === 'Escape') onClose?.() }
    document.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => { document.removeEventListener('mousedown', handleMouseDown); window.removeEventListener('keydown', handleKeyDown) }
  }, [open, onClose])

  useEffect(() => {
    if (!selectedCasa?.id || !token || !open) { setAceptadosCount(null); return undefined }
    let cancelled = false
    authFetch(`${API_URL}/solicitudes/solicitudes/aceptados-por-casa/?casa_comercial_id=${selectedCasa.id}`, {}, token)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((payload) => { if (!cancelled) setAceptadosCount(parseApiList(payload).length) })
      .catch(() => { if (!cancelled) setAceptadosCount(null) })
    return () => { cancelled = true }
  }, [open, selectedCasa?.id, token])

  const searchProducts = useCallback((term) => {
    if (!token) return
    setProductLoading(true)
    const requestId = ++productSearchIdRef.current
    const params = new URLSearchParams()
    params.set('page_size', '10')
    params.set('modulo', 'solicitudes')
    if (term) params.set('search', term)
    if (selectedCasa?.nombre) params.set('casa_comercial', selectedCasa.nombre)
    authFetch(`${API_URL}/productos/listado/?${params.toString()}`, {}, token)
      .then(async (response) => {
        if (!response.ok) throw new Error(await readErrorMessage(response, 'No se pudieron cargar los productos.'))
        return response.json()
      })
      .then((payload) => {
        if (requestId !== productSearchIdRef.current) return
        const selectedIds = new Set(detailsRef.current.filter((item) => item.producto?.id).map((item) => String(item.producto.id)))
        setProductOptions(parseApiList(payload).filter((product) => !selectedIds.has(String(product.id))))
      })
      .catch((error) => { if (requestId === productSearchIdRef.current) toastRef.current?.show({ severity: 'error', summary: 'Error', detail: error.message, life: 4000 }) })
      .finally(() => { if (requestId === productSearchIdRef.current) setProductLoading(false) })
  }, [selectedCasa, token])

  useEffect(() => {
    if (!open || !showProductDropdown) return undefined
    if (productTimerRef.current) clearTimeout(productTimerRef.current)
    productTimerRef.current = setTimeout(() => searchProducts(productQuery.trim()), 280)
    return () => clearTimeout(productTimerRef.current)
  }, [open, productQuery, searchProducts, showProductDropdown])

  // Lo agregado a mano en la verificacion va al final del orden.
  const nextOrden = (list) => list.reduce((max, d) => Math.max(max, Number(d.orden) || 0), 0) + 1

  const handleAddProduct = (product, cantidad = '', comentario = '') => {
    const n = Number(cantidad || 0)
    if (!Number.isFinite(n) || n < 0) return
    const existing = details.find((d) => d.producto?.id && String(d.producto.id) === String(product.id))
    if (existing) {
      // Si estaba quitado de la verificacion, agregarlo de nuevo lo restaura.
      if (isVerificar && existing.quitado) {
        handleToggleQuitado(existing._key)
        setDetailDraft({ producto: null, cantidad: '', comentario: '' })
        jumpToDetailRow(existing._key)
        return
      }
      toastRef.current?.show({ severity: 'warn', summary: 'Advertencia', detail: 'Este producto ya fue agregado.', life: 3000 })
      return
    }
    const nota = String(comentario || '').trim()
    setDetails((prev) => [...prev, {
      _key: String(product.id), producto: product, cantidad: String(cantidad).trim(),
      comentario: isVerificar ? withNotaVerificacion(nota, NOTA_AGREGADO_VERIFICACION) : nota,
      ...(isVerificar ? { cantidad_aproximada: String(cantidad).trim(), orden: nextOrden(prev) } : {}),
    }])
    setProductQuery('')
    setProductOptions([])
    setShowProductDropdown(false)
    setDetailDraft({ producto: null, cantidad: '', comentario: '' })
  }

  // Verificacion: "+ Agregar nuevo producto" (el mismo popup de la
  // sugerencia). Con el OEM o la referencia se busca en el catalogo: si ya
  // existe se agrega ese producto (verde), si no, uno nuevo con el codigo
  // sugerido (verde azulado). Lleva la nota de agregado en la verificacion.
  const handleAddNuevoVerificacion = async (nuevo) => {
    const mismo = (a, b) => Boolean(String(b || '').trim()) && String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()
    const activos = details.filter((d) => !d.quitado)
    if (activos.some((d) => mismo(d.producto?.referencia || d.referencia, nuevo.referencia))) return { referencia: 'Ya hay un producto con esta referencia en el listado.' }
    if (activos.some((d) => mismo(getProductoOem(d.producto) || d.oem, nuevo.oem))) return { oem: 'Ya hay un producto con este OEM en el listado.' }
    let encontrada
    try {
      [encontrada] = await fetchCoincidencias(token, selectedCasa?.id, [{ key: 'nuevo', oem: nuevo.oem, referencia: nuevo.referencia, descripcion: nuevo.nombre }])
    } catch (e) {
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: e.message, life: 4000 })
      return {}
    }
    const row = enrichParsedRow({
      ...(encontrada || { oem: nuevo.oem, referencia: nuevo.referencia, oem_matches: [] }),
      descripcion: nuevo.nombre || encontrada?.descripcion || '',
      pvp: nuevo.precio ?? 0,
      cantidad: '',
    }, selectedCasa?.codigo)
    if (row.matched_producto_id) {
      const existente = details.find((d) => String(d.producto?.id) === String(row.matched_producto_id))
      if (existente) {
        if (existente.quitado) handleToggleQuitado(existente._key)
        else toastRef.current?.show({ severity: 'warn', summary: 'Ya está en la lista', detail: `${row.matched_producto_codigo || row.codigo} ya está en esta importación.`, life: 4000 })
        setShowNuevoProductoView(false)
        setProductSearch('')
        jumpToDetailRow(existente._key)
        return null
      }
    }
    const key = row.matched_producto_id ? String(row.matched_producto_id) : `manual_${Date.now()}`
    const detalle = sugerenciaRowToDetalle({
      ...row,
      fila_excel: key,
      _producto: row.matched_producto_id
        ? { id: row.matched_producto_id, codigo: row.matched_producto_codigo, nombre: row.matched_producto_nombre, referencia: row.matched_producto_referencia, precio: row.matched_producto_precio }
        : undefined,
    })
    setDetails((prev) => [...prev, {
      ...detalle,
      cantidad: '',
      cantidad_aproximada: '',
      comentario: withNotaVerificacion('', NOTA_AGREGADO_VERIFICACION),
      orden: nextOrden(prev),
    }])
    setShowNuevoProductoView(false)
    setProductSearch('')
    window.setTimeout(() => jumpToDetailRow(key), 50)
    return null
  }

  // Verificacion: "+ Aceptados de solicitudes" (el mismo popup de la
  // sugerencia). Quitar uno que venia de antes lo deja como quitado (se puede
  // restaurar); uno agregado en esta etapa se borra. Agregar uno quitado lo
  // restaura.
  const vigentesIds = new Set(details.filter((d) => d.producto?.id && !d.quitado).map((d) => String(d.producto.id)))
  const vigentesSolIds = new Set(details.filter((d) => !d.producto?.id && d._solId && !d.quitado).map((d) => String(d._solId)))
  const handleAceptadosVerificacion = ({ toAdd, toRemove }) => {
    setDetails((prev) => {
      const esDe = (d, item) => (item.producto_id
        ? String(d.producto?.id) === String(item.producto_id)
        : !d.producto?.id && String(d._solId) === String(item.solicitud_id))
      const next = prev.flatMap((d) => {
        if (d.quitado || !toRemove.some((item) => esDe(d, item))) return [d]
        if (esAgregadoVerificacion(d)) return []
        return [{ ...d, quitado: true, comentario: withNotaVerificacion(d.comentario, NOTA_QUITADO_VERIFICACION) }]
      })
      for (const item of toAdd) {
        const idx = next.findIndex((d) => esDe(d, item))
        if (idx >= 0) {
          const d = next[idx]
          next[idx] = d.quitado
            ? { ...d, quitado: false, comentario: withoutNotaVerificacion(d.comentario, NOTA_QUITADO_VERIFICACION) }
            : { ...d, cantidad: String(Number(d.cantidad || 0) + Number(item.cantidad || 0)) }
          continue
        }
        const base = item.producto_id
          ? { _key: String(item.producto_id), producto: { id: item.producto_id, codigo: item.codigo, nombre: item.nombre, oem: (item.oem_codigos || []).join(', '), precio: item.precio ?? null, referencia: item.referencia || '' } }
          : { _key: `sol_${item.solicitud_id}`, producto: null, codigo: item.codigo || '', nombre: item.nombre || '', oem: (item.oem_codigos || []).join(', '), referencia: item.referencia || '' }
        next.push({
          ...base,
          _solId: item.solicitud_id,
          cantidad: String(item.cantidad || ''),
          cantidad_aproximada: '',
          precio_estimado: '',
          comentario: withNotaVerificacion('', NOTA_AGREGADO_VERIFICACION),
          orden: nextOrden(next),
        })
      }
      return next
    })
  }

  const handleQuantityChange = (_key, value) => {
    const clean = String(value || '').replace(/[^\d]/g, '')
    setDetails((prev) => prev.map((item) => item._key === _key ? { ...item, cantidad: clean } : item))
    if (invalidQtyKeys.has(_key)) {
      setInvalidQtyKeys((prev) => { const next = new Set(prev); next.delete(_key); return next })
    }
  }

  // Verificacion: quitar un producto no lo borra, lo deja en rojo con la nota
  // en el comentario (se puede restaurar); al pedir confirmacion ya no va.
  const handleToggleQuitado = (_key) => {
    setDetails((prev) => prev.map((item) => {
      if (item._key !== _key) return item
      return item.quitado
        ? { ...item, quitado: false, comentario: withoutNotaVerificacion(item.comentario, NOTA_QUITADO_VERIFICACION) }
        : { ...item, quitado: true, comentario: withNotaVerificacion(item.comentario, NOTA_QUITADO_VERIFICACION) }
    }))
  }

  const handleComentarioChange = (_key, value) => {
    setDetails((prev) => prev.map((item) => item._key === _key ? { ...item, comentario: value } : item))
  }

  const handleConfirmedChange = (_key, field, value) => {
    setDetails((prev) => prev.map((item) => item._key === _key ? { ...item, [field]: String(value || '') } : item))
  }

  // El backend borra y vuelve a crear los detalles al guardar: la
  // coincidencia (amarillo/naranja) se reenvía para no perderla.
  const coincidenciaPayload = (item) => ({
    coincidencia: item.coincidencia || '',
    coincidencia_codigo: item._sugeridoDesde || '',
    coincidencia_casa: item._sugeridoCasa || '',
    coincidencia_precio: item.coincidencia_precio != null && item.coincidencia_precio !== '' ? Number(item.coincidencia_precio).toFixed(2) : null,
  })

  const handleSubmit = async () => {
    const itemsToSubmit = details
    if (!itemsToSubmit.length) {
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'Agrega al menos un producto.', life: 4000 })
      return
    }
    // En la sugerencia (borrador) y en la verificacion la cantidad todavia no
    // es obligatoria (solo no puede ser negativa): se exige al pedir la
    // confirmacion y despues.
    const cantidadOpcional = imp?.estado === 'borrador' || imp?.estado === 'cotizacion'
    const badKeys = new Set(
      itemsToSubmit.filter((item) => {
        if (item.quitado) return false
        const n = Number(item.cantidad || 0)
        if (!Number.isFinite(n) || n < 0) return true
        // Lo agregado en la verificación puede guardarse sin cantidad: se
        // exige al pedir la confirmación.
        if (cantidadOpcional || esAgregadoVerificacion(item)) return false
        return n <= 0
      }).map((item) => item._key)
    )
    if (badKeys.size > 0) {
      setInvalidQtyKeys(badKeys)
      toastRef.current?.show({
        severity: 'error',
        summary: 'Error',
        detail: cantidadOpcional ? 'Las cantidades no pueden ser negativas.' : 'Todas las cantidades deben ser mayores a cero.',
        life: 4000,
      })
      return
    }
    const normalizedDetails = itemsToSubmit.map((item) => {
      const solId = { ...(item._solId ? { solicitud_id: Number(item._solId) } : {}), ...coincidenciaPayload(item) }
      const confirmedFields = isVerificarOrConfirmacion ? {
        precio_estimado: item.precio_estimado
          ? (parseInt(String(item.precio_estimado).replace(/\D/g, '') || '0', 10) / 100).toFixed(2)
          : null,
        cantidad_aproximada: toNumberOrNull(item.cantidad_aproximada),
        precio_confirmado: item.precio_confirmado
          ? (parseInt(String(item.precio_confirmado).replace(/\D/g, '') || '0', 10) / 100).toFixed(2)
          : null,
        cantidad_confirmada: toNumberOrNull(item.cantidad_confirmada),
        seleccionado: itemCheckStates[item._key] === 'check' ? true : itemCheckStates[item._key] === 'x' ? false : null,
        quitado: Boolean(item.quitado),
      } : {
        // Sugerencia: se conserva el PVP aprox. (el backend borra y vuelve a
        // crear los detalles; sin reenviarlo se perdia al guardar).
        precio_estimado: item.precio_estimado
          ? (parseInt(String(item.precio_estimado).replace(/\D/g, '') || '0', 10) / 100).toFixed(2)
          : null,
        precio_casa: item.precio_estimado ? (item.precio_casa || '') : '',
      }
      // orden: la posición del producto en el Excel de sugerencia original --
      // el backend borra y vuelve a crear todos los detalles al guardar, así
      // que si no se reenvía aquí se pierde en cada "Guardar" (quedaba null).
      if (item.producto?.id) return { producto_id: item.producto.id, cantidad: Number(item.cantidad || item.cantidad_aproximada || 0), comentario: item.comentario || '', orden: item.orden, ...confirmedFields, ...solId }
      const manualPrecio = item.precio != null && item.precio !== '' ? Number(item.precio) : undefined
      return {
        codigo: item.codigo || '',
        nombre: item.nombre || '',
        oem: item.oem || '',
        referencia: item.referencia || '',
        cantidad: Number(item.cantidad || item.cantidad_aproximada || 0),
        comentario: item.comentario || '',
        orden: item.orden,
        ...(manualPrecio != null && !isVerificarOrConfirmacion ? { precio_confirmado: manualPrecio } : {}),
        ...confirmedFields,
        ...solId,
      }
    })
    setSubmitting(true)
    try {
      const response = await authFetch(
        `${API_URL}/importaciones/importaciones/${imp.id}/`,
        { method: 'PATCH', body: JSON.stringify({ detalles: normalizedDetails }) },
        token
      )
      if (!response.ok) throw new Error(await readErrorMessage(response, 'No se pudo guardar la importación.'))
      const payload = await response.json()
      onSaved?.(payload)
      onClose?.()
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: error.message, life: 4000 })
    } finally {
      setSubmitting(false)
    }
  }

  // Sugerencia: el mismo Excel del Paso 3 de "Sugerencia desde Excel"
  // (columnas, colores y nota), con el _key oculto para emparejar al subirlo.
  const handleDownloadSugerenciaExcel = async () => {
    try {
      const casaSugerencia = imp?.casa_comercial?.nombre || selectedCasa?.nombre || ''
      const rows = [...details]
        .sort((a, b) => (Number(a.orden) || 0) - (Number(b.orden) || 0))
        .map((item) => {
          const sinCatalogo = !item.producto?.id
          const isConflict = sinCatalogo && item.coincidencia === 'otra_casa'
          const isSuggested = sinCatalogo && item.coincidencia === 'oem'
          const pvpJp = item.producto?.precio ?? item.coincidencia_precio
          const centavos = parseInt(String(item.precio_estimado || '').replace(/\D/g, '') || '0', 10)
          return {
            codigo: item.producto?.codigo || item.codigo || '',
            referencia: item.producto?.referencia || item.referencia || '',
            oem: getProductoOem(item.producto) || item.oem || '',
            descripcion: item.producto?.nombre || item.nombre || '',
            cantidad: Number(item.cantidad) > 0 ? Number(item.cantidad) : '',
            pvpJp: pvpJp != null ? Number(pvpJp) : '',
            pvpJpCasa: pvpJp != null ? ((isConflict || isSuggested) ? (item._sugeridoCasa || '') : casaSugerencia) : '',
            pvp: centavos > 0 ? centavos / 100 : '',
            pvpCasa: centavos > 0 ? (item.precio_casa || casaSugerencia) : '',
            nota: isConflict
              ? `Ya existe en ${item._sugeridoCasa || 'otra casa'} — se creará como nuevo`
              : (isSuggested ? 'Sugerido (nuevo)' : ''),
            isConflict,
            isSuggested,
            key: item._key,
          }
        })
      await downloadSugerenciaExcel(rows, `sugerencia-${imp?.codigo || imp?.estado}.xlsx`)
    } catch (e) {
      console.error(e)
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'No se pudo generar el Excel.', life: 3500 })
    }
  }

  const handleDownloadVerificarExcel = async () => {
    try {
      const XLSXStyle = (await import('xlsx-js-style')).default
      const bt = { style: 'thin', color: { rgb: 'D1D5DB' } }
      const border = { top: bt, bottom: bt, left: bt, right: bt }
      const RO = 6; const ED = 3; const DIFF_CI = RO + ED
      const precioEditLabel = isVerificar ? 'PVP APROX.' : 'Precio conf.'
      const cantEditLabel = isVerificar ? 'Cant. aprox.' : 'Cant. conf.'
      const headers = ['Código', 'Descripción', 'OEM', 'Referencia', 'PVP JP', 'Cantidad', precioEditLabel, cantEditLabel, 'Comentario', 'Diferencia', '_key']
      const mkH = (fill, bot) => ({ font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 10 }, fill: { fgColor: { rgb: fill }, patternType: 'solid' }, alignment: { horizontal: 'center', vertical: 'center' }, border: { top: bt, bottom: { style: 'medium', color: { rgb: bot } }, left: bt, right: bt } })
      const hdrS = headers.map((_, ci) => ci < RO ? mkH('1e3a5f', '2563EB') : ci < RO + ED ? mkH('15803d', '166534') : ci === DIFF_CI ? mkH('374151', '374151') : null)

      // Mismo orden que en la importacion (item.orden). Al subirlo, cada fila
      // se empareja por _key o código, así que se puede reordenar libremente.
      // Los quitados en la verificacion no salen: si se agregan de nuevo al
      // Excel (con su código) se restauran al subirlo.
      const sortedDetails = details
        .filter((item) => !(isVerificar && item.quitado))
        .sort((a, b) => (Number(a.orden) || 0) - (Number(b.orden) || 0))
      const rows = sortedDetails.map((item) => {
        const codigo = item.producto?.codigo || item.codigo || 'SIN CATÁLOGO'
        const nombre = item.producto?.nombre || item.nombre || ''
        const oem = getProductoOem(item.producto) || item.oem || ''
        const referencia = item.producto?.referencia || item.referencia || ''
        // Keep null to detect SIN CATÁLOGO for coloring; cell will receive 0 as numeric value
        const precioReal = item.producto?.precio != null ? +Number(item.producto.precio).toFixed(2) : null
        const cantidad = +Number(item.cantidad || 0)
        const precioConf = (() => {
          const raw = isVerificar ? item.precio_estimado : item.precio_confirmado
          if (raw == null || raw === '' || raw === 0) return null
          const c = parseInt(String(raw).replace(/\D/g, '') || '0', 10)
          return c > 0 ? +(c / 100).toFixed(2) : null
        })()
        const cantConf = (() => {
          const raw = isVerificar ? item.cantidad_aproximada : item.cantidad_confirmada
          if (raw == null || raw === '') return null
          const n = parseInt(String(raw), 10)
          return !isNaN(n) && n > 0 ? n : null
        })()
        // diff uses real price so static color is meaningful; null for SIN CATÁLOGO
        const diff = precioReal != null && precioConf != null ? +(precioReal - precioConf).toFixed(2) : null
        // precio in cell is always numeric: 0 for SIN CATÁLOGO so formula =E-G can always compute
        const precio = precioReal ?? 0
        return [codigo, nombre, oem, referencia, precio, cantidad, precioConf, cantConf, item.comentario || '', diff, item._key]
      })

      // Build worksheet manually for precise type control
      const NROWS = rows.length; const NCOLS = headers.length
      const worksheet = { '!ref': XLSXStyle.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: NROWS, c: NCOLS - 1 } }) }
      const setCell = (r, c, val, s, formula) => {
        const ref = XLSXStyle.utils.encode_cell({ r, c })
        if (formula) { worksheet[ref] = { t: 'n', v: val ?? 0, f: formula, s }; return }
        if (val == null) { worksheet[ref] = { t: 's', v: '', s }; return }
        if (typeof val === 'number') { worksheet[ref] = { t: 'n', v: val, s }; return }
        worksheet[ref] = { t: 's', v: String(val), s }
      }

      headers.forEach((h, ci) => setCell(0, ci, h, hdrS[ci] || { font: { sz: 8, color: { rgb: 'AAAAAA' } } }))
      const precioCol = XLSXStyle.utils.encode_col(4)
      const editCol = XLSXStyle.utils.encode_col(RO)

      rows.forEach((row, ri) => {
        const isEven = (ri + 1) % 2 === 0
        const excelRow = ri + 2
        row.forEach((val, ci) => {
          const isEdit = ci >= RO && ci < RO + ED
          const isDiff = ci === DIFF_CI
          const isEmpty = val == null
          // Static fills: CF overrides dynamically for E=0, G/H blank, and J colors
          let bg
          if (isEdit && !isEmpty) bg = isEven ? 'FFFFFF' : 'F9FAFB'
          else if (isEdit) bg = 'fef9c3'
          else if (isDiff && !isEmpty) bg = val >= 0 ? 'dcfce7' : val >= -1 ? 'fef9c3' : 'fee2e2'
          else if (isDiff) bg = isEven ? 'f3f4f6' : 'f9fafb'
          else bg = isEven ? 'EFF6FF' : 'FFFFFF'
          const numFmt = ci === 4 || ci === RO ? '0.00' : ci === 5 || ci === RO + 1 ? '0' : isDiff ? '0.00' : null
          const s = { fill: { fgColor: { rgb: bg }, patternType: 'solid' }, alignment: { vertical: 'center' }, border, ...(numFmt ? { numFmt } : {}) }
          const formula = isDiff ? `IF(${editCol}${excelRow}="","",${precioCol}${excelRow}-${editCol}${excelRow})` : undefined
          setCell(ri + 1, ci, val, s, formula)
        })
      })

      worksheet['!cols'] = [{ wch: 14 }, { wch: 28 }, { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 8 }, { wch: 14 }, { wch: 10 }, { wch: 24 }, { wch: 12 }, { wch: 0, hidden: true }]
      worksheet['!rows'] = [{ hpt: 22 }]
      const workbook = XLSXStyle.utils.book_new()
      XLSXStyle.utils.book_append_sheet(workbook, worksheet, isVerificar ? 'Verificar' : 'Confirmacion')
      const rawOut = XLSXStyle.write(workbook, { bookType: 'xlsx', type: 'array' })

      // Inject conditional formatting via ZIP manipulation (fflate statically imported)
      const unzipped = unzipSync(new Uint8Array(rawOut))
      const dec = new TextDecoder(); const enc = new TextEncoder()

      // Add dxf color definitions to styles.xml
      let stylesXml = dec.decode(unzipped['xl/styles.xml'])
      stylesXml = stylesXml.replace(/<dxfs[^>]*\/>/,
        '<dxfs count="3">' +
        '<dxf><fill><patternFill><bgColor rgb="FFdcfce7"/></patternFill></fill></dxf>' +  // 0: verde
        '<dxf><fill><patternFill><bgColor rgb="FFfef9c3"/></patternFill></fill></dxf>' +  // 1: amarillo
        '<dxf><fill><patternFill><bgColor rgb="FFfee2e2"/></patternFill></fill></dxf>' +  // 2: rojo
        '</dxfs>')
      unzipped['xl/styles.xml'] = enc.encode(stylesXml)

      // Add conditional formatting rules to sheet1.xml
      const eCol = XLSXStyle.utils.encode_col(4)         // E - Precio
      const gCol = XLSXStyle.utils.encode_col(RO)        // G - Precio conf.
      const hCol = XLSXStyle.utils.encode_col(RO + 1)    // H - Cant. conf.
      const jCol = XLSXStyle.utils.encode_col(DIFF_CI)   // J - Diferencia
      const last = NROWS + 1
      const cfXml =
        // E: amarillo cuando Precio = 0 (SIN CATÁLOGO), limpio cuando el usuario cambia el valor
        `<conditionalFormatting sqref="${eCol}2:${eCol}${last}">` +
        `<cfRule type="cellIs" dxfId="1" priority="1" operator="equal"><formula>0</formula></cfRule>` +
        `</conditionalFormatting>` +
        // G: amarillo cuando Precio conf. está vacío
        `<conditionalFormatting sqref="${gCol}2:${gCol}${last}">` +
        `<cfRule type="cellIs" dxfId="1" priority="1" operator="equal"><formula>""</formula></cfRule>` +
        `</conditionalFormatting>` +
        // H: amarillo cuando Cant. conf. está vacía
        `<conditionalFormatting sqref="${hCol}2:${hCol}${last}">` +
        `<cfRule type="cellIs" dxfId="1" priority="1" operator="equal"><formula>""</formula></cfRule>` +
        `</conditionalFormatting>` +
        // J: verde ≥0, amarillo ≥-1, rojo <-1
        `<conditionalFormatting sqref="${jCol}2:${jCol}${last}">` +
        `<cfRule type="cellIs" dxfId="0" priority="1" stopIfTrue="1" operator="greaterThanOrEqual"><formula>0</formula></cfRule>` +
        `<cfRule type="cellIs" dxfId="1" priority="2" stopIfTrue="1" operator="greaterThanOrEqual"><formula>-1</formula></cfRule>` +
        `<cfRule type="cellIs" dxfId="2" priority="3" operator="lessThan"><formula>-1</formula></cfRule>` +
        `</conditionalFormatting>`

      let sheetXml = dec.decode(unzipped['xl/worksheets/sheet1.xml'])
      // <conditionalFormatting> must precede <ignoredErrors> in OOXML element order
      sheetXml = sheetXml.includes('<ignoredErrors')
        ? sheetXml.replace('<ignoredErrors', cfXml + '<ignoredErrors')
        : sheetXml.replace('</worksheet>', cfXml + '</worksheet>')
      unzipped['xl/worksheets/sheet1.xml'] = enc.encode(sheetXml)

      // Repack: skip directory entries, store uncompressed to avoid any compression mismatch
      const zippable = {}
      for (const [path, data] of Object.entries(unzipped)) {
        if (!path.endsWith('/')) zippable[path] = [data, { level: 0 }]
      }
      const finalOut = zipSync(zippable)
      const blob = new Blob([finalOut], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `${isVerificar ? 'verificar' : 'confirmacion'}-${imp?.codigo || imp?.estado}.xlsx`
      document.body.appendChild(link); link.click(); document.body.removeChild(link)
      URL.revokeObjectURL(link.href)
    } catch (e) {
      console.error(e)
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'No se pudo generar el Excel.', life: 3500 })
    }
  }

  // Verificacion: plantilla vacía para la fábrica, con las columnas que lee
  // aplicarExcelFabrica (Código, Referencia u OEM, y Precio).
  const handleDownloadPlantillaPrecios = async () => {
    try {
      const XLSXStyle = (await import('xlsx-js-style')).default
      const bt = { style: 'thin', color: { rgb: 'D1D5DB' } }
      const hdr = { font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 10 }, fill: { fgColor: { rgb: '1e3a5f' }, patternType: 'solid' }, alignment: { horizontal: 'center', vertical: 'center' }, border: { top: bt, bottom: { style: 'medium', color: { rgb: '2563EB' } }, left: bt, right: bt } }
      const precioHdr = { ...hdr, fill: { fgColor: { rgb: '15803d' }, patternType: 'solid' }, border: { ...hdr.border, bottom: { style: 'medium', color: { rgb: '166534' } } } }
      const worksheet = XLSXStyle.utils.aoa_to_sheet([['Código', 'Referencia', 'OEM', 'Precio']])
      ;['A1', 'B1', 'C1'].forEach((ref) => { worksheet[ref].s = hdr })
      worksheet.D1.s = precioHdr
      worksheet['!cols'] = [{ wch: 16 }, { wch: 18 }, { wch: 18 }, { wch: 12 }]
      worksheet['!rows'] = [{ hpt: 22 }]
      const instrucciones = XLSXStyle.utils.aoa_to_sheet([
        ['Cómo llenar la plantilla'],
        ['1. Una fila por producto, en la hoja "Precios".'],
        ['2. Llena al menos uno: Código, Referencia u OEM (se busca en ese orden).'],
        ['3. Precio: el PVP aproximado, con punto o coma decimal (ej. 12.50).'],
        ['4. No repitas productos. Los que no estén en la importación se ignoran.'],
        ['5. Súbelo con Excel → Subir Excel en la verificación y luego guarda.'],
      ])
      instrucciones.A1.s = { font: { bold: true, sz: 12 } }
      instrucciones['!cols'] = [{ wch: 80 }]
      const workbook = XLSXStyle.utils.book_new()
      XLSXStyle.utils.book_append_sheet(workbook, worksheet, 'Precios')
      XLSXStyle.utils.book_append_sheet(workbook, instrucciones, 'Instrucciones')
      XLSXStyle.writeFile(workbook, `plantilla-precios-${imp?.codigo || 'verificacion'}.xlsx`)
    } catch (e) {
      console.error(e)
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'No se pudo generar la plantilla.', life: 3500 })
    }
  }

  // "3, 5 y 7"
  const unirFilas =(filas) => (filas.length > 1 ? `${filas.slice(0, -1).join(', ')} y ${filas[filas.length - 1]}` : String(filas[0] ?? ''))

  // Filas repetidas en el Excel subido: no se aplica nada y se dice cuales.
  // grupos = [[{ fila, etiqueta }, ...], ...]
  const avisarRepetidos = (grupos) => {
    const detalle = grupos
      .map((grupo) => `${unirFilas(grupo.map((x) => x.fila))}${grupo[0]?.etiqueta ? ` (${grupo[0].etiqueta})` : ''}`)
      .join('; ')
    toastRef.current?.show({
      severity: 'error',
      summary: 'Filas repetidas',
      detail: `Subiste repetido en las filas ${detalle}. Corrige el Excel y vuelve a subirlo; no se cambió nada.`,
      life: 9000,
    })
  }

  // Verificacion: Excel de la fabrica, de 4 columnas (Codigo, Referencia, OEM
  // y Precio). Cada fila se busca en la lista por codigo, referencia u OEM (lo
  // primero que traiga) y solo llena el PVP Aprox.; no agrega ni quita
  // productos.
  const aplicarExcelFabrica = ({ rawRows, codigoIdx, refIdx, oemIdx, precioIdx }) => {
    const texto = (row, idx) => (idx === -1 ? '' : String(row[idx] ?? '').trim())
    const norm = (v) => String(v || '').trim().toLowerCase().replace(/^0+(?=.)/, '')
    const lista = (v) => String(v || '').split(',').map(norm).filter(Boolean)
    const current = detailsRef.current
    const codigoDe = (item) => norm(item.producto?.codigo || item.codigo)
    const refsDe = (item) => [item.producto?.referencia, ...(item.producto?.referencias || []).map((r) => r?.valor), item.referencia].map(norm).filter(Boolean)
    const oemsDe = (item) => lista(getProductoOem(item.producto) || item.oem)
    const filas = rawRows.slice(1)
      .map((row, i) => ({ row, fila: i + 2 }))
      .filter(({ row }) => row.some((c) => String(c ?? '').trim() !== ''))
    const noEncontradas = []
    const ambiguas = []
    const porProducto = new Map()
    const porValor = new Map()
    filas.forEach(({ row, fila }) => {
      const codigo = texto(row, codigoIdx)
      const ref = texto(row, refIdx)
      const oem = texto(row, oemIdx)
      const etiqueta = codigo || ref || oem
      if (!etiqueta) return
      const clave = norm(codigo) ? `c:${norm(codigo)}` : norm(ref) ? `r:${norm(ref)}` : `o:${lista(oem).join(',')}`
      porValor.set(clave, [...(porValor.get(clave) || []), { fila, etiqueta }])
      let candidatos = []
      if (norm(codigo)) candidatos = current.filter((d) => codigoDe(d) === norm(codigo))
      if (!candidatos.length && norm(ref)) candidatos = current.filter((d) => refsDe(d).includes(norm(ref)))
      if (!candidatos.length && lista(oem).length) candidatos = current.filter((d) => oemsDe(d).some((o) => lista(oem).includes(o)))
      if (!candidatos.length) { noEncontradas.push({ fila, etiqueta }); return }
      if (candidatos.length > 1) { ambiguas.push({ fila, etiqueta }); return }
      const key = candidatos[0]._key
      porProducto.set(key, [...(porProducto.get(key) || []), { fila, row, etiqueta }])
    })
    // Repetido: el mismo codigo/referencia/OEM en varias filas, o varias
    // filas que caen en el mismo producto de la lista.
    const repetidos = [...porValor.values()].filter((grupo) => grupo.length > 1)
    porProducto.forEach((grupo) => {
      if (grupo.length < 2) return
      const yaAvisado = repetidos.some((g) => g.some((x) => grupo.some((y) => y.fila === x.fila)))
      if (!yaAvisado) repetidos.push(grupo)
    })
    if (repetidos.length) { avisarRepetidos(repetidos); return }
    const precios = new Map()
    porProducto.forEach(([{ row }], key) => {
      const precio = parseFloat(texto(row, precioIdx).replace(',', '.'))
      if (!isNaN(precio) && precio >= 0) precios.set(key, String(Math.round(precio * 100)))
    })
    setDetails((prev) => prev.map((item) => (precios.has(item._key) ? { ...item, precio_estimado: precios.get(item._key) } : item)))
    const notas = [`${precios.size} precio${precios.size !== 1 ? 's' : ''} actualizado${precios.size !== 1 ? 's' : ''}`]
    if (noEncontradas.length) notas.push(`no están en la lista: filas ${unirFilas(noEncontradas.map((x) => `${x.fila} (${x.etiqueta})`))}`)
    if (ambiguas.length) notas.push(`coinciden con varios productos: filas ${unirFilas(ambiguas.map((x) => `${x.fila} (${x.etiqueta})`))}`)
    toastRef.current?.show({
      severity: noEncontradas.length || ambiguas.length ? 'warn' : 'success',
      summary: 'Precios cargados',
      detail: `${notas.join('; ')}. Recuerda guardar.`,
      life: noEncontradas.length || ambiguas.length ? 9000 : 5000,
    })
  }

  const handleUploadVerificarExcel = async (file) => {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'El archivo debe ser .xlsx', life: 3500 })
      return
    }
    try {
      const xlsxMod = await import('xlsx')
      const xlsx = xlsxMod?.default ?? xlsxMod
      const buffer = await file.arrayBuffer()
      const workbook = xlsx.read(buffer, { type: 'array' })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' })
      if (rawRows.length < 2) {
        toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'El archivo no contiene datos.', life: 3500 })
        return
      }
      // Encabezados sin importar mayúsculas ni tildes: se acepta el Excel
      // actual (PVP APROX., Casa PVP APROX....) y los anteriores (PVP, CANT.,
      // Precio, Precio est.).
      const normHeader = (h) => String(h || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      const fileHeaders = rawRows[0].map(normHeader)
      const headerIdx = (...names) => {
        for (const name of names) {
          const idx = fileHeaders.indexOf(normHeader(name))
          if (idx !== -1) return idx
        }
        return -1
      }
      const keyIdx = headerIdx('_key')
      const codigoIdx = headerIdx('Código', 'Codigo JP')
      const nombreIdx = headerIdx('Descripción')
      const oemIdx = headerIdx('OEM')
      const refIdx = headerIdx('Referencia')
      const cantSugIdx = headerIdx('Cantidad', 'Cant.')
      // Sugerencia: se editan "PVP" (PVP aprox.) y la cantidad.
      const precioIdx = isSugerencia ? headerIdx('PVP APROX.', 'PVP', 'Precio') : headerIdx(...(isVerificar ? ['PVP APROX.', 'Precio est.'] : ['Precio conf.']))
      const cantIdx = isSugerencia ? cantSugIdx : headerIdx(isVerificar ? 'Cant. aprox.' : 'Cant. conf.')
      const casaPrecioIdx = isSugerencia ? headerIdx('Casa PVP APROX.', 'Casa PVP', 'Casa del precio') : -1
      const comentIdx = headerIdx('Comentario')
      if (isVerificar && cantIdx === -1) {
        const precioFabIdx = headerIdx('Precio', 'PVP APROX.', 'PVP', 'Precio est.')
        if (precioFabIdx === -1 || (codigoIdx === -1 && refIdx === -1 && oemIdx === -1)) {
          toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'El Excel debe ser el descargado de esta verificación o traer las columnas Código, Referencia u OEM, y Precio.', life: 6000 })
          return
        }
        aplicarExcelFabrica({ rawRows, codigoIdx, refIdx, oemIdx, precioIdx: precioFabIdx })
        return
      }
      if (codigoIdx === -1 || precioIdx === -1 || cantIdx === -1) {
        toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'El archivo no corresponde a esta importación. Descarga el Excel desde este modal.', life: 4500 })
        return
      }
      const cellText = (row, idx) => (idx === -1 ? '' : String(row[idx] ?? '').trim())
      const dataRows = rawRows.slice(1).filter((row) => row.some((c) => String(c ?? '').trim() !== ''))
      // Numero de fila en el Excel (la 1 es el encabezado).
      const filaDe = new Map(rawRows.slice(1).map((row, i) => [row, i + 2]))
      const porCodigo = new Map()
      dataRows.forEach((row) => {
        const codigo = cellText(row, codigoIdx)
        const codigoLc = codigo.toLowerCase() === 'sin catálogo' ? '' : codigo.toLowerCase()
        const clave = codigoLc ? `c:${codigoLc}` : cellText(row, keyIdx) ? `k:${cellText(row, keyIdx)}` : ''
        if (!clave) return
        porCodigo.set(clave, [...(porCodigo.get(clave) || []), { fila: filaDe.get(row), etiqueta: codigo || cellText(row, refIdx) || cellText(row, oemIdx) }])
      })
      const repetidosExcel = [...porCodigo.values()].filter((grupo) => grupo.length > 1)
      if (repetidosExcel.length) { avisarRepetidos(repetidosExcel); return }

      // Las filas del Excel se pueden reordenar (o filtrar/ordenar por
      // cualquier columna) y se pueden agregar productos nuevos: cada fila se
      // empareja con su producto por _key (si el código sigue coincidiendo)
      // o, si no, por código. Las que no corresponden a ningún producto del
      // listado se buscan en el catálogo (por código, referencia u OEM, igual
      // que en la sugerencia) y se agregan como nuevas; si no existen, el
      // producto recién se crea al importar.
      const current = detailsRef.current
      const codeOf = (item) => String(item.producto?.codigo || item.codigo || '').trim().toLowerCase()
      const byKey = new Map(current.map((item) => [item._key, item]))
      const used = new Set()
      const matched = []
      const nuevos = []
      const repetidos = []
      dataRows.forEach((row, rowIdx) => {
        const fileCode = cellText(row, codigoIdx)
        const fileCodeLc = fileCode.toLowerCase() === 'sin catálogo' ? '' : fileCode.toLowerCase()
        let item = byKey.get(cellText(row, keyIdx))
        if (item && (used.has(item._key) || (fileCodeLc && codeOf(item) !== fileCodeLc))) item = null
        if (!item && fileCodeLc) item = current.find((d) => !used.has(d._key) && codeOf(d) === fileCodeLc) || null
        if (item) {
          used.add(item._key)
          matched.push({ item, row })
          return
        }
        if (fileCodeLc && (current.some((d) => codeOf(d) === fileCodeLc) || nuevos.some((n) => n.codigo.toLowerCase() === fileCodeLc))) {
          repetidos.push([{ fila: filaDe.get(row), etiqueta: fileCode }])
          return
        }
        const nombre = cellText(row, nombreIdx)
        const oem = cellText(row, oemIdx)
        const referencia = cellText(row, refIdx)
        if (!fileCodeLc && !nombre && !oem && !referencia) return
        const cantSug = parseInt(cellText(row, cantSugIdx), 10)
        const cantEdit = parseInt(cellText(row, cantIdx), 10)
        // La cantidad no es obligatoria: se completa después en la tabla.
        const cantidad = cantSug > 0 ? cantSug : cantEdit > 0 ? cantEdit : 0
        nuevos.push({
          codigo: fileCodeLc ? fileCode : '', row,
          item: {
            _key: 'manual_' + Date.now() + '_' + rowIdx + '_' + Math.floor(Math.random() * 10000),
            producto: null, codigo: fileCodeLc ? fileCode : '', nombre, oem, referencia,
            cantidad: cantidad > 0 ? String(cantidad) : '', comentario: '',
            precio_estimado: '', cantidad_aproximada: '', precio_confirmado: '', cantidad_confirmada: '',
          },
        })
      })

      // Los nuevos se buscan en el catálogo como en la sugerencia: si ya
      // existen se vinculan (o, si ya estaban en la lista, se toman como
      // ese producto) y, si no, se completan con el código sugerido, la
      // descripción y el PVP JP de la coincidencia por OEM.
      if (nuevos.length > 0 && selectedCasa?.id) {
        const aoa = [
          ['CODIGO JP', 'REFERENCIA', 'OEM', 'DESCRIPCION', 'CANTIDAD'],
          ...nuevos.map(({ item }) => [item.codigo, item.referencia, item.oem, item.nombre, Number(item.cantidad) || '']),
        ]
        const lookupBook = xlsx.utils.book_new()
        xlsx.utils.book_append_sheet(lookupBook, xlsx.utils.aoa_to_sheet(aoa), 'Nuevos')
        const lookupOut = xlsx.write(lookupBook, { bookType: 'xlsx', type: 'array' })
        const lookup = await runParseExcelJob({ file: new Blob([lookupOut]), fileName: 'nuevos.xlsx', casaId: selectedCasa.id, token })
        const byFila = new Map((lookup?.rows || []).map((r) => [r.fila_excel, enrichParsedRow(r, selectedCasa.codigo)]))
        const resolved = []
        nuevos.forEach((n, idx) => {
          const found = byFila.get(idx + 2)
          if (!found) { resolved.push(n); return }
          if (found.matched_producto_id) {
            const id = String(found.matched_producto_id)
            const enLista = current.find((d) => String(d.producto?.id ?? '') === id)
            if (enLista) {
              if (used.has(enLista._key)) {
                const otra = matched.find((m) => m.item._key === enLista._key)
                repetidos.push([{ fila: filaDe.get(otra?.row), etiqueta: enLista.producto?.codigo || id }, { fila: filaDe.get(n.row), etiqueta: enLista.producto?.codigo || id }])
                return
              }
              used.add(enLista._key)
              matched.push({ item: enLista, row: n.row })
              return
            }
            const otraNueva = resolved.find((o) => String(o.item.producto?.id ?? '') === id)
            if (otraNueva) {
              repetidos.push([{ fila: filaDe.get(otraNueva.row), etiqueta: found.matched_producto_codigo || id }, { fila: filaDe.get(n.row), etiqueta: found.matched_producto_codigo || id }])
              return
            }
            resolved.push({
              ...n,
              item: {
                ...n.item,
                _key: id,
                producto: {
                  id: found.matched_producto_id,
                  codigo: found.matched_producto_codigo,
                  nombre: found.matched_producto_nombre,
                  referencia: found.matched_producto_referencia,
                  precio: found.matched_producto_precio,
                },
                codigo: '', nombre: '', oem: '', referencia: '',
              },
            })
            return
          }
          const precioJp = found.conflicto_precio ?? found.sugerido_precio ?? null
          resolved.push({
            ...n,
            precioJp,
            precioJpCasa: found.conflicto_precio != null ? (found.conflicto_casa_nombre || '') : (found.sugerido_casa || ''),
            item: {
              ...n.item,
              codigo: n.item.codigo || found.codigo || '',
              nombre: n.item.nombre || found.descripcion || '',
              oem: n.item.oem || found.oem || '',
              referencia: n.item.referencia || found.referencia || '',
              // De dónde salió el código sugerido (se muestra bajo el código,
              // que se puede corregir igual que en la sugerencia).
              ...(found.codigo_sugerido && !n.item.codigo ? {
                _sugeridoDesde: found.sugerido_desde || '',
                _sugeridoCasa: found.sugerido_casa || found.conflicto_casa_nombre || '',
                coincidencia: found.conflicto_casa ? 'otra_casa' : 'oem',
                coincidencia_precio: precioJp,
              } : {}),
            },
          })
        })
        nuevos.splice(0, nuevos.length, ...resolved)
      }

      const precioField = isSugerencia || isVerificar ? 'precio_estimado' : 'precio_confirmado'
      const cantField = isSugerencia ? 'cantidad' : isVerificar ? 'cantidad_aproximada' : 'cantidad_confirmada'
      // Lo que trae el Excel es lo que queda: una celda vacía (o que no es un
      // número) deja el campo vacío.
      const applyRow = (item, row) => {
        const precioNum = parseFloat(cellText(row, precioIdx).replace(',', '.'))
        const cantNum = parseInt(cellText(row, cantIdx), 10)
        // La sugerencia descarga el PVP del catálogo cuando no hay PVP aprox.;
        // si vuelve igual, no se toma como PVP aprox.
        const esPrecioCatalogo = isSugerencia && !item.precio_estimado && item.producto?.precio != null
          && Math.round(Number(item.producto.precio) * 100) === Math.round(precioNum * 100)
        const nuevoPrecio = isNaN(precioNum) || esPrecioCatalogo ? '' : String(Math.round(precioNum * 100))
        // Si el precio se cambió en el Excel ya no es el de esa casa.
        const precioCambio = isSugerencia && nuevoPrecio !== String(item.precio_estimado || '').replace(/\D/g, '')
        // Si el Excel trae "CASA PVP", esa es la casa del precio.
        const casaPrecio = casaPrecioIdx !== -1 && nuevoPrecio ? cellText(row, casaPrecioIdx) : null
        return {
          ...item,
          ...(casaPrecio != null ? { precio_casa: casaPrecio } : precioCambio ? { precio_casa: '' } : {}),
          [precioField]: nuevoPrecio,
          [cantField]: isNaN(cantNum) ? '' : String(cantNum),
          comentario: comentIdx !== -1 ? cellText(row, comentIdx) : item.comentario,
        }
      }
      // Verificacion: un producto que vuelve a aparecer en el Excel se
      // restaura; uno que ya no viene se marca como quitado (en rojo, con la
      // nota en el comentario) en vez de borrarlo, para poder restaurarlo.
      const restaurar = (item) => (isVerificar && item.quitado
        ? { ...item, quitado: false, comentario: withoutNotaVerificacion(item.comentario, NOTA_QUITADO_VERIFICACION) }
        : item)
      const quitar = (item) => (isVerificar && !item.quitado
        ? { ...item, quitado: true, comentario: withNotaVerificacion(item.comentario, NOTA_QUITADO_VERIFICACION) }
        : item)
      const marcarAgregado = (item) => (isVerificar
        ? { ...item, comentario: withNotaVerificacion(item.comentario, NOTA_AGREGADO_VERIFICACION) }
        : item)
      // Precio de la coincidencia (otra casa o código sugerido) para un
      // producto nuevo sin catálogo: en la sugerencia es su PVP aprox. si el
      // Excel no trae uno; en verificación/confirmación se muestra como PVP JP.
      const conPrecioJp = (item, precioJp, casa) => {
        if (precioJp == null) return item
        if (!isSugerencia) return { ...item, precio: precioJp }
        if (item.precio_estimado) return item
        return { ...item, precio_estimado: String(Math.round(Number(precioJp) * 100)), precio_casa: casa || '' }
      }
      if (repetidos.length) { avisarRepetidos(repetidos); return }
      const ausentes = current.filter((item) => !used.has(item._key))
      const nuevosQuitados = isVerificar ? ausentes.filter((item) => !item.quitado).length : 0

      // Orden final: manda el orden de las filas del Excel, con los productos
      // del catálogo primero y los nuevos (sin producto todavía) al final.
      // Los que no vienen en el Excel quedan quitados al fondo. Se renumera
      // 1..N.
      const delExcel = [
        ...matched.map(({ item, row }) => ({ row, item: restaurar(applyRow(item, row)) })),
        ...nuevos.map(({ item, row, precioJp, precioJpCasa }) => ({ row, item: marcarAgregado(conPrecioJp(applyRow(item, row), precioJp, precioJpCasa)) })),
      ]
        .sort((a, b) => dataRows.indexOf(a.row) - dataRows.indexOf(b.row))
        .map(({ item }) => item)
      const next = [
        ...delExcel.filter((item) => item.producto?.id),
        ...delExcel.filter((item) => !item.producto?.id),
        // En la sugerencia lo que no viene en el Excel se saca del listado.
        ...(isSugerencia ? [] : ausentes.map(quitar)),
      ]
      setDetails(next.map((item, i) => ({ ...item, orden: i + 1 })))

      const notes = []
      if (nuevos.length > 0) notes.push(`${nuevos.length} producto(s) nuevo(s) agregado(s)`)
      if (isSugerencia && ausentes.length > 0) notes.push(`${ausentes.length} producto(s) que no venían en el Excel se sacaron del listado`)
      if (nuevosQuitados > 0) notes.push(`${nuevosQuitados} producto(s) que no venían en el Excel quedaron quitados (en rojo)`)
      toastRef.current?.show({
        severity: nuevosQuitados > 0 || (isSugerencia && ausentes.length > 0) ? 'warn' : 'success',
        summary: 'Datos cargados',
        detail: `Tabla actualizada desde Excel${notes.length ? ` (${notes.join('; ')})` : ''}. Recuerda guardar.`,
        life: 5000,
      })
    } catch (e) {
      console.error(e)
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'No se pudo leer el Excel.', life: 3500 })
    }
  }

  const handlePedirCotizacion = async () => {
    if (incompletos.length > 0) {
      toastRef.current?.show({
        severity: 'warn',
        summary: 'Datos incompletos',
        detail: `Completa ${incompletos.length} producto${incompletos.length !== 1 ? 's' : ''} antes de pedir la cotización (están marcados en la tabla).`,
        life: 5000,
      })
      setProductSearch('')
      jumpToDetailRow(incompletos[0]._key)
      return
    }
    // La cantidad puede quedar en 0 al pedir la cotizacion: se completa en la
    // verificacion (Cant. aprox.) y se exige al pedir la confirmacion.
    const badKeys = new Set(
      details.filter((item) => { const n = Number(item.cantidad || 0); return !Number.isFinite(n) || n < 0 }).map((item) => item._key)
    )
    if (badKeys.size > 0) {
      setInvalidQtyKeys(badKeys)
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: 'Las cantidades no pueden ser negativas.', life: 4000 })
      return
    }
    setImportarSubmitting(true)
    try {
      const normalizedDetails = details.map((item) => {
        const solId = item._solId ? { solicitud_id: Number(item._solId) } : {}
        // El PVP aprox. se reenvia: con el se crean los productos nuevos al
        // importar.
        const precioEstimado = {
          precio_estimado: item.precio_estimado
            ? (parseInt(String(item.precio_estimado).replace(/\D/g, '') || '0', 10) / 100).toFixed(2)
            : null,
        }
        if (item.producto?.id) return { producto_id: item.producto.id, cantidad: Number(item.cantidad || 0), comentario: item.comentario || '', orden: item.orden, ...precioEstimado, ...solId }
        return { codigo: item.codigo || '', nombre: item.nombre || '', oem: item.oem || '', referencia: item.referencia || '', cantidad: Number(item.cantidad || 0), comentario: item.comentario || '', orden: item.orden, ...precioEstimado, ...solId }
      })
      const saveResponse = await authFetch(
        `${API_URL}/importaciones/importaciones/${imp.id}/`,
        { method: 'PATCH', body: JSON.stringify({ detalles: normalizedDetails }) },
        token
      )
      if (!saveResponse.ok) throw new Error(await readErrorMessage(saveResponse, 'No se pudo guardar los cambios.'))
      const response = await authFetch(
        `${API_URL}/importaciones/importaciones/${imp.id}/pedir-cotizacion/`,
        { method: 'POST' },
        token
      )
      if (!response.ok) throw new Error(await readErrorMessage(response, 'No se pudo solicitar la cotización.'))
      const payload = await response.json()
      onSaved?.(payload)
      onClose?.()
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: error.message, life: 4000 })
    } finally {
      setImportarSubmitting(false)
    }
  }

  // Codigos nuevos que el backend no deja crear (ya existen en el catalogo,
  // repetidos...): todos a la vez en el aviso y marcados en la tabla, hasta
  // que se cambian.
  const showCodigosInvalidos = async (response) => {
    const payload = await response.clone().json().catch(() => null)
    const invalidos = Array.isArray(payload?.codigos_invalidos) ? payload.codigos_invalidos : []
    if (!invalidos.length) return false
    setCodigosInvalidos(invalidos)
    toastRef.current?.show({
      severity: 'warn',
      summary: 'Códigos nuevos repetidos',
      detail: `${invalidos.length} código${invalidos.length !== 1 ? 's' : ''} nuevo${invalidos.length !== 1 ? 's' : ''} no se ${invalidos.length !== 1 ? 'pueden' : 'puede'} crear: cambia el código o quita la fila (están marcados en la tabla).`,
      life: 6000,
    })
    const motivos = new Set(invalidos.map((row) => String(row.codigo || '').trim().toUpperCase()))
    const primera = details.find((item) => !item.producto?.id && !item.quitado && motivos.has(String(item.codigo || '').trim().toUpperCase()))
    if (primera) { setProductSearch(''); jumpToDetailRow(primera._key) }
    return true
  }

  const handleConfirmar = async () => {
    // Los productos quitados en la verificacion ya no pasan a confirmacion.
    const vigentes = details.filter((item) => !item.quitado)
    if (!vigentes.length) {
      toastRef.current?.show({ severity: 'error', summary: 'Sin productos', detail: 'Todos los productos están quitados: restaura al menos uno para pedir confirmación.', life: 5000 })
      return
    }
    // Guardar se puede sin completar; para pasar a confirmacion cada producto
    // necesita su PVP Aprox. y su Cant. aprox. (la cantidad pedida no cuenta).
    const missingData = vigentes.filter((item) => {
      const precio = parseInt(String(item.precio_estimado || '').replace(/\D/g, '') || '0', 10)
      return precio <= 0 || !(Number(item.cantidad_aproximada) > 0)
    })
    setFaltanConfirmar(new Set(missingData.map((item) => item._key)))
    if (missingData.length > 0) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Datos incompletos',
        detail: `Completa el PVP Aprox. y la Cant. aprox. de todos los productos (${missingData.length} sin completar). Están marcados en rojo.`,
        life: 5000,
      })
      setProductSearch('')
      jumpToDetailRow(missingData[0]._key)
      return
    }
    setImportarSubmitting(true)
    try {
      // Los quitados tambien se mandan (con su marca): el backend los guarda
      // en el historial de verificacion y recien ahi los saca.
      const normalizedDetails = details.map((item) => {
        const solId = item._solId ? { solicitud_id: Number(item._solId) } : {}
        const precioEstimadoVal = item.precio_estimado
          ? (parseInt(String(item.precio_estimado).replace(/\D/g, '') || '0', 10) / 100).toFixed(2)
          : null
        const cantAproxVal = toNumberOrNull(item.cantidad_aproximada)
        const estimadoFields = {
          precio_estimado: precioEstimadoVal,
          cantidad_aproximada: cantAproxVal,
          precio_confirmado: precioEstimadoVal,
          cantidad_confirmada: cantAproxVal,
          quitado: Boolean(item.quitado),
        }
        const cantidad = Number(item.cantidad || item.cantidad_aproximada || 0)
        if (item.producto?.id) return { producto_id: item.producto.id, cantidad, comentario: item.comentario || '', orden: item.orden, ...estimadoFields, ...solId }
        return { codigo: item.codigo || '', nombre: item.nombre || '', oem: item.oem || '', referencia: item.referencia || '', cantidad, comentario: item.comentario || '', orden: item.orden, ...estimadoFields, ...solId }
      })
      const saveResponse = await authFetch(
        `${API_URL}/importaciones/importaciones/${imp.id}/`,
        { method: 'PATCH', body: JSON.stringify({ detalles: normalizedDetails }) },
        token
      )
      if (!saveResponse.ok) throw new Error(await readErrorMessage(saveResponse, 'No se pudo guardar los cambios.'))
      const response = await authFetch(
        `${API_URL}/importaciones/importaciones/${imp.id}/confirmar/`,
        { method: 'POST' },
        token
      )
      if (!response.ok && await showCodigosInvalidos(response)) return
      if (!response.ok) throw new Error(await readErrorMessage(response, 'No se pudo confirmar la importación.'))
      const payload = await response.json()
      onSaved?.(payload)
      onClose?.()
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: error.message, life: 4000 })
    } finally {
      setImportarSubmitting(false)
    }
  }

  const handleImportar = async () => {
    const factura = facturaInput.trim()
    if (!factura || !fechaImportar) return
    setImportarSubmitting(true)
    try {
      const normalizedDetalles = details.map((item) => {
        const solId = item._solId ? { solicitud_id: Number(item._solId) } : {}
        const confirmedFields = {
          precio_estimado: item.precio_estimado
            ? (parseInt(String(item.precio_estimado).replace(/\D/g, '') || '0', 10) / 100).toFixed(2)
            : null,
          cantidad_aproximada: toNumberOrNull(item.cantidad_aproximada),
          precio_confirmado: item.precio_confirmado
            ? (parseInt(String(item.precio_confirmado).replace(/\D/g, '') || '0', 10) / 100).toFixed(2)
            : null,
          cantidad_confirmada: toNumberOrNull(item.cantidad_confirmada),
        }
        const detalleId = item._detalleId != null ? { detalle_id: item._detalleId } : {}
        if (item.producto?.id) return { producto_id: item.producto.id, cantidad: Number(item.cantidad || 0), comentario: item.comentario || '', orden: item.orden, ...confirmedFields, ...solId, ...detalleId }
        return { codigo: item.codigo || '', nombre: item.nombre || '', oem: item.oem || '', referencia: item.referencia || '', cantidad: Number(item.cantidad || 0), comentario: item.comentario || '', orden: item.orden, ...confirmedFields, ...solId, ...detalleId }
      })
      const selectedKeys = Object.entries(itemCheckStates).filter(([, s]) => s === 'check').map(([k]) => k)
      const xKeys = Object.entries(itemCheckStates).filter(([, s]) => s === 'x').map(([k]) => k)
      const response = await authFetch(
        `${API_URL}/importaciones/importaciones/${imp.id}/importar/`,
        {
          method: 'POST',
          body: JSON.stringify({
            numero_factura: factura,
            fecha_importacion: fechaImportar,
            detalles: normalizedDetalles,
            detalles_seleccionados: selectedKeys,
            detalles_x: xKeys,
          }),
        },
        token
      )
      if (!response.ok && await showCodigosInvalidos(response)) { setShowImportarModal(false); return }
      if (!response.ok) throw new Error(await readErrorMessage(response, 'No se pudo generar la importación.'))
      const payload = await response.json()
      setShowImportarModal(false)
      onSaved?.(payload)
      onClose?.()
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: error.message, life: 4000 })
    } finally {
      setImportarSubmitting(false)
    }
  }

  const isEditableForClose = imp?.estado === 'borrador' || imp?.estado === 'cotizacion' || imp?.estado === 'confirmacion'
  const hasUnsavedEdits = Boolean(open && imp && isEditableForClose && (
    serializeDetailsForDirty(details) !== serializeDetailsForDirty(initialDetailsRef.current)
    || serializeCheckStatesForDirty(itemCheckStates) !== serializeCheckStatesForDirty(initialItemCheckStatesRef.current)
  ))

  const handleCloseWithSave = () => {
    if (!isEditableForClose || submitting || importarSubmitting) { onClose?.(); return }
    if (!hasUnsavedEdits) { onClose?.(); return }
    setShowSaveOnCloseModal(true)
  }

  // Devuelve true si se guardo (lo usa tambien cerrar la pestana).
  const handleSaveAndClose = async () => {
    setShowSaveOnCloseModal(false)
    setSubmitting(true)
    try {
      const normalizedDetails = details.map((item) => {
        const solId = item._solId ? { solicitud_id: Number(item._solId) } : {}
        const confirmedFields = isVerificarOrConfirmacion ? {
          precio_estimado: item.precio_estimado ? (parseInt(String(item.precio_estimado).replace(/\D/g, '') || '0', 10) / 100).toFixed(2) : null,
          cantidad_aproximada: toNumberOrNull(item.cantidad_aproximada),
          precio_confirmado: item.precio_confirmado ? (parseInt(String(item.precio_confirmado).replace(/\D/g, '') || '0', 10) / 100).toFixed(2) : null,
          cantidad_confirmada: toNumberOrNull(item.cantidad_confirmada),
          seleccionado: itemCheckStates[item._key] === 'check' ? true : itemCheckStates[item._key] === 'x' ? false : null,
        } : {}
        if (item.producto?.id) return { producto_id: item.producto.id, cantidad: Number(item.cantidad || 0), comentario: item.comentario || '', orden: item.orden, ...confirmedFields, ...solId }
        return { codigo: item.codigo || '', nombre: item.nombre || '', oem: item.oem || '', referencia: item.referencia || '', cantidad: Number(item.cantidad || 0), comentario: item.comentario || '', orden: item.orden, ...confirmedFields, ...solId }
      })
      const response = await authFetch(
        `${API_URL}/importaciones/importaciones/${imp.id}/`,
        { method: 'PATCH', body: JSON.stringify({ detalles: normalizedDetails }) },
        token
      )
      if (!response.ok) throw new Error(await readErrorMessage(response, 'No se pudo guardar.'))
      const payload = await response.json()
      onSaved?.(payload)
      onClose?.()
      return true
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Error al guardar', detail: error.message, life: 4000 })
      return false
    } finally {
      setSubmitting(false)
    }
  }

  // Cerrar la pestana Importaciones con cambios sin guardar aqui tambien pregunta.
  useUnsavedChangesRegistration({
    dirty: hasUnsavedEdits,
    onSave: handleSaveAndClose,
    label: `Importación ${imp?.codigo || ''}`.trim(),
  })

  const handleDeleteBorrador = async () => {
    setDeleteSubmitting(true)
    try {
      const response = await authFetch(
        `${API_URL}/importaciones/importaciones/${imp.id}/`,
        { method: 'DELETE' },
        token
      )
      if (!response.ok) throw new Error(await readErrorMessage(response, 'No se pudo eliminar la sugerencia.'))
      setShowDeleteModal(false)
      onSaved?.()
      onClose?.()
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Error', detail: error.message, life: 4000 })
    } finally {
      setDeleteSubmitting(false)
    }
  }

  // Encabezado y selector de codigo fijos al desplazarse por la tabla.
  const productsHeadRef = useRef(null)
  const [productsHeadHeight, setProductsHeadHeight] = useState(40)
  useEffect(() => {
    const head = productsHeadRef.current
    if (!head || typeof ResizeObserver === 'undefined') return undefined
    const update = () => setProductsHeadHeight(head.getBoundingClientRect().height || 40)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(head)
    return () => observer.disconnect()
  })

  // Codigo que ya esta en la lista: en vez de no mostrarse, lleva a su fila.
  const [highlightedDetailKey, setHighlightedDetailKey] = useState('')
  const jumpToDetailRow = useCallback((detailKey) => {
    if (!detailKey) return
    setShowProductDropdown(false)
    setProductQuery('')
    setProductOptions([])
    setHighlightedDetailKey(String(detailKey))
    window.requestAnimationFrame(() => {
      scrollRowToTopAndFlash(document.querySelector(`[data-detail-key="${CSS.escape(String(detailKey))}"]`))
    })
    window.setTimeout(() => setHighlightedDetailKey((current) => (current === String(detailKey) ? '' : current)), 2600)
  }, [])
  // Orden en pantalla de la verificacion: lo agregado en esta etapa va arriba
  // (el ultimo primero) y el resto en su orden; un producto quitado se queda
  // en su lugar, tachado. Solo cambia como se muestra, no el orden guardado.
  const esAgregadoAqui = (item) => String(item.comentario || '').includes(NOTA_AGREGADO_VERIFICACION)
  const shownDetails = isVerificar
    ? [...details.filter(esAgregadoAqui).reverse(), ...details.filter((item) => !esAgregadoAqui(item))]
    : details
  // Mismos grupos (y colores) que las filas de la verificacion.
  const verificarColorDe = (item) => (
    item.quitado ? 'quitado'
      : esAgregadoVerificacion(item) ? (item.producto?.id ? 'agregadoExiste' : 'agregadoNuevo')
        : item.producto?.id ? 'catalogo' : 'noExiste'
  )
  const verificarConteo = isVerificar
    ? shownDetails.reduce((acc, item) => ({ ...acc, [verificarColorDe(item)]: (acc[verificarColorDe(item)] || 0) + 1 }), {})
    : {}
  // Datos que le faltan a un producto sin catalogo para pedir la cotizacion
  // (la sugerencia se puede crear y guardar sin ellos). Misma regla que el
  // backend en pedir_cotizacion.
  // La cantidad puede quedar en 0, y el OEM tambien puede faltar (hay casas
  // cuyos productos no tienen OEM, p. ej. Loma Hermosa Plast).
  // El codigo JP no hace falta: se completa al confirmar la llegada.
  const faltantesDe = (item) => {
    if (item.producto?.id) return []
    return [
      ['referencia', 'Referencia'],
      ['nombre', 'Descripción'],
    ].filter(([field]) => !String(item[field] || '').trim()).map(([, label]) => label)
  }
  const incompletos = isSugerencia ? details.filter((item) => faltantesDe(item).length > 0) : []
  // Productos nuevos cuyo codigo el backend rechazo: dejan de marcarse en
  // cuanto se les cambia el codigo (o se quitan).
  const motivoCodigoInvalido = new Map(codigosInvalidos.map((row) => [String(row.codigo || '').trim().toUpperCase(), row.motivo]))
  const codigoInvalidoDe = (item) => (!item.producto?.id && !item.quitado ? motivoCodigoInvalido.get(String(item.codigo || '').trim().toUpperCase()) : undefined)
  const filasCodigoInvalido = codigosInvalidos.length ? details.filter((item) => codigoInvalidoDe(item)) : []
  const avisoCodigosInvalidos = [...new Map(filasCodigoInvalido.map((item) => {
    const codigo = String(item.codigo || '').trim()
    return [codigo.toUpperCase(), { codigo, motivo: codigoInvalidoDe(item) }]
  })).values()]
  // La "i" del OEM (sugerencia, verificacion y confirmacion): coincidencias
  // del catalogo, pedidas una vez por fila.
  const coincidenciaItems = useMemo(() => details.map((d) => ({
    key: d._key,
    oem: getProductoOem(d.producto) || d.oem || '',
    referencia: d.producto?.referencia || d.referencia || '',
  })), [details])
  const coincidenciasByKey = useCoincidencias(token, open ? selectedCasa?.id : null, coincidenciaItems)
  const sugerenciaRows = useMemo(
    () => (isSugerencia ? details.map((d) => detalleToSugerenciaRow(d, coincidenciasByKey[d._key])) : []),
    [isSugerencia, details, coincidenciasByKey]
  )
  const setSugerenciaRows = useCallback((updater) => {
    setDetails((prev) => {
      const prevRows = prev.map((d) => detalleToSugerenciaRow(d))
      const next = typeof updater === 'function' ? updater(prevRows) : updater
      return next.map(sugerenciaRowToDetalle)
    })
  }, [])
  const sugerenciaViewRef = useRef({})
  const sugerenciaJumpToRef = useRef(null)

  // Cada clic en un contador lleva a la siguiente fila de ese grupo.
  const verificarJumpRef = useRef({ grupo: '', idx: -1 })
  const jumpToVerificarGrupo = (grupo) => {
    const keys = shownDetails.filter((item) => verificarColorDe(item) === grupo).map((item) => item._key)
    if (!keys.length) return
    const last = verificarJumpRef.current
    const idx = last.grupo === grupo && last.idx + 1 < keys.length ? last.idx + 1 : 0
    verificarJumpRef.current = { grupo, idx }
    setProductSearch('')
    jumpToDetailRow(keys[idx])
  }
  const listedMatches = useMemo(() => {
    const term = String(productQuery || '').trim().toLowerCase()
    if (term.length < 2) return []
    return details
      .filter((item) => {
        const text = [
          item.producto?.codigo || item.codigo,
          item.producto?.nombre || item.nombre,
          getProductoOem(item.producto) || item.oem,
          getReferenciasTexto(item.producto, item),
        ].join(' ').toLowerCase()
        return text.includes(term)
      })
      .slice(0, 6)
  }, [details, productQuery])

  // Selector de codigo de la fila "Agregar" (se usa en la tabla de la
  // sugerencia y en la de verificacion).
  const productPickerDropdown = (
    <div className="create-user__dropdown create-salida__product-dropdown" ref={productDropdownRef}>
      <button
        type="button"
        className="create-user__dropdown-trigger"
        onClick={() => {
          setShowProductDropdown((prev) => !prev)
          if (!showProductDropdown) { setProductQuery('') }
        }}
      >
        <span>{detailDraft.producto ? String(detailDraft.producto.codigo || '').trim() : 'Selecciona un código'}</span>
        <i className={`pi pi-chevron-${showProductDropdown ? 'up' : 'down'}`} />
      </button>
      {showProductDropdown && productPanelStyle && createPortal(
        <div data-product-portal-edit className="create-user__dropdown-panel" style={productPanelStyle}>
          <div className="create-user__dropdown-search">
            <i className="pi pi-search" />
            <input
              type="text"
              placeholder="Buscar código o nombre"
              value={productQuery}
              onChange={(e) => setProductQuery(e.target.value)}
              autoFocus
              autoComplete="off"
            />
          </div>
          <div className="create-user__dropdown-results">
            {productLoading && <small className="muted">Buscando productos...</small>}
            {!productLoading && !productQuery.trim() && !productOptions.length && <small className="muted">Escribe para buscar.</small>}
            {listedMatches.length > 0 && (
              <div className="imp-listed-matches">
                <small className="imp-listed-matches__title">Ya en la lista — toca para ir a la fila</small>
                {listedMatches.map((item) => (
                  <button
                    key={`listed-${item._key}`}
                    type="button"
                    className="create-salida__result-row imp-listed-matches__row"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => jumpToDetailRow(item._key)}
                  >
                    <span className="result-codigo">{String(item.producto?.codigo || item.codigo || '').trim()}</span>
                    <span className="result-nombre">{String(item.producto?.nombre || item.nombre || '').trim()}</span>
                    <span className="result-stock">{`Cant. ${Number(item.cantidad || 0)}`}</span>
                  </button>
                ))}
              </div>
            )}
            {!productLoading && productQuery.trim() && !productOptions.length && !listedMatches.length && <small className="muted">Sin resultados.</small>}
            {productOptions.length > 0 && (
              <div className="create-salida__results-header">
                <span>Código</span><span>Descripción</span><span>Stock</span>
              </div>
            )}
            {productOptions.map((product) => {
              const isAlreadyAdded = details.some((d) => d.producto?.id && String(d.producto.id) === String(product.id))
              const isSelected = String(detailDraft.producto?.id) === String(product.id)
              return (
                <button
                  key={product.id}
                  type="button"
                  className={`create-salida__result-row${isSelected ? ' is-selected' : ''}${isAlreadyAdded ? ' is-added' : ''}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (isAlreadyAdded) {
                      const existing = details.find((d) => d.producto?.id && String(d.producto.id) === String(product.id))
                      jumpToDetailRow(existing?._key)
                      return
                    }
                    setDetailDraft({ producto: product, cantidad: '' }); setProductQuery(''); setShowProductDropdown(false); setProductOptions([])
                  }}
                  title={isAlreadyAdded ? 'Ya está en la lista: ir a la fila' : undefined}
                >
                  <span className="result-codigo">{String(product.codigo || '').trim()}</span>
                  <span className="result-nombre">{String(product.nombre || '').trim()}</span>
                  <span className="result-stock">{Number(product.total_stock ?? 0)}</span>
                </button>
              )
            })}
          </div>
        </div>,
        getPortalRoot()
      )}
    </div>
  )

  if (!open || !imp) return null

  return (
    <>
      <Toast ref={toastRef} baseZIndex={12100} />
      <div className="create-user__overlay" role="dialog" aria-modal="true" style={{ padding: `${VIEWPORT_PADDING}px` }}>
        <div
          ref={modalRef}
          className="create-user__modal"
          style={{
            top: modalPosition.y, left: modalPosition.x,
            width: modalSize.width, height: modalSize.height,
            minWidth: MIN_WIDTH, minHeight: MIN_HEIGHT,
            maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
            maxHeight: `calc(100dvh - ${VIEWPORT_PADDING * 2}px)`,
          }}
        >
          <header className="create-user__header" onMouseDown={handleModalMouseDown}>
            <div className="create-user__header-text">
              <h3>{imp.estado === 'cotizacion' ? 'Verificar' : imp.estado === 'confirmacion' ? 'Confirmación' : 'Sugerencia'}: {imp.codigo}</h3>
            </div>
            <div className="create-user__header-actions">
              <button
                type="button"
                className="create-user__icon-button create-user__icon-button--maximize"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={toggleMaximize}
                aria-label={isMaximized ? 'Restaurar' : 'Maximizar'}
              >
                <i className={isMaximized ? 'pi pi-window-minimize' : 'pi pi-window-maximize'} aria-hidden="true" />
              </button>
              <button type="button" className="create-user__icon-button" onMouseDown={(e) => e.stopPropagation()} onClick={handleCloseWithSave} disabled={submitting} aria-label="Cerrar">
                <i className="pi pi-times" aria-hidden="true" />
              </button>
            </div>
          </header>

          {/* Mientras se confirma que imp/details son la versión más reciente
              del servidor (ver el fetch al abrir, arriba), se bloquea toda
              interacción con un overlay -- así nunca se alcanza a editar ni
              guardar sobre datos potencialmente desactualizados (precios,
              cantidades, orden) que luego pisarían lo ya guardado. */}
          {loadingImp && (
            <div className="spinner-container spinner-container--table" style={{ position: 'absolute', inset: 0, zIndex: 20 }}>
              <div className="spinner" />
            </div>
          )}
          {uploadingExcel && <ExcelLoadingOverlay />}

          <form className="create-user__form" noValidate onSubmit={(e) => { e.preventDefault(); handleSubmit() }}>
            <div className="create-user__tabs create-salida__tabs" role="tablist">
              <button type="button" className={`create-user__tab${activeTab === 'general' ? ' create-user__tab--active' : ''}`} onClick={() => setActiveTab('general')}>
                General
              </button>
              <button type="button" className={`create-user__tab${activeTab === 'productos' ? ' create-user__tab--active' : ''}`} onClick={() => setActiveTab('productos')}>
                Productos {details.length > 0 && `(${details.length})`}
              </button>
            </div>

            <div className="create-user__content create-salida__content">
              <div className="create-user__body">
                {activeTab === 'general' && (
                  <section className="create-user__section">
                    <div className="create-user__section-header">
                      <div>
                        <p className="create-user__eyebrow">General</p>
                        <h4>Información de la importación</h4>
                      </div>
                    </div>
                    <div className="create-salida__field-groups">
                      <div className="create-salida__field-group create-salida__field-group--defined">
                        <div className="create-user__grid create-user__grid--two">
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            <StaticFieldDisplay label="Código" value={imp.codigo} />
                            <StaticFieldDisplay label="Fecha" value={formatDate(imp.fecha)} />
                            <StaticFieldDisplay label="Casa comercial" value={formatCasaLabel(selectedCasa)} />
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {selectedCasa?.pais?.nombre ? (
                              <div className="create-user__field create-salida__static-field">
                                <span>País</span>
                                <div className="create-salida__static-value" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                  {(() => {
                                    const flagUrl = getFlagUrl(selectedCasa.pais?.codigo_pais)
                                    return (
                                      <span className={`create-user__flag${flagUrl ? '' : ' is-empty'}`} aria-hidden="true" style={{ flexShrink: 0 }}>
                                        {flagUrl ? <img src={flagUrl} alt="" /> : '□'}
                                      </span>
                                    )
                                  })()}
                                  {String(selectedCasa.pais.nombre).trim()}
                                </div>
                              </div>
                            ) : (
                              <StaticFieldDisplay label="País" value="-" />
                            )}
                            <StaticFieldDisplay
                              label="Días de entrega aproximados"
                              value={imp.dias_entrega_estimados != null ? `${imp.dias_entrega_estimados} días` : ''}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  </section>
                )}

                {activeTab === 'productos' && !showAceptadosView && (
                  <section className="create-user__section">
                    <div className="create-user__section-header">
                      <div>
                        <p className="create-user__eyebrow">Productos</p>
                        <h4>Listado de productos</h4>
                      </div>
                      {/* La sugerencia trae sus propios botones (SugerenciaTabla). */}
                      {!isSugerencia && (!isVerificarOrConfirmacion || (isVerificar && canEdit)) && (
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          <button
                            type="button"
                            className="create-user__ghost"
                            onClick={() => setShowNuevoProductoView(true)}
                            style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}
                          >
                            + Agregar nuevo producto
                          </button>
                          {(!isVerificarOrConfirmacion || isVerificar) && (
                            <span title={aceptadosCount === 0 ? 'No hay productos aceptados para esta casa comercial' : undefined}>
                              <button
                                type="button"
                                className="create-user__ghost"
                                onClick={() => setShowAceptadosView(true)}
                                style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}
                                disabled={aceptadosCount === 0}
                              >
                                + Aceptados de solicitudes
                              </button>
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    {isVerificar && details.length > 0 && (
                      <VerificacionGroupsSummary
                        conteo={verificarConteo}
                        chipProps={(grupo, label) => ({
                          role: 'button',
                          tabIndex: 0,
                          onClick: () => jumpToVerificarGrupo(grupo),
                          onKeyDown: (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              jumpToVerificarGrupo(grupo)
                            }
                          },
                          className: 'imp-excel-review__group-chip',
                          'aria-label': `Ir a ${label}`,
                        })}
                      />
                    )}
                    {!isSugerencia && details.length > 0 && (
                      <ImportProductSearch
                        value={productSearch}
                        onChange={setProductSearch}
                        shown={details.filter((item) => importItemMatches(item, productSearch)).length}
                        total={details.length}
                      >
                      </ImportProductSearch>
                    )}
                    {avisoCodigosInvalidos.length > 0 && (
                      <div className="imp-incompletos-aviso" role="alert">
                        <i className="pi pi-exclamation-triangle" aria-hidden="true" />
                        <span>
                          <strong>
                            {avisoCodigosInvalidos.length} código{avisoCodigosInvalidos.length !== 1 ? 's' : ''} nuevo{avisoCodigosInvalidos.length !== 1 ? 's' : ''} no se {avisoCodigosInvalidos.length !== 1 ? 'pueden' : 'puede'} crear.
                          </strong>{' '}
                          Un producto no puede ir dos veces en la importación: cambia el código o quita la fila (marcados en rojo).
                          <span className="imp-codigos-invalidos__lista">
                            {avisoCodigosInvalidos.map((row) => (
                              <span key={row.codigo}><strong>{row.codigo}</strong>: {row.motivo}</span>
                            ))}
                          </span>
                        </span>
                        <button
                          type="button"
                          className="imp-incompletos-aviso__ir"
                          onClick={() => {
                            const key = filasCodigoInvalido[0]._key
                            if (isSugerencia && sugerenciaJumpToRef.current) sugerenciaJumpToRef.current(key)
                            else { setProductSearch(''); jumpToDetailRow(key) }
                          }}
                        >
                          Ir al primero
                        </button>
                      </div>
                    )}
                    {isSugerencia ? (
                      // La misma tabla que el Paso 3 de "Sugerencia desde Excel"
                      // y que la creacion manual.
                      <SugerenciaTabla
                        token={token}
                        casa={selectedCasa}
                        rows={sugerenciaRows}
                        setRows={setSugerenciaRows}
                        viewStateRef={sugerenciaViewRef}
                        jumpRef={sugerenciaJumpToRef}
                        readOnly={!canEdit}
                        wrapStyle={{ flex: '1 1 0' }}
                        wrapClassName="imp-sugerencia__tabla-wrap"
                        invalidFields={(row) => {
                          const detalle = sugerenciaRowToDetalle(row)
                          const faltan = faltantesDe(detalle)
                          return codigoInvalidoDe(detalle) ? [...faltan, 'Código'] : faltan
                        }}
                        notify={(severity, summary, detail) => toastRef.current?.show({ severity, summary, detail, life: 4500 })}
                      />
                    ) : (
                    <div className={`create-user__locations-table create-salida__products-table create-salida__products-table--with-actions importaciones-modal__products-table${isVerificarOrConfirmacion ? ' importaciones-modal__products-table--verificar' : ''}${isConfirmacion ? ' importaciones-modal__products-table--confirmacion' : ''}`} onKeyDown={handleProductsGridKeyDown}>
                      <div className="create-user__locations-row create-user__locations-row--head imp-sticky-head" ref={productsHeadRef}>
                        <span>Código</span><span>Descripción</span><span>OEM</span><span>Referencia</span><span>{isVerificarOrConfirmacion ? 'PVP JP' : 'Precio'}</span>
                        {!isVerificarOrConfirmacion && <span>Cantidad</span>}
                        {isVerificar ? (
                          <>
                            <span onDoubleClick={() => setDetails((prev) => prev.map((d) => ({ ...d, precio_estimado: d.producto?.precio != null ? Math.round(Number(d.producto.precio) * 100) : d.precio_estimado })))} title="Doble click: llenar todas con precio original" style={{ cursor: 'pointer' }}>PVP Aprox.</span>
                            <span>Diferencia</span>
                            <span>Cant. Sug.</span>
                            <span onDoubleClick={() => setDetails((prev) => prev.map((d) => ({ ...d, cantidad_aproximada: d.cantidad })))} title="Doble click: llenar todas con cantidad original" style={{ cursor: 'pointer' }}>Cant. aprox.</span>
                            <span>Comentario</span>
                            <span>Acciones</span>
                          </>
                        ) : isConfirmacion ? (
                          <>
                            <span
                              onDoubleClick={() => !isImportRealizada && setDetails((prev) => prev.map((d) => ({ ...d, precio_confirmado: d.producto?.precio != null ? Math.round(Number(d.producto.precio) * 100) : d.precio_confirmado })))}
                              title={isImportRealizada ? undefined : 'Doble click: llenar todas con precio original'}
                              style={isImportRealizada ? undefined : { cursor: 'pointer' }}
                            >
                              Precio conf.
                            </span>
                            <span>Diferencia</span>
                            <span>Cant. Sug.</span>
                            <span
                              onDoubleClick={() => !isImportRealizada && setDetails((prev) => prev.map((d) => ({ ...d, cantidad_confirmada: d.cantidad })))}
                              title={isImportRealizada ? undefined : 'Doble click: llenar todas con cantidad original'}
                              style={isImportRealizada ? undefined : { cursor: 'pointer' }}
                            >
                              Cant. conf.
                            </span>
                            <span>Comentario</span>
                            <span
                              onDoubleClick={() => !isImportRealizada && handleCycleAllCheckStates()}
                              title={isImportRealizada ? undefined : 'Doble click: alternar todas entre ✓, ✗ y vacío'}
                              style={isImportRealizada ? undefined : { cursor: 'pointer' }}
                            >
                              Acciones
                            </span>
                          </>
                        ) : (
                          <><span>Comentario</span><span>Acciones</span></>
                        )}
                      </div>

                      {(!isVerificarOrConfirmacion || (isVerificar && canEdit)) && <div className="create-user__locations-row create-user__locations-row--form imp-sticky-form" style={{ top: productsHeadHeight }}>
                        <span className="create-salida__product-picker create-salida__product-code-cell">
                          {productPickerDropdown}
                        </span>
                        {(() => {
                          const draftNombre = (
                            <span className="create-salida__product-name-cell">
                              <span className="create-salida__table-static-value create-salida__table-static-value--name">
                                {detailDraft.producto ? String(detailDraft.producto.nombre || '').trim() : '-'}
                              </span>
                            </span>
                          )
                          const draftOem = (
                            <span className="create-salida__table-static-value">
                              {detailDraft.producto ? getProductoOem(detailDraft.producto) || '-' : '-'}
                            </span>
                          )
                          const draftReferencia = (
                            <span className="create-salida__table-static-value">
                              {detailDraft.producto ? String(detailDraft.producto.referencia || '').trim() || '-' : '-'}
                            </span>
                          )
                          const draftPrecio = (
                            <span className="create-salida__table-static-value">
                              {detailDraft.producto?.precio != null ? `$${Number(detailDraft.producto.precio).toFixed(2)}` : '-'}
                            </span>
                          )
                          const draftCantidad = (
                            <span>
                              <input
                                type="number"
                                min="1"
                                step="1"
                                value={detailDraft.cantidad}
                                onChange={(e) => setDetailDraft((prev) => ({ ...prev, cantidad: e.target.value }))}
                                disabled={!detailDraft.producto}
                                placeholder={isVerificar ? 'Cant.' : undefined}
                              />
                            </span>
                          )
                          return (
                            <>
                              {draftNombre}{draftOem}{draftReferencia}{draftPrecio}
                              {isVerificar && <><span className="create-salida__table-static-value">-</span><span className="create-salida__table-static-value">-</span></>}
                              {draftCantidad}
                            </>
                          )
                        })()}
                        {isVerificar && <span className="create-salida__table-static-value">-</span>}
                        <span>
                          <input
                            type="text"
                            value={detailDraft.comentario}
                            onChange={(e) => setDetailDraft((prev) => ({ ...prev, comentario: e.target.value }))}
                            disabled={!detailDraft.producto}
                            placeholder="Opcional"
                            autoComplete="off"
                          />
                        </span>
                        <span className="create-user__locations-cell create-user__locations-cell--action">
                          <button
                            type="button"
                            className="create-user__ghost"
                            disabled={!canAddDetailDraft}
                            onClick={() => { if (!canAddDetailDraft) return; handleAddProduct(detailDraft.producto, detailDraft.cantidad, detailDraft.comentario); setDetailDraft({ producto: null, cantidad: '', comentario: '' }) }}
                          >
                            Agregar
                          </button>
                        </span>
                      </div>}

                      {!details.length ? (
                        <div className="create-user__locations-row create-user__locations-row--empty"><span>Sin productos agregados.</span></div>
                      ) : (productSearch.trim() ? matchesFirst(shownDetails, (item) => importItemMatches(item, productSearch)) : shownDetails).map((item) => {
                        const sinCatalogo = !item.producto?.id
                        const creadoAqui = !sinCatalogo && item.producto?.creado_desde_importacion === imp.id
                        const codigo = item.producto?.codigo || item.codigo || ''
                        const nombre = item.producto?.nombre || item.nombre || ''
                        const oem = String(getProductoOem(item.producto) || item.oem || '').trim() || '-'
                        const oemList = oem !== '-' ? oem.split(',').map((s) => s.trim()).filter(Boolean) : []
                        const referencia = String(item.producto?.referencia || item.referencia || '').trim() || '-'
                        const precioEstimadoValue = item.precio_estimado ? Number(item.precio_estimado) / 100 : null
                        const pvpValue = item.precio_pvp_snapshot ?? item.producto?.precio ?? item.precio ?? precioEstimadoValue
                        const precio = pvpValue != null ? `$${Number(pvpValue).toFixed(2)}` : '-'
                        return (
                          <div key={item._key} data-detail-key={item._key} className={`create-user__locations-row${isVerificar && item.quitado ? ' imp-verificar__row--quitado' : esAgregadoVerificacion(item) ? (sinCatalogo ? ' imp-verificar__row--agregado-nuevo' : ' imp-verificar__row--agregado') : sinCatalogo ? ' importaciones-aceptados__row--no-catalogo' : creadoAqui ? ' importaciones-aceptados__row--nuevo' : ''}${highlightedDetailKey === String(item._key) ? ' imp-row--highlight' : ''}`} title={isVerificar && item.quitado ? 'Quitado de la verificación: no pasa a confirmación' : undefined}>
                            <span
                              className="imp-table-cell-tip"
                              onMouseEnter={(e) => codigo && showCellHover(e, sinCatalogo ? `${codigo} (nuevo: se crea al importar)` : codigo, 'Código')}
                              onMouseLeave={hideCellHover}
                            >
                              {/* Un producto nuevo (sin catálogo) se puede corregir o asignarle
                                  código, como en la sugerencia; si el código se sugirió se ve
                                  de qué producto salió. Los demás muestran su código o la
                                  etiqueta "Sin catálogo". */}
                              {sinCatalogo && !item.quitado && canEdit && (isSugerencia || isVerificar || (isConfirmacion && !isImportRealizada)) ? (
                                <span className="imp-codigo-editable">
                                  <input
                                    type="text"
                                    className={`imp-excel-review__codigo-input${codigoInvalidoDe(item) ? ' imp-excel-review__codigo-input--invalid' : ''}`}
                                    data-title={codigoInvalidoDe(item) ? `No se puede crear: ${codigoInvalidoDe(item)}` : undefined}
                                    value={item.codigo || ''}
                                    onChange={(e) => {
                                      const value = e.target.value.toUpperCase()
                                      setDetails((prev) => prev.map((d) => (d._key === item._key ? { ...d, codigo: value } : d)))
                                    }}
                                    placeholder="Sin catálogo"
                                    aria-label="Código del producto nuevo"
                                  />
                                  {item._sugeridoDesde && (
                                    <span className="imp-codigo-editable__origen">
                                      Sugerido de {item._sugeridoDesde}{item._sugeridoCasa ? ` (${item._sugeridoCasa})` : ''}
                                    </span>
                                  )}
                                </span>
                              ) : sinCatalogo && !codigo
                                ? <span className="importaciones-aceptados__no-catalogo-badge">Sin catálogo</span>
                                : <span className="imp-table-cell-text imp-table-cell-text--full">{codigo}</span>}
                            </span>
                            <span
                              className="imp-table-cell-tip"
                              onMouseEnter={(e) => showCellHover(e, nombre, 'Descripción')}
                              onMouseLeave={hideCellHover}
                            >
                              <span className="imp-table-cell-text">{nombre}</span>
                            </span>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                              <span
                                className="imp-table-cell-tip"
                                style={{ flex: '1 1 auto', minWidth: 0 }}
                                onMouseEnter={(e) => showCellHover(e, oemList, 'OEM')}
                                onMouseLeave={hideCellHover}
                              >
                                <span className="imp-table-cell-text">{oem}</span>
                              </span>
                              <CoincidenciasInfo matches={coincidenciasByKey[item._key]} />
                            </span>
                            <span
                              className="imp-table-cell-tip"
                              onMouseEnter={(e) => showCellHover(e, referencia !== '-' ? referencia : null, 'Referencia')}
                              onMouseLeave={hideCellHover}
                            >
                              <span className="imp-table-cell-text">{referencia}</span>
                            </span>
                            <span
                              className="imp-table-cell-tip"
                              onMouseEnter={(e) => showCellHover(e, precio !== '-' ? precio : null, 'PVP JP')}
                              onMouseLeave={hideCellHover}
                            >
                              <span className="imp-table-cell-text">{precio}</span>
                            </span>
                            {!isVerificarOrConfirmacion && (
                              <span>
                                <input
                                  type="number"
                                  value={item.cantidad}
                                  onChange={(e) => handleQuantityChange(item._key, e.target.value)}
                                  style={invalidQtyKeys.has(item._key) ? { borderColor: '#ef4444' } : undefined}
                                />
                              </span>
                            )}
                            {isVerificarOrConfirmacion ? (
                              <>
                                {(() => {
                                  const priceField = isVerificar ? 'precio_estimado' : 'precio_confirmado'
                                  const qtyField = isVerificar ? 'cantidad_aproximada' : 'cantidad_confirmada'
                                  const confirmedCentavos = item[priceField] ? parseInt(String(item[priceField]).replace(/\D/g, '') || '0', 10) : null
                                  const pvpForDiff = item.precio_pvp_snapshot ?? item.producto?.precio
                                  const storedCentavos = pvpForDiff != null ? Math.round(Number(pvpForDiff) * 100) : null
                                  const diff = storedCentavos != null && confirmedCentavos != null ? confirmedCentavos - storedCentavos : null
                                  const diffColor = diff === null ? undefined : diff <= 0 ? '#22c55e' : diff <= 100 ? '#eab308' : '#ef4444'
                                  // Eliminado en la verificacion: ya no se pide, asi que no lleva
                                  // PVP Aprox. ni Cant. aprox.
                                  const eliminado = isVerificar && item.quitado
                                  return (
                                    <>
                                      {eliminado ? <span className="imp-table-cell-text" style={{ textAlign: 'center' }}>-</span> : (
                                      <span className="importaciones-verificar__precio-cell">
                                        <span className="importaciones-verificar__currency-sign">$</span>
                                        <PrecioCentavosInput
                                          disabled={isImportRealizada}
                                          invalid={faltanConfirmar.has(item._key) && !(parseInt(String(item[priceField] || '').replace(/\D/g, '') || '0', 10) > 0)}
                                          value={item[priceField]}
                                          onChange={(cents) => handleConfirmedChange(item._key, priceField, cents)}
                                          title={isImportRealizada ? undefined : 'Doble click: usar precio original'}
                                          onDoubleClick={() => {
                                            if (isImportRealizada) return
                                            if (item.producto?.precio != null)
                                              handleConfirmedChange(item._key, priceField, Math.round(Number(item.producto.precio) * 100))
                                          }}
                                        />
                                      </span>
                                      )}
                                      {(() => {
                                        const diffText = !eliminado && diff !== null ? `${diff >= 0 ? '+' : '-'}$${(Math.abs(diff) / 100).toFixed(2)}` : ''
                                        return (
                                          <span
                                            className="imp-table-cell-tip"
                                            onMouseEnter={(e) => diffText && showCellHover(e, diffText, 'Diferencia')}
                                            onMouseLeave={hideCellHover}
                                          >
                                            <span className="imp-table-cell-text" style={{ color: diffColor }}>{diffText}</span>
                                          </span>
                                        )
                                      })()}
                                      <span
                                        className="imp-table-cell-tip"
                                        onMouseEnter={(e) => showCellHover(e, String(item.cantidad ?? ''), 'Cant. Sug.')}
                                        onMouseLeave={hideCellHover}
                                      >
                                        <span className="imp-table-cell-text" style={{ textAlign: 'center', fontWeight: 600 }}>{item.cantidad}</span>
                                      </span>
                                      {eliminado ? <span className="imp-table-cell-text" style={{ textAlign: 'center' }}>-</span> : (
                                      <span>
                                        <input
                                          type="number"
                                          min="0"
                                          step="1"
                                          disabled={isImportRealizada}
                                          value={item[qtyField] ?? ''}
                                          style={faltanConfirmar.has(item._key) && !(Number(item[qtyField]) > 0) ? { borderColor: '#ef4444' } : undefined}
                                          onChange={(e) => handleConfirmedChange(item._key, qtyField, e.target.value)}
                                          onDoubleClick={() => !isImportRealizada && handleConfirmedChange(item._key, qtyField, item.cantidad)}
                                          title={isImportRealizada ? undefined : 'Doble click: usar cantidad original'}
                                        />
                                      </span>
                                      )}
                                      <span>
                                        <input
                                          type="text"
                                          disabled={isImportRealizada}
                                          value={item.comentario || ''}
                                          onChange={(e) => handleComentarioChange(item._key, e.target.value)}
                                          placeholder="Comentario"
                                          autoComplete="off"
                                        />
                                      </span>
                                      {isVerificar && (
                                        <span className="create-user__locations-cell create-user__locations-cell--action">
                                          <button
                                            type="button"
                                            className={`create-user__locations-remove${item.quitado ? ' imp-verificar__restore' : ''}`}
                                            onClick={() => handleToggleQuitado(item._key)}
                                            disabled={!canEdit}
                                            title={item.quitado ? 'Restaurar: vuelve a la verificación' : 'Quitar de la verificación (queda en rojo, se puede restaurar)'}
                                            aria-label={item.quitado ? 'Restaurar' : 'Quitar'}
                                          >
                                            {item.quitado ? <i className="pi pi-undo" aria-hidden="true" /> : 'x'}
                                          </button>
                                        </span>
                                      )}
                                      {isConfirmacion && (
                                        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                          <button
                                            type="button"
                                            className={`imp-tri-check imp-tri-check--${itemCheckStates[item._key] || 'none'}`}
                                            onClick={() => !isImportRealizada && handleCycleCheckState(item._key)}
                                            disabled={isImportRealizada}
                                          >
                                            {itemCheckStates[item._key] === 'check' && <Check size={13} />}
                                            {itemCheckStates[item._key] === 'x' && <X size={13} />}
                                          </button>
                                        </span>
                                      )}
                                    </>
                                  )
                                })()}
                              </>
                            ) : (
                              <>
                                <span>
                                  <input
                                    type="text"
                                    value={item.comentario || ''}
                                    onChange={(e) => handleComentarioChange(item._key, e.target.value)}
                                    placeholder="Comentario"
                                    autoComplete="off"
                                  />
                                </span>
                                <span className="create-user__locations-cell create-user__locations-cell--action">
                                  <button
                                    type="button"
                                    className="create-user__locations-remove"
                                    onClick={() => setDetails((prev) => prev.filter((d) => d._key !== item._key))}
                                  >
                                    x
                                  </button>
                                </span>
                              </>
                            )}
                          </div>
                        )
                      })}
                    </div>
                    )}
                  </section>
                )}
              </div>
            </div>

            <div className="create-user__footer">
              <div className="user-details__footer-left">
                <button type="button" className="create-user__action create-user__action--cancel" onClick={onClose} disabled={submitting || importarSubmitting || deleteSubmitting}>
                  Cancelar
                </button>
                {(imp?.estado === 'borrador' || imp?.estado === 'cotizacion' || imp?.estado === 'confirmacion') && canDelete && (
                  <button
                    type="button"
                    className="create-user__action user-details__delete"
                    disabled={submitting || importarSubmitting || deleteSubmitting}
                    onClick={() => setShowDeleteModal(true)}
                  >
                    Eliminar
                  </button>
                )}
                {Array.isArray(imp?.historial_verificacion) && imp.historial_verificacion.length > 0 && (
                  <button
                    type="button"
                    className="create-user__action create-user__action--cancel"
                    onClick={() => setShowHistorialVerificacion(true)}
                  >
                    Verificación
                  </button>
                )}
                {showHistorialVerificacion && (
                  <HistorialVerificacionModal imp={imp} onClose={() => setShowHistorialVerificacion(false)} />
                )}
              </div>
              <div className="user-details__footer-right">
                {isSugerencia && details.length > 0 && (
                  <button type="button" className="create-user__action create-user__action--cancel" onClick={handleDownloadSugerenciaExcel}>
                    <i className="pi pi-download" style={{ marginRight: 6 }} />
                    Descargar Excel
                  </button>
                )}
                {(isSugerencia || isVerificarOrConfirmacion) && (
                  <div className="imp-verificar-excel-dropdown" ref={verificarExcelDropdownRef}>
                    <button
                      type="button"
                      className="users-circle users-circle--excel"
                      title="Excel"
                      onClick={() => setShowVerificarExcelDropdown((p) => !p)}
                    >
                      <i className="pi pi-file-excel" />
                    </button>
                    {showVerificarExcelDropdown && (
                      <div className="imp-verificar-excel-menu">
                        <button type="button" onClick={() => { (isSugerencia ? handleDownloadSugerenciaExcel : handleDownloadVerificarExcel)(); setShowVerificarExcelDropdown(false) }}>
                          <i className="pi pi-download" /> Descargar Excel
                        </button>
                        {isVerificar && (
                          <button type="button" onClick={() => { handleDownloadPlantillaPrecios(); setShowVerificarExcelDropdown(false) }}>
                            <i className="pi pi-file" /> Descargar plantilla
                          </button>
                        )}
                        {!isImportRealizada && (!isSugerencia || canEdit) && (
                          <button type="button" onClick={() => { verificarFileInputRef.current?.click(); setShowVerificarExcelDropdown(false) }}>
                            <i className="pi pi-upload" /> Subir Excel
                          </button>
                        )}
                      </div>
                    )}
                    <input
                      ref={verificarFileInputRef}
                      type="file"
                      accept=".xlsx"
                      style={{ display: 'none' }}
                      onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) withExcelLoading(setUploadingExcel, () => handleUploadVerificarExcel(file)) }}
                    />
                  </div>
                )}
                {canImportar && imp?.estado === 'borrador' && (
                  <button
                    type="button"
                    className="create-user__action imp-cotizacion-btn"
                    disabled={submitting || importarSubmitting || deleteSubmitting}
                    onClick={handlePedirCotizacion}
                  >
                    {importarSubmitting ? 'Enviando...' : 'Pedir cotización'}
                  </button>
                )}
                {canEdit && imp?.estado === 'cotizacion' && (
                  <button type="submit" className="create-user__action create-user__action--primary" disabled={submitting || importarSubmitting || deleteSubmitting}>
                    {submitting ? 'Guardando...' : 'Guardar'}
                  </button>
                )}
                {canImportar && imp?.estado === 'cotizacion' && (
                  <button
                    type="button"
                    className="create-user__action imp-confirmar-btn"
                    disabled={submitting || importarSubmitting || deleteSubmitting}
                    onClick={handleConfirmar}
                  >
                    {importarSubmitting ? 'Confirmando...' : 'Pedir confirmación'}
                  </button>
                )}
                {canEdit && imp?.estado === 'confirmacion' && !isImportRealizada && (
                  <button type="submit" className="create-user__action create-user__action--primary" disabled={submitting || importarSubmitting || deleteSubmitting}>
                    {submitting ? 'Guardando...' : 'Guardar'}
                  </button>
                )}
                {imp?.estado === 'confirmacion' && imp?.numero_factura && (
                  imp?.en_camino_id ? (
                    <button
                      type="button"
                      className="imp-realizada-badge imp-realizada-badge--clickable"
                      onClick={() => onOpenEnCamino?.(imp.en_camino_id)}
                    >
                      <Check size={14} /> En camino
                    </button>
                  ) : (
                    <span className="imp-realizada-badge">
                      <Check size={14} /> En camino
                    </span>
                  )
                )}
                {canImportar && imp?.estado === 'confirmacion' && !imp?.numero_factura && (
                  <button
                    type="button"
                    className="create-user__action imp-importar-btn"
                    disabled={submitting || importarSubmitting || deleteSubmitting}
                    onClick={() => {
                      const unreviewed = details.filter((item) => !itemCheckStates[item._key])
                      if (unreviewed.length > 0) {
                        toastRef.current?.show({ severity: 'warn', summary: 'Revisión incompleta', detail: `Debes marcar todos los productos con ✓ o ✗ antes de importar (${unreviewed.length} sin revisar).`, life: 5000 })
                        return
                      }
                      if (!Object.values(itemCheckStates).some((s) => s === 'check')) {
                        toastRef.current?.show({ severity: 'warn', summary: 'Sin selección', detail: 'Selecciona al menos un producto con ✓ para importar.', life: 4000 })
                        return
                      }
                      const checkMissingData = details.filter((item) => {
                        if (itemCheckStates[item._key] !== 'check') return false
                        const precio = parseInt(String(item.precio_confirmado || '').replace(/\D/g, '') || '0', 10)
                        return precio <= 0
                      })
                      if (checkMissingData.length > 0) {
                        toastRef.current?.show({ severity: 'error', summary: 'Datos incompletos', detail: `Los productos marcados con ✓ deben tener precio confirmado (${checkMissingData.length} incompletos).`, life: 5000 })
                        return
                      }
                      setFacturaInput('')
                      setFechaImportar(new Date().toISOString().slice(0, 10))
                      setShowImportarModal(true)
                    }}
                  >
                    Importar
                  </button>
                )}
                {canEdit && imp?.estado === 'borrador' && (
                  <button type="submit" className="create-user__action create-user__action--primary" disabled={submitting || importarSubmitting || deleteSubmitting}>
                    {submitting ? 'Guardando...' : 'Guardar cambios'}
                  </button>
                )}
              </div>
            </div>
          </form>
          <button
            type="button"
            aria-label="Cambiar tamaño de ventana"
            className="create-user__resize-handle"
            onMouseDown={handleResizeMouseDown}
          />
        </div>

        {showImportarModal && createPortal(
          <div className="imp-importar-modal__overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !importarSubmitting) setShowImportarModal(false) }}>
            <div className="imp-importar-modal__dialog">
              <header className="imp-importar-modal__header">
                <i className="pi pi-send" />
                <h3>Estás por generar una importación</h3>
              </header>
              <div className="imp-importar-modal__body">
                <div className="imp-importar-modal__info">
                  <div className="imp-importar-modal__info-row">
                    <span>Casa comercial</span>
                    <strong>{imp.casa_comercial?.nombre || '-'}</strong>
                  </div>
                  <div className="imp-importar-modal__info-row">
                    <span>Tiempo estimado de entrega</span>
                    <strong>
                      {imp.casa_comercial?.dias_entrega
                        ? `${imp.casa_comercial.dias_entrega} día${imp.casa_comercial.dias_entrega === 1 ? '' : 's'}`
                        : 'No especificado'}
                    </strong>
                  </div>
                </div>
                <div className="imp-importar-modal__field">
                  <label htmlFor="imp-factura-input">Número de factura</label>
                  <input
                    id="imp-factura-input"
                    type="text"
                    className="imp-importar-modal__input"
                    placeholder="Ej: FAC-2024-001"
                    value={facturaInput}
                    onChange={(e) => setFacturaInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && facturaInput.trim()) handleImportar() }}
                    autoFocus
                    disabled={importarSubmitting}
                  />
                </div>
                <div className="imp-importar-modal__field">
                  <label htmlFor="imp-fecha-input" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    Fecha de salida
                    <Info
                      size={13}
                      className="imp-distribucion__info-icon"
                      onMouseEnter={showFechaSalidaInfo}
                      onMouseLeave={hideFechaSalidaInfo}
                    />
                  </label>
                  <input
                    id="imp-fecha-input"
                    type="date"
                    className="imp-importar-modal__input"
                    value={fechaImportar}
                    onChange={(e) => setFechaImportar(e.target.value)}
                    disabled={importarSubmitting}
                  />
                </div>
              </div>
              <div className="imp-importar-modal__footer">
                <button
                  type="button"
                  className="create-user__action create-user__action--cancel"
                  onClick={() => setShowImportarModal(false)}
                  disabled={importarSubmitting}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="create-user__action imp-importar-btn"
                  onClick={handleImportar}
                  disabled={!facturaInput.trim() || !fechaImportar || importarSubmitting}
                >
                  {importarSubmitting ? 'Importando...' : 'Importar'}
                </button>
              </div>
            </div>
          </div>,
          getPortalRoot()
        )}

        {showDeleteModal && createPortal(
          <div className="user-details__confirm-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !deleteSubmitting) setShowDeleteModal(false) }}>
            <div className="user-details__confirm-dialog">
              <div className="user-details__confirm-icon">
                <Info size={18} />
              </div>
              <div className="user-details__confirm-content">
                <h4>Eliminar {imp?.estado === 'cotizacion' ? 'cotización' : imp?.estado === 'confirmacion' ? 'confirmación' : 'sugerencia'}</h4>
                <p>¿Estás seguro que quieres eliminar {imp?.estado === 'cotizacion' ? 'la cotización' : imp?.estado === 'confirmacion' ? 'la confirmación' : 'la sugerencia'} <strong>{imp?.codigo}</strong>? Esta acción no se puede deshacer.</p>
              </div>
              <div className="user-details__confirm-actions">
                <button
                  type="button"
                  className="create-user__action create-user__action--cancel"
                  onClick={() => setShowDeleteModal(false)}
                  disabled={deleteSubmitting}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="create-user__action user-details__confirm-danger"
                  onClick={handleDeleteBorrador}
                  disabled={deleteSubmitting}
                >
                  {deleteSubmitting ? 'Eliminando...' : 'Eliminar'}
                </button>
              </div>
            </div>
          </div>,
          getPortalRoot()
        )}

        <UnsavedChangesDialog
          open={showSaveOnCloseModal}
          saving={submitting}
          onCancel={() => setShowSaveOnCloseModal(false)}
          onDiscard={() => { setShowSaveOnCloseModal(false); onClose?.() }}
          onSave={handleSaveAndClose}
        />

        {showNuevoProductoView && (
          <SugerenciaNuevoProductoPopup
            onClose={() => setShowNuevoProductoView(false)}
            onAdd={handleAddNuevoVerificacion}
            notify={(severity, summary, detail) => toastRef.current?.show({ severity, summary, detail, life: 4500 })}
          />
        )}

        {cellHover && createPortal(
          <div
            className="imp-cell-hover-card"
            style={{ top: cellHover.top, left: cellHover.left }}
          >
            <div className="imp-cell-hover-card__title">{cellHover.label}</div>
            {cellHover.items.map((value, i) => (
              <div key={i} className="imp-cell-hover-card__row">{value}</div>
            ))}
          </div>,
          getPortalRoot()
        )}

        {fechaSalidaInfoPos && createPortal(
          <div
            className="movimientos-table__product-hover-card"
            role="tooltip"
            style={{ top: fechaSalidaInfoPos.top, left: fechaSalidaInfoPos.left, width: 'auto', maxWidth: 280, zIndex: 20000 }}
          >
            <p className="imp-fecha-salida-hover-text">Fecha en que el proveedor marcó la salida.</p>
          </div>,
          getPortalRoot()
        )}

        {showAceptadosView && (
          <SugerenciaAceptadosPopup
            token={token}
            casa={selectedCasa}
            alreadyAddedIds={vigentesIds}
            alreadyAddedSolIds={vigentesSolIds}
            onConfirm={handleAceptadosVerificacion}
            onClose={() => setShowAceptadosView(false)}
          />
        )}
      </div>
    </>
  )
}

function ImportacionesTable({ token, moduleActions, status: statusProp, isTabActive, pendingOpenBorradorData, onPendingOpenBorradorHandled, pendingOpenDetailsId, pendingOpenDetailsStatus, onPendingOpenDetailsHandled }) {
  const toast = useRef(null)
  const tableWrapperRef = useRef(null)

  // Ajusta automaticamente el ancho de las columnas para llenar el espacio
  // disponible en pantallas grandes, sin comprimir en pantallas chicas.
  useEffect(() => attachAutoExpandColumns(tableWrapperRef.current), [])
  const widthHandlers = useMemo(() => makeWidthStateHandlers('importaciones-table-state-v2'), [])

  const [activeStatus, setActiveStatus] = useState('borrador')
  const status = statusProp || activeStatus
  const [isStatusStale, setIsStatusStale] = useState(false)

  const importacionesBaseFields = useMemo(() => {
    const fields = ['codigo', 'fecha']
    if (status === 'importada') fields.push('creado_en', 'fecha_llegada')
    fields.push('casa_nombre', 'estado', 'dias_entrega_estimados', 'productos_resumen')
    return fields
  }, [status])

  const [columnOrder, setColumnOrder] = useState(importacionesBaseFields)

  useEffect(() => {
    const stored = tableLayoutStore.getItem('importaciones-table-columns')
    let nextOrder = importacionesBaseFields
    if (stored) {
      try {
        const parsed = JSON.parse(stored)
        if (Array.isArray(parsed) && parsed.length) {
          const validFields = new Set(importacionesBaseFields)
          const filtered = parsed.filter((field) => validFields.has(field))
          const missing = importacionesBaseFields.filter((field) => !filtered.includes(field))
          nextOrder = [...filtered, ...missing]
        }
      } catch {
        tableLayoutStore.removeItem('importaciones-table-columns')
      }
    }
    setColumnOrder(nextOrder)
  }, [importacionesBaseFields])

  const handleColumnReorder = useCallback((e) => {
    const order = (Array.isArray(e?.columns) ? e.columns : [])
      .map((col) => col.props.field)
      .filter(Boolean)
    if (!order.length) return
    setColumnOrder(order)
    tableLayoutStore.setItemNow('importaciones-table-columns', JSON.stringify(order))
  }, [])
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [showExcelImport, setShowExcelImport] = useState(false)
  const [showCreateMenu, setShowCreateMenu] = useState(false)
  const createMenuRef = useRef(null)
  const [showSearchImportaciones, setShowSearchImportaciones] = useState(false)
  const [importSearchQuery, setImportSearchQuery] = useState('')
  const [importSearchResults, setImportSearchResults] = useState([])
  const [importSearchLoading, setImportSearchLoading] = useState(false)
  const searchImportacionesRef = useRef(null)
  const importSearchTimerRef = useRef(null)
  const importSearchSeqRef = useRef(0)
  const [selectedImp, setSelectedImp] = useState(null)
  const [showImpDetails, setShowImpDetails] = useState(false)
  const [editImp, setEditImp] = useState(null)
  const [showEditImp, setShowEditImp] = useState(false)
  const [selectedRows, setSelectedRows] = useState([])
  const [processedRows, setProcessedRows] = useState(null)
  const clickTimerRef = useRef(null)
  const pendingClickRowRef = useRef(null)
  const pendingClickCountRef = useRef(0)
  const statusModalSnapshotsRef = useRef({})

  useEffect(() => {
    if (!pendingOpenBorradorData) return
    setEditImp(pendingOpenBorradorData)
    setShowEditImp(true)
    onPendingOpenBorradorHandled?.()
  }, [pendingOpenBorradorData]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!showCreateMenu) return
    const handler = (e) => { if (!createMenuRef.current?.contains(e.target)) setShowCreateMenu(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showCreateMenu])

  useEffect(() => {
    if (!pendingOpenDetailsId || !token) return
    if (pendingOpenDetailsStatus && !statusProp) setActiveStatus(pendingOpenDetailsStatus)
    authFetch(`${API_URL}/importaciones/importaciones/${pendingOpenDetailsId}/`, {}, token)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((data) => { setSelectedImp(data); setShowImpDetails(true); onPendingOpenDetailsHandled?.() })
      .catch(() => { onPendingOpenDetailsHandled?.() })
  }, [pendingOpenDetailsId]) // eslint-disable-line react-hooks/exhaustive-deps

  const [productHoverCard, setProductHoverCard] = useState(null)
  const productHoverHideTimerRef = useRef(null)
  const productHoverCardRef = useRef(null)
  const [globalFilterValue, setGlobalFilterValue] = useState('')
  const [isGlobalSearchPending, setIsGlobalSearchPending] = useState(false)
  const globalSearchDebounceRef = useRef(null)
  const [filters, setFilters] = useState({
    global: { value: null, matchMode: FilterMatchMode.CONTAINS },
  })
  const [pageFirst, setPageFirst] = useState(0)
  const pageSize = 25

  const statusConfig = STATUS_CONFIG[status] || STATUS_CONFIG.en_proceso
  const canCreate = moduleActions?.puede_crear !== false

  const selectedRowIds = useMemo(
    () => (selectedRows || []).map((row) => normId(row?.id)).filter(Boolean),
    [selectedRows]
  )

  const selectionColStyle = useMemo(
    () => ({ width: '40px', minWidth: '40px', maxWidth: '40px', textAlign: 'center' }),
    []
  )

  const normalizeList = useCallback((list) =>
    list.map((item) => {
      const detalles = item?.detalles || []
      const productos = detalles.map((d) => ({
        codigo: d.producto?.codigo || d.codigo || '-',
        nombre: d.producto?.nombre || d.nombre || '-',
        oem: getProductoOem(d.producto) || d.oem || '-',
        referencias: getReferenciasTexto(d.producto, d),
        cantidad: d.cantidad ?? 0,
        sinCatalogo: !d.producto?.id,
      }))
      const isEnCaminoConfirmada = item?.estado === 'confirmacion' && item?.numero_factura
      const estado_label = isEnCaminoConfirmada
        ? 'En camino'
        : (STATUS_BADGE[item?.estado]?.label || item?.estado || '-')
      return {
        ...item,
        casa_nombre: item?.casa_comercial?.nombre ?? '-',
        productos_resumen: productos.map((p) => `${p.codigo} ${p.nombre} ${p.oem} ${p.referencias}`).join(' | '),
        productos,
        estado_label,
      }
    })
  , [])

  // Evita que la respuesta de un fetch anterior (de otra pestaña de estado) sobreescriba
  // `items` si el usuario ya cambió de pestaña antes de que esa petición terminara.
  const latestStatusRef = useRef(status)
  useEffect(() => { latestStatusRef.current = status }, [status])

  // silent: recarga automatica en segundo plano -- sin spinner y sin avisar
  // si falla (la siguiente vuelta lo intenta de nuevo).
  const fetchItems = useCallback(async (force = false, { silent = false } = {}) => {
    if (!token) return
    const requestedStatus = status
    const cached = importacionesItemsCache[requestedStatus]
    if (!force && cached) {
      if (latestStatusRef.current === requestedStatus) setItems(cached.items)
      return
    }
    if (latestStatusRef.current === requestedStatus && !silent) {
      setLoading(true)
      setError('')
    }
    const params = new URLSearchParams()
    params.set('estado', requestedStatus)
    params.set('page_size', '200')
    try {
      const response = await authFetch(`${API_URL}/importaciones/importaciones/?${params.toString()}`, {}, token)
      if (!response.ok) throw new Error(await readErrorMessage(response, 'No se pudieron cargar las importaciones.'))
      const payload = await response.json()
      const normalized = normalizeList(parseApiList(payload))
      if (requestedStatus === 'confirmacion') {
        normalized.sort((a, b) => (a.numero_factura ? 1 : 0) - (b.numero_factura ? 1 : 0))
      }
      importacionesItemsCache[requestedStatus] = { items: normalized, fetchedAt: Date.now() }
      if (latestStatusRef.current === requestedStatus) setItems(normalized)
    } catch (err) {
      const message = err.message || 'No se pudieron cargar las importaciones.'
      if (latestStatusRef.current === requestedStatus && !silent) {
        setError(message)
        toast.current?.show({ severity: 'error', summary: 'Error', detail: message, life: 4000 })
      }
    } finally {
      if (latestStatusRef.current === requestedStatus && !silent) setLoading(false)
    }
  }, [normalizeList, status, token])

  useEffect(() => { fetchItems() }, [fetchItems])

  // Recarga automatica, como en Movimientos: mientras la pestaña está activa
  // y la ventana visible se recarga cada IMPORTACIONES_AUTO_REFRESH_MS; al
  // volver a la ventana/pestaña o cambiar de estado, si los datos ya tienen
  // ese tiempo; y cuando llega un aviso de traslados.
  useEffect(() => {
    if (!token || isTabActive === false) return undefined
    let inFlight = false
    const silentRefresh = () => {
      if (inFlight) return
      inFlight = true
      fetchItems(true, { silent: true }).finally(() => { inFlight = false })
    }
    const refreshIfOld = () => {
      if (document.visibilityState === 'hidden') return
      // Sin cache todavia: la primera carga ya esta en curso.
      const cached = importacionesItemsCache[status]
      if (!cached || Date.now() - cached.fetchedAt < IMPORTACIONES_AUTO_REFRESH_MS) return
      silentRefresh()
    }
    const refreshNow = silentRefresh
    refreshIfOld()
    // Se revisa seguido para recargar apenas los datos cumplen el tiempo.
    const interval = setInterval(refreshIfOld, 5000)
    window.addEventListener('focus', refreshIfOld)
    document.addEventListener('visibilitychange', refreshIfOld)
    window.addEventListener(REMINDERS_TRANSFER_NOTIFICATION_EVENT, refreshNow)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', refreshIfOld)
      document.removeEventListener('visibilitychange', refreshIfOld)
      window.removeEventListener(REMINDERS_TRANSFER_NOTIFICATION_EVENT, refreshNow)
    }
  }, [fetchItems, isTabActive, status, token])

  // Flags the refresh button when this pill's cached data is more than 5 minutes old,
  // so it's obvious at a glance that what's on screen may no longer be current.
  useEffect(() => {
    const checkStale = () => {
      const cached = importacionesItemsCache[status]
      setIsStatusStale(!cached || (Date.now() - cached.fetchedAt) > IMPORTACIONES_STALE_MS)
    }
    checkStale()
    const interval = setInterval(checkStale, 15000)
    return () => clearInterval(interval)
  }, [status, items])

  useEffect(() => {
    setPageFirst(0)
    setGlobalFilterValue('')
    setFilters({ global: { value: null, matchMode: FilterMatchMode.CONTAINS } })
    setSelectedRows([])
  }, [status])

  useEffect(() => {
    return () => {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
      pendingClickCountRef.current = 0
      pendingClickRowRef.current = null
    }
  }, [])

  const handleGlobalFilterChange = (event) => {
    const value = event.target.value
    setGlobalFilterValue(value)
    setPageFirst(0)
    if (globalSearchDebounceRef.current) clearTimeout(globalSearchDebounceRef.current)
    setIsGlobalSearchPending(true)
    globalSearchDebounceRef.current = setTimeout(() => {
      setFilters({ global: { value: value || null, matchMode: FilterMatchMode.CONTAINS } })
      setIsGlobalSearchPending(false)
    }, 350)
  }

  const handleStatusChange = (nextStatus) => {
    if (nextStatus === status) return

    // Remember whatever modal was open on this pill so it reopens exactly
    // as left when the user comes back to it (like the top-level workspace tabs).
    statusModalSnapshotsRef.current[status] = {
      showCreate, showExcelImport,
      editImp, showEditImp,
      selectedImp, showImpDetails,
    }

    const snapshot = statusModalSnapshotsRef.current[nextStatus] || {}
    setActiveStatus(nextStatus)
    setShowCreate(snapshot.showCreate || false)
    setShowExcelImport(snapshot.showExcelImport || false)
    setEditImp(snapshot.editImp || null)
    setShowEditImp(snapshot.showEditImp || false)
    setSelectedImp(snapshot.selectedImp || null)
    setShowImpDetails(snapshot.showImpDetails || false)
  }

  const clearProductHoverTimer = useCallback(() => {
    if (!productHoverHideTimerRef.current) return
    clearTimeout(productHoverHideTimerRef.current)
    productHoverHideTimerRef.current = null
  }, [])

  const hideProductHoverCard = useCallback(() => {
    clearProductHoverTimer()
    setProductHoverCard(null)
  }, [clearProductHoverTimer])

  useCloseDropdownsOnTabSwitch(
    useCallback(() => {
      setShowCreateMenu(false)
      hideProductHoverCard()
    }, [hideProductHoverCard])
  )

  const scheduleHideProductHoverCard = useCallback(() => {
    clearProductHoverTimer()
    productHoverHideTimerRef.current = setTimeout(() => {
      productHoverHideTimerRef.current = null
      setProductHoverCard(null)
    }, 120)
  }, [clearProductHoverTimer])

  const showProductHoverCard = useCallback((event, productos) => {
    const list = Array.isArray(productos) ? productos : []
    if (!list.length) { hideProductHoverCard(); return }
    clearProductHoverTimer()
    const rect = event?.currentTarget?.getBoundingClientRect?.()
    if (!rect) return
    let left = rect.right + 10
    if (left + IMP_HOVER_WIDTH > window.innerWidth - IMP_HOVER_MARGIN) {
      left = Math.max(IMP_HOVER_MARGIN, rect.left - IMP_HOVER_WIDTH - 10)
    }
    // Estima el alto real del card según su contenido (título + encabezado +
    // filas) en vez de asumir siempre el máximo — así una lista corta se
    // sigue posicionando pegada al ojo, y solo listas largas (que superan
    // min(70vh, 520px), el max-height real del CSS) se recorren hacia arriba
    // lo justo para no quedar cortadas por el borde inferior.
    const estimatedCardHeight = 32 + 24 + list.length * 27 + 12
    const cardHeight = Math.min(estimatedCardHeight, IMP_HOVER_MAX_HEIGHT, window.innerHeight * 0.7)
    const top = Math.min(
      Math.max(rect.top - 8, IMP_HOVER_MARGIN),
      Math.max(window.innerHeight - cardHeight - IMP_HOVER_MARGIN, IMP_HOVER_MARGIN)
    )
    setProductHoverCard({ left, top, productos: list })
  }, [clearProductHoverTimer, hideProductHoverCard])

  useEffect(() => () => clearProductHoverTimer(), [clearProductHoverTimer])
  useEffect(() => {
    const handler = (event) => {
      // Ignora el scroll que ocurre dentro del propio card (para poder
      // recorrer la lista de productos con la rueda del mouse); solo lo
      // oculta cuando el scroll viene de la tabla/página de atrás.
      if (productHoverCardRef.current && event.target && productHoverCardRef.current.contains(event.target)) {
        return
      }
      hideProductHoverCard()
    }
    window.addEventListener('scroll', handler, true)
    return () => window.removeEventListener('scroll', handler, true)
  }, [hideProductHoverCard])

  const importacionProductBodyTemplate = useCallback((rowData) => {
    const productos = Array.isArray(rowData?.productos) ? rowData.productos : []
    if (!productos.length) return <span style={{ color: '#9ca3af' }}>-</span>
    const visible = productos.slice(0, 3)
    const hasMore = productos.length > 3
    const codesText = visible.map((p) => p.oem || p.codigo).join(', ') + (hasMore ? '...' : '')
    return (
      <div className="movimientos-table__product-cell">
        <div className="movimientos-table__product-lines">
          <span className="movimientos-table__product-main" title={codesText}>{codesText}</span>
        </div>
        <button
          type="button"
          className="movimientos-table__product-eye"
          aria-label="Ver productos"
          onClick={(e) => { e.preventDefault(); e.stopPropagation() }}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseEnter={(e) => showProductHoverCard(e, productos)}
          onMouseLeave={scheduleHideProductHoverCard}
          onFocus={(e) => showProductHoverCard(e, productos)}
          onBlur={scheduleHideProductHoverCard}
        >
          <i className="pi pi-eye" />
        </button>
      </div>
    )
  }, [showProductHoverCard, scheduleHideProductHoverCard])

  const handleOpenEnCamino = useCallback(async (enCaminoId) => {
    if (!enCaminoId || !token) return
    setShowEditImp(false)
    setShowImpDetails(false)
    try {
      const response = await authFetch(`${API_URL}/importaciones/importaciones/${enCaminoId}/`, {}, token)
      if (!response.ok) throw new Error('No se pudo abrir la importación en camino.')
      const data = await response.json()
      setActiveStatus('en_camino')
      setSelectedImp(data)
      setShowImpDetails(true)
    } catch (err) {
      toast.current?.show({ severity: 'error', summary: 'Error', detail: err.message || 'No se pudo abrir la importación en camino.', life: 4000 })
    }
  }, [token])

  const estadoBodyTemplate = useCallback((rowData) => {
    const isEnCaminoConfirmada = rowData?.estado === 'confirmacion' && rowData?.numero_factura
    const badge = isEnCaminoConfirmada
      ? { label: 'En camino', color: '#d97706', bg: 'rgba(217,119,6,0.15)', border: 'none' }
      : { ...(STATUS_BADGE[rowData?.estado] || { label: rowData?.estado || '-', color: '#64748b', bg: 'rgba(100,116,139,0.1)' }), border: 'none' }
    const clickable = isEnCaminoConfirmada && Boolean(rowData?.en_camino_id)
    const Tag = clickable ? 'button' : 'span'
    return (
      <Tag
        type={clickable ? 'button' : undefined}
        onMouseDown={clickable ? (e) => e.stopPropagation() : undefined}
        onClick={clickable ? (e) => { e.stopPropagation(); handleOpenEnCamino(rowData.en_camino_id) } : undefined}
        title={clickable ? 'Ver importación en camino' : undefined}
        style={{
          fontWeight: 600, padding: '2px 9px', borderRadius: 999, background: badge.bg, color: badge.color,
          border: badge.border, whiteSpace: 'nowrap', cursor: clickable ? 'pointer' : 'default',
        }}
      >
        {badge.label}
      </Tag>
    )
  }, [handleOpenEnCamino])

  const exportColumns = [
    { key: 'codigo', header: 'Importación' },
    { key: 'fecha', header: 'Fecha' },
    { key: 'casa_nombre', header: 'Casa comercial' },
    { key: 'estado_label', header: 'Estado' },
    { key: 'dias_entrega_estimados', header: 'Días estimados' },
    { key: 'prod_codigo', header: 'Código' },
    { key: 'prod_nombre', header: 'Descripción' },
    { key: 'prod_oem', header: 'OEM' },
    { key: 'prod_cantidad', header: 'Cantidad' },
  ]

  const buildExportRows = useCallback((rows) => {
    const result = []
    for (const row of rows) {
      const productos = row.productos || []
      const base = { ...row, estado_label: STATUS_BADGE[row.estado]?.label || row.estado || '' }
      if (!productos.length) {
        result.push(base)
      } else {
        for (const p of productos) {
          result.push({ ...base, prod_codigo: p.codigo, prod_nombre: p.nombre, prod_oem: p.oem, prod_cantidad: p.cantidad })
        }
      }
    }
    return result
  }, [])

  const getExportValue = useCallback((row, key) => row?.[key] ?? '', [])

  const getRowsToExport = useCallback(() => {
    if (selectedRows?.length) return selectedRows
    return processedRows === null ? items : (processedRows ?? items)
  }, [items, processedRows, selectedRows])

  const handleExportExcel = useCallback(async () => {
    const rows = buildExportRows(getRowsToExport())
    await exportToExcel({ rows, columns: exportColumns, valueGetter: getExportValue, fileName: buildFileName('importaciones') })
  }, [buildExportRows, getExportValue, getRowsToExport])

  const handleExportPdf = useCallback(async () => {
    const rows = buildExportRows(getRowsToExport())
    await exportToPdf({ rows, columns: exportColumns, valueGetter: getExportValue, fileName: buildFileName('importaciones'), title: 'Reporte de importaciones' })
  }, [buildExportRows, getExportValue, getRowsToExport])

  const handleOpenBorrador = useCallback((borradorData) => {
    setShowCreate(false)
    setEditImp(borradorData)
    setShowEditImp(true)
  }, [])

  const handleOpenOrigen = useCallback(async (origenId) => {
    if (!origenId || !token) return
    setShowImpDetails(false)
    try {
      const response = await authFetch(`${API_URL}/importaciones/importaciones/${origenId}/`, {}, token)
      if (!response.ok) throw new Error('No se pudo abrir la importación de origen.')
      const data = await response.json()
      setActiveStatus('confirmacion')
      setEditImp(data)
      setShowEditImp(true)
    } catch (err) {
      toast.current?.show({ severity: 'error', summary: 'Error', detail: err.message || 'No se pudo abrir la importación de origen.', life: 4000 })
    }
  }, [token])

  useEffect(() => {
    if (!showSearchImportaciones) return undefined
    if (importSearchTimerRef.current) clearTimeout(importSearchTimerRef.current)

    const term = importSearchQuery.trim()
    if (term.length < 2) {
      setImportSearchResults([])
      setImportSearchLoading(false)
      return undefined
    }

    setImportSearchLoading(true)
    const seq = ++importSearchSeqRef.current
    importSearchTimerRef.current = setTimeout(async () => {
      try {
        const response = await authFetch(
          `${API_URL}/importaciones/importaciones/buscar/?q=${encodeURIComponent(term)}`,
          {},
          token
        )
        if (seq !== importSearchSeqRef.current) return
        if (!response.ok) throw new Error('No se pudo buscar.')
        const data = await response.json()
        setImportSearchResults(Array.isArray(data) ? data : [])
      } catch {
        if (seq === importSearchSeqRef.current) setImportSearchResults([])
      } finally {
        if (seq === importSearchSeqRef.current) setImportSearchLoading(false)
      }
    }, 320)

    return () => {
      if (importSearchTimerRef.current) clearTimeout(importSearchTimerRef.current)
    }
  }, [importSearchQuery, showSearchImportaciones, token])

  useEffect(() => {
    if (!showSearchImportaciones) return undefined
    const handleClickOutside = (event) => {
      if (searchImportacionesRef.current && !searchImportacionesRef.current.contains(event.target)) {
        setShowSearchImportaciones(false)
      }
    }
    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [showSearchImportaciones])

  const handleOpenSearchResult = useCallback(async (resultId) => {
    if (!resultId || !token) return
    setShowImpDetails(false)
    setShowEditImp(false)
    try {
      const response = await authFetch(`${API_URL}/importaciones/importaciones/${resultId}/`, {}, token)
      if (!response.ok) throw new Error('No se pudo abrir la importación.')
      const data = await response.json()
      if (!statusProp) setActiveStatus(data.estado)
      if (data.estado === 'borrador' || data.estado === 'cotizacion' || data.estado === 'confirmacion') {
        setEditImp(data)
        setShowEditImp(true)
      } else {
        setSelectedImp(data)
        setShowImpDetails(true)
      }
      setShowSearchImportaciones(false)
      setImportSearchQuery('')
      setImportSearchResults([])
    } catch (err) {
      toast.current?.show({ severity: 'error', summary: 'Error', detail: err.message || 'No se pudo abrir la importación.', life: 4000 })
    }
  }, [token, statusProp])

  const handleRowClick = (event) => {
    const target = event?.originalEvent?.target
    if (target?.closest?.('.p-checkbox') || target?.closest?.('.row-selection-column')) return
    // En el telefono un toque abre el registro (el doble toque no es confiable)
    if (isPhoneViewport()) {
      handleRowDoubleClick(event)
      return
    }
    const rowData = event?.data
    if (!rowData) return
    const id = normId(rowData?.id)
    if (!id) return
    const isSameRow = pendingClickRowRef.current === id
    pendingClickRowRef.current = id
    pendingClickCountRef.current = isSameRow ? pendingClickCountRef.current + 1 : 1
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
    clickTimerRef.current = setTimeout(() => {
      const clickCount = pendingClickCountRef.current
      pendingClickCountRef.current = 0
      pendingClickRowRef.current = null
      clickTimerRef.current = null
      if (clickCount > 1) return
      setSelectedRows((prev) => {
        const prevMap = new Map((prev || []).map((row) => [normId(row?.id), row]))
        if (prevMap.has(id)) {
          prevMap.delete(id)
        } else {
          prevMap.set(id, rowData)
        }
        return Array.from(prevMap.values())
      })
    }, 220)
  }

  const handleRowDoubleClick = useCallback((event) => {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
    pendingClickCountRef.current = 0
    pendingClickRowRef.current = null
    const target = event?.originalEvent?.target
    if (target?.closest?.('.p-checkbox') || target?.closest?.('.row-selection-column')) return
    const rowData = event?.data
    if (!rowData) return
    if (rowData.estado === 'borrador' || rowData.estado === 'cotizacion' || rowData.estado === 'confirmacion') {
      setEditImp(rowData)
      setShowEditImp(true)
    } else {
      setSelectedImp(rowData)
      setShowImpDetails(true)
    }
  }, [])

  const emptyMessage = loading ? ' ' : (error || statusConfig.empty)

  const header = (
    <div className="users-header">
      <div className="users-header__left">
        <div className="search-input-container">
          <input
            type="text"
            value={globalFilterValue}
            onChange={handleGlobalFilterChange}
            className="search-input"
            placeholder="Buscar en tabla"
          />
          <i className={`pi ${isGlobalSearchPending ? 'pi-spinner pi-spin' : 'pi-search'} search-input-icon`} />
        </div>
        <button
          className={`rounded-icon-btn${isStatusStale ? ' imp-refresh-btn--stale' : ''}`}
          type="button"
          onClick={() => fetchItems(true)}
          disabled={loading}
          title={isStatusStale ? 'Han pasado más de 5 minutos sin refrescar esta tabla' : 'Recargar'}
        >
          <i className="pi pi-refresh" />
        </button>
      </div>
      <div className="users-header__right">
        <span className="users-header__count">Reg. {items.length}</span>
        <button className="users-circle users-circle--excel" type="button" onClick={handleExportExcel} title={items.length ? 'Exportar Excel' : 'No hay importaciones en esta pestaña para exportar'} disabled={!items.length}>
          <i className="pi pi-file-excel" />
        </button>
        <button className="users-circle users-circle--pdf" type="button" onClick={handleExportPdf} title={items.length ? 'Exportar PDF' : 'No hay importaciones en esta pestaña para exportar'} disabled={!items.length}>
          <i className="pi pi-file-pdf" />
        </button>
      </div>
    </div>
  )

  return (
    <div className="users-page importaciones-page">
      <Toast
        ref={toast}
        baseZIndex={12050}
        appendTo={typeof document !== 'undefined' ? document.body : undefined}
      />

      <div className="users-page__top">
        <div className="users-page__actions">
          {!statusProp && (
            <div className="transfer-issues-page__type-filter" role="group" aria-label="Filtro de estado">
              {[
                { key: 'borrador', label: 'Sugerencias' },
                { key: 'cotizacion', label: 'Verificar' },
                { key: 'confirmacion', label: 'Confirmación' },
                { key: 'en_camino', label: 'En camino' },
                { key: 'importada', label: 'Importadas' },
              ].map((option) => (
                <Button
                  key={option.key}
                  label={option.label}
                  type="button"
                  className={`users-topbtn transfer-issues-page__type-btn${status === option.key ? ' transfer-issues-page__type-btn--active' : ''}`}
                  onClick={() => handleStatusChange(option.key)}
                />
              ))}
            </div>
          )}
          <div className="importaciones-page__top-actions">
            <div style={{ position: 'relative' }} ref={searchImportacionesRef}>
              <button
                type="button"
                className="p-button users-topbtn users-topbtn--search"
                onClick={() => setShowSearchImportaciones((p) => !p)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.875rem', fontWeight: 400 }}
              >
                <Search size={14} />
                <span>Buscar</span>
              </button>
              {showSearchImportaciones && (
                <div className="importaciones-page__search-popup" style={{ position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 500, background: 'var(--modal-color, #fff)', border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', width: 340, overflow: 'hidden' }}>
                  <div style={{ padding: 8, borderBottom: '1px solid var(--color-border, #e2e8f0)' }}>
                    <input
                      type="text"
                      autoFocus
                      placeholder="Código, nombre, referencia u OEM..."
                      value={importSearchQuery}
                      onChange={(e) => setImportSearchQuery(e.target.value)}
                      style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 6, fontFamily: 'inherit', fontSize: '0.875rem', background: 'var(--table-color, #fff)', color: 'inherit' }}
                    />
                  </div>
                  <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                    {importSearchLoading && (
                      <div style={{ padding: '12px 14px', fontSize: '0.85rem', color: 'var(--color-muted, #888)' }}>Buscando...</div>
                    )}
                    {!importSearchLoading && importSearchQuery.trim().length >= 2 && !importSearchResults.length && (
                      <div style={{ padding: '12px 14px', fontSize: '0.85rem', color: 'var(--color-muted, #888)' }}>Sin resultados.</div>
                    )}
                    {!importSearchLoading && importSearchQuery.trim().length < 2 && (
                      <div style={{ padding: '12px 14px', fontSize: '0.85rem', color: 'var(--color-muted, #888)' }}>Escribe al menos 2 caracteres.</div>
                    )}
                    {importSearchResults.map((result) => {
                      const badge = STATUS_BADGE[result.estado] || { label: result.estado_label || result.estado, color: '#64748b', bg: 'rgba(100,116,139,0.1)' }
                      return (
                        <button
                          key={result.id}
                          type="button"
                          style={{ display: 'flex', flexDirection: 'column', gap: 3, width: '100%', padding: '10px 14px', background: 'none', border: 'none', borderBottom: '1px solid var(--color-border, #e2e8f0)', cursor: 'pointer', textAlign: 'left', color: 'inherit', fontFamily: 'inherit' }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface, #f8fafc)' }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = 'none' }}
                          onClick={() => handleOpenSearchResult(result.id)}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                            <strong style={{ fontSize: '0.875rem' }}>{result.codigo}</strong>
                            <span style={{ fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: badge.bg, color: badge.color, fontSize: '0.72rem', whiteSpace: 'nowrap' }}>
                              {badge.label}
                            </span>
                          </div>
                          <small style={{ color: 'var(--color-muted, #888)' }}>
                            {[result.producto_codigo, result.producto_nombre, result.casa_comercial_nombre].filter(Boolean).join(' · ') || '-'}
                          </small>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
            {canCreate && status === 'borrador' && (
              <div style={{ position: 'relative' }} ref={createMenuRef}>
                <button
                  type="button"
                  className="p-button users-topbtn users-topbtn--create"
                  onClick={() => setShowCreateMenu(p => !p)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.875rem', fontWeight: 400 }}
                >
                  <i className="pi pi-plus p-button-icon" />
                  <span className="p-button-label">Crear</span>
                  <i className="pi pi-chevron-down" style={{ fontSize: '0.65rem', opacity: 0.75 }} />
                </button>
                {showCreateMenu && (
                  <div style={{ position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 500, background: 'var(--modal-color, #fff)', border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', minWidth: 230, overflow: 'hidden' }}>
                    <button
                      type="button"
                      style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.875rem', textAlign: 'left', color: 'inherit' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--color-surface, #f8fafc)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'none'}
                      onClick={() => { setShowCreate(true); setShowCreateMenu(false) }}
                    >
                      <i className="pi pi-file-edit" style={{ color: 'var(--color-primary, #2563eb)' }} />
                      <span>Crear sugerencia</span>
                    </button>
                    <div style={{ height: 1, background: 'var(--color-border, #e2e8f0)', margin: '0 10px' }} />
                    <button
                      type="button"
                      style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.875rem', textAlign: 'left', color: 'inherit' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--color-surface, #f8fafc)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'none'}
                      onClick={() => { setShowExcelImport(true); setShowCreateMenu(false) }}
                    >
                      <i className="pi pi-file-excel" style={{ color: '#16a34a' }} />
                      <span>Sugerencia desde Excel</span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="users-table users-table--card users-table--compact" ref={tableWrapperRef}>
        {loading && (
          <div className="spinner-container spinner-container--table">
            <div className="spinner" />
          </div>
        )}
        {error && !loading && (
          <div className="stale-data-msg">
            <i className="pi pi-exclamation-circle" style={{ fontSize: '0.8rem', margin: 0, color: 'white' }} />
            <span><strong>Los datos pueden estar desactualizados</strong> | intenta recargar la tabla</span>
          </div>
        )}

        <DataTable
          value={items}
          dataKey="id"
          header={header}
          className={`users-datatable users-datatable--compact${loading ? ' users-datatable--loading-content' : ''}`}
          stateStorage="custom"
          customSaveState={widthHandlers.save}
          customRestoreState={widthHandlers.restore}
          tableStyle={{ width: '100%' }}
          emptyMessage={emptyMessage}
          showGridlines
          size="small"
          scrollable
          scrollHeight="flex"
          paginator
          first={pageFirst}
          rows={pageSize}
          rowsPerPageOptions={[10, 25, 50]}
          onPage={(e) => setPageFirst(e.first)}
          filters={filters}
          globalFilterFields={[
            'codigo',
            'fecha',
            'creado_en',
            'fecha_llegada',
            'casa_nombre',
            'estado',
            'estado_label',
            'dias_entrega_estimados',
            'productos_resumen',
          ]}
          removableSort
          reorderableColumns
          onColReorder={handleColumnReorder}
          resizableColumns
          columnResizeMode="expand"
          onRowClick={handleRowClick}
          onRowDoubleClick={handleRowDoubleClick}
          onValueChange={(value) => setProcessedRows(value ?? [])}
          rowClassName={(rowData) => {
            const classes = ['p-selectable-row']
            if (selectedRowIds.includes(normId(rowData?.id))) classes.push('selected-row-shadow')
            if (rowData.estado === 'borrador') classes.push('imp-row--borrador')
            if (rowData.estado === 'cotizacion') classes.push('imp-row--cotizacion')
            if (rowData.estado === 'confirmacion') classes.push(rowData.numero_factura ? 'imp-row--confirmacion-realizada' : 'imp-row--confirmacion')
            return classes.join(' ')
          }}
          selectionMode="multiple"
          selection={selectedRows}
          onSelectionChange={(event) => {
            if (!isCheckboxSelection(event)) return
            setSelectedRows(event.value || [])
          }}
          frozenWidth="40px"
        >
          <Column
            selectionMode="multiple"
            frozen
            headerClassName="row-selection-column"
            bodyClassName="row-selection-column"
            style={selectionColStyle}
            headerStyle={selectionColStyle}
            bodyStyle={selectionColStyle}
            exportable={false}
            reorderable={false}
            resizable={false}
          />
          {columnOrder
            .filter((field) => importacionesBaseFields.includes(field))
            .map((field) => {
              switch (field) {
                case 'codigo':
                  return (
                    <Column
                      key="codigo"
                      field="codigo"
                      header="Código"
                      sortable
                      reorderable
                      className="column-max-min-width"
                      style={{ minWidth: '120px' }}
                    />
                  )
                case 'fecha':
                  return (
                    <Column
                      key="fecha"
                      field="fecha"
                      header="Fecha"
                      sortable
                      reorderable
                      className="column-max-min-width"
                      style={{ minWidth: '100px' }}
                      body={(row) => formatDate(row.fecha)}
                    />
                  )
                case 'creado_en':
                  return (
                    <Column
                      key="creado_en"
                      field="creado_en"
                      header="Fecha de creación"
                      sortable
                      reorderable
                      className="column-max-min-width"
                      style={{ minWidth: '120px' }}
                      body={(row) => formatDate(row.creado_en)}
                    />
                  )
                case 'fecha_llegada':
                  return (
                    <Column
                      key="fecha_llegada"
                      field="fecha_llegada"
                      header="Fecha de llegada"
                      sortable
                      reorderable
                      className="column-max-min-width"
                      style={{ minWidth: '120px' }}
                      body={(row) => formatDate(row.fecha_llegada)}
                    />
                  )
                case 'casa_nombre':
                  return (
                    <Column
                      key="casa_nombre"
                      field="casa_nombre"
                      header="Casa comercial"
                      sortable
                      reorderable
                      className="column-max-min-width"
                      style={{ minWidth: '150px' }}
                    />
                  )
                case 'estado':
                  return (
                    <Column
                      key="estado"
                      field="estado"
                      header="Estado"
                      sortable
                      reorderable
                      className="column-max-min-width"
                      style={{ minWidth: '110px' }}
                      body={estadoBodyTemplate}
                    />
                  )
                case 'dias_entrega_estimados':
                  return (
                    <Column
                      key="dias_entrega_estimados"
                      field="dias_entrega_estimados"
                      header="Días est."
                      sortable
                      reorderable
                      className="column-max-min-width"
                      style={{ minWidth: '90px' }}
                      body={(row) => (row.dias_entrega_estimados != null ? `${row.dias_entrega_estimados} d` : '-')}
                    />
                  )
                case 'productos_resumen':
                  return (
                    <Column
                      key="productos_resumen"
                      field="productos_resumen"
                      header="Productos"
                      reorderable
                      className="column-max-min-width"
                      style={{ minWidth: '180px' }}
                      body={importacionProductBodyTemplate}
                    />
                  )
                default:
                  return null
              }
            })}
        </DataTable>
      </div>

      <ImportacionDetailsModal
        imp={showImpDetails && isTabActive !== false ? selectedImp : null}
        token={token}
        onClose={() => setShowImpDetails(false)}
        onSaved={() => { setShowImpDetails(false); invalidateImportacionesItemsCache(); fetchItems(true) }}
        moduleActions={moduleActions}
        onOpenOrigen={handleOpenOrigen}
      />

      {Array.isArray(productHoverCard?.productos) && productHoverCard.productos.length > 0 && createPortal(
        <div
          ref={productHoverCardRef}
          className="movimientos-table__product-hover-card movimientos-table__product-hover-card--wide"
          role="tooltip"
          style={{ top: productHoverCard.top, left: productHoverCard.left, width: IMP_HOVER_WIDTH }}
          onMouseEnter={clearProductHoverTimer}
          onMouseLeave={scheduleHideProductHoverCard}
        >
          <div className="movimientos-table__product-hover-title">Productos</div>
          <table className="movimientos-table__product-hover-table" style={{ tableLayout: 'fixed', width: '100%' }}>
            <colgroup>
              <col style={{ width: '100px' }} />
              <col />
              <col style={{ width: '120px' }} />
              <col style={{ width: '52px' }} />
            </colgroup>
            <thead>
              <tr>
                <th>Código</th>
                <th>Descripción</th>
                <th>OEM</th>
                <th className="movimientos-table__product-hover-qty">Cant.</th>
              </tr>
            </thead>
            <tbody>
              {productHoverCard.productos.map((p, i) => (
                <tr key={i}>
                  <td title={p.codigo}>{p.codigo}</td>
                  <td title={p.nombre}>{p.nombre}</td>
                  <td title={p.oem}>{p.oem}</td>
                  <td className="movimientos-table__product-hover-qty">{p.cantidad}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
        getPortalRoot()
      )}

      <EditImportacionModal
        open={showEditImp}
        imp={editImp}
        token={token}
        onClose={() => setShowEditImp(false)}
        onSaved={(payload) => {
          setShowEditImp(false)
          invalidateImportacionesItemsCache()
          fetchItems(true)
          if (payload?.estado === 'en_camino' && !statusProp) setActiveStatus('en_camino')
        }}
        onOpenBorrador={handleOpenBorrador}
        onOpenEnCamino={handleOpenEnCamino}
        moduleActions={moduleActions}
      />

      {showCreate && (
        <ImportacionExcelModal
          modo="manual"
          token={token}
          isTabActive={isTabActive}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false)
            invalidateImportacionesItemsCache()
            if (status === 'borrador') {
              fetchItems(true)
            } else {
              setActiveStatus('borrador')
            }
          }}
        />
      )}

      {showExcelImport && (
        <ImportacionExcelModal
          token={token}
          isTabActive={isTabActive}
          onClose={() => setShowExcelImport(false)}
          onCreated={() => { setShowExcelImport(false); invalidateImportacionesItemsCache(); fetchItems(true) }}
        />
      )}

    </div>
  )
}

export default ImportacionesTable
