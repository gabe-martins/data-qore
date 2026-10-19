import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Info } from "lucide-react";

export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [suppressed, setSuppressed] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState({ left: 16, top: 16 });
  const visible = (hovered || focused || pinned) && !suppressed;
  useLayoutEffect(() => {
    if (!visible) return;
    function place() {
      if (!button.current || !tooltip.current) return;
      const anchor = button.current.getBoundingClientRect();
      const box = tooltip.current.getBoundingClientRect();
      const below = anchor.bottom + box.height <= window.innerHeight - 16;
      setPosition({
        left: Math.max(16, Math.min(anchor.right - box.width, window.innerWidth - box.width - 16)),
        top: Math.max(16, Math.min(below ? anchor.bottom : anchor.top - box.height, window.innerHeight - box.height - 16)),
      });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [visible]);
  return (
    <span className="help-tip" onMouseEnter={() => { setSuppressed(false); setHovered(true); }}
      onMouseLeave={() => setHovered(false)} onBlur={e => {
        if (!e.currentTarget.contains(e.relatedTarget)) { setFocused(false); setPinned(false); setSuppressed(false); }
      }} onKeyDown={e => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setSuppressed(true); setPinned(false); }
      }}>
      <button ref={button} type="button" className="help-tip-button" aria-label={label}
        aria-describedby={visible ? id : undefined}
        onFocus={() => { setSuppressed(false); setFocused(true); }}
        onClick={() => { setSuppressed(pinned); setPinned(!pinned); }}>
        <Info size={17} aria-hidden="true" />
      </button>
      {visible && <span ref={tooltip} id={id} role="tooltip" className="help-tip-content" style={position}>{children}</span>}
    </span>
  );
}
