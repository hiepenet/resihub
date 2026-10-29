import React from 'react';
import { ShieldAlert, ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../ui/Button';

export function AccessDenied({ message = 'Bạn không có quyền truy cập vào trang hoặc tài nguyên này.' }) {
  const navigate = useNavigate();
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-4">
      <div className="w-14 h-14 rounded-2xl bg-rose-50 text-rose-600 flex items-center justify-center mb-4">
        <ShieldAlert className="w-7 h-7" />
      </div>
      <h2 className="text-lg font-semibold text-slate-900">Truy cập bị từ chối (403)</h2>
      <p className="text-sm text-slate-500 max-w-md mt-1.5">{message}</p>
      <div className="mt-5">
        <Button variant="outline" icon={ArrowLeft} onClick={() => navigate(-1)}>
          Quay lại
        </Button>
      </div>
    </div>
  );
}

export default AccessDenied;

