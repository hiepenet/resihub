import React, { useEffect, useMemo, useState } from 'react';
import {
  Layers,
  Plus,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { Modal } from '../../../components/ui/Modal';
import { Tabs } from '../../../components/ui/Tabs';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Badge } from '../../../components/ui/Badge';
import { buildingsService } from '../../../services/buildings.service';
import { useToast } from '../../../hooks/useToast';
import { extractErrorMessage } from '../../../utils/validation';

const MIN_LEVEL = -10;
const MAX_LEVEL = 200;
const MAX_BULK_COUNT = 100;

function parseStrictInt(raw) {
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^-?\d+$/.test(trimmed)) return null;
    const n = Number(trimmed);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

function buildDefaultFloorName(level, namePrefix = 'Tầng') {
  const lvl = Number(level);
  if (lvl < 0) return `Tầng hầm B${Math.abs(lvl)}`;
  if (lvl === 0) return 'Tầng Trệt';
  const cleanPrefix = String(namePrefix ?? '').trim() || 'Tầng';
  if (/[-_/.]$/.test(cleanPrefix)) {
    return `${cleanPrefix}${lvl}`;
  }
  return `${cleanPrefix} ${lvl}`;
}

function computeSuggestedRange(existingFloors = []) {
  if (!Array.isArray(existingFloors) || existingFloors.length === 0) {
    return { from: 1, to: 5 };
  }
  const levels = existingFloors
    .map((f) => Number(f.level))
    .filter((n) => Number.isInteger(n));
  if (levels.length === 0) {
    return { from: 1, to: 5 };
  }
  const maxLvl = Math.max(...levels);
  const nextFrom = Math.min(MAX_LEVEL, Math.max(1, maxLvl + 1));
  const nextTo = Math.min(MAX_LEVEL, nextFrom + 4);
  return { from: nextFrom, to: nextTo };
}

export function FloorModal({
  open,
  onClose,
  buildingId,
  existingFloors = [],
  initialMode = 'bulk',
  onCreated,
}) {
  const toast = useToast();
  const [mode, setMode] = useState(initialMode);
  const [submitting, setSubmitting] = useState(false);

  // Single-floor form state
  const [singleForm, setSingleForm] = useState({ level: '', name: '' });

  // Bulk-floor form state
  const [fromLevel, setFromLevel] = useState('1');
  const [toLevel, setToLevel] = useState('5');
  const [namePrefix, setNamePrefix] = useState('Tầng');
  const [includeZero, setIncludeZero] = useState(false);
  const [zeroTouched, setZeroTouched] = useState(false);
  const [skipExisting, setSkipExisting] = useState(true);
  const [excludedLevels, setExcludedLevels] = useState([]);
  const [customNames, setCustomNames] = useState({});

  useEffect(() => {
    if (!open) return;
    const suggested = computeSuggestedRange(existingFloors);
    setMode(initialMode || 'bulk');
    setSingleForm({ level: String(suggested.from), name: '' });
    setFromLevel(String(suggested.from));
    setToLevel(String(suggested.to));
    setNamePrefix('Tầng');
    setIncludeZero(suggested.from === 0 || suggested.to === 0);
    setZeroTouched(false);
    setSkipExisting(true);
    setExcludedLevels([]);
    setCustomNames({});
  }, [open, initialMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const existingByLevel = useMemo(() => {
    const map = new Map();
    for (const f of existingFloors || []) {
      const lvl = Number(f.level);
      if (Number.isInteger(lvl)) {
        map.set(lvl, f);
      }
    }
    return map;
  }, [existingFloors]);

  const parsedFrom = parseStrictInt(fromLevel);
  const parsedTo = parseStrictInt(toLevel);
  const spansZero =
    parsedFrom !== null && parsedTo !== null && parsedFrom <= 0 && parsedTo >= 0;

  const handleRangeChange = (nextFromStr, nextToStr) => {
    setFromLevel(nextFromStr);
    setToLevel(nextToStr);
    if (!zeroTouched) {
      const f = parseStrictInt(nextFromStr);
      const t = parseStrictInt(nextToStr);
      if (f !== null && t !== null) {
        if (f < 0 && t > 0) setIncludeZero(false);
        else if (f === 0 || t === 0) setIncludeZero(true);
      }
    }
  };

  const bulkComputation = useMemo(() => {
    if (parsedFrom === null || parsedTo === null) {
      return { error: 'Vui lòng nhập Từ tầng và Đến tầng là số nguyên hợp lệ.', rows: [] };
    }
    if (parsedFrom < MIN_LEVEL || parsedTo > MAX_LEVEL || parsedTo < MIN_LEVEL || parsedFrom > MAX_LEVEL) {
      return {
        error: `Số tầng phải nằm trong khoảng từ ${MIN_LEVEL} đến ${MAX_LEVEL}.`,
        rows: [],
      };
    }
    if (parsedFrom > parsedTo) {
      return { error: 'Giá trị "Từ tầng" không được lớn hơn "Đến tầng".', rows: [] };
    }

    const excludedSet = new Set(excludedLevels);
    const rows = [];

    for (let lvl = parsedFrom; lvl <= parsedTo; lvl += 1) {
      if (lvl === 0 && !includeZero) continue;
      const existing = existingByLevel.get(lvl) || null;
      const autoSkipped = Boolean(existing && skipExisting);
      const manuallyExcluded = excludedSet.has(lvl);
      const checked = !autoSkipped && !manuallyExcluded;
      const defaultName = buildDefaultFloorName(lvl, namePrefix);
      const hasCustom = Object.prototype.hasOwnProperty.call(customNames, lvl);
      const displayName = hasCustom ? customNames[lvl] : defaultName;

      rows.push({
        level: lvl,
        existing,
        autoSkipped,
        manuallyExcluded,
        checked,
        defaultName,
        displayName,
        isConflict: Boolean(existing && !skipExisting && checked),
      });

      if (rows.length > MAX_BULK_COUNT) {
        return {
          error: `Một lần chỉ hỗ trợ tạo tối đa ${MAX_BULK_COUNT} tầng. Vui lòng thu hẹp dải tầng.`,
          rows: [],
        };
      }
    }

    if (rows.length === 0) {
      return { error: 'Dải tầng hiện tại không có tầng nào để tạo.', rows: [] };
    }

    return { error: '', rows };
  }, [parsedFrom, parsedTo, includeZero, excludedLevels, existingByLevel, skipExisting, namePrefix, customNames]);

  const selectedRows = useMemo(
    () => bulkComputation.rows.filter((r) => r.checked),
    [bulkComputation.rows]
  );
  const conflictRows = useMemo(
    () => bulkComputation.rows.filter((r) => r.isConflict),
    [bulkComputation.rows]
  );
  const skippedRows = useMemo(
    () => bulkComputation.rows.filter((r) => r.autoSkipped),
    [bulkComputation.rows]
  );

  const handleToggleRow = (level, nextChecked) => {
    setExcludedLevels((prev) => {
      const set = new Set(prev);
      if (nextChecked) set.delete(level);
      else set.add(level);
      return [...set];
    });
  };

  const handleCustomNameChange = (level, value) => {
    setCustomNames((prev) => ({ ...prev, [level]: value }));
  };

  const handleResetCustomizations = () => {
    setExcludedLevels([]);
    setCustomNames({});
  };

  const applyQuickPreset = (presetFrom, presetTo, opts = {}) => {
    setFromLevel(String(presetFrom));
    setToLevel(String(presetTo));
    if (opts.includeZero !== undefined) {
      setIncludeZero(opts.includeZero);
      setZeroTouched(true);
    }
    setExcludedLevels([]);
  };

  const handleSingleSubmit = async (e) => {
    e.preventDefault();
    const lvl = parseStrictInt(singleForm.level);
    if (lvl === null || lvl < MIN_LEVEL || lvl > MAX_LEVEL) {
      toast.warning(`Số tầng phải là số nguyên từ ${MIN_LEVEL} đến ${MAX_LEVEL}.`);
      return;
    }
    setSubmitting(true);
    try {
      const res = await buildingsService.createFloor(buildingId, {
        level: lvl,
        name: singleForm.name.trim() || undefined,
      });
      toast.success(res?.message || 'Đã thêm tầng mới.');
      window.dispatchEvent(new Event('resihub:buildings-updated'));
      onCreated?.(res);
      onClose?.();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleBulkSubmit = async (e) => {
    e.preventDefault();
    if (bulkComputation.error) {
      toast.warning(bulkComputation.error);
      return;
    }
    if (conflictRows.length > 0) {
      toast.warning('Vui lòng bật tự động bỏ qua tầng đã có hoặc bỏ chọn các tầng bị trùng.');
      return;
    }
    if (selectedRows.length === 0) {
      toast.warning('Chưa có tầng mới nào được chọn để khởi tạo.');
      return;
    }

    const payloadFloors = selectedRows.map((r) => ({
      level: r.level,
      name: String(r.displayName || '').trim() || r.defaultName,
    }));

    setSubmitting(true);
    try {
      const res = await buildingsService.createFloorsBulk(buildingId, {
        floors: payloadFloors,
        name_prefix: namePrefix.trim() || 'Tầng',
        skip_existing: skipExisting,
      });
      toast.success(res?.message || `Đã tạo ${res?.created_count || payloadFloors.length} tầng mới.`);
      window.dispatchEvent(new Event('resihub:buildings-updated'));
      onCreated?.(res);
      onClose?.();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const singlePlaceholder = (() => {
    const lvl = parseStrictInt(singleForm.level);
    return lvl !== null ? buildDefaultFloorName(lvl, 'Tầng') : 'VD: Tầng 11';
  })();

  const hasCustomEdits =
    excludedLevels.length > 0 || Object.keys(customNames).length > 0;

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!submitting) onClose?.();
      }}
      title="Thêm tầng vào tòa nhà"
      subtitle="Khởi tạo hàng loạt theo dải tầng hoặc thêm lẻ từng tầng"
      size={mode === 'bulk' ? 'lg' : 'sm'}
      footer={
        mode === 'bulk' ? (
          <>
            <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
              Hủy
            </Button>
            <Button
              type="submit"
              form="bulk-floor-form"
              icon={Layers}
              loading={submitting}
              disabled={
                submitting ||
                Boolean(bulkComputation.error) ||
                conflictRows.length > 0 ||
                selectedRows.length === 0
              }
            >
              {selectedRows.length > 0
                ? `Tạo ${selectedRows.length} tầng mới`
                : 'Không có tầng mới để tạo'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
              Hủy
            </Button>
            <Button type="submit" form="single-floor-form" icon={Plus} loading={submitting}>
              Tạo tầng
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        <Tabs
          tabs={[
            { id: 'bulk', label: 'Thêm hàng loạt', icon: Layers },
            { id: 'single', label: 'Từng tầng', icon: Plus },
          ]}
          activeTab={mode}
          onChange={setMode}
        />

        {mode === 'single' ? (
          <form id="single-floor-form" onSubmit={handleSingleSubmit} className="space-y-4 pt-1">
            <Input
              label="Số tầng (số nguyên, VD: 11 hoặc -1 cho hầm)"
              type="number"
              min={MIN_LEVEL}
              max={MAX_LEVEL}
              required
              value={singleForm.level}
              onChange={(e) => setSingleForm({ ...singleForm, level: e.target.value })}
            />
            <Input
              label="Tên hiển thị (để trống sẽ tự đặt)"
              placeholder={singlePlaceholder}
              value={singleForm.name}
              onChange={(e) => setSingleForm({ ...singleForm, name: e.target.value })}
            />
            {parseStrictInt(singleForm.level) !== null &&
            existingByLevel.has(parseStrictInt(singleForm.level)) ? (
              <p className="text-xs text-rose-600 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>
                  Tầng {parseStrictInt(singleForm.level)} đã tồn tại trong tòa nhà (
                  {existingByLevel.get(parseStrictInt(singleForm.level))?.name}).
                </span>
              </p>
            ) : null}
          </form>
        ) : (
          <form id="bulk-floor-form" onSubmit={handleBulkSubmit} className="space-y-4 pt-1">
            {/* Quick presets */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-medium text-slate-500 inline-flex items-center gap-1 mr-1">
                <Sparkles className="w-3.5 h-3.5 text-primary-500" />
                Chọn nhanh:
              </span>
              {existingFloors.length === 0 ? (
                <>
                  <Button
                    type="button"
                    variant="soft"
                    size="xs"
                    onClick={() => applyQuickPreset(1, 5, { includeZero: false })}
                  >
                    Tầng 1 → 5
                  </Button>
                  <Button
                    type="button"
                    variant="soft"
                    size="xs"
                    onClick={() => applyQuickPreset(1, 10, { includeZero: false })}
                  >
                    Tầng 1 → 10
                  </Button>
                  <Button
                    type="button"
                    variant="soft"
                    size="xs"
                    onClick={() => applyQuickPreset(-1, 5, { includeZero: false })}
                  >
                    Hầm B1 + Tầng 1 → 5
                  </Button>
                  <Button
                    type="button"
                    variant="soft"
                    size="xs"
                    onClick={() => applyQuickPreset(0, 5, { includeZero: true })}
                  >
                    Trệt (0) + Tầng 1 → 5
                  </Button>
                </>
              ) : (
                <>
                  {(() => {
                    const sug = computeSuggestedRange(existingFloors);
                    return (
                      <>
                        <Button
                          type="button"
                          variant="soft"
                          size="xs"
                          onClick={() => applyQuickPreset(sug.from, sug.to)}
                        >
                          +5 tầng kế ({sug.from} → {sug.to})
                        </Button>
                        <Button
                          type="button"
                          variant="soft"
                          size="xs"
                          onClick={() =>
                            applyQuickPreset(sug.from, Math.min(MAX_LEVEL, sug.from + 9))
                          }
                        >
                          +10 tầng kế ({sug.from} → {Math.min(MAX_LEVEL, sug.from + 9)})
                        </Button>
                      </>
                    );
                  })()}
                  <Button
                    type="button"
                    variant="soft"
                    size="xs"
                    onClick={() => applyQuickPreset(-2, -1, { includeZero: false })}
                  >
                    Thêm 2 tầng hầm (B1, B2)
                  </Button>
                </>
              )}
            </div>

            {/* Range & Prefix Inputs */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
              <Input
                label="Từ tầng"
                type="number"
                min={MIN_LEVEL}
                max={MAX_LEVEL}
                required
                placeholder="VD: 1 hoặc -1"
                value={fromLevel}
                onChange={(e) => handleRangeChange(e.target.value, toLevel)}
              />
              <Input
                label="Đến tầng"
                type="number"
                min={MIN_LEVEL}
                max={MAX_LEVEL}
                required
                placeholder="VD: 10"
                value={toLevel}
                onChange={(e) => handleRangeChange(fromLevel, e.target.value)}
              />
              <Input
                label="Tiền tố tầng nổi"
                placeholder="VD: Tầng"
                hint="Áp dụng cho tầng > 0 (VD: Tầng 1, Lầu 1)"
                value={namePrefix}
                onChange={(e) => setNamePrefix(e.target.value)}
              />
            </div>

            {/* Options checkboxes */}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl bg-slate-50 border border-slate-200/80 px-3.5 py-2.5 text-xs text-slate-700">
              <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={skipExisting}
                  onChange={(e) => setSkipExisting(e.target.checked)}
                  className="rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                />
                <span>Tự động bỏ qua tầng đã tồn tại</span>
              </label>

              {spansZero ? (
                <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={includeZero}
                    onChange={(e) => {
                      setIncludeZero(e.target.checked);
                      setZeroTouched(true);
                    }}
                    className="rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                  />
                  <span>Bao gồm Tầng Trệt (tầng 0)</span>
                </label>
              ) : null}
            </div>

            {/* Error or Live Preview Table */}
            {bulkComputation.error ? (
              <div className="rounded-xl border border-rose-200 bg-rose-50/70 px-3.5 py-3 text-xs text-rose-700 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <span>{bulkComputation.error}</span>
              </div>
            ) : (
              <div className="space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-semibold text-slate-800">
                      Xem trước danh sách tầng ({bulkComputation.rows.length} dòng)
                    </span>
                    <Badge variant={selectedRows.length > 0 ? 'emerald' : 'slate'}>
                      Sẽ tạo: {selectedRows.length}
                    </Badge>
                    {skippedRows.length > 0 ? (
                      <Badge variant="slate">Đã có (bỏ qua): {skippedRows.length}</Badge>
                    ) : null}
                    {conflictRows.length > 0 ? (
                      <Badge variant="red">Trùng tầng: {conflictRows.length}</Badge>
                    ) : null}
                  </div>

                  {hasCustomEdits ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      icon={RotateCcw}
                      onClick={handleResetCustomizations}
                    >
                      Khôi phục mặc định
                    </Button>
                  ) : null}
                </div>

                {conflictRows.length > 0 ? (
                  <div className="rounded-xl border border-rose-200 bg-rose-50/70 px-3.5 py-2.5 text-xs text-rose-800 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                    <span>
                      Có {conflictRows.length} tầng đã tồn tại trong tòa nhà (
                      {conflictRows.map((c) => c.level).join(', ')}). Hãy bật{' '}
                      <strong>Tự động bỏ qua tầng đã tồn tại</strong> hoặc bỏ chọn các dòng đỏ.
                    </span>
                  </div>
                ) : selectedRows.length > 0 ? (
                  <p className="text-[11px] text-slate-500 flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                    <span>
                      Bạn có thể bỏ tick các tầng không sử dụng (VD: tầng 4, 13) hoặc sửa tên hiển thị (VD: Tầng 12A) ngay bên dưới.
                    </span>
                  </p>
                ) : null}

                <div className="max-h-64 overflow-y-auto border border-slate-200 rounded-xl divide-y divide-slate-100 bg-white">
                  {bulkComputation.rows.map((row) => (
                    <div
                      key={row.level}
                      className={`px-3 py-2 flex items-center gap-3 text-xs transition-colors ${
                        row.isConflict
                          ? 'bg-rose-50/70'
                          : row.autoSkipped || !row.checked
                          ? 'bg-slate-50/80 opacity-75'
                          : 'bg-white'
                      }`}
                    >
                      <input
                        type="checkbox"
                        aria-label={`Chọn tầng ${row.level}`}
                        checked={row.checked}
                        disabled={row.autoSkipped}
                        onChange={(e) => handleToggleRow(row.level, e.target.checked)}
                        className="rounded border-slate-300 text-primary-600 focus:ring-primary-500 disabled:opacity-40"
                      />

                      <span className="w-16 shrink-0 font-mono font-semibold text-slate-700">
                        {row.level < 0 ? `B${Math.abs(row.level)} (${row.level})` : `Tầng ${row.level}`}
                      </span>

                      <div className="flex-1 min-w-0">
                        <Input
                          className="sm:h-8 text-xs"
                          aria-label={`Tên hiển thị tầng ${row.level}`}
                          disabled={!row.checked || row.autoSkipped}
                          placeholder={row.defaultName}
                          value={row.displayName}
                          onChange={(e) => handleCustomNameChange(row.level, e.target.value)}
                        />
                      </div>

                      <div className="shrink-0">
                        {row.autoSkipped ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-slate-200/70 text-slate-600 text-[11px] font-medium">
                            Đã có ({row.existing?.name || `Tầng ${row.level}`})
                          </span>
                        ) : row.isConflict ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-rose-100 text-rose-800 border border-rose-200 text-[11px] font-semibold">
                            Trùng tầng hiện có
                          </span>
                        ) : !row.checked ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-slate-100 text-slate-500 text-[11px]">
                            Bỏ qua
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-medium">
                            Tạo mới
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </form>
        )}
      </div>
    </Modal>
  );
}

export default FloorModal;
