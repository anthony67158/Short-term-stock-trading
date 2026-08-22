export default function BrandMark({
  size,
  className = '',
}) {
  const style = size ? { width: size, height: size } : undefined

  return (
    <span
      className={`brand-mark ${className}`.trim()}
      style={style}
      aria-hidden="true"
    >
      <img
        className="brand-mark-image"
        src="/app-icon-192.png"
        alt=""
      />
    </span>
  )
}
