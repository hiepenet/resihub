import { useMemo } from 'react';
import { useToastStore } from '../stores/toastStore';

export function useToast() {
  const addToast = useToastStore((s) => s.addToast);

  return useMemo(
    () => ({
      success: (message, title = 'Thành công') => addToast({ title, message, variant: 'success' }),
      error: (message, title = 'Có lỗi xảy ra') => addToast({ title, message, variant: 'error', duration: 5500 }),
      warning: (message, title = 'Lưu ý') => addToast({ title, message, variant: 'warning' }),
      info: (message, title = 'Thông báo') => addToast({ title, message, variant: 'info' }),
    }),
    [addToast]
  );
}

