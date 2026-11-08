import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Eye, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Modal } from '../../../components/ui/Modal';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { MoneyInput } from '../../../components/ui/MoneyInput';
import { buildingsService } from '../../../services/buildings.service';
import { useToast } from '../../../hooks/useToast';
import { extractErrorMessage } from '../../../utils/validation';

const DEFAULT_UNIT = { suffix: '', type: '1PN', bedrooms: 1, area_m2: 45, base_rent: 8500000 };
const APARTMENT_TYPES = ['Studio', '1PN', '2PN', '3PN', 'Penthouse', 'Duplex'];

function makeUnits(count, current = []) {
  return Array.from({ length: count }, (_, i) => {
    if (current[i]) return current[i];
    const row = { ...DEFAULT_UNIT, suffix: String(i + 1).padStart(2, '0') };
    return row;
  });
}

function serializeUnits(units) {
  return units.map((u) => ({
    suffix: String(u.suffix ?? '').trim().toUpperCase(),
    type: String(u.type || '1PN').trim() || '1PN',
    bedrooms: u.bedrooms === '' || u.bedrooms === null || u.bedrooms === undefined ? 0 : Number(u.bedrooms),
    area_m2: u.area_m2 === '' || u.area_m2 === null || u.area_m2 === undefined ? 0 : Number(u.area_m2),
    base_rent: u.base_rent === '' || u.base_rent === null || u.base_rent === undefined ? 0 : Number(u.base_rent),
  }));
}

export function BulkApartmentModal({ open, buildingId, floors = [], zones = [], onClose, onCreated }) {
  const toast = useToast();
  const [selectedFloorIds, setSelectedFloorIds] = useState([]);
  const [zoneId, setZoneId] = useState('');
  const [codePrefix, setCodePrefix] = useState('');
  const [units, setUnits] = useState(() => makeUnits(5));
  const [preview, setPreview] = useState(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Reset every time the modal opens; default to the first floor only.
  useEffect(() => {
    if (!open) return;
    setSelectedFloorIds(floors[0] ? [floors[0].id] : []);
    setZoneId('');
    setCodePrefix('');
    setUnits(makeUnits(5));
    setPreview(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Any form edit invalidates the previous preview so a stale preview is never committed.
  const invalidate = () => setPreview(null);

  const unitCount = units.length;
  const totalDrafts = selectedFloorIds.length * units.length;

  const previewByFloor = useMemo(() => {
    const groups = new Map();
    for (const draft of preview?.data || []) {
      if (!groups.has(draft.floor_id)) {
        groups.set(draft.floor_id, { floor_name: draft.floor_name, items: [] });
      }
      groups.get(draft.floor_id).items.push(draft);
    }
    return [...groups.values()];
  }, [preview]);

  const conflictCodeSet = useMemo(
    () => new Set((preview?.conflicts || []).map((c) => c.code)),
    [preview]
  );

  const handleToggleFloor = (floorId, checked) => {
    setSelectedFloorIds((prev) =>
      checked ? [...new Set([...prev, floorId])] : prev.filter((id) => id !== floorId)
    );
    invalidate();
  };

  const handleUnitCountChange = (e) => {
    const raw = Number(e.target.value);
    if (!Number.isFinite(raw)) return;
    const clamped = Math.max(1, Math.min(50, Math.trunc(raw)));
    setUnits((prev) => makeUnits(clamped, prev));
    invalidate();
  };

  const handleUpdateUnit = (index, patch) => {
    setUnits((prev) => prev.map((row, idx) => (idx === index ? { ...row, ...patch } : row)));
    invalidate();
  };

  const handleRemoveUnit = (index) => {
    if (units.length <= 1) return;
    setUnits((prev) => prev.filter((_, idx) => idx !== index));
    invalidate();
  };

  const handleAddUnit = () => {
    if (units.length >= 50) return;
    setUnits((prev) => [
      ...prev,
      { ...DEFAULT_UNIT, suffix: String(prev.length + 1).padStart(2, '0') },
    ]);
    invalidate();
  };

  const handlePreview = async () => {
    if (selectedFloorIds.length === 0) {
      toast.warning('Vui lòng chọn ít nhất một tầng.');
      return;
    }
    setLoadingPreview(true);
    try {
      const res = await buildingsService.previewApartmentsBulk({
        building_id: buildingId,
        floor_ids: selectedFloorIds,
        zone_id: zoneId || undefined,
        code_prefix: codePrefix.trim().toUpperCase() || undefined,
        units: serializeUnits(units),
      });
      setPreview(res);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!preview || preview.valid === false) {
      toast.warning('Vui lòng xem trước và xử lý hết mã trùng trước khi tạo.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await buildingsService.createApartmentsBulk({
        building_id: buildingId,
        floor_ids: selectedFloorIds,
        zone_id: zoneId || undefined,
        code_prefix: codePrefix.trim().toUpperCase() || undefined,
        units: serializeUnits(units),
      });
      toast.success(res.message || `Đã tạo ${res.created_count} căn hộ.`);
      onCreated?.(res);
      onClose?.();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Tạo căn hộ hàng loạt theo mẫu tầng"
      size="xl"
      footer={
        <>
          <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
            Hủy
          </Button>
          <Button
            type="submit"
            form="bulk-apartment-form"
            loading={submitting}
            disabled={!preview || preview.valid === false || submitting}
          >
            Tạo {preview?.total || totalDrafts} căn hộ
          </Button>
        </>
      }
    >
      <form id="bulk-apartment-form" onSubmit={handleSubmit} className="space-y-5">
        {/* Section 1 — Chọn tầng áp dụng */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="block text-xs font-semibold text-slate-800">
              Chọn tầng áp dụng <span className="text-rose-500">*</span>
            </label>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="xs"
                type="button"
                onClick={() => {
                  setSelectedFloorIds(floors.map((f) => f.id));
                  invalidate();
                }}
              >
                Chọn tất cả
              </Button>
              <Button
                variant="ghost"
                size="xs"
                type="button"
                onClick={() => {
                  setSelectedFloorIds([]);
                  invalidate();
                }}
              >
                Bỏ chọn
              </Button>
            </div>
          </div>

          {floors.length === 0 ? (
            <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5">
              Tòa nhà chưa có tầng nào. Vui lòng tạo tầng trước khi sinh căn hộ hàng loạt.
            </p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 max-h-40 overflow-y-auto p-2.5 rounded-xl border border-slate-200 bg-slate-50/60">
              {floors.map((floor) => {
                const checked = selectedFloorIds.includes(floor.id);
                const label = floor.name || `Tầng ${floor.level}`;
                return (
                  <label
                    key={floor.id}
                    className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs cursor-pointer transition-colors ${
                      checked
                        ? 'bg-primary-50 border-primary-300 text-primary-900 font-medium'
                        : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => handleToggleFloor(floor.id, e.target.checked)}
                      className="rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                    />
                    <span className="min-w-0 break-words">
                      {label}
                      {floor.apartment_count !== undefined ? (
                        <span className="text-slate-500 font-normal">
                          {' '}
                          ({floor.apartment_count || 0} căn hiện có)
                        </span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* Section 2 & 3 — Khu & Tiền tố mã căn */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Select
            label="Khu / Phân khu (tuỳ chọn)"
            placeholder="-- Không gán khu --"
            value={zoneId}
            onChange={(e) => {
              setZoneId(e.target.value);
              invalidate();
            }}
            options={zones.map((z) => ({
              value: z.id,
              label: z.name?.trim() || `Khu ${z.code}`,
              searchText: z.code,
            }))}
          />
          <Input
            label="Tiền tố mã căn"
            placeholder="VD: A"
            hint="Mã căn = Tiền tố + Tầng + Hậu tố (VD: A + tầng 5 + 01 = A501). Để trống sẽ dùng mã khu nếu đã chọn khu."
            value={codePrefix}
            onChange={(e) => {
              setCodePrefix(e.target.value);
              invalidate();
            }}
          />
        </div>

        {/* Section 4 — Mẫu căn */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="w-44">
              <Input
                label="Số căn mỗi tầng"
                type="number"
                min="1"
                max="50"
                value={unitCount}
                onChange={handleUnitCountChange}
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              type="button"
              icon={Plus}
              disabled={units.length >= 50}
              onClick={handleAddUnit}
            >
              Thêm loại căn
            </Button>
          </div>

          <div className="overflow-x-auto border border-slate-200 rounded-xl">
            <table className="min-w-full divide-y divide-slate-200 text-xs">
              <thead className="bg-slate-50 text-slate-600 font-semibold">
                <tr>
                  <th className="px-3 py-2 text-left w-28">Hậu tố</th>
                  <th className="px-3 py-2 text-left w-36">Loại căn</th>
                  <th className="px-3 py-2 text-left w-24">Số PN</th>
                  <th className="px-3 py-2 text-left w-32">Diện tích m²</th>
                  <th className="px-3 py-2 text-left min-w-[160px]">Giá thuê (VND/tháng)</th>
                  <th className="px-2 py-2 text-center w-12">Xóa</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {units.map((unit, idx) => (
                  <tr key={idx} className="align-top">
                    <td className="px-3 py-2">
                      <Input
                        aria-label={`Hậu tố căn ${idx + 1}`}
                        placeholder={String(idx + 1).padStart(2, '0')}
                        value={unit.suffix}
                        onChange={(e) => handleUpdateUnit(idx, { suffix: e.target.value })}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Select
                        aria-label={`Loại căn ${idx + 1}`}
                        value={unit.type}
                        onChange={(e) => handleUpdateUnit(idx, { type: e.target.value })}
                        options={APARTMENT_TYPES}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        aria-label={`Số phòng ngủ căn ${idx + 1}`}
                        type="number"
                        min="0"
                        max="20"
                        value={unit.bedrooms}
                        onChange={(e) => handleUpdateUnit(idx, { bedrooms: e.target.value })}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        aria-label={`Diện tích căn ${idx + 1}`}
                        type="number"
                        min="0"
                        step="0.5"
                        value={unit.area_m2}
                        onChange={(e) => handleUpdateUnit(idx, { area_m2: e.target.value })}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <MoneyInput
                        aria-label={`Giá thuê căn ${idx + 1}`}
                        placeholder="VD: 8.500.000"
                        value={unit.base_rent}
                        onChange={(e) => handleUpdateUnit(idx, { base_rent: e.target.value })}
                      />
                    </td>
                    <td className="px-2 py-2 text-center align-middle">
                      <button
                        type="button"
                        aria-label={`Xóa dòng mẫu căn ${idx + 1}`}
                        disabled={units.length === 1}
                        onClick={() => handleRemoveUnit(idx)}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Section 5 — Preview action & Preview panel */}
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="outline"
              icon={Eye}
              loading={loadingPreview}
              onClick={handlePreview}
              type="button"
            >
              Xem trước {totalDrafts} căn
            </Button>
          </div>

          {preview ? (
            preview.valid ? (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-3.5 space-y-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-emerald-800">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span>{preview.total} căn hợp lệ, chưa có mã trùng</span>
                </div>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {previewByFloor.map((group) => (
                    <div key={group.floor_name} className="space-y-1">
                      <p className="text-[11px] font-semibold text-slate-700">{group.floor_name}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {group.items.map((item) => (
                          <span
                            key={item.code}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white border border-emerald-200 text-xs font-mono font-semibold text-emerald-900"
                          >
                            {item.code}
                            <span className="font-sans font-normal text-slate-500">({item.type})</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-rose-200 bg-rose-50/70 p-3.5 space-y-2.5">
                <div className="flex items-start gap-2 text-xs text-rose-800">
                  <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                  <div className="space-y-0.5">
                    <p className="font-semibold">
                      Phát hiện {(preview.conflicts || []).length} mã căn đã tồn tại trong tòa nhà
                    </p>
                    <p className="text-rose-700">
                      Vui lòng đổi tiền tố mã căn, hậu tố hoặc bỏ chọn tầng bị trùng rồi bấm Xem trước lại.
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto">
                  {(preview.conflicts || []).map((c) => (
                    <span
                      key={`${c.floor_id || ''}-${c.code}`}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white border border-rose-300 text-xs font-mono font-semibold text-rose-800"
                    >
                      {c.code}
                      {c.floor_name ? (
                        <span className="font-sans font-normal text-rose-600">({c.floor_name})</span>
                      ) : null}
                    </span>
                  ))}
                </div>
                {previewByFloor.length > 0 ? (
                  <div className="space-y-1.5 pt-1 border-t border-rose-200/70 max-h-36 overflow-y-auto">
                    {previewByFloor.map((group) => (
                      <div key={group.floor_name} className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] font-semibold text-slate-700 mr-1">
                          {group.floor_name}:
                        </span>
                        {group.items.map((item) => {
                          const isConflict = conflictCodeSet.has(item.code);
                          return (
                            <span
                              key={item.code}
                              className={`px-2 py-0.5 rounded-md border text-xs font-mono ${
                                isConflict
                                  ? 'bg-rose-100 border-rose-300 text-rose-900 font-bold'
                                  : 'bg-white border-slate-200 text-slate-700'
                              }`}
                            >
                              {item.code}
                            </span>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          ) : null}
        </div>
      </form>
    </Modal>
  );
}

export default BulkApartmentModal;

