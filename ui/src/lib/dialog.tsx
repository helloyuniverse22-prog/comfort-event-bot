// 共通UI: 確認モーダル。旧 confirmDialog()/withBusy() と同じ呼び出し規約
// （グローバル関数として import して await するだけ）を維持しつつ React 化。
// <ConfirmHost/> を App ルートに1つだけ置き、confirmDialog() はそれと singleton で通信する。
import * as React from 'react';
import { useEffect, useRef, useState } from 'react';

export type ConfirmOpts = {
  title?: string;
  okLabel?: string;
  cancelLabel?: string | null; // null = キャンセルボタン非表示
  danger?: boolean;
  preformatted?: boolean; // true: 改行・空白を保持する <pre>（プレビュー用途）
};

type Request = { message: string; opts: ConfirmOpts; resolve: (v: boolean) => void };

let enqueue: ((req: Request) => void) | null = null;

export function confirmDialog(message: string, opts: ConfirmOpts = {}): Promise<boolean> {
  return new Promise((resolve) => {
    if (!enqueue) {
      console.warn('ConfirmHost not mounted');
      resolve(false);
      return;
    }
    enqueue({ message, opts, resolve });
  });
}

export function ConfirmHost() {
  const [req, setReq] = useState<Request | null>(null);
  const dlgRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    enqueue = (r) => setReq(r);
    return () => {
      enqueue = null;
    };
  }, []);

  useEffect(() => {
    const dlg = dlgRef.current;
    if (!dlg) return;
    if (req && !dlg.open) dlg.showModal();
    if (!req && dlg.open) dlg.close();
  }, [req]);

  const close = (val: boolean) => {
    req?.resolve(val);
    setReq(null);
  };

  return (
    <dialog
      ref={dlgRef}
      className="modal"
      aria-label="確認"
      onCancel={(e) => {
        e.preventDefault();
        close(false);
      }}
      onClick={(e) => {
        if (e.target === dlgRef.current) close(false);
      }}
    >
      {req && (
        <>
          <h3>{req.opts.title || '確認'}</h3>
          {req.opts.preformatted ? <pre className="dialog-preview">{req.message}</pre> : <p style={{ whiteSpace: 'pre-line' }}>{req.message}</p>}
          <div className="actions">
            {req.opts.cancelLabel !== null && (
              <button className="btn ghost" onClick={() => close(false)}>
                {req.opts.cancelLabel || 'キャンセル'}
              </button>
            )}
            <button className={'btn ' + (req.opts.danger ? 'danger' : '')} autoFocus onClick={() => close(true)}>
              {req.opts.okLabel || 'OK'}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}

/** ボタンに busy 状態（disabled + .busy）を付与しつつ非同期処理を実行する。 */
export async function withBusy<T>(btn: HTMLElement | null, fn: () => Promise<T>): Promise<T> {
  if (!btn) return fn();
  const wasDisabled = (btn as HTMLButtonElement).disabled;
  btn.classList.add('busy');
  (btn as HTMLButtonElement).disabled = true;
  try {
    return await fn();
  } finally {
    btn.classList.remove('busy');
    (btn as HTMLButtonElement).disabled = wasDisabled;
  }
}
