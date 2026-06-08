import { useEffect, type RefObject } from 'react';

/** Elements that can receive keyboard focus inside a modal/drawer. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Traps Tab / Shift-Tab focus inside `containerRef` while `active` is true.
 *
 * Modals already handle Escape + initial focus individually; this closes the
 * remaining a11y gap where Tab could move focus into the inert content behind
 * an open dialog. No-op when inactive, so it's safe to call unconditionally.
 *
 * Cycles forward off the last element back to the first (and backward off the
 * first to the last). If the container has no focusable children the keydown
 * is simply swallowed so focus can't escape.
 */
export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      // No visibility filtering: querying inside an already-open dialog,
      // every focusable descendant is on-screen, and `offsetParent`-based
      // checks misbehave for `position: fixed` modals across browsers.
      const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;

      if (e.shiftKey) {
        if (activeEl === first || !container.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else if (activeEl === last || !container.contains(activeEl)) {
        e.preventDefault();
        first.focus();
      }
    };

    container.addEventListener('keydown', onKeyDown);
    return () => container.removeEventListener('keydown', onKeyDown);
  }, [containerRef, active]);
}
