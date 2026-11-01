import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { EditorView } from "@codemirror/view";

/** Surfaces whose right-click menu gains cut/paste/select-all. */
const EDITABLE = "input, textarea, [contenteditable], .cm-editor";

type MenuState = {
  x: number;
  y: number;
  /** Element the menu was opened on — the actions operate on it. */
  target: HTMLElement;
  /** Cut/Paste/Select All only make sense on editable surfaces. */
  editable: boolean;
  /** Snapshot at open time; the actions re-read the live selection. */
  hasSelection: boolean;
};

/* ── clipboard primitives ────────────────────────────────────────────────
   Every action first focuses the target, then prefers document.execCommand:
   unlike the plugin round-trip it goes through the engine's own edit path,
   which keeps CodeMirror's internal clipboard and input undo stacks intact.
   execCommand needs user activation, so the Tauri clipboard plugin is the
   fallback (and the only way to READ the clipboard in the first place). */

const cmViewFor = (target: HTMLElement) => {
  const host = target.closest(".cm-editor");
  return host instanceof HTMLElement ? EditorView.findFromDOM(host) : null;
};

/** Selection text across engines: window selection, or an input/textarea's
    own selection range (not all engines expose it through getSelection). */
function selectionTextOf(target: HTMLElement): string {
  const text = document.getSelection()?.toString() ?? "";
  if (text) return text;
  const el = target.closest<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
  if (el) return el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);
  return "";
}

function focusEditable(target: HTMLElement) {
  const view = cmViewFor(target);
  if (view) {
    view.focus();
    return;
  }
  target.closest<HTMLElement>(EDITABLE)?.focus();
}

async function copySelection(target: HTMLElement) {
  focusEditable(target);
  if (document.execCommand("copy")) return;
  const text = selectionTextOf(target);
  if (text) await writeText(text);
}

async function cutSelection(target: HTMLElement) {
  focusEditable(target);
  if (document.execCommand("cut")) return;
  const text = selectionTextOf(target);
  if (!text) return;
  await writeText(text);
  const view = cmViewFor(target);
  if (view) {
    view.dispatch(view.state.replaceSelection(""));
    view.focus();
  } else {
    document.execCommand("delete");
  }
}

async function pasteClipboard(target: HTMLElement) {
  const text = await readText();
  const view = cmViewFor(target);
  if (view) {
    view.dispatch(view.state.replaceSelection(text));
    view.focus();
    return;
  }
  focusEditable(target);
  if (document.execCommand("insertText", false, text)) return;
  // Last resort for engines that refuse execCommand: splice the value and
  // re-announce it so controlled React inputs pick up the change.
  const el = target.closest<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
  if (!el) return;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.setRangeText(text, start, end, "end");
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function selectAllIn(target: HTMLElement) {
  const el = target.closest<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
  if (el) {
    el.focus();
    el.select();
    return;
  }
  const view = cmViewFor(target);
  if (view) {
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    view.focus();
    return;
  }
  focusEditable(target);
  document.execCommand("selectAll");
}

/* The app's only context menu for clipboard actions — identical items and
   labels on macOS, Windows and Linux, replacing the per-engine webview menus
   (WebKitGTK's GTK menu, WebView2's Chrome menu, WKWebView's none-at-all).
   Keyboard shortcuts stay native everywhere: Ctrl/Cmd+C X V reach the page
   through the engine itself (macOS additionally through the Edit menu that
   src-tauri/src/lib.rs installs). Non-editable targets without a selection
   still get no menu, as before. */

export default function ClipboardMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      // Base UI context menus (FileTree rows) claim the event when they open
      // their own menu — never stack ours on top of theirs.
      const claimed = e.defaultPrevented;
      e.preventDefault();
      if (claimed) return;
      const el = e.target as HTMLElement | null;
      if (!el) return;
      const editable = !!el.closest(EDITABLE);
      const hasSelection = selectionTextOf(el).length > 0;
      if (!editable && !hasSelection) return;
      setMenu({ x: e.clientX, y: e.clientY, target: el, editable, hasSelection });
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // Dismiss on any outside interaction; Escape hands focus back to the
  // target so a closed menu never steals it from the editor.
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest("[data-clipboard-menu]")) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (menu.editable) focusEditable(menu.target);
        setMenu(null);
      }
    };
    const dismiss = () => setMenu(null);
    window.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open/close transition only
  }, [menu !== null]);

  // Clamp into the viewport once the box has its real size, and take focus
  // so the arrow keys work right away (actions/Escape hand it back).
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!menu || !box) return;
    const r = box.getBoundingClientRect();
    setPos({
      x: Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8)),
    });
    box.focus();
  }, [menu]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const items = Array.from(
      boxRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
    );
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" && items.length) {
      e.preventDefault();
      items[(idx + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp" && items.length) {
      e.preventDefault();
      items[(idx - 1 + items.length) % items.length]?.focus();
    }
  };

  if (!menu) return null;

  const run = (action: () => void | Promise<void>) => {
    setMenu(null);
    Promise.resolve(action()).catch(() => {
      /* clipboard denied/unavailable — fail quietly, like a native menu */
    });
  };

  const items: Array<{ label: string; disabled: boolean; action: () => void | Promise<void> }> = [
    {
      label: "Cut",
      disabled: !menu.editable || !menu.hasSelection,
      action: () => cutSelection(menu.target),
    },
    {
      label: "Copy",
      disabled: !menu.hasSelection,
      action: () => copySelection(menu.target),
    },
    {
      label: "Paste",
      disabled: !menu.editable,
      action: () => pasteClipboard(menu.target),
    },
    {
      label: "Select All",
      disabled: !menu.editable,
      action: () => selectAllIn(menu.target),
    },
  ];

  return (
    <div
      ref={boxRef}
      data-clipboard-menu
      role="menu"
      aria-label="Clipboard"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-50 min-w-44 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none"
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => run(item.action)}
          className="flex w-full cursor-default items-center rounded-sm px-2 py-1 text-left text-[13px] outline-none select-none hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-40"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
