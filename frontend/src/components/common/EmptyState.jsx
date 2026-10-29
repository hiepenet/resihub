import React from 'react';
import { Inbox } from 'lucide-react';

export function EmptyState({ icon: Icon = Inbox, title = 'Chưa có dữ liệu', description, action }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6">
      <div className="w-12 h-12 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center mb-3.5">
        <Icon className="w-6 h-6" />
      </div>
      <h4 className="text-sm font-semibold text-slate-800">{title}</h4>
      {description ? <p className="text-xs text-slate-500 max-w-sm mt-1 leading-relaxed">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export default EmptyState;

