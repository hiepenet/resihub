import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title = 'Xác nhận thao tác',
  message,
  confirmLabel = 'Xác nhận',
  cancelLabel = 'Hủy bỏ',
  variant = 'danger',
  loading = false,
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button variant={variant} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex items-start gap-3.5">
        <div
          className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
            variant === 'danger' ? 'bg-rose-50 text-rose-600' : 'bg-amber-50 text-amber-600'
          }`}
        >
          <AlertTriangle className="w-5 h-5" />
        </div>
        <p className="text-sm text-slate-600 leading-relaxed pt-1">{message}</p>
      </div>
    </Modal>
  );
}

export default ConfirmDialog;

