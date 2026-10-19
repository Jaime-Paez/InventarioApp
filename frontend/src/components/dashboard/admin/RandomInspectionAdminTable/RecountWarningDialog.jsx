import { createPortal } from 'react-dom'
import { formatDateTime } from '../../../../utils/dateFormat'
import '../../common/unsavedChanges/unsavedChanges.css'

// Aviso antes de mandar una revision con productos que ya se contaron hace
// poco: dice cuales, cuando, quien y donde, y deja mandar solo los que faltan.
// result: 'cancel' | 'all' | 'only_new'
export default function RecountWarningDialog({ warning, onResolve }) {
  if (!warning || typeof document === 'undefined') return null
  const { total, contados, dias, productos = [], allowOnlyNew } = warning
  const pendientes = Math.max(0, Number(total || 0) - Number(contados || 0))
  const shown = productos.slice(0, 8)
  const hidden = Math.max(0, Number(contados || 0) - shown.length)

  return createPortal(
    <div
      className="unsaved-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Productos ya contados"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onResolve('cancel') }}
    >
      <div className="unsaved-dialog__card recount-warning">
        <h4>Algunos productos ya se contaron</h4>
        <p>
          <strong>{contados}</strong> de <strong>{total}</strong> producto{Number(total) === 1 ? '' : 's'} ya
          {Number(contados) === 1 ? ' se conto' : ' se contaron'} en los ultimos {dias} dias.
          {pendientes > 0
            ? ` Los otros ${pendientes} todavia no se han contado.`
            : ' Todos los de esta revision ya se contaron.'}
        </p>

        <div className="recount-warning__table-wrap">
          <table className="recount-warning__table">
            <thead>
              <tr>
                <th>Producto</th>
                <th>Contado</th>
                <th>Por</th>
                <th>Donde</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.producto_id || row.codigo}>
                  <td>
                    <span className="recount-warning__code">{row.codigo || '-'}</span>
                    {row.nombre && <span className="recount-warning__name">{row.nombre}</span>}
                  </td>
                  <td>{row.revisado_en ? formatDateTime(row.revisado_en) : '-'}</td>
                  <td>{row.revisor || '-'}</td>
                  <td>{row.donde || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {hidden > 0 && <p className="recount-warning__more">y {hidden} mas...</p>}
        </div>

        <div className="unsaved-dialog__actions">
          <button type="button" className="unsaved-dialog__btn" onClick={() => onResolve('cancel')}>
            Cancelar
          </button>
          {allowOnlyNew && pendientes > 0 && (
            <button type="button" className="unsaved-dialog__btn" onClick={() => onResolve('only_new')}>
              Enviar solo los no contados ({pendientes})
            </button>
          )}
          <button type="button" className="unsaved-dialog__btn unsaved-dialog__btn--save" onClick={() => onResolve('all')}>
            Enviar todos ({total})
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
