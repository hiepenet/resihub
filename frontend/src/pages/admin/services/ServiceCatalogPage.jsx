import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Sparkles,
  Plus,
  Zap,
  Droplets,
  Wifi,
  Car,
  ShieldCheck,
  Package,
  Edit3,
  Power,
  ArrowRight,
  Users,
  Layers,
} from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { MoneyInput } from '../../../components/ui/MoneyInput';
import { Select } from '../../../components/ui/Select';
import { Modal } from '../../../components/ui/Modal';
import { Badge } from '../../../components/ui/Badge';
import { Card } from '../../../components/ui/Card';
import { PageHeader } from '../../../components/common/PageHeader';
import { SearchBar } from '../../../components/common/SearchBar';
import { EmptyState } from '../../../components/common/EmptyState';
import { servicesService } from '../../../services/services.service';
import { buildingsService } from '../../../services/buildings.service';
import { usePermission } from '../../../hooks/usePermission';
import { useToast } from '../../../hooks/useToast';
import { useAuthStore } from '../../../stores/authStore';
import { formatMoney } from '../../../utils/format';
import { extractErrorMessage } from '../../../utils/validation';

const SERVICE_CATEGORIES = {
  ELECTRICITY: { label: 'Điện sinh hoạt', icon: Zap, color: 'bg-amber-50 text-amber-600 border-amber-200', badge: 'amber' },
  WATER: { label: 'Nước sạch', icon: Droplets, color: 'bg-sky-50 text-sky-600 border-sky-200', badge: 'sky' },
  INTERNET: { label: 'Internet / Viễn thông', icon: Wifi, color: 'bg-indigo-50 text-indigo-600 border-indigo-200', badge: 'indigo' },
  PARKING: { label: 'Gửi xe / Đỗ xe', icon: Car, color: 'bg-purple-50 text-purple-600 border-purple-200', badge: 'purple' },
  CLEANING: { label: 'Vệ sinh căn hộ', icon: Sparkles, color: 'bg-emerald-50 text-emerald-600 border-emerald-200', badge: 'emerald' },
  MANAGEMENT: { label: 'Phí quản lý vận hành', icon: ShieldCheck, color: 'bg-sky-50 text-sky-700 border-sky-200', badge: 'sky' },
  UTILITY: { label: 'Tiện ích mở rộng', icon: Layers, color: 'bg-slate-100 text-slate-700 border-slate-200', badge: 'slate' },
  OTHER: { label: 'Dịch vụ khác', icon: Package, color: 'bg-slate-100 text-slate-600 border-slate-200', badge: 'slate' },
};

const BILLING_TYPES = {
  FIXED: 'Trọn gói cố định / kỳ',
  METERED: 'Theo chỉ số đồng hồ',
  QUANTITY: 'Theo số lượng đăng ký',
};

const CATEGORY_OPTIONS = Object.entries(SERVICE_CATEGORIES).map(([value, item]) => ({
  value,
  label: item.label,
}));

const BILLING_TYPE_OPTIONS = Object.entries(BILLING_TYPES).map(([value, label]) => ({
  value,
  label,
}));

export function ServiceCatalogPage() {
  const toast = useToast();
  const { canManageServiceCatalog } = usePermission();
  const selectedBuildingId = useAuthStore((s) => s.selectedBuildingId);

  const [catalog, setCatalog] = useState([]);
  const [buildings, setBuildings] = useState([]);
  const [pendingSubsCount, setPendingSubsCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL'); // ALL | ACTIVE | INACTIVE

  // Modal tạo / chỉnh sửa dịch vụ
  const [modalOpen, setModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    code: '',
    name: '',
    category: 'UTILITY',
    billing_type: 'FIXED',
    unit: 'tháng',
    unit_price: '',
    building_id: '',
    description: '',
    is_active: true,
  });

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [catRes, subRes, bldgRes] = await Promise.all([
        servicesService.listCatalog(),
        servicesService
          .listSubscriptions({
            building_id: selectedBuildingId || undefined,
            status: 'PENDING_APPROVAL,CANCELLATION_PENDING',
          })
          .catch(() => ({ data: [] })),
        buildingsService.list().catch(() => ({ data: [] })),
      ]);
      setCatalog(catRes.data || []);
      setPendingSubsCount((subRes.data || []).length);
      setBuildings(bldgRes.data || []);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải danh mục dịch vụ.'));
    } finally {
      setLoading(false);
    }
  }, [selectedBuildingId, toast]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const filteredCatalog = useMemo(() => {
    return catalog.filter((item) => {
      if (selectedBuildingId && item.building_id && item.building_id !== selectedBuildingId) {
        return false;
      }
      if (categoryFilter && item.category !== categoryFilter) {
        return false;
      }
      if (statusFilter === 'ACTIVE' && !item.is_active) {
        return false;
      }
      if (statusFilter === 'INACTIVE' && item.is_active) {
        return false;
      }
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const hit =
          item.name?.toLowerCase().includes(q) ||
          item.code?.toLowerCase().includes(q) ||
          item.description?.toLowerCase().includes(q);
        if (!hit) return false;
      }
      return true;
    });
  }, [catalog, selectedBuildingId, categoryFilter, statusFilter, search]);

  const openCreateModal = () => {
    setEditingItem(null);
    setForm({
      code: '',
      name: '',
      category: 'UTILITY',
      billing_type: 'FIXED',
      unit: 'tháng',
      unit_price: '',
      building_id: selectedBuildingId || '',
      description: '',
      is_active: true,
    });
    setModalOpen(true);
  };

  const openEditModal = (item) => {
    setEditingItem(item);
    setForm({
      code: item.code || '',
      name: item.name || '',
      category: item.category || 'UTILITY',
      billing_type: item.billing_type || 'FIXED',
      unit: item.unit || 'tháng',
      unit_price: String(item.unit_price ?? 0),
      building_id: item.building_id || '',
      description: item.description || '',
      is_active: Boolean(item.is_active),
    });
    setModalOpen(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.code.trim() || !form.name.trim()) {
      toast.warning('Vui lòng nhập đầy đủ mã dịch vụ và tên dịch vụ.');
      return;
    }
    if (Number(form.unit_price) < 0 || Number.isNaN(Number(form.unit_price))) {
      toast.warning('Đơn giá dịch vụ không hợp lệ.');
      return;
    }

    setSaving(true);
    try {
      if (editingItem) {
        const res = await servicesService.updateCatalog(editingItem.id, {
          name: form.name.trim(),
          category: form.category,
          billing_type: form.billing_type,
          unit: form.unit.trim() || 'tháng',
          unit_price: Math.round(Number(form.unit_price || 0)),
          description: form.description.trim() || null,
          is_active: form.is_active,
        });
        toast.success(res.message || 'Cập nhật dịch vụ thành công.');
      } else {
        const res = await servicesService.createCatalog({
          code: form.code.trim().toUpperCase(),
          name: form.name.trim(),
          category: form.category,
          billing_type: form.billing_type,
          unit: form.unit.trim() || 'tháng',
          unit_price: Math.round(Number(form.unit_price || 0)),
          building_id: form.building_id || null,
          description: form.description.trim() || null,
        });
        toast.success(res.message || 'Tạo dịch vụ mới thành công.');
      }
      setModalOpen(false);
      fetchData();
    } catch (err) {
      if (err?.response?.data?.code === 'ORG_DEFAULT_SHARED_ACROSS_BUILDINGS') {
        toast.error(
          err.response.data.message ||
            'Không thể sửa dịch vụ mặc định tổ chức khi đang được áp dụng tại tòa nhà khác ngoài phạm vi quản lý. Vui lòng tạo cấu hình riêng cho tòa nhà của bạn.'
        );
      } else {
        toast.error(extractErrorMessage(err, 'Không thể lưu thông tin dịch vụ.'));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (item) => {
    try {
      await servicesService.updateCatalog(item.id, { is_active: !item.is_active });
      toast.success(
        !item.is_active
          ? `Đã kích hoạt lại dịch vụ "${item.name}".`
          : `Đã tạm ngưng cung cấp dịch vụ "${item.name}".`
      );
      fetchData();
    } catch (err) {
      if (err?.response?.data?.code === 'ORG_DEFAULT_SHARED_ACROSS_BUILDINGS') {
        toast.error(
          err.response.data.message ||
            'Không thể thay đổi trạng thái dịch vụ mặc định tổ chức khi đang được áp dụng tại tòa nhà khác ngoài phạm vi quản lý. Vui lòng tạo cấu hình riêng cho tòa nhà của bạn.'
        );
      } else {
        toast.error(extractErrorMessage(err, 'Không thể cập nhật trạng thái dịch vụ.'));
      }
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Danh mục Dịch vụ & Tiện ích"
        subtitle="Thiết lập bảng giá điện, nước, internet, gửi xe, vệ sinh và phí quản lý vận hành tòa nhà."
        actions={
          <>
            <Link to="/admin/services/subscriptions">
              <Button variant="outline" rightIcon={ArrowRight}>
                Quản lý đăng ký dịch vụ
                {pendingSubsCount > 0 ? (
                  <span className="ml-1 px-1.5 py-0.5 text-[11px] rounded-full bg-amber-100 text-amber-800 font-semibold">
                    {pendingSubsCount} chờ duyệt
                  </span>
                ) : null}
              </Button>
            </Link>
            {canManageServiceCatalog ? (
              <Button variant="primary" icon={Plus} onClick={openCreateModal}>
                Thêm dịch vụ mới
              </Button>
            ) : null}
          </>
        }
      />

      {/* Thanh chuyển đổi chế độ M07 */}
      <div className="flex items-center gap-1 border-b border-slate-200">
        <Link
          to="/admin/services"
          className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 border-primary-500 text-primary-600 -mb-px"
        >
          <Sparkles className="w-4 h-4" />
          <span>Bảng giá & Danh mục ({filteredCatalog.length})</span>
        </Link>
        <Link
          to="/admin/services/subscriptions"
          className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 border-transparent text-slate-500 hover:text-slate-800 hover:border-slate-300 -mb-px transition-colors"
        >
          <Users className="w-4 h-4" />
          <span>Đăng ký dịch vụ căn hộ</span>
          {pendingSubsCount > 0 ? (
            <span className="px-1.5 py-0.5 text-[11px] rounded-full bg-amber-100 text-amber-700 font-semibold">
              {pendingSubsCount}
            </span>
          ) : null}
        </Link>
      </div>

      {/* Bộ lọc */}
      <Card className="p-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          <div className="sm:col-span-2">
            <SearchBar
              value={search}
              onChange={setSearch}
              placeholder="Tìm theo tên dịch vụ, mã dịch vụ hoặc mô tả..."
            />
          </div>
          <Select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            placeholder="Tất cả nhóm dịch vụ"
            options={CATEGORY_OPTIONS}
          />
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            options={[
              { value: 'ALL', label: 'Tất cả trạng thái' },
              { value: 'ACTIVE', label: 'Đang cung cấp' },
              { value: 'INACTIVE', label: 'Ngưng cung cấp' },
            ]}
          />
        </div>
      </Card>

      {/* Card Grid danh mục dịch vụ */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div
              key={i}
              className="h-52 rounded-xl bg-white border border-slate-200 animate-pulse p-5"
            />
          ))}
        </div>
      ) : filteredCatalog.length === 0 ? (
        <Card>
          <EmptyState
            icon={Sparkles}
            title="Chưa có dịch vụ nào khớp bộ lọc"
            description="Thêm dịch vụ tiện ích mới vào danh mục để áp dụng cho các hợp đồng thuê."
            action={
              canManageServiceCatalog ? (
                <Button variant="primary" size="sm" icon={Plus} onClick={openCreateModal}>
                  Thêm dịch vụ đầu tiên
                </Button>
              ) : null
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {filteredCatalog.map((svc) => {
            const catMeta = SERVICE_CATEGORIES[svc.category] || SERVICE_CATEGORIES.OTHER;
            const IconComp = catMeta.icon;
            const bldg = buildings.find((b) => b.id === svc.building_id);

            return (
              <Card
                key={svc.id}
                className={`flex flex-col justify-between transition-all hover:shadow-md ${
                  !svc.is_active ? 'opacity-70 bg-slate-50/60' : ''
                }`}
              >
                <div className="space-y-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className={`w-11 h-11 rounded-xl border flex items-center justify-center shrink-0 ${catMeta.color}`}
                      >
                        <IconComp className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-base font-semibold text-slate-900 break-words">
                          {svc.name}
                        </h3>
                        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                          <span className="font-mono text-[11px] font-semibold text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded">
                            {svc.code}
                          </span>
                          <Badge variant={catMeta.badge}>{catMeta.label}</Badge>
                          <Badge variant={svc.building_id ? 'sky' : 'slate'} size="xs">
                            {bldg ? `Tòa ${bldg.code}` : 'Mặc định tổ chức'}
                          </Badge>
                        </div>
                      </div>
                    </div>

                    <Badge variant={svc.is_active ? 'emerald' : 'slate'} dot>
                      {svc.is_active ? 'Đang mở' : 'Tạm ngưng'}
                    </Badge>
                  </div>

                  {/* Đơn giá */}
                  <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-100 flex items-baseline justify-between gap-2">
                    <div>
                      <span className="text-xl font-bold text-primary-700">
                        {formatMoney(svc.unit_price)}
                      </span>
                      <span className="text-xs text-slate-500 ml-1">/ {svc.unit}</span>
                    </div>
                    <span className="text-xs font-medium text-slate-600">
                      {BILLING_TYPES[svc.billing_type] || svc.billing_type}
                    </span>
                  </div>

                  <p className="text-xs text-slate-600 whitespace-pre-line break-words min-h-[2rem]">
                    {svc.description || 'Chưa có mô tả chi tiết cho dịch vụ này.'}
                  </p>
                </div>

                <div className="pt-4 mt-4 border-t border-slate-100 flex items-center justify-between gap-2">
                  <div className="text-xs text-slate-500">
                    <span>
                      Đang dùng:{' '}
                      <strong className="text-slate-800">
                        {svc.active_subscriptions_count || 0} căn
                      </strong>
                    </span>
                    <span className="mx-1.5">•</span>
                    <span>{bldg ? `Tòa ${bldg.code}` : 'Mặc định tổ chức'}</span>
                  </div>

                  {canManageServiceCatalog ? (
                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="ghost"
                        size="xs"
                        icon={Edit3}
                        onClick={() => openEditModal(svc)}
                      >
                        Sửa
                      </Button>
                      <Button
                        variant={svc.is_active ? 'outline' : 'soft'}
                        size="xs"
                        icon={Power}
                        onClick={() => handleToggleActive(svc)}
                      >
                        {svc.is_active ? 'Ngưng' : 'Mở lại'}
                      </Button>
                    </div>
                  ) : null}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Modal thêm / sửa dịch vụ */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingItem ? `Chỉnh sửa dịch vụ: ${editingItem.name}` : 'Thêm dịch vụ mới'}
        subtitle="Định nghĩa đơn giá chuẩn để tự động tổng hợp khi sinh hóa đơn hàng tháng."
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setModalOpen(false)} disabled={saving}>
              Hủy
            </Button>
            <Button variant="primary" onClick={handleSave} loading={saving}>
              {editingItem ? 'Lưu thay đổi' : 'Tạo dịch vụ'}
            </Button>
          </>
        }
      >
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Mã dịch vụ"
              required
              disabled={Boolean(editingItem)}
              placeholder="VD: INTERNET_VIP, GYM_MONTHLY..."
              value={form.code}
              onChange={(e) => setForm((s) => ({ ...s, code: e.target.value.toUpperCase() }))}
              hint={editingItem ? 'Mã dịch vụ cố định không thể đổi' : 'Viết liền không dấu, in hoa'}
            />
            <Input
              label="Tên dịch vụ hiển thị"
              required
              placeholder="VD: Internet Cáp quang 500Mbps"
              value={form.name}
              onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Select
              label="Nhóm phân loại"
              required
              value={form.category}
              onChange={(e) => setForm((s) => ({ ...s, category: e.target.value }))}
              options={CATEGORY_OPTIONS}
            />
            <Select
              label="Phương thức tính phí"
              required
              value={form.billing_type}
              onChange={(e) => setForm((s) => ({ ...s, billing_type: e.target.value }))}
              options={BILLING_TYPE_OPTIONS}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <MoneyInput
              label="Đơn giá chuẩn (VNĐ)"
              required
              placeholder="VD: 220.000"
              value={form.unit_price}
              onChange={(e) => setForm((s) => ({ ...s, unit_price: e.target.value }))}
            />
            <Input
              label="Đơn vị tính"
              required
              placeholder="tháng, xe/tháng, kWh, m³, lần..."
              value={form.unit}
              onChange={(e) => setForm((s) => ({ ...s, unit: e.target.value }))}
            />
          </div>

          {!editingItem ? (
            <Select
              label="Phạm vi áp dụng"
              value={form.building_id}
              onChange={(e) => setForm((s) => ({ ...s, building_id: e.target.value }))}
              placeholder="Mặc định tổ chức (Áp dụng chung)"
              options={buildings.map((b) => ({
                value: b.id,
                label: `Riêng tòa ${b.code} — ${b.name}`,
              }))}
            />
          ) : (
            <Input
              label="Phạm vi áp dụng"
              disabled
              value={
                editingItem.building_id
                  ? (() => {
                      const b = buildings.find((x) => x.id === editingItem.building_id);
                      return b ? `Riêng tòa ${b.code} — ${b.name}` : 'Riêng theo tòa nhà';
                    })()
                  : 'Mặc định tổ chức (Áp dụng chung)'
              }
            />
          )}

          <Input
            label="Mô tả dịch vụ"
            multiline
            rows={3}
            placeholder="Mô tả quyền lợi, chu kỳ đối soát hoặc quy định đăng ký cho cư dân..."
            value={form.description}
            onChange={(e) => setForm((s) => ({ ...s, description: e.target.value }))}
          />

          {editingItem ? (
            <label className="inline-flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={(e) => setForm((s) => ({ ...s, is_active: e.target.checked }))}
                className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
              />
              <span>Đang mở cung cấp cho cư dân đăng ký mới</span>
            </label>
          ) : null}
        </form>
      </Modal>
    </div>
  );
}

export default ServiceCatalogPage;
