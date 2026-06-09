import { fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it } from 'vitest';
import { useFocusTrap } from './useFocusTrap';

function TrapHarness({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, active);
  return (
    <div ref={ref}>
      <button type="button">first</button>
      <button type="button">middle</button>
      <button type="button">last</button>
    </div>
  );
}

describe('useFocusTrap', () => {
  it('wraps Tab from the last element back to the first', () => {
    const { getByText, container } = render(<TrapHarness active />);
    const first = getByText('first') as HTMLButtonElement;
    const last = getByText('last') as HTMLButtonElement;

    last.focus();
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(container.firstChild as HTMLElement, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
  });

  it('wraps Shift+Tab from the first element to the last', () => {
    const { getByText, container } = render(<TrapHarness active />);
    const first = getByText('first') as HTMLButtonElement;
    const last = getByText('last') as HTMLButtonElement;

    first.focus();
    fireEvent.keyDown(container.firstChild as HTMLElement, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('does nothing when inactive', () => {
    const { getByText, container } = render(<TrapHarness active={false} />);
    const last = getByText('last') as HTMLButtonElement;
    last.focus();
    fireEvent.keyDown(container.firstChild as HTMLElement, { key: 'Tab' });
    // Without the trap, the browser default would move focus; jsdom doesn't
    // emulate that, so focus simply stays on `last` — and crucially is NOT
    // forced back to `first` by our hook.
    expect(document.activeElement).toBe(last);
  });
});
