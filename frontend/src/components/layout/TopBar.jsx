import React, { useEffect, useState } from 'react';
import { Menu, Building2, Bell, CheckCircle2, ChevronDown } from 'lucide-react';
import api from '../../services/api';

export default function TopBar({ onMenuClick }) {
  const [buildings, setBuildings] = useState([]);
  const [selectedBuildingId, setSelectedBuildingId] = useState('');
  const [systemHealth, setSystemHealth] = useState('checking');

  useEffect(() => {
    // Check health
    api.get('/api/health')
      .then(() => setSystemHealth('healthy'))
      .catch(() => setSystemHealth('error'));

    // Fetch buildings for switcher
    api.get('/api/v1/buildings')
      .then((res) => {
        const list = res.data?.data || [];
        setBuildings(list);
        if (list.length > 0 && !selectedBuildingId) {
          setSelectedBuildingId(list[0].id);
        }
      })
      .catch(() => {});
  }, []);

  return (
    <header className="h-16 bg-white border-b border-surface-border px-4 sm:px-6 flex items-center justify-between sticky top-0 z-30 shadow-sm">
      <div className="flex items-center gap-3">
        {/* Mobile menu toggle */}
        <button
          onClick={onMenuClick}
          className="p-2 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 lg:hidden"
        >
          <Menu className="w-5 h-5" />
        </button>

        {/* Building Switcher (PRD 8.2) */}
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary-50 text-primary-600 flex items-center justify-center">
            <Building2 className="w-4 h-4" />
          </div>
          <div className="relative">
            <select
              value={selectedBuildingId}
              onChange={(e) => setSelectedBuildingId(e.target.value)}
              className="appearance-none bg-slate-50 border border-slate-200 text-slate-800 text-xs sm:text-sm font-semibold rounded-lg pl-3 pr-8 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-500 cursor-pointer"
            >
              {buildings.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.code})
                </option>
              ))}
              {buildings.length === 0 && (
                <option value="">Đang tải tòa nhà...</option>
              )}
            </select>
            <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>
        </div>
      </div>

      {/* Right Actions */}
      <div className="flex items-center gap-3">
        {/* System API Status */}
        <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border bg-emerald-50 text-emerald-700 border-emerald-200">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
          <span>API 200 OK</span>
        </div>

        {/* Notification Bell */}
        <button className="relative p-2 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors">
          <Bell className="w-5 h-5" />
          <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-red-500" />
        </button>
      </div>
    </header>
  );
}
