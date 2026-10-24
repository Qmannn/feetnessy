import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';

export default function Modal({ title, children, onClose, busy = false }: {
  title: string; children: ReactNode; onClose: () => void; busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog?.showModal();
    return () => { dialog?.close(); if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  return <dialog ref={ref} className="modal" aria-labelledby="modal-title" onCancel={event => {
    event.preventDefault(); if (!busy) onClose();
  }}>
    <div className="modal-heading"><h2 id="modal-title">{title}</h2><button className="icon-button" aria-label="Закрыть" disabled={busy} onClick={onClose}><X size={20} /></button></div>
    {children}
  </dialog>;
}
