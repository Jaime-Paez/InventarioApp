import CatalogoTallerTable from './CatalogoTallerTable'

const CONFIG = {
  endpoint: '/taller/talleres/',
  title: 'Talleres',
  singular: 'taller',
  plural: 'los talleres',
  empty: 'Todavía no hay talleres. Crea el primero con "Crear".',
  fields: [
    { key: 'nombre', label: 'Nombre', required: true, placeholder: 'Taller 9 de Octubre', full: true },
    {
      key: 'sucursal',
      label: 'Sucursal principal',
      type: 'select',
      required: true,
      optionsEndpoint: '/taller/ordenes/sucursales/',
      placeholder: 'Elige la sucursal',
      help: 'Los repuestos salen primero de esta sucursal; si ahí no hay, se pueden despachar desde otra.',
      emptyNotice: {
        title: 'No hay sucursales para elegir',
        reason: 'Crea la sucursal en Sucursales y aparecerá aquí.',
        goTo: 'Sucursales',
      },
    },
    { key: 'direccion', label: 'Dirección' },
  ],
  columns: [
    { field: 'nombre', header: 'Taller', style: { minWidth: 200 } },
    { field: 'sucursal_nombre', header: 'Sucursal principal', style: { minWidth: 180 } },
    { field: 'direccion', header: 'Dirección', body: (row) => row.direccion || '-', style: { minWidth: 180 } },
    { field: 'ordenes_abiertas', header: 'Órdenes abiertas', style: { width: 140 } },
  ],
}

function TalleresTable(props) {
  return <CatalogoTallerTable {...props} config={CONFIG} />
}

export default TalleresTable
