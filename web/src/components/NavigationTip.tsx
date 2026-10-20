import { cloneElement, useId, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

export function NavigationTip({ label, enabled, children }: { label: string; enabled: boolean; children: ReactElement<{ 'aria-describedby'?: string }> }) {
  const id = useId(), anchor = useRef<HTMLSpanElement>(null);
  const [hover, setHover] = useState(false), [focus, setFocus] = useState(false), [dismissed, setDismissed] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const visible = enabled && (hover || focus) && !dismissed;
  useLayoutEffect(() => {
    if (!visible) return;
    const place = () => {
      const box = anchor.current?.getBoundingClientRect();
      if (box) setPosition({ left: box.right + 10, top: Math.max(8, Math.min(box.top + box.height / 2, innerHeight - 24)) });
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [visible]);
  return <span ref={anchor} className="navigation-tip" onMouseEnter={() => { setHover(true); setDismissed(false); }} onMouseLeave={() => setHover(false)}
    onFocus={() => { setFocus(true); setDismissed(false); }} onBlur={() => setFocus(false)}
    onKeyDown={event => { if (visible && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDismissed(true); } }}>
    {cloneElement(children, { 'aria-describedby': visible ? id : undefined })}
    {visible && createPortal(<span role="tooltip" id={id} className="navigation-tooltip" style={position}>{label}</span>, document.body)}
  </span>;
}
