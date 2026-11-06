import CatalogoTallerTable from './CatalogoTallerTable'

const CONFIG = {
  endpoint: '/taller/tecnicos/',
  title: 'Técnicos',
  singular: 'técnico',
  plural: 'los técnicos',
  empty: 'Todavía no hay técnicos. Crea el primero con "Crear".',
  fields: [
    { key: 'nombre', label: 'Nombre', required: true, full: true },
    { key: 'cedula', label: 'Cédula' },
    { key: 'telefono', label: 'Teléfono' },
    { key: 'especialidad', label: 'Especialidad', placeholder: 'Mecánica, eléctrico, latonería...', full: true },
  ],
  columns: [
    { field: 'nombre', header: 'Nombre', style: { minWidth: 200 } },
    { field: 'cedula', header: 'Cédula', body: (row) => row.cedula || '-', style: { minWidth: 120 } },
    { field: 'telefono', header: 'Teléfono', body: (row) => row.telefono || '-', style: { minWidth: 120 } },
    { field: 'especialidad', header: 'Especialidad', body: (row) => row.especialidad || '-', style: { minWidth: 160 } },
    { field: 'ordenes_abiertas', header: 'Órdenes abiertas', style: { width: 140 } },
  ],
}

function TecnicosTable(props) {
  return <CatalogoTallerTable {...props} config={CONFIG} />
}

export default TecnicosTable
