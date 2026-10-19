import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
export const Dialog = DialogPrimitive.Root;
export function DialogContent({
  title,
  description,
  children,
}: React.PropsWithChildren<{ title: string; description: string }>) {
  const previous = React.useRef(document.activeElement as HTMLElement | null);
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="dialog-overlay" />
      <DialogPrimitive.Content
        className="dialog-content"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          previous.current?.focus();
        }}
      >
        <DialogPrimitive.Title className="dialog-title">
          {title}
        </DialogPrimitive.Title>
        <DialogPrimitive.Description className="muted">
          {description}
        </DialogPrimitive.Description>
        <DialogPrimitive.Close
          className="icon-button dialog-close"
          aria-label="Close"
        >
          <X size={22} />
        </DialogPrimitive.Close>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
