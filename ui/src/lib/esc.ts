// HTMLエスケープ。JSX 経由でない生 HTML 文字列組み立て（EventBotTable の render セル等）でのみ必要
// — JSX は自動エスケープするため通常のコンポーネント本文では使わない。
export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
