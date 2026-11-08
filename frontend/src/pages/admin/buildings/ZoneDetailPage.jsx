import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Edit3, Trash2 } from 'lucide-react';
import { PageHeader } from '../../../components/common/PageHeader';
import { DataTable } from '../../../components/common/DataTable';
import { StatusBadge } from '../../../components/common/StatusBadge';
import { Button } from '../../../components/ui/Button';
import { Modal } from '../../../components/ui/Modal';
import { Input } from '../../../components/ui/Input';
import { PageSkeleton } from '../../../components/ui/Skeleton';
import { buildingsService } from '../../../services/buildings.service';
import { usePermission } from '../../../hooks/usePermission';
import { useToast } from '../../../hooks/useToast';
import { formatMoney } from '../../../utils/format';
import { extractErrorMessage } from '../../../utils/validation';

export function ZoneDetailPage() {
  const { id, zoneId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { canEditRealEstate, canManageBuildings } = usePermission();

  const [building, setBuilding] = useState(null);
  const [zone, setZone] = useState(null);
  const [apartments, setApartments] = useState([]);
  const [loading, setLoading] = useState(true);

  const [editOpen, setEditOpen] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  const loadZone = useCallback(async () => {
    setLoading(true);
    try {
      const [bRes, zRes, aRes] = await Promise.all([
        buildingsService.getById(id),
        buildingsService.listZones(id),
        buildingsService.listApartments({ building_id: id }),
      ]);
      setBuilding(bRes.data);
      const found = (zRes.data || []).find((z) => z.id === zoneId) || null;
      setZone(found);
      setName(found?.name || '');
      setApartments((aRes.data || []).filter((a) => a.zone_id === zoneId));
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [id, zoneId, toast]);

  useEffect(() => {
    loadZone();
  }, [loadZone]);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await buildingsService.updateZone(id, zoneId, { name: name.trim() });
      toast.success('Đã cập nhật tên phân khu.');
      setEditOpen(false);
      loadZone();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setSaving(true);
    try {
      await buildingsService.deleteZone(id, zoneId);
      toast.success(`Đã xóa phân khu ${zone?.code || ''}.`);
      navigate(`/admin/buildings/${id}`);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <PageSkeleton />;

  if (!zone) {
    return (
      <div className="p-8 text-center rounded-2xl bg-white border border-slate-200 space-y-3">
        <p className="text-sm font-semibold text-slate-700">Không tìm thấy phân khu trong tòa nhà này.</p>
        <Button variant="outline" size="sm" onClick={() => navigate(`/admin/buildings/${id}`)}>
          Quay lại tòa nhà
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Phân khu ${zone?.code || ''} — ${zone?.name || ''}`}
        subtitle={`Thuộc tòa nhà ${building?.name || ''} · ${apartments.length} căn hộ`}
        breadcrumbs={[
          { label: 'Bất động sản', to: '/admin/buildings' },
          { label: building?.code || 'Tòa nhà', to: `/admin/buildings/${id}` },
          { label: zone?.code || 'Phân khu' },
        ]}
        actions={
          <>
            {canEditRealEstate ? (
              <Button variant="outline" size="sm" icon={Edit3} onClick={() => setEditOpen(true)}>
                Đổi tên khu
              </Button>
            ) : null}
            {canManageBuildings && apartments.length === 0 ? (
              <Button variant="danger" size="sm" icon={Trash2} onClick={handleDelete} loading={saving}>
                Xóa khu trống
              </Button>
            ) : null}
          </>
        }
      />

      <DataTable
        data={apartments}
        onRowClick={(a) => navigate(`/admin/apartments/${a.id}`)}
        emptyTitle="Chưa có căn hộ nào gán vào phân khu này"
        columns={[
          { key: 'code', label: 'Mã căn hộ', sortable: true, render: (r) => <span className="font-bold text-primary-700">{r.code}</span> },
          {
            key: 'floor_name',
            label: 'Tầng',
            align: 'center',
            sortable: true,
            sortValue: (r) => r.floor_level ?? Number.MAX_SAFE_INTEGER,
            className: 'whitespace-nowrap',
          },
          {
            key: 'type',
            label: 'Loại căn / PN',
            align: 'center',
            className: 'whitespace-nowrap',
            render: (r) => `${r.type || '1PN'} (${r.bedrooms ?? 1} PN)`,
          },
          { key: 'area_m2', label: 'Diện tích', align: 'right', className: 'font-mono tabular-nums whitespace-nowrap', render: (r) => `${r.area_m2 || 0} m²` },
          { key: 'base_rent', label: 'Giá niêm yết', align: 'right', className: 'font-mono tabular-nums whitespace-nowrap', render: (r) => formatMoney(r.base_rent) },
          { key: 'status', label: 'Trạng thái', align: 'center', render: (r) => <StatusBadge status={r.status} domain="apartment" /> },
        ]}
      />

      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Đổi tên phân khu" size="sm">
        <form onSubmit={handleSave} className="space-y-4">
          <Input label="Tên phân khu" required value={name} onChange={(e) => setName(e.target.value)} />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              Hủy
            </Button>
            <Button type="submit" loading={saving}>
              Lưu
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export default ZoneDetailPage;

