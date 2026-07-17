import { useRef, type KeyboardEvent, type ReactNode } from "react";

// Arrow-key navigation for a group of buttons (segmented toggles, pill rows,
// card grids). Wrap the group's container: Left/Up and Right/Down move focus
// between the visible, enabled buttons inside; Enter/Space then activate the
// focused one natively. Tab order is untouched — this only adds arrows.
//
// Purely DOM-driven (no per-child wiring), so it works around any existing
// markup: plain <button>s, mixed content, dynamically-shown options.
export function ArrowKeyGroup({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const dir =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (dir === 0 || !ref.current) return;
    // Don't steal arrows from fields that use them natively.
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

    const items = Array.from(
      ref.current.querySelectorAll<HTMLButtonElement>("button:not([disabled])"),
    ).filter((b) => b.offsetParent !== null);
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    if (idx < 0) return;
    e.preventDefault();
    items[(idx + dir + items.length) % items.length]!.focus();
  }

  return (
    <div ref={ref} onKeyDown={onKeyDown} className={className}>
      {children}
    </div>
  );
}
