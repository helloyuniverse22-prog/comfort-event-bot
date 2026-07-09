import { api } from '../api';
import { confirmDialog } from './dialog';
import type { ToastFn } from '../App';

/** サーバーが組み立てたメッセージ本文を confirmDialog の pre 表示で見せるだけの読み取り専用プレビュー。 */
export async function showPreview(url: string, title: string, toast: ToastFn, body?: string) {
  try {
    const r = await api(url, { method: 'POST', ...(body ? { body } : {}) });
    if (!r || typeof r.content !== 'string') {
      toast('プレビューを取得できませんでした', true);
      return;
    }
    await confirmDialog(r.content, { title, okLabel: '閉じる', cancelLabel: null, preformatted: true });
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true);
  }
}
