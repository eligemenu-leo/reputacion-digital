import * as D from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** Panel lateral accesible (foco atrapado, Escape, aria-modal) basado en Radix. */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px] data-[state=open]:animate-[fade-in_150ms_ease-out]" />
        <D.Content
          className={cn(
            'fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-surface shadow-2xl focus:outline-none data-[state=open]:animate-[slide-in_200ms_cubic-bezier(.2,.8,.2,1)]',
            wide ? 'sm:max-w-2xl' : 'sm:max-w-lg',
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
            <div>
              <D.Title className="text-base font-semibold">{title}</D.Title>
              {description ? (
                <D.Description className="mt-0.5 text-sm text-muted">{description}</D.Description>
              ) : (
                <D.Description className="sr-only">{title}</D.Description>
              )}
            </div>
            <D.Close
              className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-fg"
              aria-label="Cerrar"
            >
              <X className="size-4" />
            </D.Close>
          </div>
          <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
          {footer && (
            <div className="flex justify-end gap-2 border-t border-border px-6 py-4">{footer}</div>
          )}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  danger,
  loading,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  danger?: boolean;
  loading?: boolean;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <D.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-6 shadow-2xl focus:outline-none">
          <D.Title className="text-base font-semibold">{title}</D.Title>
          <D.Description className="mt-2 text-sm text-muted">{description}</D.Description>
          <div className="mt-6 flex justify-end gap-2">
            <D.Close asChild>
              <button className="h-10 rounded-lg border border-border px-4 text-sm font-medium hover:bg-surface-2">
                Cancelar
              </button>
            </D.Close>
            <button
              onClick={onConfirm}
              disabled={loading}
              className={cn(
                'h-10 rounded-lg px-4 text-sm font-medium disabled:opacity-50',
                danger ? 'bg-danger text-white' : 'bg-accent text-accent-fg',
              )}
            >
              {confirmLabel}
            </button>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
