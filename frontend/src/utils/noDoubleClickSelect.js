// En las tablas el doble click abre el registro, asi que no debe seleccionar
// (pintar en azul) el texto de la fila. Se bloquea solo el 2do click del doble
// click; arrastrar con un click para copiar texto sigue funcionando.
const EDITABLE = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]'

let started = false

export function startNoDoubleClickSelect() {
  if (started || typeof document === 'undefined') return
  started = true
  document.addEventListener(
    'mousedown',
    (event) => {
      if (event.detail < 2 || event.button !== 0) return
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest(EDITABLE)) return
      if (!target.closest('.p-datatable-tbody > tr')) return
      event.preventDefault()
    },
    true,
  )
}
