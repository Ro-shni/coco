import { useEffect, useRef, useState } from 'react';

export interface MenuItem { label: string; onSelect: () => void; danger?: boolean }

export function ActionMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  return (
    <div className="menu-wrap" ref={wrap} onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}>
      <button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>…</button>
      {open && (
        <ul className="menu" role="menu">
          {items.map((it) => (
            <li key={it.label} role="none">
              <button type="button" role="menuitem" className={it.danger ? 'menu-item danger' : 'menu-item'} onClick={() => { setOpen(false); it.onSelect(); }}>{it.label}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
