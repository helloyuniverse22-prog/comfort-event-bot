import { api } from '../api';
import { confirmDialog, withBusy } from './dialog';
import type { ToastFn } from '../App';

/**
 * サーバーが組み立てたメッセージ本文を confirmDialog の pre 表示で見せるだけの読み取り専用プレビュー。
 * busyBtn を渡すと取得中だけボタンを busy にする（ダイアログ表示中はラベルを戻す・M22）。
 */
export async function showPreview(url: string, title: string, toast: ToastFn, body?: string, busyBtn?: HTMLElement | null) {
  let r: { content?: unknown } | null;
  try {
    r = await withBusy(busyBtn ?? null, () => api(url, { method: 'POST', ...(body ? { body } : {}) }));
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true);
    return;
  }
  if (!r || typeof r.content !== 'string') {
    toast('プレビューを取得できませんでした', true);
    return;
  }
  await confirmDialog(r.content, { title, okLabel: '閉じる', cancelLabel: null, preformatted: true });
}
