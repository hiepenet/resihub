import React, { useState, useEffect } from 'react';
import { Building2, Plus, LayoutGrid, List, X, Home, CheckCircle2, AlertCircle } from 'lucide-react';
import Button from '../../../components/ui/Button';
import Input from '../../../components/ui/Input';
import FormField from '../../../components/ui/FormField';
import StatusBadge from '../../../components/ui/StatusBadge';
import Money from '../../../components/ui/Money';
import DataTable from '../../../components/ui/DataTable';
import api from '../../../services/api';

export default function BuildingsPage() {
  const [buildings, setBuildings] = useState([]);
  const [selectedBuilding, setSelectedBuilding] = useState(null);
  const [activeTab, setActiveTab] = useState('floormap'); // 'floormap' | 'list'
  const [floorMap, setFloorMap] = useState([]);
  const [selectedApartment, setSelectedApartment] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  // Modals
  const [isBuildingModalOpen, setIsBuildingModalOpen] = useState(false);
  const [isApartmentModalOpen, setIsApartmentModalOpen] = useState(false);
  const [newBuilding, setNewBuilding] = useState({ name: '', code: '', address: '' });
  const [newApartment, setNewApartment] = useState({
    code: '',
    floor_id: '',
    area_m2: 45,
    type: '1PN',
    bedrooms: 1,
    base_rent: 7500000,
    status: 'AVAILABLE',
  });
  const [formError, setFormError] = useState('');

  const loadBuildings = async () => {
    setIsLoading(true);
    try {
      const res = await api.get('/api/v1/buildings');
      const list = res.data?.data || [];
      setBuildings(list);
      if (list.length > 0 && !selectedBuilding) {
        setSelectedBuilding(list[0]);
      }
    } catch (err) {
      console.error('Error loading buildings:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const loadFloorMap = async (buildingId) => {
    if (!buildingId) return;
    try {
      const res = await api.get(`/api/v1/buildings/${buildingId}/floor-map`);
      setFloorMap(res.data?.data || []);
    } catch (err) {
      console.error('Error loading floor map:', err);
    }
  };

  useEffect(() => {
    loadBuildings();
  }, []);

  useEffect(() => {
    if (selectedBuilding) {
      loadFloorMap(selectedBuilding.id);
    }
  }, [selectedBuilding]);

  const handleCreateBuilding = async (e) => {
    e.preventDefault();
    setFormError('');

    if (!newBuilding.name || !newBuilding.code) {
      setFormError('Vui lòng nhập tên và mã tòa nhà.');
      return;
    }

    try {
      const res = await api.post('/api/v1/buildings', newBuilding);
      setIsBuildingModalOpen(false);
      setNewBuilding({ name: '', code: '', address: '' });
      await loadBuildings();
      setSelectedBuilding(res.data.data);
    } catch (err) {
      setFormError(err.response?.data?.message || 'Lỗi khi tạo tòa nhà.');
    }
  };

  const handleCreateApartment = async (e) => {
    e.preventDefault();
    setFormError('');

    if (!newApartment.code) {
      setFormError('Vui lòng nhập mã phòng.');
      return;
    }

    try {
      await api.post('/api/v1/apartments', {
        ...newApartment,
        building_id: selectedBuilding.id,
      });
      setIsApartmentModalOpen(false);
      setNewApartment({
        code: '',
        floor_id: '',
        area_m2: 45,
        type: '1PN',
        bedrooms: 1,
        base_rent: 7500000,
        status: 'AVAILABLE',
      });
      loadFloorMap(selectedBuilding.id);
    } catch (err) {
      setFormError(err.response?.data?.message || 'Lỗi khi tạo căn hộ.');
    }
  };

  const buildingColumns = [
    { title: 'Tên tòa nhà', key: 'name', sortable: true },
    { title: 'Mã tòa', key: 'code', sortable: true },
    { title: 'Địa chỉ', key: 'address' },
    {
      title: 'Số căn',
      key: 'total_apartments',
      render: (val) => <span className="font-semibold">{val || 0} căn</span>,
    },
    {
      title: 'Trạng thái',
      key: 'status',
      render: (val) => <StatusBadge status={val} />,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header & Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight">
            Quản lý Bất động sản
          </h2>
          <p className="text-xs sm:text-sm text-slate-500 mt-1">
            Sơ đồ tầng trực quan, phân bổ căn hộ và thông tin tòa nhà
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <Button
            variant="secondary"
            size="md"
            onClick={() => setIsApartmentModalOpen(true)}
            leftIcon={Plus}
            disabled={!selectedBuilding}
          >
            Thêm căn hộ
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={() => setIsBuildingModalOpen(true)}
            leftIcon={Plus}
          >
            Tạo tòa nhà mới
          </Button>
        </div>
      </div>

      {/* Building Tabs & Selector */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-3">
        {/* Buildings Pills */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1 sm:pb-0">
          {buildings.map((b) => (
            <button
              key={b.id}
              onClick={() => setSelectedBuilding(b)}
              className={`px-3.5 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-150 flex items-center gap-2 flex-shrink-0 ${
                selectedBuilding?.id === b.id
                  ? 'bg-primary-600 text-white shadow-sm shadow-primary-500/30'
                  : 'bg-white text-slate-700 hover:bg-slate-100 border border-slate-200'
              }`}
            >
              <Building2 className="w-4 h-4" />
              <span>{b.name}</span>
            </button>
          ))}
        </div>

        {/* View mode toggle */}
        <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl self-start sm:self-auto">
          <button
            onClick={() => setActiveTab('floormap')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              activeTab === 'floormap' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <LayoutGrid className="w-3.5 h-3.5" />
            <span>Sơ đồ tầng</span>
          </button>
          <button
            onClick={() => setActiveTab('list')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              activeTab === 'list' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <List className="w-3.5 h-3.5" />
            <span>Danh sách tòa</span>
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      {activeTab === 'list' ? (
        <DataTable
          columns={buildingColumns}
          data={buildings}
          isLoading={isLoading}
          searchKeys={['name', 'code', 'address']}
        />
      ) : (
        <div className="space-y-6">
          {/* Status Legend (FR-010) */}
          <div className="flex flex-wrap items-center gap-4 p-4 bg-white rounded-xl border border-slate-200/80 text-xs text-slate-600 shadow-sm">
            <span className="font-semibold text-slate-800 mr-2">Trạng thái:</span>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-emerald-500" />
              <span>🟢 Có sẵn</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-indigo-500" />
              <span>🔵 Đang thuê</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-amber-500" />
              <span>🟡 Đã đặt cọc</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-rose-500" />
              <span>🔴 Bảo trì</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-slate-400" />
              <span>⚫ Không KD</span>
            </div>
          </div>

          {/* Sơ đồ tầng theo thiết kế PRD FR-010 */}
          <div className="space-y-4">
            {floorMap.length === 0 ? (
              <div className="bg-white p-12 text-center rounded-xl border border-dashed border-slate-200 text-slate-500">
                Chưa có dữ liệu tầng hoặc căn hộ cho tòa nhà này.
              </div>
            ) : (
              floorMap.map((floor) => (
                <div key={floor.id} className="bg-white rounded-xl border border-slate-200/90 shadow-sm p-5">
                  <div className="flex items-center justify-between mb-4 border-b border-slate-100 pb-3">
                    <div className="flex items-center gap-2.5">
                      <span className="text-xs font-bold uppercase tracking-wider bg-slate-100 text-slate-700 px-2.5 py-1 rounded-md">
                        {floor.name || `TẦNG ${floor.level}`}
                      </span>
                      <span className="text-xs text-slate-400">
                        {floor.apartments?.length || 0} căn hộ
                      </span>
                    </div>
                  </div>

                  {/* Apartment Blocks Grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                    {floor.apartments?.map((apt) => {
                      const statusStyles = {
                        AVAILABLE: 'border-emerald-300 bg-emerald-50/50 hover:bg-emerald-100/50 text-emerald-950',
                        OCCUPIED: 'border-indigo-300 bg-indigo-50/50 hover:bg-indigo-100/50 text-indigo-950',
                        RESERVED: 'border-amber-300 bg-amber-50/50 hover:bg-amber-100/50 text-amber-950',
                        MAINTENANCE: 'border-rose-300 bg-rose-50/50 hover:bg-rose-100/50 text-rose-950',
                        INACTIVE: 'border-slate-300 bg-slate-50 hover:bg-slate-100 text-slate-600',
                      };

                      return (
                        <div
                          key={apt.id}
                          onClick={() => setSelectedApartment(apt)}
                          className={`p-3.5 rounded-xl border-2 cursor-pointer transition-all duration-150 transform hover:-translate-y-0.5 shadow-sm ${
                            statusStyles[apt.status] || 'border-slate-200 bg-white'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <span className="font-bold text-base">{apt.code}</span>
                            <StatusBadge status={apt.status} size="sm" />
                          </div>
                          <div className="text-xs text-slate-500 font-medium">
                            {apt.area_m2} m² · {apt.type || '1PN'}
                          </div>
                          <div className="mt-2 text-xs font-semibold">
                            <Money amount={apt.base_rent} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Slide-over Apartment Detail Panel */}
      {selectedApartment && (
        <div className="fixed inset-0 z-50 overflow-hidden">
          <div
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity"
            onClick={() => setSelectedApartment(null)}
          />
          <div className="fixed inset-y-0 right-0 max-w-full flex pl-10">
            <div className="w-screen max-w-md bg-white shadow-2xl p-6 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between border-b border-slate-100 pb-4">
                  <div>
                    <h3 className="text-lg font-bold text-slate-900">
                      Căn hộ {selectedApartment.code}
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">{selectedBuilding?.name}</p>
                  </div>
                  <button
                    onClick={() => setSelectedApartment(null)}
                    className="p-1 rounded-lg text-slate-400 hover:text-slate-600"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <div className="mt-6 space-y-4 text-sm">
                  <div className="flex justify-between py-2 border-b border-slate-50">
                    <span className="text-slate-500">Trạng thái</span>
                    <StatusBadge status={selectedApartment.status} />
                  </div>
                  <div className="flex justify-between py-2 border-b border-slate-50">
                    <span className="text-slate-500">Giá thuê cơ bản</span>
                    <Money amount={selectedApartment.base_rent} className="font-semibold text-slate-900" />
                  </div>
                  <div className="flex justify-between py-2 border-b border-slate-50">
                    <span className="text-slate-500">Diện tích</span>
                    <span className="font-medium">{selectedApartment.area_m2} m²</span>
                  </div>
                  <div className="flex justify-between py-2 border-b border-slate-50">
                    <span className="text-slate-500">Loại phòng</span>
                    <span className="font-medium">{selectedApartment.type || '1PN'}</span>
                  </div>
                  <div className="flex justify-between py-2 border-b border-slate-50">
                    <span className="text-slate-500">Số phòng ngủ</span>
                    <span className="font-medium">{selectedApartment.bedrooms || 1} phòng</span>
                  </div>

                  <div className="pt-2">
                    <span className="text-slate-500 block mb-2 font-medium">Tiện ích đi kèm</span>
                    <div className="flex flex-wrap gap-1.5">
                      <span className="px-2.5 py-1 bg-slate-100 text-slate-700 rounded-lg text-xs font-medium">Wifi</span>
                      <span className="px-2.5 py-1 bg-slate-100 text-slate-700 rounded-lg text-xs font-medium">Điều hòa</span>
                      <span className="px-2.5 py-1 bg-slate-100 text-slate-700 rounded-lg text-xs font-medium">Nóng lạnh</span>
                      <span className="px-2.5 py-1 bg-slate-100 text-slate-700 rounded-lg text-xs font-medium">Khóa từ</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="pt-6 border-t border-slate-100 flex gap-2">
                <Button
                  variant="primary"
                  className="w-full"
                  onClick={() => setSelectedApartment(null)}
                >
                  Đóng panel
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal Tạo Tòa Nhà (NV-02) */}
      {isBuildingModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 border border-slate-100">
            <div className="flex items-center justify-between mb-4 border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">Tạo mới Tòa nhà</h3>
              <button onClick={() => setIsBuildingModalOpen(false)}>
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>

            <form onSubmit={handleCreateBuilding} className="space-y-4">
              <FormField label="Tên tòa nhà" required error={formError}>
                <Input
                  placeholder="Ví dụ: Tòa nhà ResiHub Landmark"
                  value={newBuilding.name}
                  onChange={(e) => setNewBuilding({ ...newBuilding, name: e.target.value })}
                />
              </FormField>

              <FormField label="Mã tòa nhà (Unique)" required hint="Viết hoa, viết liền, không dấu (vd: LM-01)">
                <Input
                  placeholder="LM-01"
                  value={newBuilding.code}
                  onChange={(e) => setNewBuilding({ ...newBuilding, code: e.target.value.toUpperCase() })}
                />
              </FormField>

              <FormField label="Địa chỉ">
                <Input
                  placeholder="Số nhà, đường, phường, quận, TP"
                  value={newBuilding.address}
                  onChange={(e) => setNewBuilding({ ...newBuilding, address: e.target.value })}
                />
              </FormField>

              <div className="flex justify-end gap-2.5 pt-4 border-t border-slate-100">
                <Button variant="secondary" onClick={() => setIsBuildingModalOpen(false)}>
                  Hủy
                </Button>
                <Button type="submit" variant="primary">
                  Tạo tòa nhà
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Tạo Căn Hộ */}
      {isApartmentModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 border border-slate-100">
            <div className="flex items-center justify-between mb-4 border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">
                Thêm Căn hộ mới vào {selectedBuilding?.name}
              </h3>
              <button onClick={() => setIsApartmentModalOpen(false)}>
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>

            <form onSubmit={handleCreateApartment} className="space-y-4">
              <FormField label="Mã căn hộ" required error={formError} hint="Ví dụ: A101, B202">
                <Input
                  placeholder="A101"
                  value={newApartment.code}
                  onChange={(e) => setNewApartment({ ...newApartment, code: e.target.value.toUpperCase() })}
                />
              </FormField>

              <div className="grid grid-cols-2 gap-3">
                <FormField label="Diện tích (m²)">
                  <Input
                    type="number"
                    value={newApartment.area_m2}
                    onChange={(e) => setNewApartment({ ...newApartment, area_m2: e.target.value })}
                  />
                </FormField>

                <FormField label="Loại phòng">
                  <select
                    value={newApartment.type}
                    onChange={(e) => setNewApartment({ ...newApartment, type: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 py-2 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  >
                    <option value="Studio">Studio</option>
                    <option value="1PN">1 Phòng ngủ</option>
                    <option value="2PN">2 Phòng ngủ</option>
                    <option value="3PN">3 Phòng ngủ</option>
                    <option value="Penthouse">Penthouse</option>
                  </select>
                </FormField>
              </div>

              <FormField label="Giá thuê cơ bản (VND/tháng)" required>
                <Input
                  type="number"
                  value={newApartment.base_rent}
                  onChange={(e) => setNewApartment({ ...newApartment, base_rent: e.target.value })}
                />
              </FormField>

              <div className="flex justify-end gap-2.5 pt-4 border-t border-slate-100">
                <Button variant="secondary" onClick={() => setIsApartmentModalOpen(false)}>
                  Hủy
                </Button>
                <Button type="submit" variant="primary">
                  Thêm căn hộ
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
