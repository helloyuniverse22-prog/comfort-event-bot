// SortableJS の薄いフック包装（ADR 0019: react ラッパは導入せず既存 sortablejs を流用）。
// メンバー配置ボードは D&D 中 SortableJS が DOM を直接操作するため非制御（uncontrolled）。
// React 側は初回描画のみ担当し、以降は DOM を直接読み書きする（旧実装と同じ設計）。
declare global {
  interface Window {
    Sortable?: {
      create: (el: HTMLElement, opts: Record<string, unknown>) => { destroy: () => void };
    };
  }
}

export function createSortableGroup(
  containerEls: HTMLElement[],
  onChange: () => void,
): { destroy: () => void } {
  if (typeof window.Sortable === 'undefined') {
    console.warn('SortableJS not loaded');
    return { destroy: () => {} };
  }
  const instances = containerEls.map((el) =>
    window.Sortable!.create(el, {
      group: 'grouping',
      animation: 150,
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      filter: '.order-no', // 行頭ラベルはクリック編集するのでドラッグ開始対象から除外
      preventOnFilter: false,
      onEnd: onChange,
      onAdd: onChange,
      onUpdate: onChange,
      onSort: onChange,
    }),
  );
  return {
    destroy: () => {
      for (const s of instances) {
        try {
          s.destroy();
        } catch {}
      }
    },
  };
}
