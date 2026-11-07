import type { ReactNode } from "react";

export function PanelHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-8 shrink-0 items-center justify-between pr-2 pl-4">
      <h2 className="text-xs font-medium text-muted-foreground">{title}</h2>
      <div className="flex items-center gap-0.5">{children}</div>
    </div>
  );
}
