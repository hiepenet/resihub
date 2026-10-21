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
    deposit_amount: 8000000, // 1 month deposit standard (PRD v2.0)
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
        // ERR-4: bám Building Switcher — localStorage set trước khi fetch xong thì dùng nó, bList[0] chỉ là fallback
        const saved = localStorage.getItem('resihub_selected_building_id');
        const target = saved && saved !== 'ALL' && bList.some((b) => b.id === saved) ? saved : bList[0].id;
        setFormData((prev) => ({ ...prev, building_id: target }));
        loadApartments(target);
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
          deposit_amount: (apts[0].base_rent || 8000000) * 1,
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
      deposit_amount: apt ? apt.base_rent * 1 : prev.deposit_amount,
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

                <FormField label="Tiền đặt cọc (VND)" required hint="Quy tắc: 1 tháng tiền thuê. Sau ký, thu bù chênh lệch qua Sổ cọc">
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
  const [isOccupantsOpen, setIsOccupantsOpen] = useState(false);
  const [isServicesOpen, setIsServicesOpen] = useState(false);
  const [isAmendmentsOpen, setIsAmendmentsOpen] = useState(false);

  const handleActivate = async () => {
    if (!window.confirm('Kích hoạt hợp đồng này? Hệ thống kiểm tra bản scan, giấy tờ, căn hộ và kỳ hạn.')) return;
    try {
      const res = await api.post(`/api/v1/contracts/${row.id}/activate`);
      if (res.data?.remaining_collect > 0) {
        alert(res.data.message || `Kích hoạt thành công. Cần thu bổ sung ${res.data.remaining_collect.toLocaleString('vi-VN')} ₫ vào Sổ cọc.`);
      }
      onChanged();
    } catch (err) {
      // PRICE_NEEDS_APPROVAL: 409 hợp lệ — DB đã chuyển PENDING_APPROVAL, phải refresh row;
      // các 409 khác không đổi state, refresh vô hại
      alert(err.response?.data?.message || 'Lỗi khi kích hoạt hợp đồng.');
      if (err.response?.status === 409) onChanged();
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
      const res = await api.post(`/api/v1/contracts/${row.id}/approve`);
      if (res.data?.remaining_collect > 0) {
        alert(res.data.message || `Phê duyệt thành công. Cần thu bổ sung ${res.data.remaining_collect.toLocaleString('vi-VN')} ₫ vào Sổ cọc.`);
      }
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

  const renderNavButtons = () => (
    <>
      <div className="flex flex-wrap gap-1">
        <OccupantsButton onClick={() => setIsOccupantsOpen(true)} />
        <ServicesButton onClick={() => setIsServicesOpen(true)} />
        {['ACTIVE', 'RENEWAL_PENDING'].includes(row.status) && (
          <AmendmentsButton onClick={() => setIsAmendmentsOpen(true)} />
        )}
      </div>
      {isOccupantsOpen && <OccupantsModal contractId={row.id} onClose={() => { setIsOccupantsOpen(false); onChanged(); }} />}
      {isServicesOpen && <ServicePricesModal contractId={row.id} startDate={row.start_date} onClose={() => { setIsServicesOpen(false); onChanged(); }} />}
      {isAmendmentsOpen && <AmendmentsModal contract={row} currentRole={currentRole} onClose={() => { setIsAmendmentsOpen(false); onChanged(); }} />}
    </>
  );

  if (row.status === 'DRAFT') {
    return (
      <div className="flex flex-col gap-1.5 min-w-[150px]">
        {renderNavButtons()}
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
      <div className="flex flex-col gap-1.5">
        {renderNavButtons()}
        <button
          className="px-2 py-1 text-xs rounded-lg bg-amber-500 text-white hover:bg-amber-600 font-medium"
          onClick={handleApprove}
        >
          Duyệt
        </button>
      </div>
    );
  }

  if (row.status === 'TERMINATION_PENDING') {
    if (currentRole === 'OWNER') {
      return (
        <div className="flex flex-col gap-1.5">
          {renderNavButtons()}
          <button
            className="px-2 py-1 text-xs rounded-lg bg-rose-600 text-white hover:bg-rose-700 font-medium"
            onClick={async () => {
              if (!window.confirm('Xác nhận duyệt chấm dứt hợp đồng? Căn hộ sẽ chuyển sang bảo trì.')) return;
              try {
                await api.post(`/api/v1/contracts/${row.id}/terminate/approve`);
                onChanged();
              } catch (err) {
                alert(err.response?.data?.message || 'Lỗi khi duyệt chấm dứt.');
              }
            }}
          >
            Duyệt chấm dứt
          </button>
          <button
            className="px-2 py-1 text-xs rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 font-medium"
            onClick={async () => {
              const reason = window.prompt('Lý do từ chối yêu cầu chấm dứt:');
              if (reason === null) return;
              if (!reason.trim()) {
                alert('Vui lòng nhập lý do từ chối');
                return;
              }
              try {
                await api.post(`/api/v1/contracts/${row.id}/terminate/reject`, { reason: reason.trim() });
                onChanged();
              } catch (err) {
                alert(err.response?.data?.message || 'Lỗi khi từ chối chấm dứt.');
              }
            }}
          >
            Từ chối
          </button>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-1.5">
        {renderNavButtons()}
        <span className="text-xs px-2 py-1 rounded bg-amber-50 text-amber-700 border border-amber-200 font-medium text-center">
          Chờ OWNER duyệt chấm dứt
        </span>
      </div>
    );
  }

  if (row.status === 'ACTIVE') {
    return (
      <div className="flex flex-col gap-1.5">
        {renderNavButtons()}
        <button
          className="px-2 py-1 text-xs rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50 font-medium"
          onClick={async () => {
            const todayStr = new Date().toISOString().split('T')[0];
            const termDate = window.prompt(`Ngày chấm dứt hợp đồng (YYYY-MM-DD):`, todayStr);
            if (!termDate) return;
            const reason = window.prompt('Lý do chấm dứt hợp đồng:');
            if (reason === null) return;
            if (!reason.trim()) {
              alert('Vui lòng nhập lý do chấm dứt');
              return;
            }
            try {
              await api.post(`/api/v1/contracts/${row.id}/terminate`, {
                terminated_date: termDate.trim(),
                reason: reason.trim(),
                note: `Chấm dứt sớm: ${reason.trim()}`,
              });
              onChanged();
            } catch (err) {
              alert(err.response?.data?.message || 'Lỗi khi chấm dứt hợp đồng.');
            }
          }}
        >
          Chấm dứt
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {renderNavButtons()}
      <span className="text-xs text-slate-400">—</span>
    </div>
  );

  function OccupantsButton({ onClick }) {
    return (
      <button
        className="px-2 py-1 text-xs rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 font-medium"
        onClick={onClick}
      >
        Thành viên
      </button>
    );
  }

  function ServicesButton({ onClick }) {
    return (
      <button
        className="px-2 py-1 text-xs rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 font-medium"
        onClick={onClick}
      >
        Dịch vụ
      </button>
    );
  }

  function ServicePricesModal({ contractId, startDate, onClose }) {
    const [prices, setPrices] = useState([]);
    const [form, setForm] = useState({
      service_code: 'INTERNET',
      unit_price: 100000,
      effective_from: startDate ? new Date(startDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]
    });

    const SERVICE_LABELS = {
      INTERNET: 'Mạng Internet',
      MOTORBIKE_PARKING: 'Gửi xe máy (xăng)',
      ELECTRICBIKE_PARKING: 'Gửi xe máy điện',
      TRASH: 'Vệ sinh rác',
      COMMON_SERVICE: 'Phí dịch vụ chung'
    };

    const loadPrices = () => {
      api.get(`/api/v1/contracts/${contractId}/service-prices`)
        .then((res) => setPrices(res.data?.data || []))
        .catch((err) => console.error(err));
    };

    useEffect(loadPrices, [contractId]);

    const handleAdd = async (e) => {
      e.preventDefault();
      try {
        await api.post(`/api/v1/contracts/${contractId}/service-prices`, form);
        loadPrices();
      } catch (err) {
        alert(err.response?.data?.message || 'Lỗi khi lưu đơn giá dịch vụ.');
      }
    };

    const handleDelete = async (priceId) => {
      if (!window.confirm('Xóa đơn giá dịch vụ này? Hệ thống sẽ dùng giá tòa/mặc định.')) return;
      try {
        await api.delete(`/api/v1/contracts/${contractId}/service-prices/${priceId}`);
        loadPrices();
      } catch (err) {
        alert(err.response?.data?.message || 'Lỗi khi xóa đơn giá.');
      }
    };

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm" onClick={onClose}>
        <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full p-6 border border-slate-100 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between mb-4 border-b border-slate-100 pb-3">
            <div>
              <h3 className="text-base font-bold text-slate-900">Đơn giá Dịch vụ theo Hợp đồng (FR-065)</h3>
              <p className="text-xs text-slate-500">Ưu tiên áp dụng: Giá hợp đồng → Giá tòa → Giá mặc định</p>
            </div>
            <button onClick={onClose}><X className="w-5 h-5 text-slate-400" /></button>
          </div>

          <div className="space-y-2 mb-4">
            {prices.length === 0 && (
              <p className="text-xs text-slate-400 text-center py-3 border border-dashed rounded-lg">
                Chưa có đơn giá riêng cho hợp đồng này (sử dụng biểu phí chuẩn của tòa nhà).
              </p>
            )}
            {prices.map((p) => (
              <div key={p.id} className="flex items-center justify-between p-2.5 rounded-lg border border-slate-100 bg-slate-50/50">
                <div>
                  <span className="text-sm font-semibold text-slate-900">
                    {SERVICE_LABELS[p.service_code] || p.service_code}
                  </span>
                  <span className="text-xs text-slate-400 block">
                    Áp dụng từ: {new Date(p.effective_from).toLocaleDateString('vi-VN')}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <Money amount={p.unit_price} className="font-bold text-indigo-600 text-sm" />
                  <button
                    className="text-xs text-rose-600 hover:text-rose-700 font-medium"
                    onClick={() => handleDelete(p.id)}
                  >
                    Xóa
                  </button>
                </div>
              </div>
            ))}
          </div>

          <form onSubmit={handleAdd} className="space-y-3 pt-3 border-t border-slate-100">
            <p className="text-xs font-bold text-slate-800 uppercase tracking-wider">Thêm / Cập nhật đơn giá</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 sm:col-span-1">
                <label className="text-[11px] text-slate-500 font-medium block mb-1">Mã dịch vụ *</label>
                <select
                  value={form.service_code}
                  onChange={(e) => setForm({ ...form, service_code: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 py-1.5 px-2.5 text-xs bg-white"
                >
                  {Object.entries(SERVICE_LABELS).map(([code, label]) => (
                    <option key={code} value={code}>{label} ({code})</option>
                  ))}
                </select>
              </div>

              <div className="col-span-2 sm:col-span-1">
                <label className="text-[11px] text-slate-500 font-medium block mb-1">Đơn giá riêng (VND) *</label>
                <Input
                  type="number"
                  min="0"
                  value={form.unit_price}
                  onChange={(e) => setForm({ ...form, unit_price: e.target.value })}
                />
              </div>

              <div className="col-span-2">
                <label className="text-[11px] text-slate-500 font-medium block mb-1">Ngày hiệu lực *</label>
                <Input
                  type="date"
                  value={form.effective_from}
                  onChange={(e) => setForm({ ...form, effective_from: e.target.value })}
                />
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <Button type="submit" variant="primary" size="sm">
                Lưu đơn giá
              </Button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  function AmendmentsButton({ onClick }) {
    return (
      <button
        className="px-2 py-1 text-xs rounded-lg border border-indigo-200 text-indigo-700 hover:bg-indigo-50 font-medium"
        onClick={onClick}
      >
        Phụ lục
      </button>
    );
  }

  function AmendmentsModal({ contract, currentRole, onClose }) {
    const [versions, setVersions] = useState([]);
    const [type, setType] = useState('RENEWAL'); // RENEWAL | RENT | DEPOSIT | NOTE
    const [form, setForm] = useState({
      end_date: contract.end_date ? new Date(new Date(contract.end_date).getTime() + 180 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] : '',
      rent_amount: contract.rent_amount || '',
      deposit_amount: contract.deposit_amount || '',
      note: '',
      reason: '',
      effective_from: new Date().toISOString().split('T')[0],
    });

    const loadVersions = () => {
      api.get(`/api/v1/contracts/${contract.id}/amendments`)
        .then((res) => setVersions(res.data?.data || []))
        .catch((err) => console.error(err));
    };

    useEffect(loadVersions, [contract.id]);

    const handleCreate = async (e) => {
      e.preventDefault();
      if (!form.reason.trim()) {
        alert('Vui lòng nhập lý do lập phụ lục.');
        return;
      }

      const changes = {};
      if (type === 'RENEWAL') changes.end_date = form.end_date;
      if (type === 'RENT') changes.rent_amount = Number(form.rent_amount);
      if (type === 'DEPOSIT') changes.deposit_amount = Number(form.deposit_amount);
      if (type === 'NOTE') changes.note = form.note;

      try {
        await api.post(`/api/v1/contracts/${contract.id}/amendments`, {
          changes,
          reason: form.reason.trim(),
          effective_from: form.effective_from,
        });
        alert('Đã gửi đề xuất phụ lục hợp đồng, chờ OWNER phê duyệt.');
        setForm((prev) => ({ ...prev, reason: '' }));
        loadVersions();
      } catch (err) {
        alert(err.response?.data?.message || 'Lỗi khi đề xuất phụ lục.');
      }
    };

    const handleApprove = async (versionId) => {
      if (!window.confirm('Phê duyệt và áp dụng phụ lục này vào hợp đồng?')) return;
      try {
        await api.post(`/api/v1/contracts/${contract.id}/amendments/${versionId}/approve`);
        alert('Phê duyệt phụ lục thành công.');
        loadVersions();
      } catch (err) {
        alert(err.response?.data?.message || 'Lỗi khi phê duyệt phụ lục.');
      }
    };

    const handleReject = async (versionId) => {
      const reason = window.prompt('Lý do từ chối phụ lục:');
      if (reason === null) return;
      if (!reason.trim()) {
        alert('Vui lòng nhập lý do từ chối.');
        return;
      }
      try {
        await api.post(`/api/v1/contracts/${contract.id}/amendments/${versionId}/reject`, { reason: reason.trim() });
        alert('Đã từ chối phụ lục.');
        loadVersions();
      } catch (err) {
        alert(err.response?.data?.message || 'Lỗi khi từ chối phụ lục.');
      }
    };

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm" onClick={onClose}>
        <div className="bg-white rounded-2xl shadow-2xl max-w-xl w-full p-6 border border-slate-100 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between mb-4 border-b border-slate-100 pb-3">
            <div>
              <h3 className="text-base font-bold text-slate-900">Phụ lục Hợp đồng (FR-016 / FR-015)</h3>
              <p className="text-xs text-slate-500">Căn {contract.apartment_code} · Khách {contract.tenant_name}</p>
            </div>
            <button onClick={onClose}><X className="w-5 h-5 text-slate-400" /></button>
          </div>

          {/* Lịch sử phiên bản phụ lục */}
          <div className="space-y-3 mb-6">
            <p className="text-xs font-bold text-slate-800 uppercase tracking-wider">Lịch sử phụ lục hợp đồng</p>
            {versions.length === 0 && (
              <p className="text-xs text-slate-400 text-center py-3 border border-dashed rounded-lg">
                Chưa có phụ lục hợp đồng nào.
              </p>
            )}
            {versions.map((v) => {
              const diff = v.diff || {};
              const isPending = !v.approved_by && diff.status !== 'REJECTED';
              const isApproved = !!v.approved_by || diff.status === 'APPROVED';
              const isRejected = diff.status === 'REJECTED';

              return (
                <div key={v.id} className="p-3 rounded-xl border border-slate-200 bg-slate-50/50 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-900">Phụ lục #{v.version_no} · {v.reason}</span>
                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                      isApproved ? 'bg-emerald-100 text-emerald-800' :
                      isRejected ? 'bg-rose-100 text-rose-800' :
                      'bg-amber-100 text-amber-800'
                    }`}>
                      {isApproved ? 'Đã duyệt' : isRejected ? 'Từ chối' : 'Chờ duyệt'}
                    </span>
                  </div>

                  <div className="text-xs text-slate-600 space-y-1">
                    {diff.end_date && (
                      <p>Gia hạn thời hạn: <strong>{diff.end_date.old} → {diff.end_date.new}</strong></p>
                    )}
                    {diff.rent_amount && (
                      <p>Điều chỉnh giá thuê: <strong>{Number(diff.rent_amount.old).toLocaleString('vi-VN')} ₫ → {Number(diff.rent_amount.new).toLocaleString('vi-VN')} ₫</strong></p>
                    )}
                    {diff.deposit_amount && (
                      <p>Điều chỉnh tiền cọc: <strong>{Number(diff.deposit_amount.old).toLocaleString('vi-VN')} ₫ → {Number(diff.deposit_amount.new).toLocaleString('vi-VN')} ₫</strong></p>
                    )}
                    {diff.note && (
                      <p>Cập nhật điều khoản: <em>{diff.note.new}</em></p>
                    )}
                    <p className="text-[11px] text-slate-400">
                      Hiệu lực: {new Date(v.effective_from).toLocaleDateString('vi-VN')}
                      {v.approved_by_name && ` · Người duyệt: ${v.approved_by_name}`}
                      {diff.rejection_reason && ` · Lý do từ chối: ${diff.rejection_reason}`}
                    </p>
                  </div>

                  {isPending && currentRole === 'OWNER' && (
                    <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
                      <Button size="sm" variant="outline" onClick={() => handleReject(v.id)} className="text-rose-600 border-rose-200 hover:bg-rose-50 text-xs">
                        Từ chối
                      </Button>
                      <Button size="sm" variant="primary" onClick={() => handleApprove(v.id)} className="bg-emerald-600 hover:bg-emerald-700 text-xs">
                        Duyệt phụ lục
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Form lập đề xuất phụ lục mới */}
          {['ACTIVE', 'RENEWAL_PENDING'].includes(contract.status) && (
            <form onSubmit={handleCreate} className="space-y-3 pt-3 border-t border-slate-100">
              <p className="text-xs font-bold text-slate-800 uppercase tracking-wider">Đề xuất phụ lục mới (MANAGER/OWNER)</p>

              <div>
                <label className="text-xs text-slate-600 font-medium block mb-1">Nội dung thay đổi</label>
                <select
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 py-1.5 px-3 text-xs bg-white"
                >
                  <option value="RENEWAL">Gia hạn thời hạn hợp đồng (end_date)</option>
                  <option value="RENT">Điều chỉnh giá thuê (rent_amount)</option>
                  <option value="DEPOSIT">Điều chỉnh tiền cọc (deposit_amount)</option>
                  <option value="NOTE">Bổ sung điều khoản ghi chú (note)</option>
                </select>
              </div>

              {type === 'RENEWAL' && (
                <div>
                  <label className="text-xs text-slate-600 font-medium block mb-1">Ngày kết thúc mới (Gia hạn) *</label>
                  <Input
                    type="date"
                    required
                    value={form.end_date}
                    onChange={(e) => setForm({ ...form, end_date: e.target.value })}
                  />
                  <span className="text-[11px] text-slate-400">Hạn hiện tại: {contract.end_date}</span>
                </div>
              )}

              {type === 'RENT' && (
                <div>
                  <label className="text-xs text-slate-600 font-medium block mb-1">Giá thuê mới / tháng (VND) *</label>
                  <Input
                    type="number"
                    required
                    min="0"
                    value={form.rent_amount}
                    onChange={(e) => setForm({ ...form, rent_amount: e.target.value })}
                  />
                  <span className="text-[11px] text-slate-400">Giá hiện tại: {Number(contract.rent_amount).toLocaleString('vi-VN')} ₫</span>
                </div>
              )}

              {type === 'DEPOSIT' && (
                <div>
                  <label className="text-xs text-slate-600 font-medium block mb-1">Tiền cọc mới (VND) *</label>
                  <Input
                    type="number"
                    required
                    min="0"
                    value={form.deposit_amount}
                    onChange={(e) => setForm({ ...form, deposit_amount: e.target.value })}
                  />
                  <span className="text-[11px] text-slate-400">Cọc hiện tại: {Number(contract.deposit_amount).toLocaleString('vi-VN')} ₫</span>
                </div>
              )}

              {type === 'NOTE' && (
                <div>
                  <label className="text-xs text-slate-600 font-medium block mb-1">Nội dung điều khoản mới *</label>
                  <Input
                    required
                    value={form.note}
                    placeholder="vd: Cho phép nuôi thú cưng nhỏ, thêm 1 chỗ gửi xe..."
                    onChange={(e) => setForm({ ...form, note: e.target.value })}
                  />
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="text-xs text-slate-600 font-medium block mb-1">Lý do lập phụ lục *</label>
                  <Input
                    required
                    placeholder="vd: Khách thỏa thuận thuê thêm 6 tháng, gia hạn hợp đồng..."
                    value={form.reason}
                    onChange={(e) => setForm({ ...form, reason: e.target.value })}
                  />
                </div>

                <div className="col-span-2">
                  <label className="text-xs text-slate-600 font-medium block mb-1">Ngày hiệu lực *</label>
                  <Input
                    type="date"
                    required
                    value={form.effective_from}
                    onChange={(e) => setForm({ ...form, effective_from: e.target.value })}
                  />
                </div>
              </div>

              <div className="flex justify-end pt-2">
                <Button type="submit" variant="primary" size="sm">
                  Gửi đề xuất phụ lục
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    );
  }

  function OccupantsModal({ contractId, onClose }) {
    const [list, setList] = useState([]);
    const [form, setForm] = useState({ full_name: '', phone: '', relationship: '', email: '', id_number: '' });

    const load = () => {
      api.get(`/api/v1/contracts/${contractId}/occupants`)
        .then((res) => setList(res.data?.data || []))
        .catch(() => {});
    };
    useEffect(load, [contractId]);

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm" onClick={onClose}>
        <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full p-6 border border-slate-100 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between mb-4 border-b border-slate-100 pb-3">
            <h3 className="text-base font-bold text-slate-900">Thành viên cùng ở</h3>
            <button onClick={onClose}><X className="w-5 h-5 text-slate-400" /></button>
          </div>

          <div className="space-y-2 mb-4">
            {list.length === 0 && (
              <p className="text-xs text-slate-400 text-center py-2">Chưa có thành viên cùng ở nào.</p>
            )}
            {list.map((m) => (
              <div key={m.tenant_id} className="flex items-center justify-between p-2.5 rounded-lg border border-slate-100 bg-slate-50/50">
                <div>
                  <span className="text-sm font-medium text-slate-900">{m.full_name}</span>
                  <span className="text-xs text-slate-400 block">{m.phone} · {m.relationship || '—'}</span>
                </div>
                <button
                  className="text-xs text-rose-600 hover:text-rose-700 font-medium"
                  onClick={async () => {
                    if (!window.confirm(`Gỡ ${m.full_name} khỏi hợp đồng? Hồ sơ cư dân sẽ được giữ nguyên.`)) return;
                    try {
                      await api.delete(`/api/v1/contracts/${contractId}/occupants/${m.tenant_id}`);
                      load();
                    } catch (err) {
                      alert(err.response?.data?.message || 'Lỗi khi gỡ thành viên.');
                    }
                  }}
                >
                  Gỡ
                </button>
              </div>
            ))}
          </div>

          <form
            className="space-y-3 pt-3 border-t border-slate-100"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api.post(`/api/v1/contracts/${contractId}/occupants`, form);
                setForm({ full_name: '', phone: '', relationship: '', email: '', id_number: '' });
                load();
              } catch (err) {
                alert(err.response?.data?.message || 'Lỗi khi thêm thành viên.');
              }
            }}
          >
            <p className="text-xs font-bold text-slate-800 uppercase tracking-wider">Thêm thành viên</p>
            <div className="grid grid-cols-2 gap-3">
              <input required placeholder="Họ tên *" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} className="w-full rounded-lg border border-slate-300 py-2 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
              <input required placeholder="SĐT *" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="w-full rounded-lg border border-slate-300 py-2 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
              <input required placeholder="Quan hệ * (vd: vợ, con)" value={form.relationship} onChange={(e) => setForm({ ...form, relationship: e.target.value })} className="w-full rounded-lg border border-slate-300 py-2 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
              <input placeholder="Số CCCD" value={form.id_number} onChange={(e) => setForm({ ...form, id_number: e.target.value })} className="w-full rounded-lg border border-slate-300 py-2 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
              <input placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="col-span-2 w-full rounded-lg border border-slate-300 py-2 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
            </div>
            <div className="flex justify-end">
              <Button type="submit" variant="primary" size="sm">Thêm</Button>
            </div>
          </form>
        </div>
      </div>
    );
  }
}
