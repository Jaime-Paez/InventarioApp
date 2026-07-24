import { useMemo, useState } from 'react'
import {
  Building2,
  RotateCcw,
  ShieldCheck,
  ShoppingBag,
  UserRound,
} from 'lucide-react'

const DEFAULT_HELPER_TEXT = 'Pasa el cursor sobre un botón para ver su descripción.'
const ICONS_BY_NAME = {
  branch: Building2,
  customer: UserRound,
  guarantee: ShieldCheck,
  purchase: ShoppingBag,
  return: RotateCcw,
}

function SubTipoButtonSelector({
  label,
  options,
  value,
  onChange,
  disabled = false,
  helperText = DEFAULT_HELPER_TEXT,
  ariaLabel,
}) {
  const [hoveredValue, setHoveredValue] = useState('')

  const normalizedOptions = useMemo(
    () => (Array.isArray(options) ? options : []),
    [options]
  )
  const selectedOption = useMemo(
    () => normalizedOptions.find((option) => String(option?.value) === String(value)),
    [normalizedOptions, value]
  )
  const hoveredOption = useMemo(
    () => normalizedOptions.find((option) => String(option?.value) === String(hoveredValue)),
    [normalizedOptions, hoveredValue]
  )

  const resolvedHelperText = hoveredOption?.blocked
    ? 'No tienes permiso para crear este tipo de entrada en esta sucursal.'
    : hoveredOption?.description || selectedOption?.description || helperText
  const helperClassName = [
    'create-salida__subtipo-help',
    hoveredOption ? 'is-hovered' : '',
    !hoveredOption && selectedOption ? 'is-selected' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className="create-salida__subtipo-selector">
      {label ? <span className="create-salida__subtipo-selector-label">{label}</span> : null}
      <div
        className="create-salida__subtipo-buttons"
        role="group"
        aria-label={ariaLabel || label || 'Selector de tipo'}
        onMouseLeave={() => setHoveredValue('')}
      >
        {normalizedOptions.map((option) => {
          const optionValue = String(option?.value || '')
          const isActive = optionValue === String(value)
          const isBlocked = Boolean(option?.blocked)
          const Icon = ICONS_BY_NAME[option?.icon] || null
          return (
            <button
              key={optionValue}
              type="button"
              className={`create-salida__subtipo-btn${isBlocked ? ' create-salida__subtipo-btn--blocked' : ''}`}
              aria-pressed={isActive}
              aria-disabled={isBlocked || undefined}
              disabled={disabled || isBlocked}
              onMouseEnter={() => setHoveredValue(optionValue)}
              onFocus={() => setHoveredValue(optionValue)}
              onBlur={() => setHoveredValue('')}
              onClick={() => !isBlocked && onChange?.(optionValue)}
            >
              {Icon ? <Icon size={28} strokeWidth={2.1} className="create-salida__subtipo-btn-icon" aria-hidden="true" /> : null}
              <span className="create-salida__subtipo-btn-label">{option?.label}</span>
            </button>
          )
        })}
      </div>
      <p className={helperClassName} aria-live="polite">
        {resolvedHelperText}
      </p>
    </div>
  )
}

export default SubTipoButtonSelector
