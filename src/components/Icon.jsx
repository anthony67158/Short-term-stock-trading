// 统一 SVG 图标库（line 风格，1.6 描边，继承 currentColor）
// 用法：<Icon name="target" size={16} />
const paths = {
  // 导航
  radar: <><circle cx="12" cy="12" r="9" /><path d="M12 12 L12 4" /><path d="M12 12 L18 15" /><circle cx="12" cy="12" r="4" /></>,
  clipboard: <><rect x="6" y="4" width="12" height="17" rx="2" /><path d="M9 4a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 4" /><path d="M9 11h6" /><path d="M9 15h4" /></>,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 4v4h4" /><path d="M12 8v4l3 2" /></>,
  layers: <><path d="M12 3 3 8l9 5 9-5-9-5Z" /><path d="M3 13l9 5 9-5" /></>,
  // 功能
  target: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="1" /></>,
  spark: <><path d="M12 3v4M12 17v4M3 12h4M17 12h4" /><path d="M12 8a4 4 0 0 0 4 4 4 4 0 0 0-4 4 4 4 0 0 0-4-4 4 4 0 0 0 4-4Z" /></>,
  bolt: <><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" /></>,
  book: <><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z" /><path d="M4 19a2 2 0 0 1 2-2h13" /><path d="M9 7h7M9 11h5" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></>,
  edit: <><path d="M4 20h4L18.5 9.5a2 2 0 0 0-3-3L5 17v3Z" /><path d="M13.5 6.5l3 3" /></>,
  star: <><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9L12 3.5Z" /></>,
  sun: <><circle cx="12" cy="12" r="4.2" /><path d="M12 2v2.4M12 19.6V22M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M2 12h2.4M19.6 12H22M4.9 19.1l1.7-1.7M17.4 6.6l1.7-1.7" /></>,
  moon: <><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" /></>,
  logo: <><path d="M4 16 L10 10.5 L14 13.5 L20 5.5" /><circle cx="20" cy="5.5" r="1.6" fill="currentColor" stroke="none" /><path d="M7.5 13.5v5M16 15v3.5" /></>,
  starFill: <><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9L12 3.5Z" fill="currentColor" /></>,
  fire: <><path d="M12 3c1 3-1 4-1 6a3 3 0 0 0 6 0c0-1 0-2-1-3 2 1 3 4 3 6a7 7 0 1 1-14 0c0-3 2-5 4-7 0 2 1 3 2 3 1-1 1-3 1-5Z" /></>,
  rocket: <><path d="M5 15c-1 1-2 4-2 4s3-1 4-2" /><path d="M9 11a12 12 0 0 1 8-8c2 0 3 1 3 3a12 12 0 0 1-8 8l-3-3Z" /><circle cx="14.5" cy="9.5" r="1.3" /><path d="M9 11l-3 1 3 3 1-3" /></>,
  pulse: <><path d="M3 12h4l2-6 4 12 2-6h6" /></>,
  wave: <><path d="M3 10c3-3 6 3 9 0s6-3 9 0" /><path d="M3 15c3-3 6 3 9 0s6-3 9 0" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  check: <><path d="M20 6 9 17l-5-5" /></>,
  close: <><path d="M18 6 6 18M6 6l12 12" /></>,
  trash: <><path d="M4 7h16M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2M6 7l1 13a1.5 1.5 0 0 0 1.5 1.4h7A1.5 1.5 0 0 0 17 20L18 7" /></>,
  chevronRight: <><path d="M9 6l6 6-6 6" /></>,
  chevronDown: <><path d="M6 9l6 6 6-6" /></>,
  arrowUp: <><path d="M12 19V5M6 11l6-6 6 6" /></>,
  arrowDown: <><path d="M12 5v14M6 13l6 6 6-6" /></>,
  cart: <><circle cx="9" cy="20" r="1.4" /><circle cx="17" cy="20" r="1.4" /><path d="M3 4h2l2.4 12h10L20 8H6" /></>,
  sell: <><path d="M7 7h10v10" /><path d="M7 17 17 7" /></>,
  wallet: <><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18" /><circle cx="16.5" cy="14" r="1.3" /></>,
  chart: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
  candle: <><path d="M6 4v4m0 8v4M6 8h0M18 6v3m0 7v3" /><rect x="4" y="8" width="4" height="8" rx="1" /><rect x="16" y="9" width="4" height="7" rx="1" /></>,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h0" /></>,
  refresh: <><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 4v4h-4" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 20v-4h4" /></>,
  dot: <><circle cx="12" cy="12" r="5" /></>,
  send: <><path d="M4 12 20 4l-6 16-2.5-6.5L4 12Z" /></>,
  news: <><rect x="3" y="5" width="14" height="15" rx="2" /><path d="M17 8h3a1 1 0 0 1 1 1v9a2 2 0 0 1-2 2M7 9h6M7 13h6M7 17h4" /></>,
  filter: <><path d="M3 5h18l-7 8v6l-4-2v-4L3 5Z" /></>,
  building: <><rect x="5" y="3" width="14" height="18" rx="1.5" /><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2" /></>,
  compass: <><circle cx="12" cy="12" r="9" /><path d="M15.5 8.5 13 13l-4.5 2.5L11 11l4.5-2.5Z" /></>,
  brain: <><path d="M9 3a3 3 0 0 0-3 3 3 3 0 0 0-1 5 3 3 0 0 0 1 5 3 3 0 0 0 3 3V3Z" /><path d="M15 3a3 3 0 0 1 3 3 3 3 0 0 1 1 5 3 3 0 0 1-1 5 3 3 0 0 1-3 3V3Z" /></>,
  shield: <><path d="M12 3 5 6v5c0 4 3 7 7 9 4-2 7-5 7-9V6l-7-3Z" /></>,
  gauge: <><path d="M4 15a8 8 0 1 1 16 0" /><path d="M12 15l4-3" /><circle cx="12" cy="15" r="1.2" /></>,
  bell: <><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" /><path d="M10 20a2 2 0 0 0 4 0" /></>,
  scale: <><path d="M12 3v18" /><path d="M6 8h12" /><path d="M6 8l-3 6a3 3 0 0 0 6 0L6 8Z" /><path d="M18 8l-3 6a3 3 0 0 0 6 0l-3-6Z" /><path d="M8 21h8" /></>,
  flag: <><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  download: <><path d="M12 4v10M8 11l4 4 4-4" /><path d="M4 19h16" /></>,
  coins: <><ellipse cx="9" cy="7" rx="6" ry="3" /><path d="M3 7v5c0 1.7 2.7 3 6 3s6-1.3 6-3V7" /><path d="M9 15c0 1.7 2.7 3 6 3s6-1.3 6-3v-5" /><ellipse cx="15" cy="10" rx="6" ry="3" /></>,
}

export default function Icon({ name, size = 16, className = '', style }) {
  const p = paths[name]
  if (!p) return null
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
      className={'icon ' + className} style={style} aria-hidden="true"
    >
      {p}
    </svg>
  )
}
