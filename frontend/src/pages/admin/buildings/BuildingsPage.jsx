import React, { useState, useEffect } from 'react';
import {
  Building2,
  Plus,
  LayoutGrid,
  List,
  X,
  Home,
  CheckCircle2,
  AlertCircle,
  Shield,
  Layers,
  ArrowRight,
  Power,
  RotateCcw,
  Trash2,
  Pencil,
  BookmarkCheck,
  Calendar,
} from 'lucide-react';
import Button from '../../../components/ui/Button';
import Input from '../../../components/ui/Input';
import FormField from '../../../components/ui/FormField';
import StatusBadge from '../../../components/ui/StatusBadge';
import Money from '../../../components/ui/Money';
import DataTable from '../../../components/ui/DataTable';
import ConfirmDialog from '../../../components/ui/ConfirmDialog';
import AccessDenied from '../../../components/common/AccessDenied';
import api from '../../../services/api';
import { useAuthStore } from '../../../stores/authStore';

export default function BuildingsPage() {
  const { user, getCurrentRole } = useAuthStore();
  const currentRole = getCurrentRole();

  // Phân quyền theo yêu cầu:
  // Tòa/khu/tầng/căn hộ: Manager: CRU (tòa của mình quản lý), Owner: R, RESIDENT (căn của mình)
  const isManager = currentRole === 'MANAGER';
  const isOwner = currentRole === 'OWNER';

  const canCreateBuilding = isManager; // Manager CRU, Owner R
  const canManageUnits = isManager;    // Manager CRU, Owner R
  const canChangeBuildingStatus = isManager;
  const isSysAdmin = false; // SYS_ADMIN đã xóa khỏi hệ thống

  // Nếu người dùng là RESIDENT -> chặn hiển thị trang quản trị tòa nhà chung
  if (currentRole === 'RESIDENT') {
    return (
      <AccessDenied
        currentRole={currentRole}
        allowedRoles={['OWNER', 'MANAGER']}
      />
    );
  }


  const [buildings, setBuildings] = useState([]);
  const [selectedBuilding, setSelectedBuilding] = useState(null);
  const [activeTab, setActiveTab] = useState('floormap'); // 'floormap' | 'list'
  const [floorMap, setFloorMap] = useState([]);
  const [selectedApartment, setSelectedApartment] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  // Modals & Drawers
  const [isBuildingModalOpen, setIsBuildingModalOpen] = useState(false);
  const [isApartmentModalOpen, setIsApartmentModalOpen] = useState(false);
  const [isFloorModalOpen, setIsFloorModalOpen] = useState(false);
  const [confirmStatusModal, setConfirmStatusModal] = useState({ isOpen: false, building: null, targetStatus: null });

  // NV-03 Form State
  const [newBuilding, setNewBuilding] = useState({
    name: '',
    code: '',
    address: '',
    bank: '',
    account_no: '',
    account_name: '',
    account_type: 'personal',
    lease_notes: '',
    owner_id: '',
  });
  const [codeCheckStatus, setCodeCheckStatus] = useState(null); // null | 'checking' | 'available' | 'taken' | 'invalid'
  const [codeMessage, setCodeMessage] = useState('');
  const [buildingFormError, setBuildingFormError] = useState('');

  // Add Floor State
  const [newFloor, setNewFloor] = useState({ level: 1, name: '' });

  // B3: sửa tòa + chọn chủ sở hữu
  const [editingBuilding, setEditingBuilding] = useState(null);
  const [owners, setOwners] = useState([]);

  useEffect(() => {
    api.get('/api/v1/buildings/owners')
      .then((res) => setOwners(res.data?.data || []))
      .catch(() => {});
  }, []);

  const openEditBuilding = async (row) => {
    const res = await api.get(`/api/v1/buildings/${row.id}`).catch(() => null);
    const b = res?.data?.data || row;
    setEditingBuilding(b);
    setNewBuilding({
      name: b.name || '',
      code: b.code || '',
      address: b.address || '',
      bank: b.lease_terms?.payment_account?.bank || '',
      account_no: b.lease_terms?.payment_account?.account_no || '',
      account_name: b.lease_terms?.payment_account?.account_name || '',
      account_type: b.lease_terms?.payment_account?.type || 'personal',
      lease_notes: b.lease_terms?.notes || '',
      owner_id: b.owner_id || '',
    });
    setIsBuildingModalOpen(true);
  };

  // Add Apartment State
  const [newApartment, setNewApartment] = useState({
    code: '',
    floor_id: '',
    area_m2: 45,
    type: '1PN',
    bedrooms: 1,
    base_rent: 7500000,
    status: 'AVAILABLE',
  });
  const [aptFormError, setAptFormError] = useState('');

  // NV-06 Reservation State
  const [isReservationModalOpen, setIsReservationModalOpen] = useState(false);
  const [reservationData, setReservationData] = useState({
    prospect_name: '',
    phone: '',
    hold_amount: 1000000,
    hold_until: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    note: '',
  });
  const [reservationError, setReservationError] = useState('');

  const loadBuildings = async () => {
    setIsLoading(true);
    try {
      const res = await api.get('/api/v1/buildings');
      const list = res.data?.data || [];
      setBuildings(list);
      if (list.length > 0 && !selectedBuilding) {
        setSelectedBuilding(list[0]);
      } else if (selectedBuilding) {
        const updated = list.find((b) => b.id === selectedBuilding.id);
        if (updated) setSelectedBuilding(updated);
      }
    } catch (err) {
      console.error('Error loading buildings:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const loadFloorMap = async (buildingId) => {
    if (!buildingId) return;
    try {
      const res = await api.get(`/api/v1/buildings/${buildingId}/floor-map`);
      const map = res.data?.data || [];
      setFloorMap(map);
      if (map.length > 0 && !newApartment.floor_id) {
        setNewApartment((prev) => ({ ...prev, floor_id: map[0].id }));
      }
    } catch (err) {
      console.error('Error loading floor map:', err);
    }
  };

  // B1: phân khu Khu/Block
  const [zones, setZones] = useState([]);
  const [isZoneModalOpen, setIsZoneModalOpen] = useState(false);
  const [newZone, setNewZone] = useState({ code: '', name: '' });

  const loadZones = async (buildingId) => {
    if (!buildingId) return;
    try {
      const res = await api.get(`/api/v1/buildings/${buildingId}/zones`);
      setZones(res.data?.data || []);
    } catch (err) {
      console.error('Error loading zones:', err);
    }
  };

  const handleCreateZone = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/api/v1/buildings/${selectedBuilding.id}/zones`, newZone);
      setIsZoneModalOpen(false);
      setNewZone({ code: '', name: '' });
      loadZones(selectedBuilding.id);
    } catch (err) {
      alert(err.response?.data?.message || 'Lỗi khi tạo khu.');
    }
  };

  const handleToggleZoneStatus = async (z) => {
    const target = z.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    try {
      await api.patch(`/api/v1/buildings/${selectedBuilding.id}/zones/${z.id}`, { status: target });
      loadZones(selectedBuilding.id);
    } catch (err) {
      alert(err.response?.data?.message || 'Lỗi đổi trạng thái khu.');
    }
  };

  useEffect(() => {
    loadBuildings();
  }, []);

  useEffect(() => {
    if (selectedBuilding) {
      loadFloorMap(selectedBuilding.id);
      loadZones(selectedBuilding.id);
    }
  }, [selectedBuilding]);

  // Real-time Check Mã Tòa (FR-007 / NV-03)
  const handleCodeBlur = async () => {
    const rawCode = newBuilding.code.trim();
    if (!rawCode) {
      setCodeCheckStatus(null);
      setCodeMessage('');
      return;
    }

    if (!/^[A-Z0-9-]+$/.test(rawCode)) {
      setCodeCheckStatus('invalid');
      setCodeMessage('Mã chỉ gồm chữ cái, số và dấu gạch ngang (-)');
      return;
    }

    setCodeCheckStatus('checking');
    try {
      const res = await api.get(`/api/v1/buildings/check-code?code=${rawCode}`);
      if (res.data.available) {
        setCodeCheckStatus('available');
        setCodeMessage('✅ Mã tòa chưa được dùng (Hợp lệ)');
      } else {
        setCodeCheckStatus('taken');
        setCodeMessage('❌ Mã tòa này đã tồn tại trong tổ chức');
      }
    } catch (e) {
      setCodeCheckStatus(null);
    }
  };

  const handleCreateBuilding = async (e) => {
    e.preventDefault();
    setBuildingFormError('');

    if (!newBuilding.name.trim()) {
      setBuildingFormError('Tên tòa nhà không được để trống (2-100 ký tự).');
      return;
    }

    if (!editingBuilding && !newBuilding.code.trim()) {
      setBuildingFormError('Mã tòa nhà không được để trống.');
      return;
    }

    if (!editingBuilding && (codeCheckStatus === 'taken' || codeCheckStatus === 'invalid')) {
      setBuildingFormError('Mã tòa không hợp lệ hoặc đã bị trùng.');
      return;
    }

    try {
      const payment_account = {
        bank: newBuilding.bank,
        account_no: newBuilding.account_no,
        account_name: newBuilding.account_name,
        type: newBuilding.account_type,
      };
      const lease_terms = { notes: newBuilding.lease_notes, payment_account };

      if (editingBuilding) {
        // B3: sửa tòa — mã KHÔNG được sửa
        await api.patch(`/api/v1/buildings/${editingBuilding.id}`, {
          name: newBuilding.name.trim(),
          address: newBuilding.address.trim(),
          owner_id: newBuilding.owner_id === '' ? null : (newBuilding.owner_id || undefined),
          payment_account,
          lease_terms: { notes: newBuilding.lease_notes },
        });
      } else {
        await api.post('/api/v1/buildings', {
          name: newBuilding.name.trim(),
          code: newBuilding.code.trim().toUpperCase(),
          address: newBuilding.address.trim(),
          owner_id: newBuilding.owner_id || undefined,
          payment_account,
          lease_terms,
        });
      }
      setIsBuildingModalOpen(false);
      setEditingBuilding(null);
      setNewBuilding({
        name: '',
        code: '',
        address: '',
        bank: '',
        account_no: '',
        account_name: '',
        account_type: 'personal',
        lease_notes: '',
        owner_id: '',
      });
      setCodeCheckStatus(null);
      await loadBuildings();
    } catch (err) {
      setBuildingFormError(err.response?.data?.message || 'Lỗi khi lưu tòa nhà.');
    }
  };

  const handleCreateFloor = async (e) => {
    e.preventDefault();
    if (!selectedBuilding) return;

    try {
      await api.post(`/api/v1/buildings/${selectedBuilding.id}/floors`, newFloor);
      setIsFloorModalOpen(false);
      setNewFloor({ level: floorMap.length + 1, name: '' });
      await loadFloorMap(selectedBuilding.id);
      loadBuildings();
    } catch (err) {
      alert(err.response?.data?.message || 'Lỗi khi tạo tầng.');
    }
  };

  const handleCreateApartment = async (e) => {
    e.preventDefault();
    setAptFormError('');

    if (!newApartment.code) {
      setAptFormError('Vui lòng nhập mã phòng.');
      return;
    }

    try {
      await api.post('/api/v1/apartments', {
        ...newApartment,
        building_id: selectedBuilding.id,
      });
      setIsApartmentModalOpen(false);
      setNewApartment({
        code: '',
        floor_id: floorMap[0]?.id || '',
        area_m2: 45,
        type: '1PN',
        bedrooms: 1,
        base_rent: 7500000,
        status: 'AVAILABLE',
      });
      loadFloorMap(selectedBuilding.id);
    } catch (err) {
      setAptFormError(err.response?.data?.message || 'Lỗi khi tạo căn hộ.');
    }
  };

  const handleDeleteFloor = async (floorId) => {
    if (!window.confirm('Bạn có chắc chắn muốn xóa tầng này? (Chỉ xóa được khi không có căn hộ)')) return;
    try {
      await api.delete(`/api/v1/buildings/${selectedBuilding.id}/floors/${floorId}`);
      await loadFloorMap(selectedBuilding.id);
      loadBuildings();
    } catch (err) {
      alert(err.response?.data?.message || 'Lỗi khi xóa tầng.');
    }
  };

  const handleCreateReservation = async (e) => {
    e.preventDefault();
    setReservationError('');
    if (!selectedApartment) return;

    try {
      await api.post('/api/v1/reservations', {
        ...reservationData,
        apartment_id: selectedApartment.id,
      });
      setIsReservationModalOpen(false);
      setReservationData({
        prospect_name: '',
        phone: '',
        hold_amount: 1000000,
        hold_until: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        note: '',
      });
      setSelectedApartment(null);
      loadFloorMap(selectedBuilding.id);
    } catch (err) {
      setReservationError(err.response?.data?.message || 'Lỗi khi đặt giữ chỗ.');
    }
  };

  const handleForfeitReservation = async (apartmentId) => {
    if (!window.confirm('Xác nhận khách hủy giữ chỗ (mất cọc)? Căn hộ sẽ mở lại trạng thái có sẵn.')) return;
    try {
      const resList = await api.get(`/api/v1/reservations?status=HELD`);
      const found = resList.data?.data?.find((r) => r.apartment_id === apartmentId);
      if (!found) {
        alert('Không tìm thấy thông tin giữ chỗ đang chờ xử lý của căn này.');
        return;
      }
      await api.patch(`/api/v1/reservations/${found.id}/forfeit`);
      setSelectedApartment(null);
      loadFloorMap(selectedBuilding.id);
    } catch (err) {
      alert(err.response?.data?.message || 'Lỗi xử lý hủy giữ chỗ.');
    }
  };

  const handleRefundReservation = async (apartmentId) => {
    if (!window.confirm('Xác nhận hoàn tiền giữ chỗ cho khách? Căn hộ sẽ mở lại trạng thái có sẵn.')) return;
    try {
      const resList = await api.get(`/api/v1/reservations?status=HELD`);
      const found = resList.data?.data?.find((r) => r.apartment_id === apartmentId);
      if (!found) {
        alert('Không tìm thấy thông tin giữ chỗ đang chờ xử lý của căn này.');
        return;
      }
      await api.patch(`/api/v1/reservations/${found.id}/refund`);
      setSelectedApartment(null);
      loadFloorMap(selectedBuilding.id);
    } catch (err) {
      alert(err.response?.data?.message || 'Lỗi hoàn tiền giữ chỗ.');
    }
  };

  // Bàn giao & nghiệm thu sau chấm dứt hợp đồng (B8 / PRD 7.5)
  const handleHandover = async () => {
    if (!window.confirm('Xác nhận bàn giao & nghiệm thu phòng? Căn hộ sẽ về trạng thái sẵn sàng kinh doanh (AVAILABLE).')) return;
    try {
      const res = await api.patch(`/api/v1/apartments/${selectedApartment.id}/handover`);
      if (res.data?.warnings?.length) {
        alert(res.data.warnings.join('\n'));
      }
      setSelectedApartment(null);
      loadFloorMap(selectedBuilding.id);
    } catch (err) {
      alert(err.response?.data?.message || 'Lỗi bàn giao căn hộ.');
    }
  };

  // B2: đổi trạng thái MAINTENANCE <-> INACTIVE <-> AVAILABLE trực tiếp từ panel
  const handleSetApartmentStatus = async (targetStatus, confirmText) => {
    if (!window.confirm(confirmText)) return;
    try {
      await api.patch(`/api/v1/apartments/${selectedApartment.id}`, { status: targetStatus });
      setSelectedApartment(null);
      loadFloorMap(selectedBuilding.id);
    } catch (err) {
      alert(err.response?.data?.message || 'Lỗi đổi trạng thái căn hộ.');
    }
  };

  // State Machine Toggle: ACTIVE <-> INACTIVE
  const handleToggleStatus = async () => {
    const { building, targetStatus } = confirmStatusModal;
    if (!building) return;

    try {
      await api.patch(`/api/v1/buildings/${building.id}/status`, { status: targetStatus });
      setConfirmStatusModal({ isOpen: false, building: null, targetStatus: null });
      loadBuildings();
    } catch (err) {
      alert(err.response?.data?.message || 'Lỗi khi đổi trạng thái tòa nhà.');
      setConfirmStatusModal({ isOpen: false, building: null, targetStatus: null });
    }
  };

  const buildingColumns = [
    { title: 'Tên tòa nhà', key: 'name', sortable: true },
    { title: 'Mã tòa', key: 'code', sortable: true },
    { title: 'Địa chỉ', key: 'address' },
    {
      title: 'Tầng / Căn',
      key: 'total_apartments',
      render: (_, row) => (
        <span className="font-medium text-xs text-slate-700">
          {row.total_floors || 0} tầng · {row.total_apartments || 0} căn
        </span>
      ),
    },
    {
      title: 'Trạng thái',
      key: 'status',
      render: (val) => <StatusBadge status={val} />,
    },
    {
      title: 'Thao tác',
      key: 'actions',
      render: (_, row) => canChangeBuildingStatus ? (
        <div className="flex gap-1.5">
          <button
            onClick={() => openEditBuilding(row)}
            className="text-xs font-semibold px-2.5 py-1 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 transition-colors"
          >
            Sửa
          </button>
          <button
          onClick={() => setConfirmStatusModal({
            isOpen: true,
            building: row,
            targetStatus: row.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
          })}
          className={`text-xs font-semibold px-2.5 py-1 rounded-lg border transition-colors ${
            row.status === 'ACTIVE'
              ? 'text-amber-700 bg-amber-50 border-amber-200 hover:bg-amber-100'
              : 'text-emerald-700 bg-emerald-50 border-emerald-200 hover:bg-emerald-100'
          }`}
        >
          {row.status === 'ACTIVE' ? 'Tạm dừng' : 'Kích hoạt lại'}
        </button>
        </div>
      ) : (
        <span className="text-xs text-slate-400 italic">Chỉ xem</span>
      ),
    },
  ];

  const needsFloorConfig = selectedBuilding && floorMap.length === 0;

  return (
    <div className="space-y-6">
      {/* Header & Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight">
            Quản lý Bất động sản (M03)
          </h2>
          <p className="text-xs sm:text-sm text-slate-500 mt-1">
            Khởi tạo tòa nhà (NV-03), sơ đồ phân bổ tầng & phòng (NV-04) và cấu hình vận hành
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          {canCreateBuilding && (
            <Button
              variant="primary"
              size="md"
              onClick={() => setIsBuildingModalOpen(true)}
              leftIcon={Plus}
            >
              Thêm tòa mới
            </Button>
          )}

          {canManageUnits && (
            <>
              <Button
                variant="secondary"
                size="md"
                onClick={() => setIsZoneModalOpen(true)}
                leftIcon={Layers}
                disabled={!selectedBuilding}
              >
                Thêm khu
              </Button>

              <Button
                variant="secondary"
                size="md"
                onClick={() => setIsFloorModalOpen(true)}
                leftIcon={Layers}
                disabled={!selectedBuilding}
              >
                Thêm tầng
              </Button>

              <Button
                variant="secondary"
                size="md"
                onClick={() => setIsApartmentModalOpen(true)}
                leftIcon={Plus}
                disabled={!selectedBuilding || floorMap.length === 0}
              >
                Thêm căn hộ
              </Button>
            </>
          )}
        </div>
      </div>


      {/* Checklist "Hoàn thiện cấu hình tòa" (Phần 7 của Quy Trình Tạo Tòa Nhà) */}
      {needsFloorConfig && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 text-amber-900 shadow-sm animate-fade-in">
          <div className="flex items-start gap-3">
            <span className="text-xl">🚀</span>
            <div className="flex-1">
              <h4 className="font-bold text-sm">
                Hoàn thiện cấu hình cho tòa "{selectedBuilding.name}" để bắt đầu vận hành
              </h4>
              <p className="text-xs text-amber-800 mt-1">
                Tòa nhà mới tạo ở trạng thái <strong>ACTIVE</strong> nhưng chưa có tầng và phòng. Vui lòng thêm tầng trước khi phân bổ căn hộ.
              </p>

              <div className="mt-3.5 flex flex-wrap items-center gap-4 text-xs font-medium">
                <span className="flex items-center gap-1.5 text-emerald-700 bg-white px-2.5 py-1 rounded-lg border border-emerald-200">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                  Thông tin tòa nhà
                </span>
                <span className="flex items-center gap-1.5 text-amber-800 bg-amber-100/80 px-2.5 py-1 rounded-lg border border-amber-300">
                  <span className="w-2 h-2 rounded-full bg-amber-600" />
                  Thêm tầng (Hiện có 0 tầng)
                </span>
                <span className="text-slate-400">→ Thêm căn hộ (cần có tầng trước)</span>
              </div>
            </div>

            <Button
              size="sm"
              variant="primary"
              onClick={() => setIsFloorModalOpen(true)}
              leftIcon={Plus}
              className="text-xs shadow-sm flex-shrink-0"
            >
              Thêm tầng ngay
            </Button>
          </div>
        </div>
      )}

      {/* Buildings Pills & View Toggle */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-3">
        {/* Buildings Pills */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1 sm:pb-0">
          {buildings.map((b) => (
            <button
              key={b.id}
              onClick={() => setSelectedBuilding(b)}
              className={`px-3.5 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-150 flex items-center gap-2 flex-shrink-0 ${
                selectedBuilding?.id === b.id
                  ? 'bg-primary-600 text-white shadow-sm shadow-primary-500/30'
                  : 'bg-white text-slate-700 hover:bg-slate-100 border border-slate-200'
              }`}
            >
              <Building2 className="w-4 h-4" />
              <span>{b.name}</span>
              {b.status === 'INACTIVE' && (
                <span className="text-[10px] bg-slate-200 text-slate-700 px-1.5 py-0.5 rounded">Tạm dừng</span>
              )}
            </button>
          ))}
        </div>

        {/* View mode toggle */}
        <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl self-start sm:self-auto">
          <button
            onClick={() => setActiveTab('floormap')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              activeTab === 'floormap' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <LayoutGrid className="w-3.5 h-3.5" />
            <span>Sơ đồ tầng</span>
          </button>
          <button
            onClick={() => setActiveTab('list')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              activeTab === 'list' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <List className="w-3.5 h-3.5" />
            <span>Danh sách tòa</span>
          </button>
        </div>
      </div>

      {/* Main View */}
      {activeTab === 'list' ? (
        <DataTable
          columns={buildingColumns}
          data={buildings}
          isLoading={isLoading}
          searchKeys={['name', 'code', 'address']}
        />
      ) : (
        <div className="space-y-6">
          {/* Status Legend */}
          <div className="flex flex-wrap items-center gap-4 p-4 bg-white rounded-xl border border-slate-200/80 text-xs text-slate-600 shadow-sm">
            <span className="font-semibold text-slate-800 mr-2">Trạng thái:</span>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-emerald-500" />
              <span>🟢 Có sẵn</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-indigo-500" />
              <span>🔵 Đang thuê</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-amber-500" />
              <span>🟡 Đã đặt cọc</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-rose-500" />
              <span>🔴 Bảo trì</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-slate-400" />
              <span>⚫ Không KD</span>
            </div>
          </div>

          {/* B1: dải phân khu Khu/Block */}
          {zones.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Khu/Block:</span>
              {zones.map((z) => (
                <span
                  key={z.id}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border ${
                    z.status === 'ACTIVE' ? 'bg-primary-50 text-primary-800 border-primary-200' : 'bg-slate-100 text-slate-500 border-slate-200 opacity-60'
                  }`}
                  title={`${z.apartment_count || 0} căn hộ${z.status === 'INACTIVE' ? ' — Đã ngưng sử dụng' : ''}`}
                >
                  {z.code}{z.name ? ` — ${z.name}` : ''} ({z.apartment_count || 0})
                  {canManageUnits && (
                    <button
                      className="ml-1 text-[10px] underline hover:no-underline"
                      onClick={() => handleToggleZoneStatus(z)}
                    >
                      {z.status === 'ACTIVE' ? 'Tắt' : 'Bật'}
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}

          {/* Sơ đồ tầng theo thiết kế PRD FR-010 */}
          <div className="space-y-4">
            {floorMap.length === 0 ? (
              <div className="bg-white p-12 text-center rounded-xl border border-dashed border-slate-200 text-slate-500">
                <p className="font-medium">Chưa có tầng nào được cấu hình cho tòa nhà này.</p>
                <p className="text-xs text-slate-400 mt-1">Nhấn 'Thêm tầng' để bắt đầu thiết lập.</p>
              </div>
            ) : (
              floorMap.map((floor) => (
                <div key={floor.id} className="bg-white rounded-xl border border-slate-200/90 shadow-sm p-5">
                  <div className="flex items-center justify-between mb-4 border-b border-slate-100 pb-3">
                    <div className="flex items-center gap-2.5">
                      <span className="text-xs font-bold uppercase tracking-wider bg-slate-100 text-slate-700 px-2.5 py-1 rounded-md">
                        {floor.name || `TẦNG ${floor.level}`}
                      </span>
                      <span className="text-xs text-slate-400">
                        {floor.apartments?.length || 0} căn hộ
                      </span>
                      {canManageUnits && (
                        <button
                          onClick={async () => {
                            const name = window.prompt('Tên hiển thị tầng mới:', floor.name || `Tầng ${floor.level}`);
                            if (name === null) return;
                            const levelStr = window.prompt('Số tầng (level): <0 hầm, 0 trệt, >0 tầng', String(floor.level));
                            if (levelStr === null) return;
                            try {
                              await api.patch(`/api/v1/buildings/${selectedBuilding.id}/floors/${floor.id}`, {
                                name,
                                level: parseInt(levelStr, 10),
                              });
                              await loadFloorMap(selectedBuilding.id);
                            } catch (err) {
                              alert(err.response?.data?.message || 'Lỗi khi sửa tầng.');
                            }
                          }}
                          className="text-slate-400 hover:text-primary-600 p-1 rounded transition-colors"
                          title="Sửa tầng"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {isSysAdmin && (!floor.apartments || floor.apartments.length === 0) && (
                        <button
                          onClick={() => handleDeleteFloor(floor.id)}
                          className="text-slate-400 hover:text-red-500 p-1 rounded transition-colors"
                          title="Xóa tầng trống"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Apartment Blocks Grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                    {floor.apartments?.map((apt) => {
                      const statusStyles = {
                        AVAILABLE: 'border-emerald-300 bg-emerald-50/50 hover:bg-emerald-100/50 text-emerald-950',
                        OCCUPIED: 'border-indigo-300 bg-indigo-50/50 hover:bg-indigo-100/50 text-indigo-950',
                        RESERVED: 'border-amber-300 bg-amber-50/50 hover:bg-amber-100/50 text-amber-950',
                        MAINTENANCE: 'border-rose-300 bg-rose-50/50 hover:bg-rose-100/50 text-rose-950',
                        INACTIVE: 'border-slate-300 bg-slate-50 hover:bg-slate-100 text-slate-600',
                      };

                      return (
                        <div
                          key={apt.id}
                          onClick={() => setSelectedApartment(apt)}
                          className={`p-3.5 rounded-xl border-2 cursor-pointer transition-all duration-150 transform hover:-translate-y-0.5 shadow-sm ${
                            statusStyles[apt.status] || 'border-slate-200 bg-white'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <span className="font-bold text-base">{apt.code}</span>
                            <StatusBadge status={apt.status} size="sm" />
                          </div>
                          <div className="text-xs text-slate-500 font-medium">
                            {apt.area_m2} m² · {apt.type || '1PN'}
                          </div>
                          <div className="mt-2 text-xs font-semibold">
                            <Money amount={apt.base_rent} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Slide-over Apartment Detail Panel */}
      {selectedApartment && (
        <div className="fixed inset-0 z-50 overflow-hidden">
          <div
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity"
            onClick={() => setSelectedApartment(null)}
          />
          <div className="fixed inset-y-0 right-0 max-w-full flex pl-10">
            <div className="w-screen max-w-md bg-white shadow-2xl p-6 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between border-b border-slate-100 pb-4">
                  <div>
                    <h3 className="text-lg font-bold text-slate-900">
                      Căn hộ {selectedApartment.code}
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">{selectedBuilding?.name}</p>
                  </div>
                  <button
                    onClick={() => setSelectedApartment(null)}
                    className="p-1 rounded-lg text-slate-400 hover:text-slate-600"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <div className="mt-6 space-y-4 text-sm">
                  <div className="flex justify-between py-2 border-b border-slate-50">
                    <span className="text-slate-500">Trạng thái</span>
                    <StatusBadge status={selectedApartment.status} />
                  </div>
                  <div className="flex justify-between py-2 border-b border-slate-50">
                    <span className="text-slate-500">Giá thuê cơ bản</span>
                    <Money amount={selectedApartment.base_rent} className="font-semibold text-slate-900" />
                  </div>
                  <div className="flex justify-between py-2 border-b border-slate-50">
                    <span className="text-slate-500">Diện tích</span>
                    <span className="font-medium">{selectedApartment.area_m2} m²</span>
                  </div>
                  <div className="flex justify-between py-2 border-b border-slate-50">
                    <span className="text-slate-500">Loại phòng</span>
                    <span className="font-medium">{selectedApartment.type || '1PN'}</span>
                  </div>
                  <div className="flex justify-between py-2 border-b border-slate-50">
                    <span className="text-slate-500">Khu / Block</span>
                    <span className="font-medium">
                      {zones.find((z) => z.id === selectedApartment.zone_id)
                        ? `${zones.find((z) => z.id === selectedApartment.zone_id).code}`
                        : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between py-2 border-b border-slate-50">
                    <span className="text-slate-500">Số phòng ngủ</span>
                    <span className="font-medium">{selectedApartment.bedrooms || 1} phòng</span>
                  </div>

                  <div className="pt-2">
                    <span className="text-slate-500 block mb-2 font-medium">Tiện ích đi kèm</span>
                    <div className="flex flex-wrap gap-1.5">
                      <span className="px-2.5 py-1 bg-slate-100 text-slate-700 rounded-lg text-xs font-medium">Wifi</span>
                      <span className="px-2.5 py-1 bg-slate-100 text-slate-700 rounded-lg text-xs font-medium">Điều hòa</span>
                      <span className="px-2.5 py-1 bg-slate-100 text-slate-700 rounded-lg text-xs font-medium">Nóng lạnh</span>
                      <span className="px-2.5 py-1 bg-slate-100 text-slate-700 rounded-lg text-xs font-medium">Khóa từ</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="pt-6 border-t border-slate-100 flex flex-col gap-2.5">
                {selectedApartment.status === 'AVAILABLE' && (
                  <Button
                    variant="primary"
                    className="w-full bg-amber-500 hover:bg-amber-600 text-white flex items-center justify-center gap-1.5"
                    onClick={() => setIsReservationModalOpen(true)}
                  >
                    <BookmarkCheck className="w-4 h-4" />
                    <span>Đặt cọc giữ chỗ (NV-06)</span>
                  </Button>
                )}

                {selectedApartment.status === 'RESERVED' && (
                  <div className="space-y-2 w-full">
                    <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800">
                      <p className="font-semibold flex items-center gap-1">
                        <BookmarkCheck className="w-4 h-4 text-amber-600" />
                        Căn hộ đang được giữ chỗ
                      </p>
                      <p className="text-[11px] mt-0.5">Khách đã đặt cọc giữ chỗ. Xử lý khi khách ký HĐ hoặc hủy:</p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        className="flex-1 text-xs border-rose-200 text-rose-600 hover:bg-rose-50"
                        onClick={() => handleForfeitReservation(selectedApartment.id)}
                      >
                        Hủy mất cọc
                      </Button>
                      <Button
                        variant="outline"
                        className="flex-1 text-xs border-slate-200 text-slate-700 hover:bg-slate-50"
                        onClick={() => handleRefundReservation(selectedApartment.id)}
                      >
                        Hoàn tiền cọc
                      </Button>
                    </div>
                  </div>
                )}

                {selectedApartment.status === 'MAINTENANCE' && (
                  <div className="space-y-2 w-full">
                    <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-800">
                      <p className="font-semibold">Căn hộ đang bảo trì</p>
                      <p className="text-[11px] mt-0.5">Sau chấm dứt hợp đồng, cần bàn giao & nghiệm thu trước khi kinh doanh lại.</p>
                    </div>
                    <Button
                      variant="primary"
                      className="w-full bg-emerald-600 hover:bg-emerald-700 text-white flex items-center justify-center gap-1.5"
                      onClick={handleHandover}
                    >
                      <span>Xác nhận bàn giao & nghiệm thu phòng</span>
                    </Button>
                    <Button
                      variant="outline"
                      className="w-full text-xs border-slate-200 text-slate-700 hover:bg-slate-50"
                      onClick={() => handleSetApartmentStatus('INACTIVE', 'Chuyển căn hộ sang Không kinh doanh (INACTIVE)?')}
                    >
                      Chuyển sang Không kinh doanh
                    </Button>
                  </div>
                )}

                {selectedApartment.status === 'INACTIVE' && (
                  <Button
                    variant="primary"
                    className="w-full bg-emerald-600 hover:bg-emerald-700 text-white"
                    onClick={() => handleSetApartmentStatus('AVAILABLE', 'Kinh doanh lại căn hộ này (AVAILABLE)?')}
                  >
                    <span>Kinh doanh lại</span>
                  </Button>
                )}

                <Button
                  variant="secondary"
                  className="w-full text-slate-600"
                  onClick={() => setSelectedApartment(null)}
                >
                  Đóng panel
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Drawer / Modal Tạo Tòa Nhà Mới (NV-03) */}
      {isBuildingModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full p-6 border border-slate-100 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4 border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  {editingBuilding ? `Sửa Tòa nhà (NV-03)` : 'Thêm Tòa nhà mới (NV-03)'}
                </h3>
                <p className="text-xs text-slate-500">Module: M03{editingBuilding ? ` · Code ${editingBuilding.code} (không đổi được)` : ''}</p>
              </div>
              <button onClick={() => setIsBuildingModalOpen(false)}>
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>

            <form onSubmit={handleCreateBuilding} className="space-y-4">
              {buildingFormError && (
                <div className="p-3 bg-red-50 border border-red-200 text-xs text-red-700 rounded-xl flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>{buildingFormError}</span>
                </div>
              )}

              <FormField
                label="Tên tòa nhà"
                required
                hint="Ví dụ: Tòa Sunrise A, Thảo Điền Tower"
              >
                <Input
                  placeholder="VD: Tòa Sunrise A"
                  value={newBuilding.name}
                  onChange={(e) => setNewBuilding({ ...newBuilding, name: e.target.value })}
                  autoFocus
                />
              </FormField>

              <FormField
                label="Mã tòa (Code)"
                required={!editingBuilding}
                hint={editingBuilding ? 'Mã tòa không được phép sửa sau khi tạo.' : (codeMessage || 'Chỉ chứa chữ hoa (A-Z), số (0-9) và dấu gạch ngang (-). VD: TN-A')}
              >
                <Input
                  placeholder="VD: TN-A"
                  value={newBuilding.code}
                  onChange={(e) => {
                    if (editingBuilding) return;
                    setNewBuilding({ ...newBuilding, code: e.target.value.toUpperCase() });
                    setCodeCheckStatus(null);
                  }}
                  onBlur={editingBuilding ? undefined : handleCodeBlur}
                  disabled={!!editingBuilding}
                  className="font-mono uppercase font-bold disabled:bg-slate-100 disabled:text-slate-500"
                />
              </FormField>

              <FormField label="Chủ sở hữu (tuỳ chọn)" hint="Danh sách owner thuộc tổ chức">
                <select
                  value={newBuilding.owner_id || ''}
                  onChange={(e) => setNewBuilding({ ...newBuilding, owner_id: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 py-2 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  <option value="">— Không gán —</option>
                  {owners.map((o) => (
                    <option key={o.id} value={o.id}>{o.full_name}</option>
                  ))}
                </select>
              </FormField>

              <FormField label="Địa chỉ">
                <Input
                  placeholder="123 Nguyễn Văn A, P.1, Q.1, TP.HCM"
                  value={newBuilding.address}
                  onChange={(e) => setNewBuilding({ ...newBuilding, address: e.target.value })}
                />
              </FormField>

              {/* Thông tin tài khoản nhận tiền (Tùy chọn) */}
              <div className="pt-2 border-t border-slate-100">
                <p className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-2">
                  Tài khoản nhận tiền (Tùy chọn)
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <FormField label="Ngân hàng">
                    <Input
                      placeholder="Vietcombank"
                      value={newBuilding.bank}
                      onChange={(e) => setNewBuilding({ ...newBuilding, bank: e.target.value })}
                    />
                  </FormField>
                  <FormField label="Số tài khoản">
                    <Input
                      placeholder="0123456789"
                      value={newBuilding.account_no}
                      onChange={(e) => setNewBuilding({ ...newBuilding, account_no: e.target.value })}
                    />
                  </FormField>
                </div>
                <div className="mt-3">
                  <FormField label="Tên chủ tài khoản">
                    <Input
                      placeholder="NGUYEN VAN A"
                      value={newBuilding.account_name}
                      onChange={(e) => setNewBuilding({ ...newBuilding, account_name: e.target.value.toUpperCase() })}
                    />
                  </FormField>
                </div>
              </div>

              <FormField label="Ghi chú điều khoản thuê lại">
                <Input
                  placeholder="Hợp đồng thuê 5 năm, kỳ thanh toán quý..."
                  value={newBuilding.lease_notes}
                  onChange={(e) => setNewBuilding({ ...newBuilding, lease_notes: e.target.value })}
                />
              </FormField>

              <div className="flex justify-end gap-2.5 pt-4 border-t border-slate-100">
                <Button variant="secondary" onClick={() => { setIsBuildingModalOpen(false); setEditingBuilding(null); }}>
                  Hủy
                </Button>
                <Button type="submit" variant="primary">
                  {editingBuilding ? 'Lưu thay đổi' : 'Tạo tòa nhà'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Thêm Khu/Block (B1, FR-007) */}
      {isZoneModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-6 border border-slate-100">
            <div className="flex items-center justify-between mb-4 border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">
                Thêm khu vào {selectedBuilding?.name}
              </h3>
              <button onClick={() => setIsZoneModalOpen(false)}>
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>

            <form onSubmit={handleCreateZone} className="space-y-4">
              <FormField label="Mã khu" required hint="Ví dụ: A, B, TOWER-1 (duy nhất trong tòa)">
                <Input
                  placeholder="A"
                  value={newZone.code}
                  onChange={(e) => setNewZone({ ...newZone, code: e.target.value.toUpperCase() })}
                  autoFocus
                />
              </FormField>

              <FormField label="Tên hiển thị" hint="Ví dụ: Khu A —Tower chính">
                <Input
                  placeholder="Khu A"
                  value={newZone.name}
                  onChange={(e) => setNewZone({ ...newZone, name: e.target.value })}
                />
              </FormField>

              <div className="flex justify-end gap-2.5 pt-4 border-t border-slate-100">
                <Button variant="secondary" onClick={() => setIsZoneModalOpen(false)}>
                  Hủy
                </Button>
                <Button type="submit" variant="primary">
                  Thêm khu
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Thêm Tầng (NV-04) */}
      {isFloorModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-6 border border-slate-100">
            <div className="flex items-center justify-between mb-4 border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">
                Thêm tầng vào {selectedBuilding?.name}
              </h3>
              <button onClick={() => setIsFloorModalOpen(false)}>
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>

            <form onSubmit={handleCreateFloor} className="space-y-4">
              <FormField label="Số tầng (Level)" required hint="< 0: Hầm (B1, B2); 0: Trệt; > 0: Tầng 1, 2...">
                <Input
                  type="number"
                  value={newFloor.level}
                  onChange={(e) => setNewFloor({ ...newFloor, level: parseInt(e.target.value, 10) || 1 })}
                  autoFocus
                />
              </FormField>

              <FormField label="Tên hiển thị tầng" hint="Ví dụ: Tầng 1 (Trệt), Tầng 2, Tầng Thượng">
                <Input
                  placeholder="Tầng 1"
                  value={newFloor.name}
                  onChange={(e) => setNewFloor({ ...newFloor, name: e.target.value })}
                />
              </FormField>

              <div className="flex justify-end gap-2.5 pt-4 border-t border-slate-100">
                <Button variant="secondary" onClick={() => setIsFloorModalOpen(false)}>
                  Hủy
                </Button>
                <Button type="submit" variant="primary">
                  Thêm tầng
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Tạo Căn Hộ */}
      {isApartmentModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 border border-slate-100">
            <div className="flex items-center justify-between mb-4 border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">
                Thêm Căn hộ mới vào {selectedBuilding?.name}
              </h3>
              <button onClick={() => setIsApartmentModalOpen(false)}>
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>

            <form onSubmit={handleCreateApartment} className="space-y-4">
              <FormField label="Chọn tầng" required>
                <select
                  value={newApartment.floor_id}
                  onChange={(e) => setNewApartment({ ...newApartment, floor_id: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 py-2 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  {floorMap.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name || `Tầng ${f.level}`}
                    </option>
                  ))}
                </select>
              </FormField>

              <FormField label="Khu / Block (tuỳ chọn)" hint="Phân khu lớn trong tòa, ví dụ Block A">
                <select
                  value={newApartment.zone_id || ''}
                  onChange={(e) => setNewApartment({ ...newApartment, zone_id: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 py-2 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  <option value="">— Không phân khu —</option>
                  {zones.filter((z) => z.status === 'ACTIVE').map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.code}{z.name ? ` — ${z.name}` : ''}
                    </option>
                  ))}
                </select>
              </FormField>

              <FormField label="Mã căn hộ" required error={aptFormError} hint="Ví dụ: A101, B202">
                <Input
                  placeholder="A101"
                  value={newApartment.code}
                  onChange={(e) => setNewApartment({ ...newApartment, code: e.target.value.toUpperCase() })}
                />
              </FormField>

              <div className="grid grid-cols-2 gap-3">
                <FormField label="Diện tích (m²)">
                  <Input
                    type="number"
                    value={newApartment.area_m2}
                    onChange={(e) => setNewApartment({ ...newApartment, area_m2: e.target.value })}
                  />
                </FormField>

                <FormField label="Loại phòng">
                  <select
                    value={newApartment.type}
                    onChange={(e) => setNewApartment({ ...newApartment, type: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 py-2 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  >
                    <option value="Studio">Studio</option>
                    <option value="1PN">1 Phòng ngủ</option>
                    <option value="2PN">2 Phòng ngủ</option>
                    <option value="3PN">3 Phòng ngủ</option>
                    <option value="Penthouse">Penthouse</option>
                  </select>
                </FormField>
              </div>

              <FormField label="Giá thuê cơ bản (VND/tháng)" required>
                <Input
                  type="number"
                  value={newApartment.base_rent}
                  onChange={(e) => setNewApartment({ ...newApartment, base_rent: e.target.value })}
                />
              </FormField>

              <div className="flex justify-end gap-2.5 pt-4 border-t border-slate-100">
                <Button variant="secondary" onClick={() => setIsApartmentModalOpen(false)}>
                  Hủy
                </Button>
                <Button type="submit" variant="primary">
                  Thêm căn hộ
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Đặt Cọc Giữ Chỗ (NV-06) */}
      {isReservationModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 border border-slate-100">
            <div className="flex items-center justify-between mb-4 border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  Đặt cọc giữ chỗ căn {selectedApartment?.code} (NV-06)
                </h3>
                <p className="text-xs text-slate-500">{selectedBuilding?.name} · Giá niêm yết: <Money amount={selectedApartment?.base_rent} /></p>
              </div>
              <button onClick={() => setIsReservationModalOpen(false)}>
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>

            <form onSubmit={handleCreateReservation} className="space-y-4">
              {reservationError && (
                <div className="p-3 bg-red-50 border border-red-200 text-xs text-red-700 rounded-xl flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>{reservationError}</span>
                </div>
              )}

              <FormField label="Họ tên khách tiềm năng" required>
                <Input
                  placeholder="VD: Nguyễn Văn A"
                  value={reservationData.prospect_name}
                  onChange={(e) => setReservationData({ ...reservationData, prospect_name: e.target.value })}
                  autoFocus
                />
              </FormField>

              <FormField label="Số điện thoại" required>
                <Input
                  placeholder="VD: 0901234567"
                  value={reservationData.phone}
                  onChange={(e) => setReservationData({ ...reservationData, phone: e.target.value })}
                />
              </FormField>

              <div className="grid grid-cols-2 gap-3">
                <FormField label="Tiền giữ chỗ (VND)" required>
                  <Input
                    type="number"
                    value={reservationData.hold_amount}
                    onChange={(e) => setReservationData({ ...reservationData, hold_amount: parseInt(e.target.value, 10) || 0 })}
                  />
                </FormField>
                <FormField label="Giữ đến ngày" required>
                  <Input
                    type="date"
                    value={reservationData.hold_until}
                    onChange={(e) => setReservationData({ ...reservationData, hold_until: e.target.value })}
                  />
                </FormField>
              </div>

              <FormField label="Ghi chú">
                <Input
                  placeholder="Khách hẹn thứ 7 tuần sau qua ký hợp đồng..."
                  value={reservationData.note}
                  onChange={(e) => setReservationData({ ...reservationData, note: e.target.value })}
                />
              </FormField>

              <div className="flex justify-end gap-2.5 pt-4 border-t border-slate-100">
                <Button variant="secondary" onClick={() => setIsReservationModalOpen(false)}>
                  Hủy
                </Button>
                <Button type="submit" variant="primary" className="bg-amber-500 hover:bg-amber-600 text-white">
                  Xác nhận giữ chỗ
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Confirm Deactivate / Reactivate Modal */}
      <ConfirmDialog
        isOpen={confirmStatusModal.isOpen}
        onClose={() => setConfirmStatusModal({ isOpen: false, building: null, targetStatus: null })}
        onConfirm={handleToggleStatus}
        title={confirmStatusModal.targetStatus === 'INACTIVE' ? 'Tạm dừng hoạt động tòa nhà' : 'Kích hoạt lại tòa nhà'}
        description={
          confirmStatusModal.targetStatus === 'INACTIVE'
            ? `Bạn có chắc muốn tạm dừng hoạt động tòa nhà "${confirmStatusModal.building?.name}"? Hệ thống sẽ kiểm tra và từ chối nếu còn hợp đồng thuê đang có hiệu lực (Rule State Machine NV-03).`
            : `Kích hoạt lại hoạt động cho tòa nhà "${confirmStatusModal.building?.name}".`
        }
        confirmText={confirmStatusModal.targetStatus === 'INACTIVE' ? 'Xác nhận tạm dừng' : 'Kích hoạt lại'}
        variant={confirmStatusModal.targetStatus === 'INACTIVE' ? 'warning' : 'primary'}
      />
    </div>
  );
}
