import React, { useEffect, useState, useMemo } from 'react';
import {
  Building2,
  Home,
  CheckCircle2,
  DollarSign,
  TrendingUp,
  Users,
  PlusCircle,
  ShieldCheck,
  FileText,
  ArrowRight,
  Filter,
  RefreshCw,
  Clock,
  Briefcase,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  Chart as ChartJS,
  ArcElement,
  Tooltip,
  Legend,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
} from 'chart.js';
import { Doughnut, Bar } from 'react-chartjs-2';
import Button from '../../../components/ui/Button';
import Money from '../../../components/ui/Money';
import StatusBadge from '../../../components/ui/StatusBadge';
import AccessDenied from '../../../components/common/AccessDenied';
import api from '../../../services/api';
import { useAuthStore } from '../../../stores/authStore';

ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement, Title);

export default function DashboardPage() {
  const navigate = useNavigate();
  const { getCurrentRole } = useAuthStore();
  const currentRole = getCurrentRole();

  // Phân quyền Dashboard theo yêu cầu:
  // - MANAGER: R (tòa của mình quản lý), CRU (tạo tòa, tạo hợp đồng)
  // - OWNER: R (toàn bộ tòa thuộc sở hữu - Read-only, không được tạo)
  // - RESIDENT: Chặn truy cập
  if (currentRole === 'RESIDENT') {
    return (
      <AccessDenied
        currentRole={currentRole}
        allowedRoles={['OWNER', 'MANAGER']}
      />
    );
  }

  const isOwner = currentRole === 'OWNER';
  const isManager = currentRole === 'MANAGER';

  const canViewContracts = true;
  const canViewFinancials = true;
  const canCreateBuilding = isManager; // Manager CRU, Owner R
  const canCreateContract = isManager; // Manager CRU, Owner R

  // Raw data from database
  const [buildings, setBuildings] = useState([]);
  const [apartments, setApartments] = useState([]);
  const [contracts, setContracts] = useState([]);
  const [deposits, setDeposits] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [reservations, setReservations] = useState([]);

  // UI state
  const [selectedBuildingId, setSelectedBuildingId] = useState('ALL');
  const [activeTab, setActiveTab] = useState('apartments'); // 'apartments' | 'contracts' | 'reservations'
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Load live data from backend based on role
  const loadData = async (showRefresh = false) => {
    if (showRefresh) setIsRefreshing(true);
    else setIsLoading(true);

    try {
      const promises = [
        api.get('/api/v1/buildings'),
        api.get('/api/v1/apartments'),
      ];

      // Chỉ tải hợp đồng và cọc nếu vai trò được phép (tránh lỗi 403 cho STAFF theo PRD 6.2)
      if (canViewContracts) {
        promises.push(api.get('/api/v1/contracts').catch(() => ({ data: { data: [] } })));
        promises.push(api.get('/api/v1/deposits').catch(() => ({ data: { data: [] } })));
        promises.push(api.get('/api/v1/reservations').catch(() => ({ data: { data: [] } })));
      } else {
        promises.push(Promise.resolve({ data: { data: [] } }));
        promises.push(Promise.resolve({ data: { data: [] } }));
        promises.push(Promise.resolve({ data: { data: [] } }));
      }
      promises.push(api.get('/api/v1/tenants').catch(() => ({ data: { data: [] } })));

      const [bRes, aRes, cRes, dRes, rRes, tRes] = await Promise.all(promises);

      setBuildings(bRes.data?.data || []);
      setApartments(aRes.data?.data || []);
      setContracts(cRes.data?.data || []);
      setDeposits(dRes.data?.data || []);
      setReservations(rRes.data?.data || []);
      setTenants(tRes.data?.data || []);
      setTenants(tRes.data?.data || []);
      setReservations(rRes.data?.data || []);
    } catch (err) {
      console.error('Error loading dashboard live data:', err);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // Filtered dataset based on selected building
  const filteredData = useMemo(() => {
    const isAll = selectedBuildingId === 'ALL';

    const bldList = isAll
      ? buildings
      : buildings.filter((b) => b.id === selectedBuildingId);

    const aptList = isAll
      ? apartments
      : apartments.filter((a) => a.building_id === selectedBuildingId);

    const ctrList = isAll
      ? contracts
      : contracts.filter((c) => c.building_id === selectedBuildingId);

    const depList = isAll
      ? deposits
      : deposits.filter((d) => d.building_id === selectedBuildingId);

    const resList = isAll
      ? reservations
      : reservations.filter((r) => r.building_id === selectedBuildingId);

    return {
      buildings: bldList,
      apartments: aptList,
      contracts: ctrList,
      deposits: depList,
      reservations: resList,
    };
  }, [selectedBuildingId, buildings, apartments, contracts, deposits, reservations]);

  // Dynamic Metrics computed 100% from live DB data
  const stats = useMemo(() => {
    const { buildings: blds, apartments: apts, contracts: ctrs, deposits: deps, reservations: resvs } = filteredData;

    const totalBuildings = blds.length;
    const activeBuildings = blds.filter((b) => b.status === 'ACTIVE').length;
    const inactiveBuildings = totalBuildings - activeBuildings;

    const totalApartments = apts.length;
    const availableCount = apts.filter((a) => a.status === 'AVAILABLE').length;
    const occupiedCount = apts.filter((a) => a.status === 'OCCUPIED').length;
    const reservedCount = apts.filter((a) => a.status === 'RESERVED').length;
    const maintenanceCount = apts.filter((a) => a.status === 'MAINTENANCE').length;

    const occupancyRate = totalApartments > 0 ? Math.round((occupiedCount / totalApartments) * 100) : 0;

    const activeContracts = ctrs.filter((c) => c.status === 'ACTIVE');
    const monthlyRevenue = activeContracts.reduce((sum, c) => sum + (parseInt(c.rent_amount, 10) || 0), 0);

    const heldDeposits = deps.filter((d) => d.status === 'HELD');
    const totalDepositHeld = heldDeposits.reduce((sum, d) => sum + (parseInt(d.holding_amount, 10) || 0), 0);

    const activeReservations = resvs.filter((r) => r.status === 'HELD');
    const totalReservationAmount = activeReservations.reduce((sum, r) => sum + (parseInt(r.hold_amount, 10) || 0), 0);

    return {
      totalBuildings,
      activeBuildings,
      inactiveBuildings,
      totalApartments,
      availableCount,
      occupiedCount,
      reservedCount,
      maintenanceCount,
      occupancyRate,
      activeContractsCount: activeContracts.length,
      monthlyRevenue,
      heldDepositsCount: heldDeposits.length,
      totalDepositHeld,
      activeReservationsCount: activeReservations.length,
      totalReservationAmount,
    };
  }, [filteredData]);

  // Doughnut Chart Data (Apartment Status Breakdown)
  const doughnutData = useMemo(() => {
    return {
      labels: ['Đang thuê', 'Có sẵn', 'Cọc giữ chỗ', 'Bảo trì'],
      datasets: [
        {
          data: [
            stats.occupiedCount,
            stats.availableCount,
            stats.reservedCount,
            stats.maintenanceCount,
          ],
          backgroundColor: ['#6366f1', '#10b981', '#f59e0b', '#f43f5e'],
          hoverBackgroundColor: ['#4f46e5', '#059669', '#d97706', '#e11d48'],
          borderWidth: 2,
          borderColor: '#ffffff',
        },
      ],
    };
  }, [stats]);

  // Bar Chart Data (Comparison across Buildings or Floors)
  const barData = useMemo(() => {
    if (selectedBuildingId === 'ALL') {
      // Top 6 buildings with most apartments
      const topBuildings = [...buildings]
        .map((b) => {
          const bApts = apartments.filter((a) => a.building_id === b.id);
          const occupied = bApts.filter((a) => a.status === 'OCCUPIED').length;
          const available = bApts.filter((a) => a.status === 'AVAILABLE').length;
          return {
            name: b.name.length > 15 ? b.name.slice(0, 15) + '...' : b.name,
            occupied,
            available,
            total: bApts.length,
          };
        })
        .filter((b) => b.total > 0)
        .slice(0, 6);

      return {
        labels: topBuildings.map((b) => b.name),
        datasets: [
          {
            label: 'Đang thuê',
            data: topBuildings.map((b) => b.occupied),
            backgroundColor: '#6366f1',
            borderRadius: 6,
          },
          {
            label: 'Có sẵn',
            data: topBuildings.map((b) => b.available),
            backgroundColor: '#10b981',
            borderRadius: 6,
          },
        ],
      };
    } else {
      // Specific building: Group by floor
      const currentBldApts = apartments.filter((a) => a.building_id === selectedBuildingId);
      const floorMap = {};

      currentBldApts.forEach((apt) => {
        const fName = apt.floor_name || 'Khác';
        if (!floorMap[fName]) floorMap[fName] = { occupied: 0, available: 0 };
        if (apt.status === 'OCCUPIED') floorMap[fName].occupied++;
        if (apt.status === 'AVAILABLE') floorMap[fName].available++;
      });

      const floorLabels = Object.keys(floorMap);
      return {
        labels: floorLabels.length > 0 ? floorLabels : ['Chưa có tầng'],
        datasets: [
          {
            label: 'Đang thuê',
            data: floorLabels.map((f) => floorMap[f].occupied),
            backgroundColor: '#6366f1',
            borderRadius: 6,
          },
          {
            label: 'Có sẵn',
            data: floorLabels.map((f) => floorMap[f].available),
            backgroundColor: '#10b981',
            borderRadius: 6,
          },
        ],
      };
    }
  }, [selectedBuildingId, buildings, apartments]);

  const selectedBuildingObj = useMemo(() => {
    if (selectedBuildingId === 'ALL') return null;
    return buildings.find((b) => b.id === selectedBuildingId);
  }, [selectedBuildingId, buildings]);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] space-y-4">
        <RefreshCw className="w-8 h-8 text-primary-600 animate-spin" />
        <p className="text-sm text-slate-500 font-medium">Đang tải dữ liệu vận hành thời gian thực...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top Banner & Dynamic Controls */}
      <div className="relative overflow-hidden bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 rounded-2xl p-6 text-white shadow-xl border border-slate-800">
        <div className="relative z-10 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-5">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Dữ liệu trực tiếp (Live DB)
              </span>
              {selectedBuildingObj && (
                <span className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-indigo-500/30 text-indigo-200 border border-indigo-400/30">
                  {selectedBuildingObj.name}
                </span>
              )}
            </div>
            <h2 className="text-xl sm:text-2xl font-bold tracking-tight">
              {isManager ? 'Tổng quan Vận hành Tòa nhà (Quản lý)' : 'Tổng quan Bất động sản (Chủ sở hữu)'}
            </h2>
            <p className="text-xs sm:text-sm text-slate-300 mt-1">
              {selectedBuildingId === 'ALL'
                ? (isManager
                    ? `Toàn bộ ${buildings.length} tòa nhà do bạn quản lý`
                    : `Toàn bộ ${buildings.length} tòa nhà thuộc sở hữu trong tổ chức`)
                : `Thống kê chi tiết riêng cho ${selectedBuildingObj?.name || 'tòa nhà được chọn'}`}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/* Building Filter Selector */}
            <div className="relative flex items-center bg-slate-800/90 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white shadow-sm focus-within:ring-2 focus-within:ring-indigo-500">
              <Filter className="w-4 h-4 text-slate-400 mr-2 shrink-0" />
              <select
                value={selectedBuildingId}
                onChange={(e) => setSelectedBuildingId(e.target.value)}
                className="bg-transparent text-xs text-white focus:outline-none cursor-pointer pr-4"
              >
                <option value="ALL" className="bg-slate-900 text-white">
                  🏢 {isManager ? 'Tất cả tòa của tôi' : 'Tất cả tòa nhà'} ({buildings.length} tòa)
                </option>
                {buildings.map((b) => (
                  <option key={b.id} value={b.id} className="bg-slate-900 text-white">
                    {b.name} ({b.code})
                  </option>
                ))}
              </select>
            </div>

            {/* Refresh Button */}
            <button
              onClick={() => loadData(true)}
              disabled={isRefreshing}
              className="p-2 rounded-xl bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700 text-slate-300 hover:text-white transition-colors"
              title="Làm mới dữ liệu"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-indigo-400' : ''}`} />
            </button>

            {/* Quick Actions (Phân quyền theo PRD 6.2) */}
            {canCreateBuilding && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => navigate('/admin/buildings')}
                leftIcon={PlusCircle}
                className="text-xs bg-white/10 hover:bg-white/20 text-white border-white/20"
              >
                Tạo tòa nhà
              </Button>
            )}
            {canCreateContract && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => navigate('/admin/contracts')}
                leftIcon={PlusCircle}
                className="text-xs shadow-md"
              >
                Lập hợp đồng
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* KPI Cards Grid (6 Live Dynamic Cards) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        {/* Card 1: Buildings */}
        <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm flex flex-col justify-between hover:border-indigo-300 transition-all">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Tòa nhà</span>
            <div className="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center">
              <Building2 className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-2">
            <h3 className="text-2xl font-bold text-slate-800">{stats.totalBuildings}</h3>
            <p className="text-[11px] text-slate-500 mt-1 truncate">
              {stats.activeBuildings} hoạt động
              {stats.inactiveBuildings > 0 && ` · ${stats.inactiveBuildings} tạm ngưng`}
            </p>
          </div>
        </div>

        {/* Card 2: Total Rooms */}
        <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm flex flex-col justify-between hover:border-emerald-300 transition-all">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Căn hộ</span>
            <div className="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center">
              <Home className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-2">
            <h3 className="text-2xl font-bold text-slate-800">{stats.totalApartments}</h3>
            <p className="text-[11px] text-emerald-600 font-medium mt-1 truncate">
              {stats.availableCount} sẵn sàng đón khách
            </p>
          </div>
        </div>

        {/* Card 3: Occupancy Rate */}
        <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm flex flex-col justify-between hover:border-blue-300 transition-all">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Tỷ lệ lấp đầy</span>
            <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center">
              <TrendingUp className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-2">
            <div className="flex items-baseline justify-between">
              <h3 className="text-2xl font-bold text-slate-800">{stats.occupancyRate}%</h3>
              <span className="text-[11px] text-slate-400">
                {stats.occupiedCount}/{stats.totalApartments} căn
              </span>
            </div>
            {/* Visual Mini Progress Bar */}
            <div className="w-full bg-slate-100 rounded-full h-1.5 mt-2 overflow-hidden">
              <div
                className="bg-indigo-600 h-1.5 rounded-full transition-all duration-500"
                style={{ width: `${Math.min(100, stats.occupancyRate)}%` }}
              />
            </div>
          </div>
        </div>

        {/* Financial Cards (Ẩn với STAFF theo PRD 6.2 - Module Báo cáo/Tài chính) */}
        {canViewFinancials ? (
          <>
            {/* Card 4: Monthly Rent Revenue */}
            <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm flex flex-col justify-between hover:border-amber-300 transition-all">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Thu thuê/tháng</span>
                <div className="w-8 h-8 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center">
                  <DollarSign className="w-4 h-4" />
                </div>
              </div>
              <div className="mt-2">
                <h3 className="text-lg font-bold text-slate-800 truncate">
                  <Money amount={stats.monthlyRevenue} />
                </h3>
                <p className="text-[11px] text-slate-500 mt-1 truncate">
                  {stats.activeContractsCount} hợp đồng hiệu lực
                </p>
              </div>
            </div>

            {/* Card 5: Held Deposits */}
            <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm flex flex-col justify-between hover:border-violet-300 transition-all">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Cọc giữ (HELD)</span>
                <div className="w-8 h-8 rounded-lg bg-violet-50 text-violet-600 flex items-center justify-center">
                  <ShieldCheck className="w-4 h-4" />
                </div>
              </div>
              <div className="mt-2">
                <h3 className="text-lg font-bold text-slate-800 truncate">
                  <Money amount={stats.totalDepositHeld} />
                </h3>
                <p className="text-[11px] text-slate-500 mt-1 truncate">
                  {stats.heldDepositsCount} sổ cọc đang quản lý
                </p>
              </div>
            </div>

            {/* Card 6: Active Reservations */}
            <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm flex flex-col justify-between hover:border-rose-300 transition-all">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Cọc giữ chỗ</span>
                <div className="w-8 h-8 rounded-lg bg-rose-50 text-rose-600 flex items-center justify-center">
                  <Clock className="w-4 h-4" />
                </div>
              </div>
              <div className="mt-2">
                <h3 className="text-lg font-bold text-slate-800 truncate">
                  <Money amount={stats.totalReservationAmount} />
                </h3>
                <p className="text-[11px] text-rose-600 font-medium mt-1 truncate">
                  {stats.activeReservationsCount} căn giữ cọc chờ ký HĐ
                </p>
              </div>
            </div>
          </>
        ) : (
          <>
            {/* Operational Card 4 for STAFF: Available Units */}
            <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm flex flex-col justify-between hover:border-emerald-300 transition-all">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Phòng có sẵn</span>
                <div className="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center">
                  <CheckCircle2 className="w-4 h-4" />
                </div>
              </div>
              <div className="mt-2">
                <h3 className="text-2xl font-bold text-slate-800">{stats.availableCount}</h3>
                <p className="text-[11px] text-emerald-600 font-medium mt-1 truncate">
                  Căn trống sẵn sàng bàn giao
                </p>
              </div>
            </div>

            {/* Operational Card 5 for STAFF: Maintenance Units */}
            <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm flex flex-col justify-between hover:border-rose-300 transition-all">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Đang bảo trì</span>
                <div className="w-8 h-8 rounded-lg bg-rose-50 text-rose-600 flex items-center justify-center">
                  <Briefcase className="w-4 h-4" />
                </div>
              </div>
              <div className="mt-2">
                <h3 className="text-2xl font-bold text-slate-800">{stats.maintenanceCount}</h3>
                <p className="text-[11px] text-rose-600 font-medium mt-1 truncate">
                  Cần xử lý sửa chữa/kỹ thuật
                </p>
              </div>
            </div>

            {/* Operational Card 6 for STAFF: Occupied Units */}
            <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm flex flex-col justify-between hover:border-indigo-300 transition-all">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Đang có khách</span>
                <div className="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center">
                  <Users className="w-4 h-4" />
                </div>
              </div>
              <div className="mt-2">
                <h3 className="text-2xl font-bold text-slate-800">{stats.occupiedCount}</h3>
                <p className="text-[11px] text-indigo-600 font-medium mt-1 truncate">
                  Căn hộ có cư dân sinh sống
                </p>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Middle Section: 2 Charts side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Doughnut Chart: Apartment Statuses */}
        <div className="bg-white p-6 rounded-xl border border-slate-200/80 shadow-sm flex flex-col">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-semibold text-slate-800">Cơ cấu Trạng thái Căn hộ</h4>
            <span className="text-xs text-slate-400 font-medium">{stats.totalApartments} căn</span>
          </div>
          <p className="text-xs text-slate-400 mb-4">Phân bổ căn hộ theo thời gian thực</p>

          {stats.totalApartments === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center py-10 text-slate-400">
              <Home className="w-10 h-10 mb-2 stroke-1 text-slate-300" />
              <p className="text-xs">Chưa có căn hộ nào trong phạm vi chọn</p>
            </div>
          ) : (
            <>
              <div className="w-44 h-44 mx-auto relative my-2">
                <Doughnut
                  data={doughnutData}
                  options={{
                    cutout: '72%',
                    maintainAspectRatio: false,
                    plugins: {
                      legend: { display: false },
                      tooltip: {
                        callbacks: {
                          label: function (context) {
                            const val = context.raw || 0;
                            const total = stats.totalApartments || 1;
                            const pct = Math.round((val / total) * 100);
                            return ` ${context.label}: ${val} căn (${pct}%)`;
                          },
                        },
                      },
                    },
                  }}
                />
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <span className="text-2xl font-bold text-slate-800">{stats.occupancyRate}%</span>
                  <span className="text-[11px] text-slate-400 font-medium">Lấp đầy</span>
                </div>
              </div>

              {/* Dynamic Legend with Real Numbers */}
              <div className="grid grid-cols-2 gap-2 mt-4 pt-4 border-t border-slate-100 text-xs">
                <div className="flex items-center justify-between p-1.5 rounded-lg bg-indigo-50/50">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-indigo-500" />
                    <span className="text-slate-700">Đang thuê</span>
                  </div>
                  <span className="font-semibold text-slate-800">{stats.occupiedCount}</span>
                </div>
                <div className="flex items-center justify-between p-1.5 rounded-lg bg-emerald-50/50">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                    <span className="text-slate-700">Có sẵn</span>
                  </div>
                  <span className="font-semibold text-slate-800">{stats.availableCount}</span>
                </div>
                <div className="flex items-center justify-between p-1.5 rounded-lg bg-amber-50/50">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-amber-500" />
                    <span className="text-slate-700">Giữ chỗ</span>
                  </div>
                  <span className="font-semibold text-slate-800">{stats.reservedCount}</span>
                </div>
                <div className="flex items-center justify-between p-1.5 rounded-lg bg-rose-50/50">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-rose-500" />
                    <span className="text-slate-700">Bảo trì</span>
                  </div>
                  <span className="font-semibold text-slate-800">{stats.maintenanceCount}</span>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Bar Chart: Comparison */}
        <div className="lg:col-span-2 bg-white p-6 rounded-xl border border-slate-200/80 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-1">
              <h4 className="text-sm font-semibold text-slate-800">
                {selectedBuildingId === 'ALL'
                  ? 'Phân bổ Căn hộ theo Tòa nhà'
                  : `Phân bổ Căn hộ theo Tầng (${selectedBuildingObj?.name})`}
              </h4>
              <span className="text-xs text-slate-400">Đang thuê vs Có sẵn</span>
            </div>
            <p className="text-xs text-slate-400 mb-4">
              {selectedBuildingId === 'ALL'
                ? 'So sánh số phòng đang khai thác tại các tòa nhà trọng điểm'
                : 'Thống kê tình trạng phòng theo từng tầng trong tòa'}
            </p>
          </div>

          <div className="h-64 w-full">
            <Bar
              data={barData}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                  legend: {
                    position: 'top',
                    labels: { boxWidth: 12, font: { size: 11 } },
                  },
                },
                scales: {
                  x: { grid: { display: false }, ticks: { font: { size: 11 } } },
                  y: {
                    beginAtZero: true,
                    ticks: { stepSize: 1, font: { size: 11 } },
                    grid: { color: '#f1f5f9' },
                  },
                },
              }}
            />
          </div>
        </div>
      </div>

      {/* Bottom Section: Interactive Multi-Tab Activity List */}
      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        {/* Tab Headers */}
        <div className="border-b border-slate-200 px-6 pt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveTab('apartments')}
              className={`pb-3 px-3 text-xs font-semibold border-b-2 transition-colors flex items-center gap-2 ${
                activeTab === 'apartments'
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <Home className="w-4 h-4" />
              Căn hộ gần đây
              <span className="px-1.5 py-0.2 rounded-full bg-slate-100 text-slate-600 text-[10px]">
                {filteredData.apartments.length}
              </span>
            </button>

            <button
              onClick={() => setActiveTab('contracts')}
              className={`pb-3 px-3 text-xs font-semibold border-b-2 transition-colors flex items-center gap-2 ${
                activeTab === 'contracts'
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <FileText className="w-4 h-4" />
              Hợp đồng thuê
              <span className="px-1.5 py-0.2 rounded-full bg-slate-100 text-slate-600 text-[10px]">
                {filteredData.contracts.length}
              </span>
            </button>

            <button
              onClick={() => setActiveTab('reservations')}
              className={`pb-3 px-3 text-xs font-semibold border-b-2 transition-colors flex items-center gap-2 ${
                activeTab === 'reservations'
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <Clock className="w-4 h-4" />
              Cọc giữ chỗ
              <span className="px-1.5 py-0.2 rounded-full bg-slate-100 text-slate-600 text-[10px]">
                {filteredData.reservations.length}
              </span>
            </button>
          </div>

          <div className="pb-3 text-right">
            {activeTab === 'apartments' && (
              <button
                onClick={() => navigate('/admin/buildings')}
                className="text-xs text-primary-600 hover:text-primary-700 font-semibold inline-flex items-center gap-1"
              >
                Quản lý căn hộ <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
            {activeTab === 'contracts' && canViewContracts && (
              <button
                onClick={() => navigate('/admin/contracts')}
                className="text-xs text-primary-600 hover:text-primary-700 font-semibold inline-flex items-center gap-1"
              >
                Quản lý hợp đồng <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}

            {activeTab === 'reservations' && (
              <button
                onClick={() => navigate('/admin/buildings')}
                className="text-xs text-primary-600 hover:text-primary-700 font-semibold inline-flex items-center gap-1"
              >
                Chi tiết giữ chỗ <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Tab Content 1: Apartments */}
        {activeTab === 'apartments' && (
          <div className="p-6">
            {filteredData.apartments.length === 0 ? (
              <div className="py-10 text-center text-slate-400 text-xs">
                Chưa có căn hộ nào được tạo trong phạm vi này.
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {filteredData.apartments.slice(0, 6).map((apt) => (
                  <div
                    key={apt.id}
                    className="py-3 flex items-center justify-between hover:bg-slate-50/60 px-2 rounded-lg transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-indigo-50/70 font-bold text-xs text-indigo-700 flex items-center justify-center border border-indigo-100">
                        {apt.code}
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-slate-800">
                          Căn {apt.code} {apt.type ? `· ${apt.type}` : ''}
                        </div>
                        <div className="text-xs text-slate-400 mt-0.5">
                          {apt.building_name} · {apt.floor_name || 'Tầng trệt'} · {apt.area_m2} m²
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <Money amount={apt.base_rent} className="text-sm font-semibold text-slate-800" />
                        <span className="text-[11px] text-slate-400 block">/tháng</span>
                      </div>
                      <StatusBadge status={apt.status} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tab Content 2: Contracts */}
        {activeTab === 'contracts' && (
          <div className="p-6">
            {filteredData.contracts.length === 0 ? (
              <div className="py-10 text-center text-slate-400 text-xs">
                Chưa có hợp đồng thuê nào trong phạm vi này.
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {filteredData.contracts.slice(0, 6).map((c) => (
                  <div
                    key={c.id}
                    className="py-3 flex items-center justify-between hover:bg-slate-50/60 px-2 rounded-lg transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-emerald-50/70 font-bold text-xs text-emerald-700 flex items-center justify-center border border-emerald-100">
                        <FileText className="w-5 h-5" />
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-slate-800">
                          {c.tenant_name || 'Khách thuê'}
                          <span className="text-xs font-normal text-slate-400 ml-2">
                            ({c.tenant_phone || 'N/A'})
                          </span>
                        </div>
                        <div className="text-xs text-slate-400 mt-0.5">
                          Căn {c.apartment_code} · {c.building_name} · Kỳ hạn:{' '}
                          {c.start_date?.slice(0, 10)} → {c.end_date?.slice(0, 10)}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <Money amount={c.rent_amount} className="text-sm font-semibold text-slate-800" />
                        <span className="text-[11px] text-slate-400 block">/tháng</span>
                      </div>
                      <StatusBadge status={c.status} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tab Content 3: Reservations */}
        {activeTab === 'reservations' && (
          <div className="p-6">
            {filteredData.reservations.length === 0 ? (
              <div className="py-10 text-center text-slate-400 text-xs">
                Chưa có yêu cầu đặt cọc giữ chỗ nào trong phạm vi này.
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {filteredData.reservations.slice(0, 6).map((r) => (
                  <div
                    key={r.id}
                    className="py-3 flex items-center justify-between hover:bg-slate-50/60 px-2 rounded-lg transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-amber-50/70 font-bold text-xs text-amber-700 flex items-center justify-center border border-amber-100">
                        <Clock className="w-5 h-5" />
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-slate-800">
                          {r.prospect_name}
                          <span className="text-xs font-normal text-slate-400 ml-2">
                            ({r.phone})
                          </span>
                        </div>
                        <div className="text-xs text-slate-400 mt-0.5">
                          Căn {r.apartment_code} · {r.building_name} · Hạn giữ:{' '}
                          {r.hold_until?.slice(0, 10)}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <Money amount={r.hold_amount} className="text-sm font-semibold text-amber-700" />
                        <span className="text-[11px] text-slate-400 block">Tiền giữ chỗ</span>
                      </div>
                      <StatusBadge status={r.status} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
