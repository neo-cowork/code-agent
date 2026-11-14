import { useCallback, useEffect, type Dispatch, type KeyboardEvent, type RefObject, type SetStateAction } from 'react';
import type { ModelProvider } from '@shared/contract';
import type { RuntimeModelOption } from '@shared/modelRuntime';

interface NavigationOptions {
  open: boolean;
  searchQuery: string;
  selectableOptionCount: number;
  activeOptionIndex: number;
  setActiveOptionIndex: Dispatch<SetStateAction<number>>;
  filteredOptions: RuntimeModelOption[];
  handleSelect: (option: RuntimeModelOption) => void | Promise<void>;
  handleSelectAuto: () => void | Promise<void>;
  setOpen: Dispatch<SetStateAction<boolean>>;
  menuRef: RefObject<HTMLDivElement | null>;
  settingsLoaded: boolean;
  showModelSettingsPrompt: boolean;
  groupedFilteredOptions: readonly { options: readonly { option: Pick<RuntimeModelOption, 'model' | 'provider'>; index: number }[] }[];
  displayModel: string;
  displayProvider: ModelProvider;
  anchorPendingRef: RefObject<boolean>;
  listScrollRef: RefObject<HTMLDivElement | null>;
}

/** Keyboard navigation and the existing selected-model scroll anchor. */
export function useModelMenuNavigation({
  open, searchQuery, selectableOptionCount, activeOptionIndex, setActiveOptionIndex,
  filteredOptions, handleSelect, handleSelectAuto, setOpen, menuRef,
  settingsLoaded, showModelSettingsPrompt, groupedFilteredOptions,
  displayModel, displayProvider, anchorPendingRef, listScrollRef,
}: NavigationOptions) {
  useEffect(() => {
    if (!open) return;
    setActiveOptionIndex(0);
  }, [open, searchQuery]);

  useEffect(() => {
    if (!open || selectableOptionCount <= 0) return;
    setActiveOptionIndex((index) => Math.min(index, selectableOptionCount - 1));
  }, [open, selectableOptionCount]);

  useEffect(() => {
    if (!open || selectableOptionCount <= 0) return;
    const active = menuRef.current?.querySelector<HTMLElement>(`[data-model-option-index="${activeOptionIndex}"]`);
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeOptionIndex, open, selectableOptionCount]);

  const handleMenuKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    // 输入法合成期（中文/日文等选候选词）的回车/方向键交给输入法，不当弹窗快捷键，
    // 否则按回车选词会被误当"选中模型+关弹窗"。
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (selectableOptionCount <= 0) return;
      event.preventDefault();
      setActiveOptionIndex((index) => {
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        return (index + delta + selectableOptionCount) % selectableOptionCount;
      });
      return;
    }

    if (event.key === 'Enter') {
      if (selectableOptionCount <= 0) return;
      event.preventDefault();
      if (activeOptionIndex === 0) {
        void handleSelectAuto();
        return;
      }
      const option = filteredOptions[activeOptionIndex - 1];
      if (option) void handleSelect(option);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  }, [
    activeOptionIndex,
    filteredOptions,
    handleSelect,
    handleSelectAuto,
    selectableOptionCount,
  ]);

  // 打开面板时锚定到当前选中模型：等 modelSettings IPC 返回、列表二次渲染后执行一次。
  // 用 anchorPendingRef 保证每次打开只锚一次，搜索过滤（groupedFilteredOptions 变化）不重复锚定。
  useEffect(() => {
    if (!open) return;
    if (!settingsLoaded) {
      anchorPendingRef.current = true;
      return;
    }
    if (!anchorPendingRef.current) return;
    anchorPendingRef.current = false;
    if (showModelSettingsPrompt) return;
    let selectedIndex = 0;
    for (const group of groupedFilteredOptions) {
      const hit = group.options.find(
        ({ option }) => option.model === displayModel && option.provider === displayProvider,
      );
      if (hit) {
        selectedIndex = hit.index;
        break;
      }
    }
    // 键盘导航从当前选中项开始；无选中项时保持 0（「自动」）
    setActiveOptionIndex(selectedIndex);
    if (selectedIndex <= 0) return;
    // 直接设置内层滚动容器的 scrollTop 让选中行居中可见，避免 scrollIntoView 误滚外层页面
    const container = listScrollRef.current;
    const row = container?.querySelector<HTMLElement>(`[data-model-option-index="${selectedIndex}"]`);
    if (container && row) {
      container.scrollTop = row.offsetTop - (container.clientHeight - row.clientHeight) / 2;
    }
  }, [open, settingsLoaded, showModelSettingsPrompt, groupedFilteredOptions, displayModel, displayProvider]);

  return handleMenuKeyDown;
}
