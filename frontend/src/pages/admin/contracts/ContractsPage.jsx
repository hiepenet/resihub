import React, { useState, useEffect } from 'react';
import { FileText, Plus, Calendar, Home, User, DollarSign, X } from 'lucide-react';
import Button from '../../../components/ui/Button';
import Input from '../../../components/ui/Input';
import FormField from '../../../components/ui/FormField';
import DataTable from '../../../components/ui/DataTable';
import StatusBadge from '../../../components/ui/StatusBadge';
import Money from '../../../components/ui/Money';
import AccessDenied from '../../../components/common/AccessDenied';
import api from '../../../services/api';
import { useAuthStore } from '../../../stores/authStore';

export default function ContractsPage() {
  const { getCurrentRole } = useAuthStore();
  const currentRole = getCurrentRole();
  const [contracts, setContracts] = useState([]);

  const [buildings, setBuildings] = useState([]);
  const [apartments, setApartments] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [formError, setFormError] = useState('');

  // Phân quyền Hợp đồng: MANAGER (CRU+A - được tạo), OWNER (R + Duyệt PENDING_APPROVAL), RESIDENT (chặn)
  const canCreateContract = currentRole === 'MANAGER';

  // Form
  const [formData, setFormData] = useState({
    building_id: '',
    apartment_id: '',
    primary_tenant_id: '',
    start_date: new Date().toISOString().split('T')[0],
    end_date: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // +6 months
    rent_amount: 8000000,
    deposit_amount: 16000000, // 2 months deposit standard
    billing_day: 1,
    billing_cycle: 'monthly',
    note: '',
  });

  // Phân quyền truy cập trang: chặn RESIDENT
  if (currentRole === 'RESIDENT') {
    return (
      <AccessDenied
        currentRole={currentRole}
        allowedRoles={['OWNER', 'MANAGER']}
      />
    );
  }

  const loadInitialData = async () => {
    setIsLoading(true);
    try {
      const [cRes, bRes, tRes] = await Promise.all([
        api.get('/api/v1/contracts'),
        api.get('/api/v1/buildings'),
        api.get('/api/v1/tenants'),
      ]);

      setContracts(cRes.data?.data || []);
      const bList = bRes.data?.data || [];
      setBuildings(bList);
      setTenants(tRes.data?.data || []);

      if (bList.length > 0) {
        setFormData((prev) => ({ ...prev, building_id: bList[0].id }));
        loadApartments(bList[0].id);
      }
    } catch (err) {
      console.error('Error loading contracts:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const loadApartments = async (buildingId) => {
    try {
      const res = await api.get(`/api/v1/apartments?building_id=${buildingId}&status=AVAILABLE,RESERVED`);
      const apts = res.data?.data || [];
      setApartments(apts);
      if (apts.length > 0) {
        setFormData((prev) => ({
          ...prev,
          apartment_id: apts[0].id,
          rent_amount: apts[0].base_rent || 8000000,
          deposit_amount: (apts[0].base_rent || 8000000) * 2,
        }));
      }
    } catch (err) {
      console.error('Error loading apartments:', err);
    }
  };

  useEffect(() => {
    loadInitialData();
  }, []);

  // B3: đồng bộ với Building Switcher trên TopBar
  useEffect(() => {
    const applySelectedBuilding = (val) => {
      if (val && val !== 'ALL') {
        setFormData((prev) => ({ ...prev, building_id: val }));
        loadApartments(val);
      }
    };
    const onBuildingChanged = (e) => applySelectedBuilding(e.detail);
    applySelectedBuilding(localStorage.getItem('resihub_selected_building_id'));
    window.addEventListener('buildingChanged', onBuildingChanged);
    return () => window.removeEventListener('buildingChanged', onBuildingChanged);
  }, []);

  const handleBuildingChange = (bId) => {
    setFormData((prev) => ({ ...prev, building_id: bId }));
    loadApartments(bId);
  };

  const handleApartmentChange = (aptId) => {
    const apt = apartments.find((a) => a.id === aptId);
    setFormData((prev) => ({
      ...prev,
      apartment_id: aptId,
      rent_amount: apt?.base_rent || prev.rent_amount,
      deposit_amount: apt ? apt.base_rent * 2 : prev.deposit_amount,
    }));
  };

  const handleCreateContract = async (e) => {
    e.preventDefault();
    setFormError('');

    if (!formData.building_id || !formData.apartment_id || !formData.primary_tenant_id) {
      setFormError('Vui lòng chọn đầy đủ tòa nhà, căn hộ và người thuê.');
      return;
    }

    try {
      await api.post('/api/v1/contracts', formData);
      setIsModalOpen(false);
      loadInitialData();
    } catch (err) {
      setFormError(err.response?.data?.message || 'Lỗi khi tạo hợp đồng.');
    }
  };

  const columns = [
    {
      title: 'Căn hộ & Tòa',
      key: 'apartment_code',
      sortable: true,
      render: (val, row) => (
        <div>
          <span className="font-bold text-slate-900 block">Căn {val}</span>
          <span className="text-xs text-slate-400">{row.building_name}</span>
        </div>
      ),
    },
    {
      title: 'Khách thuê',
      key: 'tenant_name',
      sortable: true,
      render: (val, row) => (
        <div>
          <span className="font-semibold text-slate-900 block">{val}</span>
          <span className="text-xs text-slate-400">{row.tenant_phone}</span>
        </div>
      ),
    },
    {
      title: 'Thời hạn thuê',
      key: 'start_date',
      render: (val, row) => (
        <span className="text-xs text-slate-600 font-medium">
          {new Date(val).toLocaleDateString('vi-VN')} → {new Date(row.end_date).toLocaleDateString('vi-VN')}
        </span>
      ),
    },
    {
      title: 'Giá thuê / tháng',
      key: 'rent_amount',
      sortable: true,
      render: (val) => <Money amount={val} className="font-semibold text-slate-900" />,
    },
    {
      title: 'Tiền cọc giữ',
      key: 'deposit_amount',
      render: (val) => <Money amount={val} className="text-indigo-600 font-semibold" />,
    },
    {
      title: 'Trạng thái',
      key: 'status',
      render: (val) => <StatusBadge status={val} />,
    },
    ...(canCreateContract || currentRole === 'OWNER' ? [{
      title: 'Thao tác',
      key: 'actions',
      render: (val, row) => <ContractActions row={row} currentRole={currentRole} onChanged={loadInitialData} />,
    }] : []),
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight">
            Quản lý Hợp đồng Thuê
          </h2>
          <p className="text-xs sm:text-sm text-slate-500 mt-1">
            Thiết lập điều khoản thuê, chu kỳ thu tiền, ràng buộc cọc và trạng thái hiệu lực
          </p>
        </div>

        {canCreateContract && (
          <Button
            variant="primary"
            size="md"
            onClick={() => setIsModalOpen(true)}
            leftIcon={Plus}
          >
            Lập hợp đồng mới
          </Button>
        )}
      </div>


      <DataTable
        columns={columns}
        data={contracts}
        isLoading={isLoading}
        searchKeys={['apartment_code', 'tenant_name', 'building_name', 'tenant_phone']}
        emptyTitle="Chưa có hợp đồng nào"
        emptyDescription="Nhấn 'Lập hợp đồng mới' để tạo hợp đồng cho căn hộ có sẵn."
      />

      {/* Modal Lập Hợp Đồng */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full p-6 border border-slate-100 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4 border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">Lập Hợp đồng Thuê Nhà</h3>
              <button onClick={() => setIsModalOpen(false)}>
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>

            <form onSubmit={handleCreateContract} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Tòa nhà" required>
                  <select
                    value={formData.building_id}
                    onChange={(e) => handleBuildingChange(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 py-2 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  >
                    {buildings.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                </FormField>

                <FormField label="Căn hộ trống" required>
                  <select
                    value={formData.apartment_id}
                    onChange={(e) => handleApartmentChange(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 py-2 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  >
                    {apartments.length === 0 ? (
                      <option value="">Không có căn trống</option>
                    ) : (
                      apartments.map((a) => (
                        <option key={a.id} value={a.id}>
                          Căn {a.code} ({a.area_m2}m²){a.status === 'RESERVED' ? ' — Đã cọc giữ chỗ' : ''}
                        </option>
                      ))
                    )}
                  </select>
                </FormField>
              </div>

              <FormField label="Khách thuê đại diện (Chủ hộ)" required error={formError}>
                <select
                  value={formData.primary_tenant_id}
                  onChange={(e) => setFormData({ ...formData, primary_tenant_id: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 py-2 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  <option value="">-- Chọn khách thuê --</option>
                  {tenants.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.full_name} ({t.phone})
                    </option>
                  ))}
                </select>
              </FormField>

              <div className="grid grid-cols-2 gap-3">
                <FormField label="Ngày bắt đầu thuê" required>
                  <Input
                    type="date"
                    value={formData.start_date}
                    onChange={(e) => setFormData({ ...formData, start_date: e.target.value })}
                  />
                </FormField>

                <FormField label="Ngày kết thúc hợp đồng" required>
                  <Input
                    type="date"
                    value={formData.end_date}
                    onChange={(e) => setFormData({ ...formData, end_date: e.target.value })}
                  />
                </FormField>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <FormField label="Giá thuê / tháng (VND)" required>
                  <Input
                    type="number"
                    value={formData.rent_amount}
                    onChange={(e) => setFormData({ ...formData, rent_amount: e.target.value })}
                  />
                </FormField>

                <FormField label="Tiền đặt cọc (VND)" required hint="Tự động mở sổ cọc HELD">
                  <Input
                    type="number"
                    value={formData.deposit_amount}
                    onChange={(e) => setFormData({ ...formData, deposit_amount: e.target.value })}
                  />
                </FormField>
              </div>

              <FormField label="Ghi chú điều khoản bổ sung">
                <Input
                  placeholder="Ghi chú về nội thất, chu kỳ thanh toán..."
                  value={formData.note}
                  onChange={(e) => setFormData({ ...formData, note: e.target.value })}
                />
              </FormField>

              <div className="flex justify-end gap-2.5 pt-4 border-t border-slate-100">
                <Button variant="secondary" onClick={() => setIsModalOpen(false)}>
                  Hủy
                </Button>
                <Button type="submit" variant="primary">
                  Xác nhận ký hợp đồng
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// Hành động theo trạng thái hợp đồng (A3: DRAFT → bản ký → ACTIVE; PENDING_APPROVAL → OWNER duyệt)
function ContractActions({ row, currentRole, onChanged }) {
  const fileRef = React.useRef(null);

  const handleActivate = async () => {
    if (!window.confirm('Kích hoạt hợp đồng này? Hệ thống kiểm tra bản scan, giấy tờ, căn hộ và kỳ hạn.')) return;
    try {
      await api.post(`/api/v1/contracts/${row.id}/activate`);
      onChanged();
    } catch (err) {
      alert(err.response?.data?.message || 'Lỗi khi kích hoạt hợp đồng.');
    }
  };

  const handleCancel = async () => {
    const reason = window.prompt('Lý do hủy hợp đồng nháp:');
    if (reason === null) return;
    try {
      await api.post(`/api/v1/contracts/${row.id}/cancel`, { reason });
      onChanged();
    } catch (err) {
      alert(err.response?.data?.message || 'Lỗi khi hủy hợp đồng.');
    }
  };

  const handleApprove = async () => {
    if (!window.confirm('Phê duyệt và kích hoạt hợp đồng (giá lệch khung đã được xem xét)?')) return;
    try {
      await api.post(`/api/v1/contracts/${row.id}/approve`);
      onChanged();
    } catch (err) {
      alert(err.response?.data?.message || 'Lỗi khi phê duyệt hợp đồng.');
    }
  };

  const handleScanFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      alert('Ảnh vượt quá 5MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await api.post(`/api/v1/contracts/${row.id}/scan`, { image_base64: reader.result });
        alert('Đã đính kèm bản scan hợp đồng.');
        onChanged();
      } catch (err) {
        alert(err.response?.data?.message || 'Lỗi khi đính kèm bản scan.');
      }
    };
    reader.readAsDataURL(file);
  };

  if (row.status === 'DRAFT') {
    return (
      <div className="flex flex-col gap-1.5 min-w-[150px]">
        <button
          className="px-2 py-1 text-xs rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 font-medium"
          onClick={handleActivate}
        >
          Kích hoạt
        </button>
        <div className="flex gap-1.5">
          <button
            className="px-2 py-1 text-xs rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50"
            onClick={() => fileRef.current?.click()}
          >
            Đính bản ký
          </button>
          <button
            className="px-2 py-1 text-xs rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50"
            onClick={handleCancel}
          >
            Hủy
          </button>
        </div>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png" className="hidden" onChange={handleScanFile} />
      </div>
    );
  }

  if (row.status === 'PENDING_APPROVAL' && currentRole === 'OWNER') {
    return (
      <button
        className="px-2 py-1 text-xs rounded-lg bg-amber-500 text-white hover:bg-amber-600 font-medium"
        onClick={handleApprove}
      >
        Duyệt
      </button>
    );
  }

  if (row.status === 'ACTIVE') {
    return (
      <button
        className="px-2 py-1 text-xs rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
        onClick={async () => {
          if (!window.confirm('Chấm dứt hợp đồng này sớm? Căn hộ sẽ chuyển sang bảo trì chờ bàn giao.')) return;
          try {
            await api.post(`/api/v1/contracts/${row.id}/terminate`, { note: 'Chấm dứt từ danh sách hợp đồng' });
            onChanged();
          } catch (err) {
            alert(err.response?.data?.message || 'Lỗi khi chấm dứt hợp đồng.');
          }
        }}
      >
        Chấm dứt
      </button>
    );
  }

  return <span className="text-xs text-slate-400">—</span>;
}
