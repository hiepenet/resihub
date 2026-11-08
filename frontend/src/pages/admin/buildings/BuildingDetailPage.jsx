import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
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
import { FloorModal } from './FloorModal';
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

  const cachedBld = buildingsService.peekById(id)?.data || null;
  const cachedZones = buildingsService.peekZones(id)?.data;
  const cachedFloors = buildingsService.peekFloors(id)?.data;
  const cachedContracts = contractsService.peekList({ building_id: id })?.data;
  const cachedTenants = tenantsService.peekList({ building_id: id })?.data;

  const [tab, setTab] = useState('overview');
  const [building, setBuilding] = useState(cachedBld);
  const [zones, setZones] = useState(() => (Array.isArray(cachedZones) ? cachedZones : []));
  const [floors, setFloors] = useState(() => (Array.isArray(cachedFloors) ? cachedFloors : []));
  const [contracts, setContracts] = useState(() => (Array.isArray(cachedContracts) ? cachedContracts : []));
  const [contractsLoaded, setContractsLoaded] = useState(() => Array.isArray(cachedContracts));
  const [contractsLoading, setContractsLoading] = useState(false);
  const [tenants, setTenants] = useState(() => (Array.isArray(cachedTenants) ? cachedTenants : []));
  const [tenantsLoaded, setTenantsLoaded] = useState(() => Array.isArray(cachedTenants));
  const [tenantsLoading, setTenantsLoading] = useState(false);
  const [loading, setLoading] = useState(() => !cachedBld);

  const [zoneModalOpen, setZoneModalOpen] = useState(false);
  const [zoneForm, setZoneForm] = useState({ code: '', name: '' });
  const [savingZone, setSavingZone] = useState(false);
  const [floorModalOpen, setFloorModalOpen] = useState(false);
  const [deactivateConfirmOpen, setDeactivateConfirmOpen] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [deleteBuildingOpen, setDeleteBuildingOpen] = useState(false);
  const [deletingBuilding, setDeletingBuilding] = useState(false);
  const [deleteZoneTarget, setDeleteZoneTarget] = useState(null);
  const [deletingZone, setDeletingZone] = useState(false);
  const [deleteFloorTarget, setDeleteFloorTarget] = useState(null);
  const [deletingFloor, setDeletingFloor] = useState(false);

  const loadBuildingData = useCallback(async (opts = {}) => {
    const force = Boolean(opts?.force);
    if (!buildingsService.peekById(id)?.data) {
      setLoading(true);
    }
    // Warm floor-map cache concurrently so embedded FloorPlanView renders in one network wave
    buildingsService.getFloorMap(id, { force }).catch(() => {});
    try {
      const [bRes, zRes, fRes] = await Promise.all([
        buildingsService.getById(id, { force }),
        buildingsService.listZones(id, { force }).catch(() => ({ data: [] })),
        buildingsService.listFloors(id, { force }).catch(() => ({ data: [] })),
      ]);
      setBuilding(bRes.data);
      setZones(zRes.data || []);
      setFloors(fRes.data || []);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    setContractsLoaded(Array.isArray(contractsService.peekList({ building_id: id })?.data));
    setTenantsLoaded(Array.isArray(tenantsService.peekList({ building_id: id })?.data));
    loadBuildingData();
  }, [id, loadBuildingData]);

  useEffect(() => {
    if (tab !== 'tenants' || !id) return;
    const hasCached = Array.isArray(tenantsService.peekList({ building_id: id })?.data);
    if (!hasCached) setTenantsLoading(true);
    tenantsService
      .list({ building_id: id })
      .then((res) => {
        setTenants(Array.isArray(res?.data) ? res.data : []);
        setTenantsLoaded(true);
      })
      .catch(() => {})
      .finally(() => setTenantsLoading(false));
  }, [tab, id]);

  useEffect(() => {
    if (tab !== 'contracts' || !id) return;
    const hasCached = Array.isArray(contractsService.peekList({ building_id: id })?.data);
    if (!hasCached) setContractsLoading(true);
    contractsService
      .list({ building_id: id })
      .then((res) => {
        setContracts(Array.isArray(res?.data) ? res.data : []);
        setContractsLoaded(true);
      })
      .catch(() => {})
      .finally(() => setContractsLoading(false));
  }, [tab, id]);

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

  const handleConfirmDeleteZone = async () => {
    if (!deleteZoneTarget?.id) return;
    setDeletingZone(true);
    try {
      await buildingsService.deleteZone(id, deleteZoneTarget.id);
      toast.success(`Đã xóa phân khu ${deleteZoneTarget.code}.`);
      setDeleteZoneTarget(null);
      window.dispatchEvent(new Event('resihub:buildings-updated'));
      await loadBuildingData({ force: true });
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setDeletingZone(false);
    }
  };

  const handleConfirmDeleteFloor = async () => {
    if (!deleteFloorTarget?.id) return;
    setDeletingFloor(true);
    try {
      const res = await buildingsService.deleteFloor(id, deleteFloorTarget.id);
      toast.success(res?.message || `Đã xóa ${deleteFloorTarget.name || `Tầng ${deleteFloorTarget.level}`}.`);
      setDeleteFloorTarget(null);
      window.dispatchEvent(new Event('resihub:buildings-updated'));
      await loadBuildingData({ force: true });
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể xóa tầng.'));
    } finally {
      setDeletingFloor(false);
    }
  };

  const handleConfirmDeleteBuilding = async () => {
    setDeletingBuilding(true);
    try {
      const res = await buildingsService.remove(id);
      toast.success(res?.message || `Đã xóa tòa nhà ${building?.code || ''}.`);
      setDeleteBuildingOpen(false);
      window.dispatchEvent(new Event('resihub:buildings-updated'));
      navigate('/admin/buildings');
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể xóa tòa nhà.'));
    } finally {
      setDeletingBuilding(false);
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
  const hasBuildingChildren =
    zones.length > 0 || floors.length > 0 || Number(building.total_apartments || 0) > 0;

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
            {canManageBuildings ? (
              <span
                title={
                  hasBuildingChildren
                    ? 'Chỉ được xóa tòa nhà rỗng (0 khu, 0 tầng, 0 căn hộ). Vui lòng dùng Ngừng khai thác nếu đã vận hành.'
                    : 'Xóa tòa nhà rỗng'
                }
              >
                <Button
                  variant="outline"
                  icon={Trash2}
                  disabled={hasBuildingChildren}
                  className={
                    hasBuildingChildren
                      ? ''
                      : 'border-rose-200 text-rose-600 hover:bg-rose-50 hover:border-rose-300'
                  }
                  onClick={() => setDeleteBuildingOpen(true)}
                >
                  Xóa tòa nhà
                </Button>
              </span>
            ) : null}
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
          { id: 'tenants', label: 'Cư dân', icon: Users, count: tenantsLoaded ? tenants.length : undefined },
          { id: 'contracts', label: 'Hợp đồng', icon: FileSignature, count: contractsLoaded ? contracts.length : undefined },
        ]}
        activeTab={tab}
        onChange={setTab}
      />

      {tab === 'overview' ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            <Card className="lg:col-span-2">
              <CardHeader title="Thông tin định danh tòa nhà" />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
                <div>
                  <p className="text-xs text-slate-400">Mã &amp; Tên tòa nhà</p>
                  <p className="font-semibold text-slate-800 mt-0.5 break-words">
                    {building.code} — {building.name}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Quy mô tầng</p>
                  <p className="font-semibold text-slate-800 mt-0.5">
                    {floors.length || building.total_floors || 0} tầng
                  </p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Trạng thái khai thác</p>
                  <div className="mt-1">
                    <Badge variant={isBuildingActive ? 'emerald' : 'purple'} dot>
                      {isBuildingActive ? 'Đang khai thác (ACTIVE)' : 'Ngừng khai thác (INACTIVE)'}
                    </Badge>
                  </div>
                </div>
                <div className="sm:col-span-3">
                  <p className="text-xs text-slate-400">Địa chỉ</p>
                  <p className="text-slate-700 mt-0.5 flex items-start gap-1.5">
                    <MapPin className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                    <span className="break-words">{building.address || '—'}</span>
                  </p>
                </div>
              </div>
            </Card>

            <Card>
              <CardHeader title="Tài khoản nhận thanh toán" />
              {(() => {
                const paymentAccount = building.payment_account || building.lease_terms?.payment_account || {};
                return paymentAccount.account_number || paymentAccount.bank_name ? (
                  <div className="space-y-2.5 text-sm">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-slate-500 shrink-0">Ngân hàng:</span>
                      <span className="font-semibold flex items-center gap-2 text-right break-words">
                        {paymentAccount.bank_logo ? (
                          <img
                            src={paymentAccount.bank_logo}
                            alt=""
                            className="w-8 h-5 object-contain rounded bg-white border border-slate-200 p-0.5 shrink-0"
                          />
                        ) : null}
                        <span>
                          {paymentAccount.bank_name || '—'}
                          {paymentAccount.bank_code ? ` (${paymentAccount.bank_code})` : ''}
                        </span>
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500 shrink-0">Số TK:</span>
                      <span className="font-mono font-semibold text-primary-600 break-all text-right">
                        {paymentAccount.account_number || '—'}
                      </span>
                    </div>
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-slate-500 shrink-0">Chủ TK:</span>
                      <span className="font-medium text-right break-words">
                        {paymentAccount.account_holder || '—'}
                      </span>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-slate-400">Chưa thiết lập tài khoản ngân hàng riêng cho tòa này.</p>
                );
              })()}
            </Card>
          </div>

          <FloorPlanView
            buildingId={id}
            embedded
            initialBuilding={building}
            initialZones={zones}
            onFloorsChanged={() => loadBuildingData({ force: true })}
          />
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
                    {canManageBuildings ? (() => {
                      const zoneHasApts = Number(r.apartment_count || 0) > 0;
                      return (
                        <span
                          title={
                            zoneHasApts
                              ? 'Không thể xóa phân khu đang có căn hộ gắn kèm.'
                              : 'Xóa phân khu'
                          }
                        >
                          <Button
                            variant="ghost"
                            size="xs"
                            icon={Trash2}
                            disabled={zoneHasApts}
                            className={
                              zoneHasApts ? '' : 'text-rose-600 hover:text-rose-700 hover:bg-rose-50'
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteZoneTarget(r);
                            }}
                          >
                            Xóa
                          </Button>
                        </span>
                      );
                    })() : null}
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
          <Card>
            <CardHeader
              title={`Danh sách tầng (${floors.length} tầng)`}
              action={
                canEditRealEstate ? (
                  <Button
                    size="xs"
                    variant="outline"
                    icon={Layers}
                    onClick={() => setFloorModalOpen(true)}
                  >
                    Thêm tầng / Hàng loạt
                  </Button>
                ) : null
              }
            />
            {floors.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {floors.map((f) => {
                  const floorAptCount = Number(f.apartment_count || 0);
                  const floorHasApts = floorAptCount > 0;
                  return (
                    <div
                      key={f.id}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs"
                    >
                      <span className="font-semibold text-slate-800">{f.name || `Tầng ${f.level}`}</span>
                      <span className="text-slate-400">({floorAptCount} căn)</span>
                      {canManageBuildings ? (
                        <span
                          title={
                            floorHasApts
                              ? 'Không thể xóa tầng đang có căn hộ. Vui lòng xóa hoặc chuyển căn hộ trước.'
                              : 'Xóa tầng rỗng'
                          }
                        >
                          <button
                            type="button"
                            disabled={floorHasApts}
                            onClick={() => setDeleteFloorTarget(f)}
                            className={`ml-1 p-1 rounded-md transition-colors ${
                              floorHasApts
                                ? 'text-slate-300 cursor-not-allowed'
                                : 'text-rose-500 hover:text-rose-700 hover:bg-rose-50'
                            }`}
                            aria-label={`Xóa ${f.name || `Tầng ${f.level}`}`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-slate-500">
                Tòa nhà chưa có tầng nào. Nhấn <strong>Thêm tầng / Hàng loạt</strong> để khởi tạo nhanh dải tầng.
              </p>
            )}
          </Card>
        </div>
      ) : null}

      {tab === 'tenants' ? (
        <DataTable
          loading={tenantsLoading}
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
          loading={contractsLoading}
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

      <FloorModal
        open={floorModalOpen}
        onClose={() => setFloorModalOpen(false)}
        buildingId={id}
        existingFloors={floors}
        initialMode="bulk"
        onCreated={() => loadBuildingData({ force: true })}
      />

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

      <ConfirmDialog
        open={deleteBuildingOpen}
        onClose={() => {
          if (!deletingBuilding) setDeleteBuildingOpen(false);
        }}
        onConfirm={handleConfirmDeleteBuilding}
        loading={deletingBuilding}
        variant="danger"
        title="Xác nhận xóa vĩnh viễn tòa nhà"
        confirmLabel="Xóa tòa nhà"
        message={`Bạn có chắc chắn muốn xóa vĩnh viễn tòa nhà "${building.code} — ${building.name}"? Thao tác này không thể hoàn tác.`}
      />

      <ConfirmDialog
        open={Boolean(deleteZoneTarget)}
        onClose={() => {
          if (!deletingZone) setDeleteZoneTarget(null);
        }}
        onConfirm={handleConfirmDeleteZone}
        loading={deletingZone}
        variant="danger"
        title="Xác nhận xóa phân khu"
        confirmLabel="Xóa phân khu"
        message={
          deleteZoneTarget
            ? `Bạn có chắc chắn muốn xóa phân khu "${deleteZoneTarget.code} — ${deleteZoneTarget.name}"?`
            : ''
        }
      />

      <ConfirmDialog
        open={Boolean(deleteFloorTarget)}
        onClose={() => {
          if (!deletingFloor) setDeleteFloorTarget(null);
        }}
        onConfirm={handleConfirmDeleteFloor}
        loading={deletingFloor}
        variant="danger"
        title="Xác nhận xóa tầng"
        confirmLabel="Xóa tầng"
        message={
          deleteFloorTarget
            ? `Bạn có chắc chắn muốn xóa vĩnh viễn "${deleteFloorTarget.name || `Tầng ${deleteFloorTarget.level}`}" khỏi tòa nhà ${building.code}?`
            : ''
        }
      />
    </div>
  );
}

export default BuildingDetailPage;

