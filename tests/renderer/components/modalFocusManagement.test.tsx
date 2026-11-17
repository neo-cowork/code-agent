// @vitest-environment jsdom

import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Modal } from '../../../src/renderer/components/primitives/Modal';

afterEach(cleanup);

describe('Modal backdrop', () => {
  it('浅色使用中等阴影，深色保留强阴影', () => {
    render(
      <Modal isOpen title="Shadow test">
        content
      </Modal>,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('shadow-md');
    expect(dialog.className).toContain('dark:shadow-2xl');
  });

  it('点 backdrop 调 onClose（默认 closeOnBackdropClick=true）；点弹层容器自身不调', () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen title="Backdrop test" onClose={onClose}>
        Dialog content
      </Modal>
    );

    const dialog = screen.getByRole('dialog');
    // backdrop = Modal 根 overlay 的第一个子元素（dialog 的兄弟）
    const backdrop = dialog.parentElement?.firstElementChild as Element;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closeOnBackdropClick=false 时点 backdrop 不调 onClose', () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen title="Backdrop disabled" onClose={onClose} closeOnBackdropClick={false}>
        Dialog content
      </Modal>
    );

    const dialog = screen.getByRole('dialog');
    const backdrop = dialog.parentElement?.firstElementChild as Element;
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Modal focus management', () => {
  it('wraps Tab forward and Shift+Tab backward within the dialog', () => {
    render(
      <Modal isOpen title="Focus test" showCloseButton={false}>
        <button>First action</button>
        <button>Last action</button>
      </Modal>
    );

    const first = screen.getByRole('button', { name: 'First action' });
    const last = screen.getByRole('button', { name: 'Last action' });

    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('restores focus to the trigger when the dialog closes', () => {
    const Harness = () => {
      const [isOpen, setIsOpen] = useState(false);

      return (
        <>
          <button onClick={() => setIsOpen(true)}>Open dialog</button>
          <Modal isOpen={isOpen} onClose={() => setIsOpen(false)} title="Restore focus">
            Dialog content
          </Modal>
        </>
      );
    };

    render(<Harness />);

    const trigger = screen.getByRole('button', { name: 'Open dialog' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));

    expect(document.activeElement).toBe(trigger);
  });

  it('uses a title-less custom header as the accessible dialog name', () => {
    render(
      <Modal isOpen header={<h2>Custom settings</h2>}>
        Dialog content
      </Modal>
    );

    expect(screen.getByRole('dialog', { name: 'Custom settings' })).toBeTruthy();
  });

  it('closes stacked modals one at a time and keeps body scroll locked', () => {
    const Harness = () => {
      const [isOuterOpen, setIsOuterOpen] = useState(true);
      const [isInnerOpen, setIsInnerOpen] = useState(false);

      return (
        <Modal
          isOpen={isOuterOpen}
          onClose={() => setIsOuterOpen(false)}
          title="Outer dialog"
        >
          <button onClick={() => setIsInnerOpen(true)}>Open inner dialog</button>
          <Modal
            isOpen={isInnerOpen}
            onClose={() => setIsInnerOpen(false)}
            title="Inner dialog"
          >
            Inner content
          </Modal>
        </Modal>
      );
    };

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open inner dialog' }));

    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Inner dialog' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Outer dialog' })).toBeTruthy();
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Outer dialog' })).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });
});


describe('Modal Escape handled marker', () => {
  it('marks a cancelable Escape only when the top modal handles it and still bubbles', () => {
    const outerClose = vi.fn();
    const innerClose = vi.fn();
    const observe = vi.fn();
    const { rerender } = render(
      <Modal isOpen onClose={outerClose}>
        <Modal isOpen={false} onClose={innerClose}>Inner</Modal>
      </Modal>
    );
    rerender(
      <Modal isOpen onClose={outerClose}>
        <Modal isOpen onClose={innerClose}>Inner</Modal>
      </Modal>
    );
    window.addEventListener('keydown', observe);
    try {
      const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      fireEvent(document, escape);
      expect(escape.defaultPrevented).toBe(true);
      expect(innerClose).toHaveBeenCalledTimes(1);
      expect(outerClose).not.toHaveBeenCalled();
      expect(observe).toHaveBeenCalledTimes(1);
      rerender(
        <Modal isOpen onClose={outerClose}>
          <Modal isOpen closeOnEsc={false} onClose={innerClose}>Inner</Modal>
        </Modal>
      );
      const ignored = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      fireEvent(document, ignored);
      expect(ignored.defaultPrevented).toBe(false);
      expect(innerClose).toHaveBeenCalledTimes(1);
      expect(outerClose).not.toHaveBeenCalled();
      rerender(<Modal isOpen>Without a close handler</Modal>);
      const noHandler = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      fireEvent(document, noHandler);
      expect(noHandler.defaultPrevented).toBe(false);
    } finally {
      window.removeEventListener('keydown', observe);
    }
  });
});

describe('Modal keyboard scrolling', () => {
  const setup = () => {
    render(
      <Modal isOpen title="Scroll test">
        <input aria-label="field" />
        <button>inner</button>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    const content = screen.getByLabelText('field').parentElement as HTMLElement;
    Object.defineProperty(content, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(content, 'scrollHeight', { value: 2000, configurable: true });
    const scrollBy = vi.fn();
    const scrollTo = vi.fn();
    content.scrollBy = scrollBy as unknown as typeof content.scrollBy;
    content.scrollTo = scrollTo as unknown as typeof content.scrollTo;
    return { dialog, content, scrollBy, scrollTo };
  };

  it('dialog container keys scroll the content layer and are default-prevented', () => {
    const { dialog, scrollBy, scrollTo } = setup();
    expect(fireEvent.keyDown(dialog, { key: 'PageDown' })).toBe(false);
    expect(scrollBy).toHaveBeenLastCalledWith({ top: 360 });
    fireEvent.keyDown(dialog, { key: 'PageUp' });
    expect(scrollBy).toHaveBeenLastCalledWith({ top: -360 });
    fireEvent.keyDown(dialog, { key: ' ' });
    expect(scrollBy).toHaveBeenLastCalledWith({ top: 360 });
    fireEvent.keyDown(dialog, { key: ' ', shiftKey: true });
    expect(scrollBy).toHaveBeenLastCalledWith({ top: -360 });
    const arrow = scrollBy.mock.calls.length;
    fireEvent.keyDown(dialog, { key: 'ArrowDown' });
    fireEvent.keyDown(dialog, { key: 'ArrowUp' });
    expect(scrollBy.mock.calls[arrow][0].top).toBeGreaterThan(0);
    expect(scrollBy.mock.calls[arrow + 1][0].top).toBeLessThan(0);
    fireEvent.keyDown(dialog, { key: 'Home' });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0 });
    fireEvent.keyDown(dialog, { key: 'End' });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 2000 });
  });

  it('keys targeting controls inside the content are not intercepted', () => {
    const { scrollBy, scrollTo } = setup();
    expect(fireEvent.keyDown(screen.getByLabelText('field'), { key: ' ' })).toBe(true);
    expect(fireEvent.keyDown(screen.getByText('inner'), { key: 'PageDown' })).toBe(true);
    expect(scrollBy).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('modifier keys are not intercepted', () => {
    const { dialog, scrollBy, scrollTo } = setup();
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(fireEvent.keyDown(dialog, { key: 'PageDown', ...mod })).toBe(true);
      expect(fireEvent.keyDown(dialog, { key: 'End', ...mod })).toBe(true);
    }
    expect(scrollBy).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
