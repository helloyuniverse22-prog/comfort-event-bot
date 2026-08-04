// 大きいフォーム用モーダル（ネイティブ <dialog class="modal-lg">）。DS の <Modal> は確認用の
// 小さい `.modal` 専用のため、区分/臨時回など編集フォームのオーバーレイはこちらを使う。
import * as React from 'react';
import { useEffect, useRef } from 'react';

export function FormDialog({
  open,
  title,
  onClose,
  footer,
  children,
}: {
  open: boolean;
  title: React.ReactNode;
  onClose: () => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (open && !dlg.open) dlg.showModal();
    if (!open && dlg.open) dlg.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="modal-lg"
      aria-labelledby="formDialogTitle"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="modal-head">
        <h3 id="formDialogTitle">{title}</h3>
        <button type="button" className="modal-close" aria-label="閉じる" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-foot">{footer}</div>}
    </dialog>
  );
}
