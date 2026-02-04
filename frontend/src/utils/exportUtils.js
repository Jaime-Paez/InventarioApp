export const buildFileName = (base) => {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${base}-${yyyy}-${mm}-${dd}`
}

const toPlainValue = (value) => {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'boolean') return value ? 'Si' : 'No'
  return String(value)
}

export const buildExportData = (rows, columns, valueGetter) =>
  (rows || []).map((row) => {
    const entry = {}
    columns.forEach((col) => {
      entry[col.header] = toPlainValue(valueGetter(row, col.key))
    })
    return entry
  })

export const buildExportMatrix = (rows, columns, valueGetter) => {
  const headers = columns.map((col) => col.header)
  const body = (rows || []).map((row) => columns.map((col) => toPlainValue(valueGetter(row, col.key))))
  return { headers, body }
}

const REPORT_HEADER_URL = new URL('../assets/reports/Header.png', import.meta.url).href

const formatReportDate = () => {
  const now = new Date()
  const date = now.toLocaleDateString('es-EC', { year: 'numeric', month: 'long', day: '2-digit' })
  const time = now.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })
  return `${date} ${time}`
}

const loadImageData = async (url) => {
  const response = await fetch(url)
  const blob = await response.blob()
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
  const dimensions = await new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.width, height: img.height })
    img.onerror = reject
    img.src = dataUrl
  })
  return { dataUrl, ...dimensions }
}

const downloadBlob = (blob, fileName) => {
  const link = document.createElement('a')
  const url = URL.createObjectURL(blob)
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

export const exportToExcel = async ({ rows, columns, valueGetter, fileName = 'export' }) => {
  const xlsx = await import('xlsx')
  const XLSX = xlsx?.default ?? xlsx
  const utils = XLSX.utils
  const data = buildExportData(rows, columns, valueGetter)
  const worksheet = utils.json_to_sheet(data)
  const workbook = utils.book_new()
  utils.book_append_sheet(workbook, worksheet, 'Datos')
  const fullName = `${fileName}.xlsx`

  if (typeof XLSX.writeFile === 'function') {
    XLSX.writeFile(workbook, fullName)
    return
  }

  if (typeof XLSX.writeFileXLSX === 'function') {
    XLSX.writeFileXLSX(workbook, fullName)
    return
  }

  if (typeof XLSX.write === 'function') {
    const out = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' })
    const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    downloadBlob(blob, fullName)
  }
}

export const exportToPdf = async ({ rows, columns, valueGetter, fileName = 'export', title = 'Reporte', subtitle }) => {
  const { jsPDF } = await import('jspdf')
  const autoTable = (await import('jspdf-autotable')).default

  const doc = new jsPDF({
    orientation: columns.length > 6 ? 'landscape' : 'portrait',
    unit: 'pt',
    format: 'a4',
  })

  const marginX = 24
  let cursorY = 0
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const baseTopMargin = 40

  try {
    const header = await loadImageData(REPORT_HEADER_URL)
    const availableWidth = pageWidth
    const ratio = header.width ? availableWidth / header.width : 1
    const headerHeight = header.height ? header.height * ratio : 0
    if (headerHeight > 0) {
      doc.addImage(header.dataUrl, 'PNG', 0, cursorY, availableWidth, headerHeight)
      cursorY += headerHeight + 28
    }
  } catch {
    // If header fails, keep the PDF usable
  }

  doc.setFontSize(12)
  doc.text(title, marginX, cursorY)
  cursorY += 12
  if (subtitle) {
    doc.setFontSize(9)
    doc.setTextColor(90)
    doc.text(subtitle, marginX, cursorY)
    doc.setTextColor(0)
    cursorY += 10
  }
  doc.setFontSize(9)
  doc.setTextColor(90)
  doc.text(`Fecha de creación: ${formatReportDate()}`, marginX, cursorY)
  doc.setTextColor(0)
  cursorY += 10

  const { headers, body } = buildExportMatrix(rows, columns, valueGetter)
  autoTable(doc, {
    head: [headers],
    body,
    startY: Math.max(cursorY, baseTopMargin),
    margin: { top: baseTopMargin, left: marginX, right: marginX, bottom: 40 },
    showHead: 'everyPage',
    styles: { fontSize: 8, cellPadding: 4 },
    headStyles: { fillColor: [25, 25, 25] },
  })

  const totalPages = doc.internal.getNumberOfPages()
  doc.setFontSize(9)
  doc.setTextColor(90)
  for (let i = 1; i <= totalPages; i += 1) {
    doc.setPage(i)
    doc.text(`Página ${i} de ${totalPages}`, pageWidth - marginX, pageHeight - 24, { align: 'right' })
  }
  doc.setTextColor(0)

  doc.save(`${fileName}.pdf`)
}
