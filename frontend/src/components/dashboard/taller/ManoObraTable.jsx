import CatalogoTallerTable from './CatalogoTallerTable'
import { formatMoney } from './tallerConstants'

const CONFIG = {
  endpoint: '/taller/mano-obra/',
  title: 'Mano de obra',
  singular: 'trabajo',
  plural: 'el catálogo de mano de obra',
  empty: 'El catálogo está vacío. Agrega el primer trabajo con "Crear". En la orden siempre se puede escribir cualquier otro trabajo.',
  fields: [
    { key: 'nombre', label: 'Trabajo', required: true, placeholder: 'Cambio de aceite, ABC de frenos, ...', full: true },
    { key: 'precio', label: 'Precio fijo', type: 'money' },
  ],
  columns: [
    { field: 'nombre', header: 'Trabajo', style: { minWidth: 260 } },
    { field: 'precio', header: 'Precio', body: (row) => formatMoney(row.precio), style: { width: 140, textAlign: 'right' } },
  ],
}

function ManoObraTable(props) {
  return <CatalogoTallerTable {...props} config={CONFIG} />
}

export default ManoObraTable
