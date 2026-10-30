import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  DoorOpen,
  Plus,
  ExternalLink,
  CheckCircle2,
  BookmarkPlus,
  Wrench,
  Layers,
} from 'lucide-react';
import { PageHeader } from '../../../components/common/PageHeader';
import { StatusBadge } from '../../../components/common/StatusBadge';
import { EmptyState } from '../../../components/common/EmptyState';
import { Card } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Modal } from '../../../components/ui/Modal';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { PageSkeleton } from '../../../components/ui/Skeleton';
import { APARTMENT_STATUS } from '../../../constants/statuses';
import { buildingsService } from '../../../services/buildings.service';
import { usePermission } from '../../../hooks/usePermission';
import { useToast } from '../../../hooks/useToast';
import { formatMoney, formatDate } from '../../../utils/format';
import { extractErrorMessage } from '../../../utils/validation';

export function FloorPlanView({ buildingId, embedded = false }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { canEditRealEstate, isManager } = usePermission();

  const [building, setBuilding] = useState(null);
  const [floorMap, setFloorMap] = useState([]);
  const [zones, setZones] = useState([]);
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [zoneFilter, setZoneFilter] = useState('ALL');
  const [loading, setLoading] = useState(true);

  // Slide-over apartment detail
  const [selectedApt, setSelectedApt] = useState(null);
  const [aptDetail, setAptDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Modals: Add Floor, Add Apartment, Create Reservation
  const [floorModalOpen, setFloorModalOpen] = useState(false);
  const [floorForm, setFloorForm] = useState({ level: '', name: '' });

  const [aptModalOpen, setAptModalOpen] = useState(false);
  const [aptForm, setAptForm] = useState({
    floor_id: '',
    zone_id: '',
    code: '',
    type: '1PN',
    bedrooms: 1,
    area_m2: 45,
    base_rent: 8500000,
  });

  const [resModalOpen, setResModalOpen] = useState(false);
  const [resForm, setResForm] = useState({
    prospect_name: '',
    phone: '',
    hold_amount: 2000000,
    hold_from: '',
    hold_until: '',
    note: '',
  });
  const [submitting, setSubmitting] = useState(false);

  const loadFloorPlan = useCallback(async () => {
    if (!buildingId) return;
    setLoading(true);
    try {
      const [bRes, fmRes, zRes] = await Promise.all([
        buildingsService.getById(buildingId),
        buildingsService.getFloorMap(buildingId),
        buildingsService.listZones(buildingId).catch(() => ({ data: [] })),
      ]);
      setBuilding(bRes.data);
      setFloorMap(fmRes.data || []);
      setZones(zRes.data || []);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [buildingId, toast]);

  useEffect(() => {
    loadFloorPlan();
  }, [loadFloorPlan]);

  const handleOpenAptDrawer = async (apt) => {
    setSelectedApt(apt);
    setAptDetail(null);
    setDetailLoading(true);
    try {
      const res = await buildingsService.getApartment(apt.id);
      setAptDetail(res.data);
    } catch {
      setAptDetail(apt);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleCreateFloor = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await buildingsService.createFloor(buildingId, {
        level: Number(floorForm.level),
        name: floorForm.name.trim() || undefined,
      });
      toast.success('Đã thêm tầng mới.');
      setFloorModalOpen(false);
      setFloorForm({ level: '', name: '' });
      loadFloorPlan();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateApt = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await buildingsService.createApartment({
        building_id: buildingId,
        floor_id: aptForm.floor_id || undefined,
        zone_id: aptForm.zone_id || undefined,
        code: aptForm.code.trim().toUpperCase(),
        type: aptForm.type,
        bedrooms: Number(aptForm.bedrooms),
        area_m2: Number(aptForm.area_m2),
        base_rent: Number(aptForm.base_rent),
      });
      toast.success(`Đã tạo căn hộ ${aptForm.code.toUpperCase()}.`);
      setAptModalOpen(false);
      loadFloorPlan();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleHandover = async (aptId) => {
    setSubmitting(true);
    try {
      const res = await buildingsService.handoverApartment(aptId);
      toast.success(res.message || 'Bàn giao phòng thành công.');
      setSelectedApt(null);
      loadFloorPlan();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleChangeStatus = async (aptId, nextStatus) => {
    setSubmitting(true);
    try {
      await buildingsService.updateApartment(aptId, { status: nextStatus });
      toast.success(`Đã chuyển trạng thái sang ${APARTMENT_STATUS[nextStatus]?.label || nextStatus}.`);
      setSelectedApt(null);
      loadFloorPlan();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateReservation = async (e) => {
    e.preventDefault();
    if (!selectedApt) return;
    setSubmitting(true);
    try {
      await buildingsService.createReservation({
        apartment_id: selectedApt.id,
        prospect_name: resForm.prospect_name.trim(),
        phone: resForm.phone.trim(),
        hold_amount: Number(resForm.hold_amount || 0),
        hold_from: resForm.hold_from || undefined,
        hold_until: resForm.hold_until,
        note: resForm.note.trim(),
      });
      toast.success('Đã ghi nhận đặt cọc giữ chỗ thành công.');
      setResModalOpen(false);
      setSelectedApt(null);
      loadFloorPlan();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading && floorMap.length === 0) return <PageSkeleton />;

  const legendItems = [
    { key: 'AVAILABLE', label: 'Còn trống', dot: 'bg-emerald-500' },
    { key: 'OCCUPIED', label: 'Đang thuê', dot: 'bg-rose-500' },
    { key: 'RESERVED', label: 'Đã giữ chỗ', dot: 'bg-amber-500' },
    { key: 'MAINTENANCE', label: 'Đang bảo trì', dot: 'bg-slate-500' },
    { key: 'INACTIVE', label: 'Tạm khóa / Ngưng', dot: 'bg-purple-500' },
  ];

  return (
    <div className="space-y-5">
      {!embedded ? (
        <PageHeader
          title={`Sơ đồ tầng — ${building?.name || ''}`}
          subtitle="Nhấn vào từng ô căn hộ để xem thông tin nhanh, giữ chỗ, bảo trì hoặc bàn giao phòng"
          breadcrumbs={[
            { label: 'Bất động sản', to: '/admin/buildings' },
            { label: building?.code || 'Tòa nhà', to: `/admin/buildings/${buildingId}` },
            { label: 'Sơ đồ tầng' },
          ]}
          actions={
            canEditRealEstate ? (
              <>
                <Button variant="outline" size="sm" icon={Layers} onClick={() => setFloorModalOpen(true)}>
                  Thêm tầng
                </Button>
                <Button
                  size="sm"
                  icon={Plus}
                  onClick={() => {
                    setAptForm((f) => ({ ...f, floor_id: floorMap[0]?.id || '', code: '' }));
                    setAptModalOpen(true);
                  }}
                >
                  Thêm căn hộ
                </Button>
              </>
            ) : null
          }
        />
      ) : null}

      {/* Legend & Filter Bar */}
      <Card className="p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setStatusFilter('ALL')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              statusFilter === 'ALL'
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
            }`}
          >
            Tất cả trạng thái
          </button>
          {legendItems.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setStatusFilter(statusFilter === item.key ? 'ALL' : item.key)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                statusFilter === item.key
                  ? 'bg-primary-50 text-primary-700 border-primary-300'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              <span className={`w-2.5 h-2.5 rounded-full ${item.dot}`} />
              {item.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {zones.length > 0 ? (
            <div className="w-56">
              <Select
                size="sm"
                aria-label="Lọc theo phân khu"
                searchPlaceholder="Tìm khu / block..."
                value={zoneFilter}
                onChange={(e) => setZoneFilter(e.target.value)}
                options={[
                  { value: 'ALL', label: `Tất cả phân khu (${zones.length})` },
                  ...zones.map((z) => ({
                    value: z.id,
                    label: `Khu ${z.code}${z.name ? ` — ${z.name}` : ''}`,
                  })),
                  { value: 'UNASSIGNED', label: 'Chưa gán khu' },
                ]}
              />
            </div>
          ) : null}

          {embedded && canEditRealEstate ? (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="xs" icon={Layers} onClick={() => setFloorModalOpen(true)}>
                Thêm tầng
              </Button>
              <Button
                size="xs"
                icon={Plus}
                onClick={() => {
                  setAptForm((f) => ({ ...f, floor_id: floorMap[0]?.id || '', code: '' }));
                  setAptModalOpen(true);
                }}
              >
                Thêm căn hộ
              </Button>
            </div>
          ) : null}
        </div>
      </Card>

      {/* Floor Rows */}
      {floorMap.length === 0 ? (
        <Card>
          <EmptyState
            icon={DoorOpen}
            title="Chưa có dữ liệu tầng"
            description="Hãy khởi tạo các tầng và căn hộ cho tòa nhà này."
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {floorMap.map((floor) => {
            const apts = (floor.apartments || []).filter((a) => {
              const matchStatus =
                statusFilter === 'ALL'
                  ? true
                  : statusFilter === 'INACTIVE'
                  ? ['INACTIVE', 'BLOCKED'].includes(a.status)
                  : a.status === statusFilter;
              const matchZone =
                zoneFilter === 'ALL'
                  ? true
                  : zoneFilter === 'UNASSIGNED'
                  ? !a.zone_id
                  : a.zone_id === zoneFilter;
              return matchStatus && matchZone;
            });

            return (
              <div
                key={floor.id}
                className="bg-white rounded-xl border border-slate-200/80 shadow-card p-4 flex flex-col md:flex-row md:items-start gap-4"
              >
                <div className="md:w-36 shrink-0 flex md:flex-col justify-between md:justify-start border-b md:border-b-0 md:border-r border-slate-100 pb-2 md:pb-0 md:pr-4">
                  <div>
                    <p className="text-sm font-bold text-slate-900">{floor.name || `Tầng ${floor.level}`}</p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {(floor.apartments || []).length} căn hộ
                    </p>
                  </div>
                </div>

                <div className="flex-1 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-2.5">
                  {apts.length === 0 ? (
                    <p className="col-span-full text-xs text-slate-400 py-2">
                      Không có căn hộ khớp bộ lọc ở tầng này.
                    </p>
                  ) : (
                    apts.map((apt) => {
                      const st = APARTMENT_STATUS[apt.status] || APARTMENT_STATUS.AVAILABLE;
                      return (
                        <button
                          key={apt.id}
                          type="button"
                          onClick={() => handleOpenAptDrawer(apt)}
                          className={`text-left p-3 rounded-xl border transition-all shadow-sm ${st.floorBg}`}
                        >
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-xs font-bold tracking-tight">{apt.code}</span>
                            <span className={`w-2 h-2 rounded-full shrink-0 ${st.dot}`} />
                          </div>
                          <p className="text-[11px] opacity-80 mt-1 truncate">
                            {apt.type || `${apt.bedrooms || 1}PN`} · {apt.area_m2 || 0}m²
                            {apt.zone_code ? ` · ${apt.zone_code}` : ''}
                          </p>
                          <p className="text-[11px] font-semibold mt-0.5 truncate">
                            {formatMoney(apt.base_rent)}
                          </p>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Slide-over Apartment Quick Panel */}
      <Modal
        open={Boolean(selectedApt)}
        onClose={() => setSelectedApt(null)}
        variant="drawer"
        title={`Căn hộ ${selectedApt?.code || ''}`}
        subtitle={`${building?.code || ''} — ${building?.name || ''}`}
        footer={
          selectedApt ? (
            <Button
              variant="outline"
              icon={ExternalLink}
              onClick={() => navigate(`/admin/apartments/${selectedApt.id}`)}
            >
              Mở trang chi tiết căn hộ
            </Button>
          ) : null
        }
      >
        {selectedApt ? (
          <div className="space-y-5">
            <div className="flex items-center justify-between p-3.5 rounded-xl bg-slate-50 border border-slate-200/80">
              <div>
                <p className="text-xs text-slate-500">Trạng thái hiện tại</p>
                <div className="mt-1">
                  <StatusBadge status={selectedApt.status} domain="apartment" />
                </div>
              </div>
              <div className="text-right">
                <p className="text-xs text-slate-500">Giá thuê niêm yết</p>
                <p className="text-base font-bold text-primary-600 mt-0.5">
                  {formatMoney(selectedApt.base_rent)}/tháng
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
              <div className="p-3 rounded-xl border border-slate-200">
                <p className="text-[11px] text-slate-400">Phân khu</p>
                <p className="text-sm font-semibold text-slate-800 mt-0.5 truncate">
                  {selectedApt.zone_code || '—'}
                </p>
              </div>
              <div className="p-3 rounded-xl border border-slate-200">
                <p className="text-[11px] text-slate-400">Loại căn</p>
                <p className="text-sm font-semibold text-slate-800 mt-0.5">{selectedApt.type || '1PN'}</p>
              </div>
              <div className="p-3 rounded-xl border border-slate-200">
                <p className="text-[11px] text-slate-400">Diện tích</p>
                <p className="text-sm font-semibold text-slate-800 mt-0.5">{selectedApt.area_m2 || 0} m²</p>
              </div>
              <div className="p-3 rounded-xl border border-slate-200">
                <p className="text-[11px] text-slate-400">Phòng ngủ</p>
                <p className="text-sm font-semibold text-slate-800 mt-0.5">{selectedApt.bedrooms || 1} PN</p>
              </div>
            </div>

            {/* Active Contract & Reservation Summary if loaded */}
            {detailLoading ? (
              <p className="text-xs text-slate-400">Đang tải chi tiết hợp đồng & giữ chỗ...</p>
            ) : (
              <>
                {aptDetail?.contracts?.length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-slate-700">Hợp đồng gần nhất</p>
                    {aptDetail.contracts.slice(0, 3).map((c) => (
                      <div
                        key={c.id}
                        onClick={() => navigate(`/admin/contracts/${c.id}`)}
                        className="p-3 rounded-xl border border-slate-200 hover:border-primary-300 cursor-pointer flex items-center justify-between"
                      >
                        <div>
                          <p className="text-xs font-semibold text-slate-800">{c.tenant_name || 'Cư dân'}</p>
                          <p className="text-[11px] text-slate-500">
                            {formatDate(c.start_date)} → {formatDate(c.end_date)}
                          </p>
                        </div>
                        <StatusBadge status={c.status} domain="contract" />
                      </div>
                    ))}
                  </div>
                ) : null}

                {(aptDetail?.reservations || []).filter((r) => r.status === 'HELD').length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-amber-800">
                      Đang giữ chỗ ({(aptDetail?.reservations || []).filter((r) => r.status === 'HELD').length} lượt)
                    </p>
                    {(aptDetail?.reservations || [])
                      .filter((r) => r.status === 'HELD')
                      .map((r) => (
                        <div
                          key={r.id}
                          className="p-3 rounded-xl bg-amber-50/70 border border-amber-200 flex items-center justify-between gap-2"
                        >
                          <div>
                            <p className="text-xs font-semibold text-slate-800">
                              {r.prospect_name} <span className="font-mono text-slate-500">({r.phone})</span>
                            </p>
                            <p className="text-[11px] text-amber-800 font-medium">
                              {formatDate(r.hold_from || r.created_at)} → {formatDate(r.hold_until)}
                            </p>
                          </div>
                          <span className="text-xs font-mono font-bold text-amber-900">
                            {formatMoney(r.hold_amount)}
                          </span>
                        </div>
                      ))}
                  </div>
                ) : null}
              </>
            )}

            {/* Quick Actions */}
            <div className="space-y-2.5 pt-2 border-t border-slate-100">
              <p className="text-xs font-semibold text-slate-700">Thao tác nhanh</p>
              <div className="flex flex-wrap gap-2">
                {isManager && ['AVAILABLE', 'RESERVED', 'OCCUPIED'].includes(selectedApt.status) ? (
                  <Button
                    size="sm"
                    variant="warning"
                    icon={BookmarkPlus}
                    onClick={() => {
                      const baseStart = new Date();
                      const heldEnds = (aptDetail?.reservations || [])
                        .filter((r) => r.status === 'HELD' && r.hold_until)
                        .map((r) => String(r.hold_until).slice(0, 10))
                        .sort();
                      const activeContractEnds = (aptDetail?.contracts || [])
                        .filter((c) => ['ACTIVE', 'RENEWAL_PENDING'].includes(c.status) && c.end_date)
                        .map((c) => String(c.end_date).slice(0, 10))
                        .sort();

                      let startStr = baseStart.toISOString().slice(0, 10);
                      if (heldEnds.length > 0) {
                        const afterHeld = new Date(`${heldEnds[heldEnds.length - 1]}T00:00:00Z`);
                        afterHeld.setUTCDate(afterHeld.getUTCDate() + 1);
                        const candidate = afterHeld.toISOString().slice(0, 10);
                        if (candidate > startStr) startStr = candidate;
                      }
                      if (activeContractEnds.length > 0) {
                        const afterContract = activeContractEnds[activeContractEnds.length - 1];
                        if (afterContract > startStr) startStr = afterContract;
                      }

                      const untilDate = new Date(`${startStr}T00:00:00Z`);
                      untilDate.setUTCDate(untilDate.getUTCDate() + 7);
                      setResForm({
                        prospect_name: '',
                        phone: '',
                        hold_amount: 2000000,
                        hold_from: startStr,
                        hold_until: untilDate.toISOString().slice(0, 10),
                        note: '',
                      });
                      setResModalOpen(true);
                    }}
                  >
                    Đặt cọc giữ chỗ
                  </Button>
                ) : null}

                {isManager && ['AVAILABLE', 'RESERVED', 'OCCUPIED'].includes(selectedApt.status) ? (
                  <Button
                    size="sm"
                    icon={Plus}
                    onClick={() => navigate(`/admin/contracts?apartment_id=${selectedApt.id}`)}
                  >
                    Tạo hợp đồng thuê
                  </Button>
                ) : null}

                {canEditRealEstate && selectedApt.status === 'MAINTENANCE' ? (
                  <Button
                    size="sm"
                    variant="success"
                    icon={CheckCircle2}
                    loading={submitting}
                    onClick={() => handleHandover(selectedApt.id)}
                  >
                    Nghiệm thu & Bàn giao (Về Còn trống)
                  </Button>
                ) : null}

                {canEditRealEstate && ['AVAILABLE', 'OCCUPIED'].includes(selectedApt.status) ? (
                  <Button
                    size="sm"
                    variant="outline"
                    icon={Wrench}
                    loading={submitting}
                    onClick={() => handleChangeStatus(selectedApt.id, 'MAINTENANCE')}
                  >
                    Chuyển sang Bảo trì
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* Add Floor Modal */}
      <Modal
        open={floorModalOpen}
        onClose={() => setFloorModalOpen(false)}
        title="Thêm tầng mới"
        size="sm"
      >
        <form onSubmit={handleCreateFloor} className="space-y-4">
          <Input
            label="Số tầng (số nguyên, VD: 11 hoặc -1 cho hầm)"
            type="number"
            required
            value={floorForm.level}
            onChange={(e) => setFloorForm({ ...floorForm, level: e.target.value })}
          />
          <Input
            label="Tên hiển thị (để trống sẽ tự đặt)"
            placeholder="VD: Tầng 11"
            value={floorForm.name}
            onChange={(e) => setFloorForm({ ...floorForm, name: e.target.value })}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setFloorModalOpen(false)}>
              Hủy
            </Button>
            <Button type="submit" loading={submitting}>
              Tạo tầng
            </Button>
          </div>
        </form>
      </Modal>

      {/* Add Apartment Modal */}
      <Modal
        open={aptModalOpen}
        onClose={() => setAptModalOpen(false)}
        title="Thêm căn hộ mới"
        size="md"
      >
        <form onSubmit={handleCreateApt} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <Select
              label="Chọn tầng"
              required
              value={aptForm.floor_id}
              onChange={(e) => setAptForm({ ...aptForm, floor_id: e.target.value })}
              options={floorMap.map((f) => ({ value: f.id, label: f.name || `Tầng ${f.level}` }))}
            />
            {zones.length > 0 ? (
              <Select
                label="Khu / Phân khu"
                placeholder="-- Không chọn --"
                value={aptForm.zone_id}
                onChange={(e) => setAptForm({ ...aptForm, zone_id: e.target.value })}
                options={zones.map((z) => ({ value: z.id, label: `${z.code} — ${z.name || ''}` }))}
              />
            ) : (
              <Input
                label="Mã căn hộ"
                required
                placeholder="VD: A1101"
                value={aptForm.code}
                onChange={(e) => setAptForm({ ...aptForm, code: e.target.value })}
              />
            )}
          </div>
          {zones.length > 0 ? (
            <Input
              label="Mã căn hộ"
              required
              placeholder="VD: A1101"
              value={aptForm.code}
              onChange={(e) => setAptForm({ ...aptForm, code: e.target.value })}
            />
          ) : null}
          <div className="grid grid-cols-3 gap-3">
            <Select
              label="Loại căn"
              value={aptForm.type}
              onChange={(e) => setAptForm({ ...aptForm, type: e.target.value })}
              options={['Studio', '1PN', '2PN', '3PN', 'Penthouse', 'Duplex']}
            />
            <Input
              label="Số phòng ngủ"
              type="number"
              min="0"
              value={aptForm.bedrooms}
              onChange={(e) => setAptForm({ ...aptForm, bedrooms: e.target.value })}
            />
            <Input
              label="Diện tích (m²)"
              type="number"
              min="10"
              step="0.5"
              value={aptForm.area_m2}
              onChange={(e) => setAptForm({ ...aptForm, area_m2: e.target.value })}
            />
          </div>
          <Input
            label="Giá thuê niêm yết (VND/tháng)"
            type="number"
            min="0"
            required
            value={aptForm.base_rent}
            onChange={(e) => setAptForm({ ...aptForm, base_rent: e.target.value })}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setAptModalOpen(false)}>
              Hủy
            </Button>
            <Button type="submit" loading={submitting}>
              Tạo căn hộ
            </Button>
          </div>
        </form>
      </Modal>

      {/* Create Reservation Modal */}
      <Modal
        open={resModalOpen}
        onClose={() => setResModalOpen(false)}
        title={`Đặt cọc giữ chỗ — Căn ${selectedApt?.code || ''}`}
        subtitle="Giữ chỗ tối đa 30 ngày theo quy định FR-067"
      >
        <form onSubmit={handleCreateReservation} className="space-y-4">
          <Input
            label="Họ tên khách đặt giữ chỗ"
            required
            value={resForm.prospect_name}
            onChange={(e) => setResForm({ ...resForm, prospect_name: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-3.5">
            <Input
              label="Số điện thoại"
              required
              placeholder="0912345678"
              value={resForm.phone}
              onChange={(e) => setResForm({ ...resForm, phone: e.target.value })}
            />
            <Input
              label="Tiền cọc giữ chỗ (VND)"
              type="number"
              min="0"
              required
              value={resForm.hold_amount}
              onChange={(e) => setResForm({ ...resForm, hold_amount: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <Input
              label="Giữ chỗ từ ngày"
              type="date"
              required
              value={resForm.hold_from}
              onChange={(e) => setResForm({ ...resForm, hold_from: e.target.value })}
            />
            <Input
              label="Đến hết ngày (tối đa 30 ngày)"
              type="date"
              required
              value={resForm.hold_until}
              onChange={(e) => setResForm({ ...resForm, hold_until: e.target.value })}
            />
          </div>
          <Input
            label="Ghi chú"
            multiline
            rows={2}
            value={resForm.note}
            onChange={(e) => setResForm({ ...resForm, note: e.target.value })}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setResModalOpen(false)}>
              Hủy
            </Button>
            <Button type="submit" loading={submitting}>
              Xác nhận giữ chỗ
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export function FloorPlanPage() {
  const { id } = useParams();
  return <FloorPlanView buildingId={id} embedded={false} />;
}

export default FloorPlanPage;

