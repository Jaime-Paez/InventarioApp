function StaticFieldDisplay({
  label,
  value,
  helper = '',
  helperTone = 'muted',
  fullWidth = false,
  required = false,
  loading = false,
}) {
  const fieldClassName = [
    'create-user__field',
    'create-salida__static-field',
    fullWidth ? 'create-user__field--full' : '',
    required ? 'create-user__field--required' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const helperClassName = helperTone === 'error' ? 'create-user__field-error' : 'muted'
  const resolvedValue = String(value ?? '').trim()
  const shouldShowLoader = loading && !resolvedValue

  return (
    <div className={fieldClassName}>
      {label ? <span>{label}</span> : null}
      <div className={`create-salida__static-value${shouldShowLoader ? ' is-loading' : ''}`}>
        {shouldShowLoader ? <span className="create-salida__static-loader" aria-hidden="true" /> : (resolvedValue || '-')}
      </div>
      {helper ? <small className={helperClassName}>{helper}</small> : null}
    </div>
  )
}

export default StaticFieldDisplay
