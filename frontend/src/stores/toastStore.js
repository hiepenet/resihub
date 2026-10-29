import { create } from 'zustand';

let nextToastId = 1;

export const useToastStore = create((set) => ({
  toasts: [],
  addToast: ({ title, message, variant = 'info', duration = 4000 }) => {
    const id = nextToastId++;
    set((state) => ({
      toasts: [...state.toasts, { id, title, message, variant }],
    }));
    if (duration > 0) {
      setTimeout(() => {
        set((state) => ({
          toasts: state.toasts.filter((t) => t.id !== id),
        }));
      }, duration);
    }
    return id;
  },
  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),
}));

