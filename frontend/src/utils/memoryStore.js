// Almacen en memoria con la misma forma que sessionStorage (getItem/setItem/
// removeItem/clear). Se usa para estado de pantalla que solo debe durar
// mientras la app esta abierta (por ejemplo, filas seleccionadas en una
// tabla): nada de la app se guarda en el almacenamiento del navegador; lo que
// debe persistir va a la base de datos.
const values = new Map()

export const memoryStore = {
  getItem(key) {
    const value = values.get(String(key))
    return value === undefined ? null : value
  },
  setItem(key, value) {
    values.set(String(key), String(value))
  },
  removeItem(key) {
    values.delete(String(key))
  },
  clear() {
    values.clear()
  },
}
