import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Building2,
  Plus,
  MapPin,
  Layers,
  DoorOpen,
  LayoutGrid,
  Edit3,
  ArrowRight,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { PageHeader } from '../../../components/common/PageHeader';
import { StatsCard } from '../../../components/common/StatsCard';
import { SearchBar } from '../../../components/common/SearchBar';
import { EmptyState } from '../../../components/common/EmptyState';
import { Card } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { Modal } from '../../../components/ui/Modal';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { PageSkeleton } from '../../../components/ui/Skeleton';
import { buildingsService } from '../../../services/buildings.service';
import { usePermission } from '../../../hooks/usePermission';
import { useToast } from '../../../hooks/useToast';
import { extractErrorMessage } from '../../../utils/validation';

export function BuildingsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { canManageBuildings, canEditRealEstate } = usePermission();

  const [buildings, setBuildings] = useState([]);
  const [owners, setOwners] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [codeCheck, setCodeCheck] = useState(null);
  const [form, setForm] = useState({
    name: '',
    code: '',
    address: '',
    owner_id: '',
    bank_name: '',
    account_number: '',
    account_holder: '',
  });

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [bRes, oRes] = await Promise.all([
        buildingsService.list(),
        buildingsService.listOwners().catch(() => ({ data: [] })),
      ]);
      setBuildings(bRes.data || []);
      setOwners(oRes.data || []);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const openCreate = () => {
    setEditing(null);
    setCodeCheck(null);
    setForm({
      name: '',
      code: '',
      address: '',
      owner_id: owners[0]?.id || '',
      bank_name: 'Vietcombank',
      account_number: '',
      account_holder: '',
    });
    setModalOpen(true);
  };

  const openEdit = (b, e) => {
    e?.stopPropagation();
    setEditing(b);
    setCodeCheck(null);
    const pa = b.payment_account || {};
    setForm({
      name: b.name || '',
      code: b.code || '',
      address: b.address || '',
      owner_id: b.owner_id || '',
      bank_name: pa.bank_name || '',
      account_number: pa.account_number || '',
      account_holder: pa.account_holder || '',
    });
    setModalOpen(true);
  };

  const handleCodeBlur = async () => {
    if (editing || !form.code.trim()) return;
    try {
      const res = await buildingsService.checkCode(form.code.trim());
      setCodeCheck(res);
    } catch {
      setCodeCheck(null);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        code: form.code.trim().toUpperCase(),
        address: form.address.trim(),
        owner_id: form.owner_id || undefined,
        payment_account: {
          bank_name: form.bank_name.trim(),
          account_number: form.account_number.trim(),
          account_holder: form.account_holder.trim(),
        },
      };

      if (editing) {
        await buildingsService.update(editing.id, payload);
        toast.success('Đã cập nhật thông tin tòa nhà.');
      } else {
        await buildingsService.create(payload);
        toast.success('Đã tạo tòa nhà mới thành công.');
      }
      setModalOpen(false);
      loadData();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading && buildings.length === 0) return <PageSkeleton />;

  const filtered = buildings.filter((b) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      b.name?.toLowerCase().includes(q) ||
      b.code?.toLowerCase().includes(q) ||
      b.address?.toLowerCase().includes(q)
    );
  });

  const totals = buildings.reduce(
    (acc, b) => {
      acc.apts += Number(b.total_apartments || 0);
      acc.occupied += Number(b.occupied_apartments || 0);
      acc.available += Number(b.available_apartments || 0);
      return acc;
    },
    { apts: 0, occupied: 0, available: 0 }
  );
  const avgOccupancy = totals.apts > 0 ? ((totals.occupied / totals.apts) * 100).toFixed(1) : '0.0';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Quản lý Bất động sản"
        subtitle="Danh mục các tòa nhà, khu phân khu, tầng và sơ đồ căn hộ trong phạm vi quản lý"
        actions={
          canManageBuildings ? (
            <Button icon={Plus} onClick={openCreate}>
              Thêm tòa nhà mới
            </Button>
          ) : null
        }
      />

      {/* Summary KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatsCard
          title="Tổng số tòa nhà"
          value={buildings.length}
          subtext="Các tòa trong phạm vi phân quyền"
          icon={Building2}
          color="sky"
        />
        <StatsCard
          title="Tổng quy mô căn hộ"
          value={totals.apts}
          subtext={`${totals.occupied} đang thuê · ${totals.available} còn trống`}
          icon={DoorOpen}
          color="indigo"
        />
        <StatsCard
          title="Tỷ lệ lấp đầy trung bình"
          value={`${avgOccupancy}%`}
          subtext="Tính trên tổng quỹ căn hộ khai thác"
          icon={LayoutGrid}
          color="emerald"
        />
      </div>

      <div className="flex items-center justify-between gap-4">
        <SearchBar
          value={search}
          onChange={setSearch}
          placeholder="Tìm theo tên tòa nhà, mã tòa, địa chỉ..."
          className="w-full max-w-md"
        />
      </div>

      {/* Building Card Grid */}
      {filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon={Building2}
            title="Không tìm thấy tòa nhà nào"
            description="Thử thay đổi từ khóa tìm kiếm hoặc thêm tòa nhà mới."
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {filtered.map((b) => {
            const total = Number(b.total_apartments || 0);
            const occ = Number(b.occupied_apartments || 0);
            const avail = Number(b.available_apartments || 0);
            const rate = total > 0 ? Math.round((occ / total) * 100) : 0;

            return (
              <div
                key={b.id}
                onClick={() => navigate(`/admin/buildings/${b.id}`)}
                className="group bg-white rounded-2xl border border-slate-200/80 shadow-card hover:shadow-elevated hover:border-primary-300 transition-all cursor-pointer overflow-hidden flex flex-col"
              >
                {/* Decorative Top Banner */}
                <div className="h-24 bg-gradient-to-r from-sky-600 via-primary-500 to-indigo-600 p-4 flex items-start justify-between text-white relative">
                  <div>
                    <span className="inline-block px-2.5 py-0.5 rounded-md bg-white/20 backdrop-blur text-xs font-bold tracking-wide">
                      {b.code}
                    </span>
                    <h3 className="text-base font-bold mt-1.5 line-clamp-1">{b.name}</h3>
                  </div>
                  <Badge variant={b.status === 'INACTIVE' ? 'slate' : 'emerald'}>
                    {b.status === 'INACTIVE' ? 'Tạm ngưng' : 'Hoạt động'}
                  </Badge>
                </div>

                {/* Body */}
                <div className="p-5 flex-1 flex flex-col justify-between space-y-4">
                  <div className="space-y-3">
                    <p className="text-xs text-slate-500 flex items-start gap-1.5 line-clamp-2 min-h-[32px]">
                      <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                      <span>{b.address || 'Chưa cập nhật địa chỉ'}</span>
                    </p>

                    <div className="grid grid-cols-3 gap-2 py-2.5 px-3 rounded-xl bg-slate-50 border border-slate-100 text-center">
                      <div>
                        <p className="text-[11px] text-slate-400">Số tầng</p>
                        <p className="text-sm font-bold text-slate-800 flex items-center justify-center gap-1 mt-0.5">
                          <Layers className="w-3.5 h-3.5 text-sky-500" />
                          {b.total_floors || 0}
                        </p>
                      </div>
                      <div className="border-x border-slate-200/70">
                        <p className="text-[11px] text-slate-400">Đang thuê</p>
                        <p className="text-sm font-bold text-rose-600 mt-0.5">{occ}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-slate-400">Còn trống</p>
                        <p className="text-sm font-bold text-emerald-600 mt-0.5">{avail}</p>
                      </div>
                    </div>

                    {/* Occupancy Progress */}
                    <div>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-slate-500">Tỷ lệ lấp đầy</span>
                        <span className="font-semibold text-slate-800">
                          {rate}% ({occ}/{total} căn)
                        </span>
                      </div>
                      <div className="w-full h-2 rounded-full bg-slate-100 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-primary-500 to-secondary-500 transition-all"
                          style={{ width: `${Math.min(100, rate)}%` }}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Card Footer */}
                  <div className="pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="soft"
                        size="xs"
                        icon={LayoutGrid}
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/admin/buildings/${b.id}/floor-plan`);
                        }}
                      >
                        Sơ đồ tầng
                      </Button>
                      {canEditRealEstate ? (
                        <Button
                          variant="ghost"
                          size="xs"
                          icon={Edit3}
                          onClick={(e) => openEdit(b, e)}
                        >
                          Sửa
                        </Button>
                      ) : null}
                    </div>
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-primary-600 group-hover:translate-x-0.5 transition-transform">
                      Chi tiết
                      <ArrowRight className="w-3.5 h-3.5" />
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create / Edit Building Modal */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? `Cập nhật tòa nhà ${editing.code}` : 'Khởi tạo tòa nhà mới'}
        subtitle="Thiết lập thông tin định danh, chủ đầu tư sở hữu và tài khoản thụ hưởng"
        size="lg"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
            <div className="sm:col-span-2">
              <Input
                label="Tên tòa nhà"
                required
                placeholder="VD: Vinhomes Ocean Park - Tòa A"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div>
              <Input
                label="Mã tòa nhà"
                required
                disabled={Boolean(editing)}
                placeholder="VD: VOP-A"
                value={form.code}
                onBlur={handleCodeBlur}
                onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
              />
              {codeCheck && !editing ? (
                <p
                  className={`text-[11px] mt-1 flex items-center gap-1 ${
                    codeCheck.available ? 'text-emerald-600' : 'text-rose-600'
                  }`}
                >
                  {codeCheck.available ? (
                    <CheckCircle2 className="w-3.5 h-3.5" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5" />
                  )}
                  {codeCheck.message}
                </p>
              ) : null}
            </div>
          </div>

          <Input
            label="Địa chỉ chi tiết"
            required
            placeholder="Số nhà, đường, quận/huyện, tỉnh/thành phố"
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
          />

          {canManageBuildings && owners.length > 0 ? (
            <Select
              label="Chủ đầu tư sở hữu (OWNER)"
              placeholder="-- Chọn chủ đầu tư --"
              value={form.owner_id}
              onChange={(e) => setForm({ ...form, owner_id: e.target.value })}
              options={owners.map((o) => ({
                value: o.id,
                label: `${o.full_name || o.name}${o.email ? ` (${o.email})` : ''}`,
              }))}
            />
          ) : null}

          <div className="pt-2 border-t border-slate-100">
            <p className="text-xs font-semibold text-slate-700 mb-2.5">
              Tài khoản ngân hàng nhận tiền thuê / phí dịch vụ
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Input
                label="Ngân hàng"
                placeholder="Vietcombank"
                value={form.bank_name}
                onChange={(e) => setForm({ ...form, bank_name: e.target.value })}
              />
              <Input
                label="Số tài khoản"
                placeholder="001100..."
                value={form.account_number}
                onChange={(e) => setForm({ ...form, account_number: e.target.value })}
              />
              <Input
                label="Chủ tài khoản"
                placeholder="CONG TY..."
                value={form.account_holder}
                onChange={(e) => setForm({ ...form, account_holder: e.target.value })}
              />
            </div>
          </div>

          <div className="flex justify-end gap-2.5 pt-3">
            <Button variant="outline" onClick={() => setModalOpen(false)}>
              Hủy bỏ
            </Button>
            <Button type="submit" loading={saving}>
              {editing ? 'Lưu cập nhật' : 'Tạo tòa nhà'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export default BuildingsPage;

