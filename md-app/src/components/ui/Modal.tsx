import { type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** positioning/width overrides for the popup */
  className?: string;
  children: ReactNode;
}

export default function Modal({ open, onOpenChange, className, children }: Props) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-background/50 backdrop-blur-[2px]" />
        <Dialog.Popup
          className={
            "fixed left-1/2 -translate-x-1/2 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-2xl " +
            // Never taller than the viewport (short screens / soft keyboard):
            // the popup scrolls instead of clipping past the bottom edge.
            "max-h-[86dvh] overflow-y-auto " +
            (className ?? "top-1/3 w-80 max-w-[90vw]")
          }
        >
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
