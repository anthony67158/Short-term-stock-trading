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
        className="brand-mark-image brand-mark-light"
        src="/brand-light.svg"
        alt=""
      />
      <img
        className="brand-mark-image brand-mark-dark"
        src="/brand-dark.svg"
        alt=""
      />
    </span>
  )
}
