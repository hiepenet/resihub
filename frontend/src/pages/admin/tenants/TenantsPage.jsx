import React, { useState, useEffect } from 'react';
import { Users, Plus, AlertTriangle, CheckCircle, Search, X } from 'lucide-react';
import Button from '../../../components/ui/Button';
import Input from '../../../components/ui/Input';
import FormField from '../../../components/ui/FormField';
import DataTable from '../../../components/ui/DataTable';
import StatusBadge from '../../../components/ui/StatusBadge';
import AccessDenied from '../../../components/common/AccessDenied';
import api from '../../../services/api';
import { useAuthStore } from '../../../stores/authStore';

export default function TenantsPage() {
  const { getCurrentRole } = useAuthStore();
  const currentRole = getCurrentRole();

  // Phân quyền Cư dân: MANAGER (CRU - được tạo), OWNER (R - chỉ xem), RESIDENT (chặn truy cập)
  const canCreateTenant = currentRole === 'MANAGER';

  if (currentRole === 'RESIDENT') {
    return (
      <AccessDenied
        currentRole={currentRole}
        allowedRoles={['OWNER', 'MANAGER']}
      />
    );
  }

  const [tenants, setTenants] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);


  // Form State
  const [formData, setFormData] = useState({
    full_name: '',
    phone: '',
    email: '',
    id_number: '',
    type: 'primary',
  });
  const [editingTenant, setEditingTenant] = useState(null); // A8: sửa hồ sơ tái dùng modal
  const [formError, setFormError] = useState('');
  const [duplicateWarning, setDuplicateWarning] = useState(null);

  const loadTenants = async () => {
    setIsLoading(true);
    try {
      const res = await api.get('/api/v1/tenants');
      setTenants(res.data?.data || []);
    } catch (err) {
      console.error('Error loading tenants:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadTenants();
  }, []);

  // Real-time Duplicate Check (FR-021)
  useEffect(() => {
    let timeout;
    if (formData.phone && formData.phone.length >= 10) {
      timeout = setTimeout(async () => {
        try {
          const res = await api.get(`/api/v1/tenants/check-dup?phone=${formData.phone}`);
          if (res.data?.isDuplicate) {
            setDuplicateWarning(res.data.duplicates[0]);
          } else {
            setDuplicateWarning(null);
          }
        } catch (e) {
          // ignore
        }
      }, 400);
    } else {
      setDuplicateWarning(null);
    }

    return () => clearTimeout(timeout);
  }, [formData.phone]);

  const handleCreateTenant = async (e) => {
    e.preventDefault();
    setFormError('');

    if (!formData.full_name || !formData.phone) {
      setFormError('Họ tên và số điện thoại là bắt buộc.');
      return;
    }

    try {
      if (editingTenant) {
        // A8: sửa hồ sơ — PATCH, giữ trạng thái
        await api.patch(`/api/v1/tenants/${editingTenant.id}`, {
          full_name: formData.full_name,
          phone: formData.phone,
          email: formData.email,
          id_number: formData.id_number,
        });
      } else {
        await api.post('/api/v1/tenants', formData);
      }
      setIsModalOpen(false);
      setEditingTenant(null);
      setFormData({ full_name: '', phone: '', email: '', id_number: '', type: 'primary' });
      setDuplicateWarning(null);
      loadTenants();
    } catch (err) {
      setFormError(err.response?.data?.message || 'Lỗi khi lưu hồ sơ cư dân.');
    }
  };

  // A6: duyệt / từ chối hồ sơ PENDING
  const handleApproveTenant = async (row, action) => {
    if (action === 'approve' && !row.id_number && !window.confirm('Hồ sơ chưa có CCCD — hệ thống sẽ chặn duyệt. Tiếp tục?')) return;
    try {
      await api.patch(`/api/v1/tenants/${row.id}`, { action });
      loadTenants();
    } catch (err) {
      alert(err.response?.data?.message || 'Lỗi khi duyệt hồ sơ.');
    }
  };

  const openEditTenant = (row) => {
    setEditingTenant(row);
    setFormData({
      full_name: row.full_name || '',
      phone: row.phone || '',
      email: row.email || '',
      id_number: row.id_number || '',
      type: row.type || 'primary',
    });
    setDuplicateWarning(null);
    setIsModalOpen(true);
  };

  const columns = [
    {
      title: 'Họ và tên',
      key: 'full_name',
      sortable: true,
      render: (val, row) => (
        <div>
          <span className="font-semibold text-slate-900 block">{val}</span>
          <span className="text-xs text-slate-400">{row.email || 'Chưa cập nhật email'}</span>
        </div>
      ),
    },
    { title: 'Số điện thoại', key: 'phone', sortable: true },
    { 
      title: 'Số CCCD/CMND', 
      key: 'id_number', 
      render: (val) => currentRole === 'STAFF' ? (
        <span className="text-slate-400 italic font-mono text-xs">•••••••••••• (Ẩn PII)</span>
      ) : (val || '---') 
    },
    {
      title: 'Vai trò thuê',
      key: 'type',
      render: (val) => (
        <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${
          val === 'primary' ? 'bg-primary-50 text-primary-700' : 'bg-slate-100 text-slate-700'
        }`}>
          {val === 'primary' ? 'Chủ hộ thuê' : 'Thành viên cùng ở'}
        </span>
      ),
    },
    {
      title: 'Trạng thái',
      key: 'status',
      render: (val) => <StatusBadge status={val} />,
    },
    ...(canCreateTenant ? [{
      title: 'Thao tác',
      key: 'actions',
      render: (val, row) => (
        <div className="flex gap-1.5">
          {row.status === 'PENDING' && (
            <>
              <button
                className="px-2 py-1 text-xs rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 font-medium"
                onClick={() => handleApproveTenant(row, 'approve')}
              >
                Duyệt
              </button>
              <button
                className="px-2 py-1 text-xs rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50"
                onClick={() => handleApproveTenant(row, 'reject')}
              >
                Từ chối
              </button>
            </>
          )}
          <button
            className="px-2 py-1 text-xs rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 font-medium"
            onClick={() => openEditTenant(row)}
          >
            Sửa
          </button>
        </div>
      ),
    }] : []),
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight">
            Quản lý Cư dân & Khách thuê
          </h2>
          <p className="text-xs sm:text-sm text-slate-500 mt-1">
            Hồ sơ khách hàng, phân loại chủ hộ / thành viên, kiểm tra trùng lặp CCCD/SĐT
          </p>
        </div>

        {canCreateTenant && (
          <Button
            variant="primary"
            size="md"
            onClick={() => {
              setEditingTenant(null);
              setFormData({ full_name: '', phone: '', email: '', id_number: '', type: 'primary' });
              setDuplicateWarning(null);
              setIsModalOpen(true);
            }}
            leftIcon={Plus}
          >
            Thêm cư dân mới
          </Button>
        )}
      </div>


      <DataTable
        columns={columns}
        data={tenants}
        isLoading={isLoading}
        searchKeys={['full_name', 'phone', 'id_number']}
        emptyTitle="Chưa có hồ sơ cư dân"
        emptyDescription="Nhấn 'Thêm cư dân mới' để đăng ký hồ sơ khách thuê đầu tiên."
      />

      {/* Modal Thêm Cư Dân với FR-021 Duplicate Check */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full p-6 border border-slate-100">
            <div className="flex items-center justify-between mb-4 border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">{editingTenant ? 'Cập nhật hồ sơ cư dân' : 'Tạo hồ sơ Cư dân'}</h3>
              <button onClick={() => setIsModalOpen(false)}>
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>

            <form onSubmit={handleCreateTenant} className="space-y-4">
              <FormField label="Họ và tên" required error={formError}>
                <Input
                  placeholder="Ví dụ: Trần Văn Nam"
                  value={formData.full_name}
                  onChange={(e) => setFormData({ ...formData, full_name: e.target.value })}
                />
              </FormField>

              <FormField label="Số điện thoại" required hint="Hệ thống tự động kiểm tra trùng lặp hồ sơ">
                <Input
                  type="tel"
                  placeholder="090 123 4567"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                />
              </FormField>

              {/* FR-021 Duplicate Alert Banner */}
              {duplicateWarning && (
                <div className="p-3 bg-amber-50 rounded-xl border border-amber-200 text-amber-900 text-xs flex items-start gap-2.5">
                  <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <strong className="block">Cảnh báo trùng số điện thoại (FR-021)!</strong>
                    Số này đã thuộc hồ sơ: <strong>{duplicateWarning.full_name}</strong>. Hệ thống sẽ liên kết hồ sơ hiện tại thay vì tạo trùng lặp.
                  </div>
                </div>
              )}

              {editingTenant && <IdImagesSection tenantId={editingTenant.id} />}

              <div className="grid grid-cols-2 gap-3">
                <FormField label="Số CCCD / Hộ chiếu">
                  <Input
                    placeholder="079090..."
                    value={formData.id_number}
                    onChange={(e) => setFormData({ ...formData, id_number: e.target.value })}
                  />
                </FormField>

                <FormField label="Vai trò">
                  <select
                    value={formData.type}
                    onChange={(e) => setFormData({ ...formData, type: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 py-2 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  >
                    <option value="primary">Chủ hộ (Đại diện HĐ)</option>
                    <option value="occupant">Thành viên ở cùng</option>
                  </select>
                </FormField>
              </div>

              <FormField label="Email">
                <Input
                  type="email"
                  placeholder="nam.tran@example.com"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                />
              </FormField>

              <div className="flex justify-end gap-2.5 pt-4 border-t border-slate-100">
                <Button variant="secondary" onClick={() => setIsModalOpen(false)}>
                  Hủy
                </Button>
                <Button type="submit" variant="primary">
                  Lưu hồ sơ cư dân
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// B7: ảnh CCCD (mặt trước/sau) trong modal sửa hồ sơ — fetch blob gắn Bearer rồi objectURL
// (ERR-2: <img src> trần không mang Authorization, API yêu cầu Bearer)
function IdImagesSection({ tenantId }) {
  const [images, setImages] = useState([]);
  const [urls, setUrls] = useState({});

  const load = () => {
    api.get(`/api/v1/tenants/${tenantId}/id-images`)
      .then(async (res) => {
        const list = res.data?.data || [];
        setImages(list);
        const next = {};
        for (const im of list) {
          if (!urls[im.attachment_id]) {
            try {
              const blobRes = await api.get(`/api/v1/attachments/${im.attachment_id}/view`, { responseType: 'blob' });
              next[im.attachment_id] = URL.createObjectURL(blobRes.data);
            } catch {
              next[im.attachment_id] = null;
            }
          } else {
            next[im.attachment_id] = urls[im.attachment_id];
          }
        }
        setUrls(next);
      })
      .catch(() => {});
  };
  useEffect(load, [tenantId]);

  const upload = (side) => (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      alert('Ảnh vượt quá 5MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await api.post(`/api/v1/tenants/${tenantId}/id-images`, { image_base64: reader.result, side });
        load();
      } catch (err) {
        alert(err.response?.data?.message || 'Lỗi khi lưu ảnh.');
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="pt-2 border-t border-slate-100">
      <p className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-2">Ảnh CCCD (PII — xem có kiểm soát)</p>
      <div className="grid grid-cols-2 gap-3">
        {['front', 'back'].map((side) => {
          const img = [...images].filter((im) => im.side === side).pop(); // ảnh mới nhất của side (upload lại thay ảnh cũ)
          return (
            <div key={side} className="text-center">
              <div className="aspect-[3/2] rounded-lg border border-dashed border-slate-300 bg-slate-50 flex items-center justify-center overflow-hidden mb-1">
                {img ? (
                  <img
                    src={urls[img.attachment_id] || ''}
                    alt={`CCCD ${side === 'front' ? 'mặt trước' : 'mặt sau'}`}
                    className="w-full h-full object-cover cursor-zoom-in"
                    onClick={() => urls[img.attachment_id] && window.open(urls[img.attachment_id], '_blank')}
                  />
                ) : (
                  <span className="text-xs text-slate-400">{side === 'front' ? 'Mặt trước' : 'Mặt sau'}</span>
                )}
              </div>
              <label className="text-xs text-primary-600 font-medium cursor-pointer hover:underline">
                {img ? 'Thay ảnh' : 'Tải ảnh lên'}
                <input type="file" accept="image/jpeg,image/png" className="hidden" onChange={upload(side)} />
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
}
