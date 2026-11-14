import { useEffect, useRef, type ReactNode } from 'react';

/** Accessible modal: role=dialog, Escape closes, focus moves into the dialog and returns on close. */
export function Modal({ title, titleId, onClose, children, wide }: { title: string; titleId: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => previous?.focus?.();
  }, []);
  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} className={wide ? 'dialog dialog-wide' : 'dialog'}
           onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}
