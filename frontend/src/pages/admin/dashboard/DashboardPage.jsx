import React, { useEffect, useState } from 'react';
import { Building2, Home, CheckCircle2, DollarSign, TrendingUp, Users, PlusCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Chart as ChartJS, ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement } from 'chart.js';
import { Doughnut } from 'react-chartjs-2';
import Button from '../../../components/ui/Button';
import Money from '../../../components/ui/Money';
import StatusBadge from '../../../components/ui/StatusBadge';
import api from '../../../services/api';

ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement);

export default function DashboardPage() {
  const navigate = useNavigate();
  const [stats, setStats] = useState({
    totalBuildings: 0,
    totalApartments: 0,
    availableApartments: 0,
    occupiedApartments: 0,
    totalRevenue: 0,
  });
  const [apartments, setApartments] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadData() {
      setIsLoading(true);
      try {
        const [bRes, aRes, cRes] = await Promise.all([
          api.get('/api/v1/buildings'),
          api.get('/api/v1/apartments'),
          api.get('/api/v1/contracts'),
        ]);

        const buildings = bRes.data?.data || [];
        const apts = aRes.data?.data || [];
        const contracts = cRes.data?.data || [];

        const available = apts.filter((a) => a.status === 'AVAILABLE').length;
        const occupied = apts.filter((a) => a.status === 'OCCUPIED').length;
        const totalRent = contracts.reduce((acc, c) => acc + (parseInt(c.rent_amount, 10) || 0), 0);

        setStats({
          totalBuildings: buildings.length,
          totalApartments: apts.length,
          availableApartments: available,
          occupiedApartments: occupied,
          totalRevenue: totalRent,
        });

        setApartments(apts.slice(0, 5));
      } catch (err) {
        console.error('Error loading dashboard:', err);
      } finally {
        setIsLoading(false);
      }
    }

    loadData();
  }, []);

  const occupancyRate = stats.totalApartments > 0
    ? Math.round((stats.occupiedApartments / stats.totalApartments) * 100)
    : 0;

  const chartData = {
    labels: ['Đang thuê', 'Có sẵn', 'Khác (Cọc / Bảo trì)'],
    datasets: [
      {
        data: [
          stats.occupiedApartments,
          stats.availableApartments,
          Math.max(0, stats.totalApartments - stats.occupiedApartments - stats.availableApartments),
        ],
        backgroundColor: ['#6366f1', '#10b981', '#f59e0b'],
        borderWidth: 0,
      },
    ],
  };

  return (
    <div className="space-y-6">
      {/* Top Banner & Quick Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 rounded-2xl p-6 text-white shadow-xl">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight">Tổng quan Vận hành</h2>
          <p className="text-xs sm:text-sm text-slate-300 mt-1">
            Theo dõi tỷ lệ lấp đầy, phòng trống và doanh thu thời gian thực
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => navigate('/admin/buildings')}
            leftIcon={PlusCircle}
            className="text-xs"
          >
            Tạo tòa nhà
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => navigate('/admin/contracts')}
            leftIcon={PlusCircle}
            className="text-xs shadow-md"
          >
            Lập hợp đồng
          </Button>
        </div>
      </div>

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Buildings */}
        <div className="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Tòa nhà quản lý</p>
            <h3 className="text-2xl font-bold text-slate-800 mt-1">{stats.totalBuildings}</h3>
            <p className="text-xs text-slate-400 mt-1">Hoạt động bình thường</p>
          </div>
          <div className="w-12 h-12 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center">
            <Building2 className="w-6 h-6" />
          </div>
        </div>

        {/* Card 2: Total Rooms */}
        <div className="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Tổng số căn hộ</p>
            <h3 className="text-2xl font-bold text-slate-800 mt-1">{stats.totalApartments}</h3>
            <p className="text-xs text-emerald-600 font-medium mt-1">
              {stats.availableApartments} căn sẵn sàng đón khách
            </p>
          </div>
          <div className="w-12 h-12 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center">
            <Home className="w-6 h-6" />
          </div>
        </div>

        {/* Card 3: Occupancy Rate */}
        <div className="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Tỷ lệ lấp đầy</p>
            <h3 className="text-2xl font-bold text-slate-800 mt-1">{occupancyRate}%</h3>
            <p className="text-xs text-slate-400 mt-1">Mục tiêu quý: ≥ 85%</p>
          </div>
          <div className="w-12 h-12 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center">
            <TrendingUp className="w-6 h-6" />
          </div>
        </div>

        {/* Card 4: Monthly Rent */}
        <div className="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Doanh thu thuê/tháng</p>
            <h3 className="text-xl font-bold text-slate-800 mt-1">
              <Money amount={stats.totalRevenue} />
            </h3>
            <p className="text-xs text-slate-400 mt-1">Dựa trên hợp đồng hiệu lực</p>
          </div>
          <div className="w-12 h-12 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center">
            <DollarSign className="w-6 h-6" />
          </div>
        </div>
      </div>

      {/* Middle Section: Chart & Quick List */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Doughnut Chart */}
        <div className="bg-white p-6 rounded-xl border border-slate-200/80 shadow-sm flex flex-col items-center justify-center">
          <h4 className="text-sm font-semibold text-slate-800 mb-4 self-start">Tỷ lệ Trạng thái Căn hộ</h4>
          <div className="w-48 h-48 relative">
            <Doughnut
              data={chartData}
              options={{
                cutout: '72%',
                plugins: {
                  legend: { display: false },
                },
              }}
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-2xl font-bold text-slate-800">{occupancyRate}%</span>
              <span className="text-[11px] text-slate-400">Lấp đầy</span>
            </div>
          </div>
          <div className="flex items-center gap-4 mt-6 text-xs text-slate-600">
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-indigo-500" />
              <span>Đang thuê ({stats.occupiedApartments})</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
              <span>Có sẵn ({stats.availableApartments})</span>
            </div>
          </div>
        </div>

        {/* Quick Apartment List */}
        <div className="lg:col-span-2 bg-white p-6 rounded-xl border border-slate-200/80 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h4 className="text-sm font-semibold text-slate-800">Căn hộ cập nhật gần đây</h4>
            <button
              onClick={() => navigate('/admin/buildings')}
              className="text-xs text-primary-600 hover:text-primary-700 font-semibold"
            >
              Xem tất cả →
            </button>
          </div>

          <div className="divide-y divide-slate-100">
            {apartments.map((apt) => (
              <div key={apt.id} className="py-3 flex items-center justify-between hover:bg-slate-50/50 px-2 rounded-lg transition-colors">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-slate-100 font-bold text-xs text-slate-700 flex items-center justify-center border border-slate-200">
                    {apt.code}
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-slate-800">
                      Căn {apt.code} · {apt.type || '1PN'}
                    </div>
                    <div className="text-xs text-slate-400">
                      Diện tích: {apt.area_m2} m² · {apt.floor_name || 'Tầng trệt'}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <Money amount={apt.base_rent} className="text-sm font-semibold text-slate-800" />
                  <StatusBadge status={apt.status} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
