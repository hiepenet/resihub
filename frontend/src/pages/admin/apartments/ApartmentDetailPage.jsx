import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Edit3,
  CheckCircle2,
  Plus,
  Gauge,
  Wrench,
  FileSignature,
  Bookmark,
  Layers,
} from 'lucide-react';
import { PageHeader } from '../../../components/common/PageHeader';
import { StatusBadge } from '../../../components/common/StatusBadge';
import { DataTable } from '../../../components/common/DataTable';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
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

export function ApartmentDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { canEditRealEstate, isManager } = usePermission();

  const [apt, setApt] = useState(null);
  const [zones, setZones] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    zone_id: '',
    area_m2: 0,
    base_rent: 0,
    note: '',
    amenitiesText: '',
  });

  const loadApartment = useCallback(async () => {
    setLoading(true);
    try {
      const res = await buildingsService.getApartment(id);
      const d = res.data;
      setApt(d);
      if (d?.building_id) {
        const zRes = await buildingsService.listZones(d.building_id).catch(() => ({ data: [] }));
        setZones(zRes.data || []);
      }
      const am =
        d.amenities && typeof d.amenities === 'object'
          ? Object.keys(d.amenities)
              .filter((k) => d.amenities[k])
              .join(', ')
          : '';
      setForm({
        zone_id: d.zone_id || '',
        area_m2: d.area_m2 || 0,
        base_rent: d.base_rent || 0,
        note: d.note || '',
        amenitiesText: am,
      });
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    loadApartment();
  }, [loadApartment]);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const amenitiesObj = {};
      form.amenitiesText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((k) => {
          amenitiesObj[k] = true;
        });

      await buildingsService.updateApartment(id, {
        zone_id: form.zone_id || null,
        area_m2: Number(form.area_m2),
        base_rent: Number(form.base_rent),
        note: form.note,
        amenities: amenitiesObj,
      });
      toast.success('Đã cập nhật thông tin căn hộ.');
      setEditOpen(false);
      loadApartment();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleTransition = async (nextStatus) => {
    setSaving(true);
    try {
      await buildingsService.updateApartment(id, { status: nextStatus });
      toast.success(`Đã chuyển trạng thái sang ${APARTMENT_STATUS[nextStatus]?.label || nextStatus}.`);
      loadApartment();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleHandover = async () => {
    setSaving(true);
    try {
      const res = await buildingsService.handoverApartment(id);
      toast.success(res.message || 'Nghiệm thu & bàn giao phòng thành công.');
      loadApartment();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleReservationAction = async (resId, action) => {
    setSaving(true);
    try {
      if (action === 'refund')
        await buildingsService.refundReservation(resId, { reason: 'Hoàn cọc giữ chỗ cho khách' });
      else if (action === 'forfeit')
        await buildingsService.forfeitReservation(resId, { reason: 'Khách quá hạn không ký HĐ' });
      toast.success('Đã xử lý hồ sơ giữ chỗ.');
      loadApartment();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading && !apt) return <PageSkeleton />;
  if (!apt) return null;

  const manualTransitions = (apt.allowed_transitions || []).filter(
    (st) => !['OCCUPIED', 'RESERVED'].includes(st)
  );
  const amenityKeys =
    apt.amenities && typeof apt.amenities === 'object'
      ? Object.entries(apt.amenities)
          .filter(([, v]) => Boolean(v))
          .map(([k, v]) => (typeof v === 'string' ? `${k}: ${v}` : k))
      : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Căn hộ ${apt.code}`}
        subtitle={`${apt.building_code} — ${apt.building_name} · ${apt.floor_name || ''}${
          apt.zone_code ? ` · Khu ${apt.zone_code}` : ''
        }`}
        breadcrumbs={[
          { label: 'Bất động sản', to: '/admin/buildings' },
          { label: apt.building_code, to: `/admin/buildings/${apt.building_id}` },
          { label: 'Sơ đồ tầng', to: `/admin/buildings/${apt.building_id}/floor-plan` },
          { label: `Căn ${apt.code}` },
        ]}
        actions={
          <>
            {canEditRealEstate && apt.status === 'MAINTENANCE' ? (
              <Button variant="success" size="sm" icon={CheckCircle2} onClick={handleHandover} loading={saving}>
                Nghiệm thu & Bàn giao
              </Button>
            ) : null}
            {isManager && ['AVAILABLE', 'RESERVED'].includes(apt.status) ? (
              <Button
                size="sm"
                icon={Plus}
                onClick={() => navigate(`/admin/contracts?apartment_id=${apt.id}`)}
              >
                Tạo hợp đồng thuê
              </Button>
            ) : null}
            {canEditRealEstate ? (
              <Button variant="outline" size="sm" icon={Edit3} onClick={() => setEditOpen(true)}>
                Chỉnh sửa
              </Button>
            ) : null}
          </>
        }
      />

      {/* Info & State Machine */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2 space-y-4">
          <CardHeader title="Thông số kỹ thuật & Tiện nghi" />
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3.5">
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-100">
              <p className="text-xs text-slate-400">Trạng thái</p>
              <div className="mt-1">
                <StatusBadge status={apt.status} domain="apartment" />
              </div>
            </div>
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-100">
              <p className="text-xs text-slate-400">Phân khu (Khu)</p>
              <div className="mt-1">
                {apt.zone_id ? (
                  <Link
                    to={`/admin/buildings/${apt.building_id}/zones/${apt.zone_id}`}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-primary-700 hover:underline"
                  >
                    <Layers className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">
                      {apt.zone_code}
                      {apt.zone_name ? ` — ${apt.zone_name}` : ''}
                    </span>
                  </Link>
                ) : (
                  <span className="text-xs text-slate-400 italic">Chưa gán khu</span>
                )}
              </div>
            </div>
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-100">
              <p className="text-xs text-slate-400">Giá niêm yết</p>
              <p className="text-sm font-bold text-primary-600 mt-1">{formatMoney(apt.base_rent)}</p>
            </div>
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-100">
              <p className="text-xs text-slate-400">Diện tích</p>
              <p className="text-sm font-bold text-slate-800 mt-1">{apt.area_m2 || 0} m²</p>
            </div>
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-100 col-span-2 sm:col-span-1">
              <p className="text-xs text-slate-400">Thiết kế</p>
              <p className="text-sm font-bold text-slate-800 mt-1">
                {apt.type || '1PN'} ({apt.bedrooms || 1} PN)
              </p>
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold text-slate-600 mb-2">Danh sách nội thất / tiện nghi</p>
            {amenityKeys.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {amenityKeys.map((k) => (
                  <Badge key={k} variant="sky">
                    {k}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-400">Chưa khai báo danh mục tiện nghi chi tiết.</p>
            )}
          </div>

          {apt.note ? (
            <div className="p-3 rounded-xl bg-amber-50/50 border border-amber-100 text-xs text-slate-700">
              <span className="font-semibold">Ghi chú:</span> {apt.note}
            </div>
          ) : null}
        </Card>

        <Card className="space-y-4">
          <CardHeader
            title="Chuyển trạng thái (FR-008)"
            subtitle="OCCUPIED & RESERVED tự động đồng bộ qua Hợp đồng / Giữ chỗ"
          />
          {canEditRealEstate && manualTransitions.length > 0 ? (
            <div className="flex flex-col gap-2">
              {manualTransitions.map((st) => (
                <Button
                  key={st}
                  variant="outline"
                  size="sm"
                  loading={saving}
                  onClick={() => handleTransition(st)}
                  className="justify-between"
                >
                  <span>Chuyển sang: {APARTMENT_STATUS[st]?.label || st}</span>
                  <StatusBadge status={st} domain="apartment" />
                </Button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-500">
              Không có chuyển đổi thủ công khả dụng ở trạng thái hiện tại.
            </p>
          )}

          {/* Meters Quick Summary */}
          <div className="pt-3 border-t border-slate-100 space-y-2">
            <p className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
              <Gauge className="w-4 h-4 text-primary-500" />
              Đồng hồ Điện / Nước
            </p>
            {(apt.meters || []).length === 0 ? (
              <p className="text-xs text-slate-400">Chưa gắn đồng hồ.</p>
            ) : (
              apt.meters.map((m) => (
                <div key={m.id} className="flex items-center justify-between text-xs p-2.5 rounded-lg bg-slate-50">
                  <div>
                    <span className="font-semibold text-slate-800">
                      {m.meter_type === 'ELECTRICITY' ? 'Điện' : 'Nước'} ({m.meter_code})
                    </span>
                    <p className="text-[11px] text-slate-400">
                      Đơn giá: {formatMoney(m.unit_price)}/{m.unit}
                    </p>
                  </div>
                  <div className="text-right">
                    <span className="font-bold text-primary-700">
                      {m.latest_reading ?? m.initial_reading} {m.unit}
                    </span>
                    {m.latest_period ? <p className="text-[11px] text-slate-400">Kỳ {m.latest_period}</p> : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      {/* Contracts & Reservations */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card padding={false} className="overflow-hidden min-w-0">
          <div className="p-5 pb-3 flex items-center gap-2">
            <FileSignature className="w-4 h-4 text-primary-500" />
            <h3 className="text-sm font-semibold text-slate-900">Lịch sử Hợp đồng của căn hộ</h3>
          </div>
          <DataTable
            embedded
            data={apt.contracts || []}
            onRowClick={(c) => navigate(`/admin/contracts/${c.id}`)}
            emptyTitle="Chưa phát sinh hợp đồng"
            columns={[
              {
                key: 'tenant_name',
                label: 'Khách thuê',
                render: (r) => <span className="font-medium text-slate-900">{r.tenant_name || '—'}</span>,
              },
              {
                key: 'period',
                label: 'Kỳ hạn',
                align: 'center',
                className: 'whitespace-nowrap text-xs',
                render: (r) => `${formatDate(r.start_date)} → ${formatDate(r.end_date)}`,
              },
              {
                key: 'rent_amount',
                label: 'Giá thuê',
                align: 'right',
                className: 'font-mono tabular-nums whitespace-nowrap',
                render: (r) => formatMoney(r.rent_amount),
              },
              {
                key: 'status',
                label: 'Trạng thái',
                align: 'center',
                render: (r) => <StatusBadge status={r.status} domain="contract" />,
              },
            ]}
          />
        </Card>

        <Card padding={false} className="overflow-hidden min-w-0">
          <div className="p-5 pb-3 flex items-center gap-2">
            <Bookmark className="w-4 h-4 text-amber-500" />
            <h3 className="text-sm font-semibold text-slate-900">Hồ sơ Đặt cọc Giữ chỗ</h3>
          </div>
          <DataTable
            embedded
            data={apt.reservations || []}
            emptyTitle="Chưa có hồ sơ giữ chỗ"
            columns={[
              {
                key: 'prospect_name',
                label: 'Khách đặt',
                render: (r) => <span className="font-medium text-slate-900">{r.prospect_name}</span>,
              },
              {
                key: 'hold_amount',
                label: 'Tiền giữ chỗ',
                align: 'right',
                className: 'font-mono tabular-nums whitespace-nowrap',
                render: (r) => formatMoney(r.hold_amount),
              },
              {
                key: 'hold_until',
                label: 'Hạn giữ',
                align: 'center',
                className: 'whitespace-nowrap text-xs',
                render: (r) => formatDate(r.hold_until),
              },
              {
                key: 'actions',
                label: 'Xử lý',
                align: 'center',
                className: 'whitespace-nowrap',
                render: (r) =>
                  r.status === 'ACTIVE' && isManager ? (
                    <div className="inline-flex items-center justify-center gap-1">
                      <Button size="xs" variant="outline" onClick={() => handleReservationAction(r.id, 'refund')}>
                        Hoàn cọc
                      </Button>
                      <Button size="xs" variant="danger" onClick={() => handleReservationAction(r.id, 'forfeit')}>
                        Tịch thu
                      </Button>
                    </div>
                  ) : (
                    <Badge variant="slate">{r.status}</Badge>
                  ),
              },
            ]}
          />
        </Card>
      </div>

      {/* Maintenance History */}
      {(apt.service_requests || []).length > 0 ? (
        <Card padding={false} className="overflow-hidden min-w-0">
          <div className="p-5 pb-3 flex items-center gap-2">
            <Wrench className="w-4 h-4 text-amber-500" />
            <h3 className="text-sm font-semibold text-slate-900">Lịch sử Yêu cầu Bảo trì / Báo hỏng</h3>
          </div>
          <DataTable
            embedded
            data={apt.service_requests}
            onRowClick={() => navigate('/admin/maintenance')}
            columns={[
              {
                key: 'tracking_code',
                label: 'Mã YC',
                render: (r) => <span className="font-mono text-xs">{r.tracking_code}</span>,
              },
              { key: 'title', label: 'Nội dung' },
              {
                key: 'created_at',
                label: 'Ngày báo',
                align: 'center',
                className: 'whitespace-nowrap',
                render: (r) => formatDate(r.created_at),
              },
              {
                key: 'status',
                label: 'Trạng thái',
                align: 'center',
                render: (r) => <StatusBadge status={r.status} domain="service_request" />,
              },
            ]}
          />
        </Card>
      ) : null}

      {/* Edit Apartment Modal */}
      <Modal open={editOpen} onClose={() => setEditOpen(false)} title={`Cập nhật căn hộ ${apt.code}`}>
        <form onSubmit={handleSave} className="space-y-4">
          <Select
            label="Phân khu (Khu / Block — FR-007)"
            placeholder="-- Không gán phân khu --"
            value={form.zone_id}
            onChange={(e) => setForm({ ...form, zone_id: e.target.value })}
            options={zones.map((z) => ({
              value: z.id,
              label: `${z.code}${z.name ? ` — ${z.name}` : ''}`,
            }))}
          />
          <div className="grid grid-cols-2 gap-3.5">
            <Input
              label="Diện tích (m²)"
              type="number"
              step="0.5"
              required
              value={form.area_m2}
              onChange={(e) => setForm({ ...form, area_m2: e.target.value })}
            />
            <Input
              label="Giá thuê niêm yết (VND)"
              type="number"
              required
              value={form.base_rent}
              onChange={(e) => setForm({ ...form, base_rent: e.target.value })}
            />
          </div>
          <Input
            label="Tiện nghi (ngăn cách bằng dấu phẩy)"
            placeholder="Điều hòa, Nóng lạnh, Tủ bếp, Máy giặt, Giường tủ"
            value={form.amenitiesText}
            onChange={(e) => setForm({ ...form, amenitiesText: e.target.value })}
          />
          <Input
            label="Ghi chú vận hành"
            multiline
            rows={2}
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              Hủy
            </Button>
            <Button type="submit" loading={saving}>
              Lưu thay đổi
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export default ApartmentDetailPage;
