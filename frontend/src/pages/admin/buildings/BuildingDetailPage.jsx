import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Building2,
  LayoutGrid,
  Layers,
  Users,
  FileSignature,
  Plus,
  MapPin,
  ArrowRight,
  Trash2,
  Ban,
  CheckCircle2,
} from 'lucide-react';
import { PageHeader } from '../../../components/common/PageHeader';
import { StatusBadge } from '../../../components/common/StatusBadge';
import { DataTable } from '../../../components/common/DataTable';
import { ConfirmDialog } from '../../../components/common/ConfirmDialog';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Tabs } from '../../../components/ui/Tabs';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { Modal } from '../../../components/ui/Modal';
import { Input } from '../../../components/ui/Input';
import { PageSkeleton } from '../../../components/ui/Skeleton';
import { FloorPlanView } from './FloorPlanPage';
import { buildingsService } from '../../../services/buildings.service';
import { contractsService } from '../../../services/contracts.service';
import { tenantsService } from '../../../services/tenants.service';
import { usePermission } from '../../../hooks/usePermission';
import { useToast } from '../../../hooks/useToast';
import { formatMoney, formatDate } from '../../../utils/format';
import { extractErrorMessage } from '../../../utils/validation';

export function BuildingDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { canEditRealEstate, canManageBuildings } = usePermission();

  const [tab, setTab] = useState('overview');
  const [building, setBuilding] = useState(null);
  const [zones, setZones] = useState([]);
  const [floors, setFloors] = useState([]);
  const [contracts, setContracts] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);

  const [zoneModalOpen, setZoneModalOpen] = useState(false);
  const [zoneForm, setZoneForm] = useState({ code: '', name: '' });
  const [savingZone, setSavingZone] = useState(false);
  const [deactivateConfirmOpen, setDeactivateConfirmOpen] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState(false);

  const loadBuildingData = useCallback(async () => {
    setLoading(true);
    try {
      const [bRes, zRes, fRes, cRes, tRes] = await Promise.all([
        buildingsService.getById(id),
        buildingsService.listZones(id).catch(() => ({ data: [] })),
        buildingsService.listFloors(id).catch(() => ({ data: [] })),
        contractsService.list({ building_id: id }).catch(() => ({ data: [] })),
        tenantsService.list({ building_id: id }).catch(() => ({ data: [] })),
      ]);
      setBuilding(bRes.data);
      setZones(zRes.data || []);
      setFloors(fRes.data || []);
      setContracts(cRes.data || []);
      setTenants(tRes.data || []);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    loadBuildingData();
  }, [loadBuildingData]);

  const handleCreateZone = async (e) => {
    e.preventDefault();
    setSavingZone(true);
    try {
      await buildingsService.createZone(id, {
        code: zoneForm.code.trim().toUpperCase(),
        name: zoneForm.name.trim(),
      });
      toast.success('Đã tạo phân khu mới.');
      setZoneModalOpen(false);
      setZoneForm({ code: '', name: '' });
      loadBuildingData();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSavingZone(false);
    }
  };

  const handleDeleteZone = async (zone, e) => {
    e?.stopPropagation();
    try {
      await buildingsService.deleteZone(id, zone.id);
      toast.success(`Đã xóa phân khu ${zone.code}.`);
      loadBuildingData();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    }
  };

  const handleToggleBuildingStatus = async (nextStatus) => {
    setUpdatingStatus(true);
    try {
      const res = await buildingsService.updateStatus(id, nextStatus);
      toast.success(
        res?.message ||
          (nextStatus === 'INACTIVE'
            ? 'Đã chuyển tòa nhà sang trạng thái Ngừng khai thác.'
            : 'Đã kích hoạt khai thác lại tòa nhà.')
      );
      setDeactivateConfirmOpen(false);
      await loadBuildingData();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể cập nhật trạng thái tòa nhà.'));
    } finally {
      setUpdatingStatus(false);
    }
  };

  if (loading && !building) return <PageSkeleton />;
  if (!building) return null;

  const isBuildingActive = (building.status || 'ACTIVE') === 'ACTIVE';

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${building.code} — ${building.name}`}
        subtitle={building.address || 'Thông tin vận hành chi tiết của tòa nhà'}
        breadcrumbs={[
          { label: 'Bất động sản', to: '/admin/buildings' },
          { label: building.code },
        ]}
        actions={
          <>
            {canEditRealEstate ? (
              isBuildingActive ? (
                <Button
                  variant="danger"
                  icon={Ban}
                  loading={updatingStatus}
                  onClick={() => setDeactivateConfirmOpen(true)}
                >
                  Ngừng khai thác
                </Button>
              ) : (
                <Button
                  variant="success"
                  icon={CheckCircle2}
                  loading={updatingStatus}
                  onClick={() => handleToggleBuildingStatus('ACTIVE')}
                >
                  Khai thác lại
                </Button>
              )
            ) : null}
            <Button
              variant="soft"
              icon={LayoutGrid}
              onClick={() => navigate(`/admin/buildings/${id}/floor-plan`)}
            >
              Mở Sơ đồ tầng toàn màn hình
            </Button>
          </>
        }
      />

      <Tabs
        tabs={[
          { id: 'overview', label: 'Sơ đồ tòa & Tổng quan', icon: LayoutGrid },
          { id: 'zones', label: 'Danh sách Khu', icon: Layers, count: zones.length },
          { id: 'tenants', label: 'Cư dân', icon: Users, count: tenants.length },
          { id: 'contracts', label: 'Hợp đồng', icon: FileSignature, count: contracts.length },
        ]}
        activeTab={tab}
        onChange={setTab}
      />

      {tab === 'overview' ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            <Card className="lg:col-span-2">
              <CardHeader title="Thông tin định danh tòa nhà" />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-xs text-slate-400">Mã tòa nhà</p>
                  <p className="font-semibold text-slate-800 mt-0.5">{building.code}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Trạng thái khai thác</p>
                  <div className="mt-1">
                    <Badge variant={isBuildingActive ? 'emerald' : 'purple'} dot>
                      {isBuildingActive ? 'Đang khai thác (ACTIVE)' : 'Ngừng khai thác (INACTIVE)'}
                    </Badge>
                  </div>
                </div>
                <div className="sm:col-span-2">
                  <p className="text-xs text-slate-400">Địa chỉ</p>
                  <p className="text-slate-700 mt-0.5 flex items-center gap-1.5">
                    <MapPin className="w-4 h-4 text-slate-400 shrink-0" />
                    {building.address || '—'}
                  </p>
                </div>
              </div>
            </Card>

            <Card>
              <CardHeader title="Tài khoản nhận thanh toán" />
              {building.payment_account?.account_number || building.payment_account?.bank_name ? (
                <div className="space-y-2.5 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500 shrink-0">Ngân hàng:</span>
                    <span className="font-semibold flex items-center gap-2 text-right">
                      {building.payment_account.bank_logo ? (
                        <img
                          src={building.payment_account.bank_logo}
                          alt=""
                          className="w-8 h-5 object-contain rounded bg-white border border-slate-200 p-0.5 shrink-0"
                        />
                      ) : null}
                      <span>
                        {building.payment_account.bank_name || '—'}
                        {building.payment_account.bank_code ? ` (${building.payment_account.bank_code})` : ''}
                      </span>
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Số TK:</span>
                    <span className="font-mono font-semibold text-primary-600">
                      {building.payment_account.account_number || '—'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Chủ TK:</span>
                    <span className="font-medium text-right">{building.payment_account.account_holder || '—'}</span>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-slate-400">Chưa thiết lập tài khoản ngân hàng riêng cho tòa này.</p>
              )}
            </Card>
          </div>

          <FloorPlanView buildingId={id} embedded />
        </div>
      ) : null}

      {tab === 'zones' ? (
        <div className="space-y-4">
          {canEditRealEstate ? (
            <div className="flex justify-end">
              <Button size="sm" icon={Plus} onClick={() => setZoneModalOpen(true)}>
                Thêm phân khu (Zone)
              </Button>
            </div>
          ) : null}
          <DataTable
            data={zones}
            emptyTitle="Chưa có khu phân khu nào"
            emptyDescription="Bạn có thể chia tòa nhà thành các cánh / phân khu (VD: Khu Đông, Khu Tây)."
            onRowClick={(z) => navigate(`/admin/buildings/${id}/zones/${z.id}`)}
            columns={[
              { key: 'code', label: 'Mã Khu', sortable: true, render: (r) => <span className="font-semibold text-primary-700">{r.code}</span> },
              { key: 'name', label: 'Tên Khu', sortable: true },
              { key: 'apartment_count', label: 'Số căn hộ', align: 'center', sortable: true, className: 'whitespace-nowrap', render: (r) => `${r.apartment_count || 0} căn` },
              {
                key: 'action',
                label: 'Thao tác',
                align: 'center',
                className: 'whitespace-nowrap',
                render: (r) => (
                  <div className="inline-flex items-center justify-center gap-1" onClick={(e) => e.stopPropagation()}>
                    {canManageBuildings && Number(r.apartment_count || 0) === 0 ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        icon={Trash2}
                        className="text-rose-600 hover:text-rose-700 hover:bg-rose-50"
                        onClick={(e) => handleDeleteZone(r, e)}
                      >
                        Xóa
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="xs"
                      rightIcon={ArrowRight}
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/admin/buildings/${id}/zones/${r.id}`);
                      }}
                    >
                      Chi tiết
                    </Button>
                  </div>
                ),
              },
            ]}
          />
          {floors.length > 0 ? (
            <Card>
              <CardHeader title={`Danh sách tầng (${floors.length} tầng)`} />
              <div className="flex flex-wrap gap-2">
                {floors.map((f) => (
                  <div key={f.id} className="px-3.5 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs">
                    <span className="font-semibold text-slate-800">{f.name || `Tầng ${f.level}`}</span>
                    <span className="text-slate-400 ml-1.5">({f.apartment_count || 0} căn)</span>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}

      {tab === 'tenants' ? (
        <DataTable
          data={tenants}
          onRowClick={(t) => navigate(`/admin/tenants/${t.id}`)}
          emptyTitle="Chưa có cư dân tại tòa nhà này"
          columns={[
            { key: 'full_name', label: 'Họ và tên', sortable: true, render: (r) => <span className="font-semibold text-slate-900">{r.full_name}</span> },
            { key: 'phone', label: 'Số điện thoại', align: 'center', className: 'whitespace-nowrap' },
            { key: 'id_number', label: 'Số CCCD', align: 'center', className: 'font-mono text-xs whitespace-nowrap' },
            { key: 'apartment_code', label: 'Căn hộ', align: 'center', className: 'whitespace-nowrap', render: (r) => r.active_contract?.apartment_code || r.apartment_code || '—' },
            { key: 'status', label: 'Trạng thái', align: 'center', render: (r) => <StatusBadge status={r.status} domain="tenant" /> },
          ]}
        />
      ) : null}

      {tab === 'contracts' ? (
        <DataTable
          data={contracts}
          onRowClick={(c) => navigate(`/admin/contracts/${c.id}`)}
          emptyTitle="Chưa có hợp đồng thuê nào"
          columns={[
            { key: 'apartment_code', label: 'Căn hộ', sortable: true, render: (r) => <span className="font-bold text-primary-700">{r.apartment_code}</span> },
            { key: 'tenant_name', label: 'Khách thuê chính', sortable: true },
            { key: 'start_date', label: 'Thời hạn', align: 'center', className: 'whitespace-nowrap text-xs', render: (r) => `${formatDate(r.start_date)} → ${formatDate(r.end_date)}` },
            { key: 'rent_amount', label: 'Giá thuê', align: 'right', className: 'font-mono tabular-nums whitespace-nowrap', render: (r) => formatMoney(r.rent_amount) },
            { key: 'status', label: 'Trạng thái', align: 'center', render: (r) => <StatusBadge status={r.status} domain="contract" /> },
          ]}
        />
      ) : null}

      <Modal
        open={zoneModalOpen}
        onClose={() => setZoneModalOpen(false)}
        title="Tạo phân khu (Zone) mới"
        size="sm"
      >
        <form onSubmit={handleCreateZone} className="space-y-4">
          <Input
            label="Mã khu"
            required
            placeholder="VD: ZONE-E"
            value={zoneForm.code}
            onChange={(e) => setZoneForm({ ...zoneForm, code: e.target.value.toUpperCase() })}
          />
          <Input
            label="Tên phân khu"
            required
            placeholder="VD: Cánh Đông"
            value={zoneForm.name}
            onChange={(e) => setZoneForm({ ...zoneForm, name: e.target.value })}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setZoneModalOpen(false)}>
              Hủy
            </Button>
            <Button type="submit" loading={savingZone}>
              Lưu phân khu
            </Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={deactivateConfirmOpen}
        onClose={() => setDeactivateConfirmOpen(false)}
        onConfirm={() => handleToggleBuildingStatus('INACTIVE')}
        loading={updatingStatus}
        variant="danger"
        title="Xác nhận ngừng khai thác tòa nhà"
        confirmLabel="Ngừng khai thác"
        message={`Bạn có chắc chắn muốn chuyển tòa nhà "${building.code} — ${building.name}" sang trạng thái Ngừng khai thác (INACTIVE)?`}
      />
    </div>
  );
}

export default BuildingDetailPage;

