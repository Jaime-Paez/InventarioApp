import CatalogoTallerTable from './CatalogoTallerTable'
import { formatMoney } from './tallerConstants'

const CONFIG = {
  endpoint: '/taller/insumos/',
  title: 'Insumos',
  singular: 'insumo',
  plural: 'el catálogo de insumos',
  empty: 'El catálogo está vacío. Agrega el primer insumo con "Crear". En la orden siempre se puede escribir cualquier otro insumo.',
  fields: [
    { key: 'nombre', label: 'Insumo', required: true, placeholder: 'Goma, cinta adhesiva, guaipe, ...', full: true },
    { key: 'precio', label: 'Precio fijo', type: 'money' },
  ],
  columns: [
    { field: 'nombre', header: 'Insumo', style: { minWidth: 260 } },
    { field: 'precio', header: 'Precio', body: (row) => formatMoney(row.precio), style: { width: 140, textAlign: 'right' } },
  ],
}

function InsumosTable(props) {
  return <CatalogoTallerTable {...props} config={CONFIG} />
}

export default InsumosTable
