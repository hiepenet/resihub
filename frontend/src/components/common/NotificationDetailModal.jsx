import React from 'react';
import { Bell, Clock, ArrowRight } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { formatDateTime, formatRelativeTime } from '../../utils/format';

export function NotificationDetailModal({
  notification,
  open,
  onClose,
  fallbackUrl = null,
  fallbackLabel = 'Đi tới trang liên quan',
  onNavigateFallback,
}) {
  if (!notification) return null;

  const payload =
    notification.payload && typeof notification.payload === 'object' ? notification.payload : {};

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Chi tiết thông báo"
      size="md"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Đóng
          </Button>
          {fallbackUrl && onNavigateFallback ? (
            <Button
              variant="primary"
              icon={ArrowRight}
              onClick={() => {
                onClose?.();
                onNavigateFallback(fallbackUrl);
              }}
            >
              {fallbackLabel}
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary-50 text-primary-600 border border-primary-100 flex items-center justify-center shrink-0">
            <Bell className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <Badge variant="sky">{notification.type || 'THÔNG BÁO'}</Badge>
              {payload.sender_name ? (
                <span className="text-xs text-slate-500">
                  Từ: <strong className="text-slate-700">{payload.sender_name}</strong>
                </span>
              ) : null}
            </div>
            <h3 className="text-base font-bold text-slate-900 break-words leading-snug">
              {notification.title}
            </h3>
            {notification.created_at ? (
              <p className="text-xs text-slate-400 mt-1 inline-flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" />
                {formatRelativeTime(notification.created_at)} ({formatDateTime(notification.created_at)})
              </p>
            ) : null}
          </div>
        </div>

        <div className="p-4 rounded-xl bg-slate-50 border border-slate-200/80 text-sm text-slate-700 whitespace-pre-line leading-relaxed break-words">
          {notification.content || 'Không có nội dung chi tiết.'}
        </div>
      </div>
    </Modal>
  );
}

export default NotificationDetailModal;

