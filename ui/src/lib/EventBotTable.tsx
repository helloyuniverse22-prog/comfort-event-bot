// window.EventBotTable（ベンダーバンドル・TanStack Table のソート/絞り込み/列並べ替え）への薄い橋渡し。
// React ラッパは導入しない（ADR 0019 と同じ判断: 既存の動作実績があるバンドルをそのまま使う）。
import { useEffect, useRef } from 'react';

declare global {
  interface Window {
    EventBotTable?: { mount: (el: HTMLElement, opts: Record<string, unknown>) => void };
  }
}

export function EventBotTable({ options }: { options: Record<string, unknown> }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current && window.EventBotTable) window.EventBotTable.mount(ref.current, options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);
  return <div ref={ref} />;
}
