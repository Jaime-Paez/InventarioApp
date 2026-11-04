import { forwardRef, useEffect, useRef, useState } from 'react'
import {
  applyMoneyDelete,
  applyMoneyInsert,
  formatMoneyState,
  formatMoneyValue,
  moneyStateFromNumber,
  moneyStateFromText,
  moneyStateToNumber,
} from '../../../utils/moneyTyping'

// Campo de dinero de toda la app. Se escribe normal, como en cualquier
// sistema (no como caja registradora): mientras se escribe se ve lo tecleado
//   1, 2, "."      -> $12.      (al salir: $12.00)
//   3, ".", 5      -> $3.5      (al salir: $3.50)
// Al entrar a un campo que ya tiene valor, lo primero que se escribe lo
// reemplaza. Fuera del campo se ve siempre $X.XX.
//
// `value`: numero (o '' / null si esta vacio). `onValueChange(numero | null)`
// recibe el valor como numero; cada pantalla lo guarda en su formato.
// `symbol={false}`: sin el "$" dentro (cuando el campo ya lo muestra al lado).
const withSymbol = (text, symbol) => (symbol ? text : String(text || '').replace(/^\$/, ''))

const MoneyInput = forwardRef(function MoneyInput(
  { value, onValueChange, onFocus, onBlur, onKeyDown, symbol = true, placeholder, ...props },
  ref
) {
  const [editing, setEditing] = useState(false)
  const [state, setState] = useState(() => moneyStateFromNumber(value))
  const freshRef = useRef(false)

  // Mientras no se esta escribiendo, se sigue el valor de la pantalla.
  useEffect(() => {
    if (!editing) setState(moneyStateFromNumber(value))
  }, [value, editing])

  const commit = (next) => {
    setState(next)
    onValueChange?.(moneyStateToNumber(next))
  }

  const handleChange = (event) => {
    const native = event.nativeEvent || {}
    const inputType = String(native.inputType || '')
    const fresh = freshRef.current
    freshRef.current = false
    if (inputType === 'insertText' && typeof native.data === 'string' && native.data.length === 1) {
      commit(applyMoneyInsert(state, native.data, fresh))
      return
    }
    if (inputType.startsWith('delete')) {
      commit(applyMoneyDelete(state, fresh))
      return
    }
    // Pegar, autocompletar o un navegador sin inputType: se lee el texto.
    commit(moneyStateFromText(event.target.value))
  }

  return (
    <input
      ref={ref}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      {...props}
      placeholder={placeholder ?? (symbol ? '$0.00' : '0.00')}
      value={withSymbol(editing ? formatMoneyState(state, { editing: true }) : formatMoneyValue(value), symbol)}
      onChange={handleChange}
      onKeyDown={(event) => {
        // Moverse con las flechas: ya no se reemplaza todo al escribir.
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) freshRef.current = false
        onKeyDown?.(event)
      }}
      onFocus={(event) => {
        setEditing(true)
        setState(moneyStateFromNumber(value))
        freshRef.current = true
        const target = event.target
        // Todo seleccionado: lo primero que se escriba reemplaza el valor.
        window.requestAnimationFrame(() => {
          try { target.select() } catch { /* el campo ya no existe */ }
        })
        onFocus?.(event)
      }}
      onClick={(event) => {
        // Clic otra vez en el campo (sin haber salido): tambien se reemplaza.
        freshRef.current = true
        try { event.currentTarget.select() } catch { /* sin seleccion */ }
        props.onClick?.(event)
      }}
      onBlur={(event) => {
        setEditing(false)
        freshRef.current = false
        onBlur?.(event)
      }}
    />
  )
})

export default MoneyInput
