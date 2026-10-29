import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Gauge,
  Plus,
  Save,
  Zap,
  Droplets,
  AlertTriangle,
  Camera,
  CheckCircle2,
  RefreshCw,
} from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { Modal } from '../../../components/ui/Modal';
import { Badge } from '../../../components/ui/Badge';
import { Card } from '../../../components/ui/Card';
import { Table, THead, TBody, TH, TD } from '../../../components/ui/Table';
import { FileUpload, AuthImage } from '../../../components/ui/FileUpload';
import { PageHeader } from '../../../components/common/PageHeader';
import { StatsCard } from '../../../components/common/StatsCard';
import { SearchBar } from '../../../components/common/SearchBar';
import { EmptyState } from '../../../components/common/EmptyState';
import { metersService } from '../../../services/meters.service';
import { buildingsService } from '../../../services/buildings.service';
import { usePermission } from '../../../hooks/usePermission';
import { useToast } from '../../../hooks/useToast';
import { useAuthStore } from '../../../stores/authStore';
import { formatMoney, formatDateTime, getCurrentPeriod } from '../../../utils/format';
import { extractErrorMessage } from '../../../utils/validation';

function getPreviousBaseline(row) {
  if (row.period_previous_reading !== null && row.period_previous_reading !== undefined) {
    return Number(row.period_previous_reading);
  }
  if (row.last_known_reading !== null && row.last_known_reading !== undefined) {
    return Number(row.last_known_reading);
  }
  return Number(row.initial_reading || 0);
}

function evaluateRowMetrics(row, draftValue) {
  const prevReading = getPreviousBaseline(row);
  const hasDraft = draftValue !== undefined && draftValue !== '' && draftValue !== null;
  const currentNum = hasDraft ? Number(draftValue) : null;
  const isInvalid = hasDraft && (Number.isNaN(currentNum) || currentNum < prevReading);
  const consumption =
    hasDraft && !isInvalid ? Number((currentNum - prevReading).toFixed(2)) : null;

  const prevCons =
    row.last_known_consumption !== null && row.last_known_consumption !== undefined
      ? Number(row.last_known_consumption)
      : null;

  let diffPct = null;
  let isAbnormal = false;

  if (consumption !== null && prevCons !== null && prevCons > 0) {
    const ratio = (consumption - prevCons) / prevCons;
    diffPct = Math.round(ratio * 100);
    if (Math.abs(ratio) > 0.3) {
      isAbnormal = true;
    }
  } else if (Boolean(row.period_is_abnormal) && String(draftValue) === String(row.period_current_reading ?? '')) {
    isAbnormal = true;
  }

  const isDirty =
    hasDraft && String(Number(draftValue)) !== String(Number(row.period_current_reading ?? -1));

  return {
    prevReading,
    hasDraft,
    currentNum,
    isInvalid,
    consumption,
    prevCons,
    diffPct,
    isAbnormal,
    isDirty,
  };
}

export function MeterReadingsPage() {
  const toast = useToast();
  const { canManageMeters } = usePermission();
  const selectedBuildingId = useAuthStore((s) => s.selectedBuildingId);

  const [period, setPeriod] = useState(getCurrentPeriod());
  const [meterType, setMeterType] = useState('');
  const [abnormalOnly, setAbnormalOnly] = useState(false);
  const [search, setSearch] = useState('');

  const [meters, setMeters] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [notes, setNotes] = useState({});
  const [loading, setLoading] = useState(true);
  const [savingBatch, setSavingBatch] = useState(false);

  // Modal ghi chi tiết 1 đồng hồ + ảnh công tơ + lịch sử
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [selectedMeter, setSelectedMeter] = useState(null);
  const [historyList, setHistoryList] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [singleForm, setSingleForm] = useState({
    current_reading: '',
    abnormal_note: '',
    image: '',
  });
  const [savingSingle, setSavingSingle] = useState(false);

  // Modal khởi tạo đồng hồ mới
  const [createOpen, setCreateOpen] = useState(false);
  const [apartments, setApartments] = useState([]);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({
    apartment_id: '',
    meter_type: 'ELECTRICITY',
    meter_code: '',
    unit_price: '3800',
    initial_reading: '0',
  });

  const fetchMeters = useCallback(async () => {
    setLoading(true);
    try {
      const res = await metersService.list({
        building_id: selectedBuildingId || undefined,
        meter_type: meterType || undefined,
        period,
        search: search.trim() || undefined,
      });
      const list = res.data || [];
      setMeters(list);

      const initDrafts = {};
      const initNotes = {};
      for (const m of list) {
        initDrafts[m.id] =
          m.period_current_reading !== null && m.period_current_reading !== undefined
            ? String(Number(m.period_current_reading))
            : '';
        initNotes[m.id] = m.period_abnormal_note || '';
      }
      setDrafts(initDrafts);
      setNotes(initNotes);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải danh sách đồng hồ điện/nước.'));
    } finally {
      setLoading(false);
    }
  }, [selectedBuildingId, meterType, period, search, toast]);

  useEffect(() => {
    const t = setTimeout(() => {
      fetchMeters();
    }, 200);
    return () => clearTimeout(t);
  }, [fetchMeters]);

  const enrichedRows = useMemo(() => {
    const mapped = meters.map((m) => ({
      ...m,
      metrics: evaluateRowMetrics(m, drafts[m.id]),
    }));
    if (!abnormalOnly) return mapped;
    return mapped.filter((r) => r.metrics.isAbnormal || Boolean(r.period_is_abnormal));
  }, [meters, drafts, abnormalOnly]);

  const dirtyValidRows = useMemo(() => {
    return meters.filter((m) => {
      const meta = evaluateRowMetrics(m, drafts[m.id]);
      return meta.isDirty && !meta.isInvalid;
    });
  }, [meters, drafts]);

  const hasInvalidDrafts = useMemo(() => {
    return meters.some((m) => evaluateRowMetrics(m, drafts[m.id]).isInvalid);
  }, [meters, drafts]);

  const stats = useMemo(() => {
    const total = meters.length;
    const recorded = meters.filter(
      (m) => m.period_current_reading !== null && m.period_current_reading !== undefined
    ).length;
    const abnormalCount = meters.filter(
      (m) => evaluateRowMetrics(m, drafts[m.id]).isAbnormal || Boolean(m.period_is_abnormal)
    ).length;
    return { total, recorded, unrecorded: Math.max(0, total - recorded), abnormalCount };
  }, [meters, drafts]);

  const handleSaveBatch = async () => {
    if (hasInvalidDrafts) {
      toast.error('Có dòng nhập chỉ số mới nhỏ hơn chỉ số cũ. Vui lòng kiểm tra các ô màu đỏ.');
      return;
    }
    if (dirtyValidRows.length === 0) {
      toast.info('Chưa có thay đổi chỉ số mới nào cần lưu.');
      return;
    }

    setSavingBatch(true);
    try {
      const payload = {
        period,
        readings: dirtyValidRows.map((m) => ({
          meter_id: m.id,
          period,
          current_reading: Number(drafts[m.id]),
          abnormal_note: notes[m.id]?.trim() || undefined,
        })),
      };
      const res = await metersService.recordBatch(payload);
      if (res.abnormal_count > 0) {
        toast.warning(res.message || `Đã lưu với ${res.abnormal_count} cảnh báo bất thường (>30%).`);
      } else {
        toast.success(res.message || `Đã lưu thành công ${dirtyValidRows.length} chỉ số.`);
      }
      fetchMeters();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể lưu chỉ số hàng loạt.'));
    } finally {
      setSavingBatch(false);
    }
  };

  const openSingleModal = async (meter) => {
    setSelectedMeter(meter);
    setSingleForm({
      current_reading:
        drafts[meter.id] !== undefined && drafts[meter.id] !== ''
          ? drafts[meter.id]
          : meter.period_current_reading !== null && meter.period_current_reading !== undefined
          ? String(Number(meter.period_current_reading))
          : '',
      abnormal_note: notes[meter.id] || meter.period_abnormal_note || '',
      image: meter.period_image_url || '',
    });
    setDetailModalOpen(true);
    setHistoryLoading(true);
    try {
      const res = await metersService.listMeterReadings(meter.id);
      setHistoryList(res.data || []);
    } catch {
      setHistoryList([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleSaveSingle = async (e) => {
    e.preventDefault();
    if (!selectedMeter) return;
    const prev = getPreviousBaseline(selectedMeter);
    const val = Number(singleForm.current_reading);

    if (singleForm.current_reading === '' || Number.isNaN(val) || val < prev) {
      toast.warning(`Chỉ số mới phải lớn hơn hoặc bằng chỉ số cũ (${prev}).`);
      return;
    }

    setSavingSingle(true);
    try {
      const payload = {
        period,
        current_reading: val,
        abnormal_note: singleForm.abnormal_note.trim() || undefined,
      };
      if (singleForm.image && singleForm.image.startsWith('data:image/')) {
        payload.image_base64 = singleForm.image;
      } else if (singleForm.image) {
        payload.image_url = singleForm.image;
      }

      const res = await metersService.recordReading(selectedMeter.id, payload);
      if (res.data?.is_abnormal) {
        toast.warning(res.message);
      } else {
        toast.success(res.message || 'Ghi chỉ số đồng hồ thành công.');
      }
      setDetailModalOpen(false);
      fetchMeters();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể lưu chỉ số đồng hồ.'));
    } finally {
      setSavingSingle(false);
    }
  };

  const openCreateModal = async () => {
    setCreateForm({
      apartment_id: '',
      meter_type: 'ELECTRICITY',
      meter_code: '',
      unit_price: '3800',
      initial_reading: '0',
    });
    setCreateOpen(true);
    try {
      const res = await buildingsService.listApartments({
        building_id: selectedBuildingId || undefined,
      });
      setApartments(res.data || []);
    } catch {
      setApartments([]);
    }
  };

  const handleCreateMeter = async (e) => {
    e.preventDefault();
    if (!createForm.apartment_id) {
      toast.warning('Vui lòng chọn căn hộ cần lắp đặt đồng hồ.');
      return;
    }
    setCreating(true);
    try {
      const res = await metersService.create({
        apartment_id: createForm.apartment_id,
        meter_type: createForm.meter_type,
        meter_code: createForm.meter_code.trim() || undefined,
        unit_price: Number(createForm.unit_price || 0),
        initial_reading: Number(createForm.initial_reading || 0),
      });
      toast.success(res.message || 'Khởi tạo đồng hồ mới thành công.');
      setCreateOpen(false);
      fetchMeters();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể khởi tạo đồng hồ.'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ghi Chỉ số Điện / Nước"
        subtitle="Chốt chỉ số công tơ nhanh theo kỳ, tự động tính sản lượng và cảnh báo biến động bất thường >30%."
        actions={
          <>
            <Button variant="outline" icon={RefreshCw} onClick={fetchMeters}>
              Làm mới
            </Button>
            {canManageMeters ? (
              <>
                <Button variant="outline" icon={Plus} onClick={openCreateModal}>
                  Khởi tạo đồng hồ
                </Button>
                <Button
                  variant="primary"
                  icon={Save}
                  loading={savingBatch}
                  disabled={dirtyValidRows.length === 0 && !hasInvalidDrafts}
                  onClick={handleSaveBatch}
                >
                  Lưu hàng loạt {dirtyValidRows.length > 0 ? `(${dirtyValidRows.length})` : ''}
                </Button>
              </>
            ) : null}
          </>
        }
      />

      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsCard
          title={`Tổng đồng hồ (${period})`}
          value={stats.total}
          subtext="Điện (kWh) & Nước (m³)"
          icon={Gauge}
          color="sky"
        />
        <StatsCard
          title="Đã chốt kỳ này"
          value={`${stats.recorded} / ${stats.total}`}
          subtext={`Còn ${stats.unrecorded} đồng hồ chưa chốt`}
          icon={CheckCircle2}
          color="emerald"
        />
        <StatsCard
          title="Chưa chốt chỉ số"
          value={stats.unrecorded}
          subtext="Cần nhập trước khi sinh hóa đơn"
          icon={Zap}
          color="indigo"
        />
        <StatsCard
          title="Cảnh báo bất thường (>30%)"
          value={stats.abnormalCount}
          subtext="Biến động sản lượng cần kiểm tra"
          icon={AlertTriangle}
          color={stats.abnormalCount > 0 ? 'rose' : 'amber'}
          onClick={() => setAbnormalOnly((v) => !v)}
        />
      </div>

      {/* Bộ lọc */}
      <Card className="p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-center">
          <div>
            <input
              type="month"
              value={period}
              onChange={(e) => setPeriod(e.target.value || getCurrentPeriod())}
              className="w-full h-9 px-3 rounded-lg border border-slate-200 bg-white text-sm font-medium text-slate-800 focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20"
            />
          </div>

          <Select
            value={meterType}
            onChange={(e) => setMeterType(e.target.value)}
            options={[
              { value: '', label: 'Tất cả loại đồng hồ' },
              { value: 'ELECTRICITY', label: '⚡ Đồng hồ Điện (kWh)' },
              { value: 'WATER', label: '💧 Đồng hồ Nước (m³)' },
            ]}
          />

          <div className="lg:col-span-2">
            <SearchBar
              value={search}
              onChange={setSearch}
              placeholder="Tìm theo mã căn hộ hoặc mã công tơ..."
            />
          </div>

          <label className="inline-flex items-center gap-2 px-3 h-9 rounded-lg border border-amber-200 bg-amber-50/70 text-xs font-semibold text-amber-800 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={abnormalOnly}
              onChange={(e) => setAbnormalOnly(e.target.checked)}
              className="w-4 h-4 rounded border-amber-400 text-amber-600 focus:ring-amber-500"
            />
            <span>Chỉ hiện bất thường (&gt;30%)</span>
          </label>
        </div>
      </Card>

      {/* Bảng nhập chỉ số nhanh */}
      <div className="bg-white rounded-xl border border-slate-200/80 shadow-card overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-slate-400">
            Đang tải bảng chỉ số kỳ {period}...
          </div>
        ) : enrichedRows.length === 0 ? (
          <EmptyState
            icon={Gauge}
            title="Không có đồng hồ nào khớp điều kiện lọc"
            description={
              abnormalOnly
                ? 'Không có đồng hồ nào có biến động sản lượng bất thường (>30%) trong kỳ này.'
                : 'Hãy khởi tạo đồng hồ điện/nước cho căn hộ để bắt đầu ghi nhận chỉ số hàng kỳ.'
            }
            action={
              canManageMeters && !abnormalOnly ? (
                <Button variant="primary" size="sm" icon={Plus} onClick={openCreateModal}>
                  Khởi tạo đồng hồ mới
                </Button>
              ) : null
            }
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Căn hộ / Công tơ</TH>
                <TH>Loại & Đơn giá</TH>
                <TH className="text-right">Chỉ số cũ</TH>
                <TH className="min-w-[150px] text-center">Chỉ số mới ({period})</TH>
                <TH className="text-right">Sản lượng</TH>
                <TH className="text-right">Tạm tính</TH>
                <TH className="text-center">Trạng thái</TH>
                <TH className="w-px whitespace-nowrap text-center">Thao tác</TH>
              </tr>
            </THead>
            <TBody>
              {enrichedRows.map((row) => {
                const { metrics } = row;
                const isElec = row.meter_type === 'ELECTRICITY';
                const rowHighlight = metrics.isInvalid
                  ? 'bg-rose-50/70'
                  : metrics.isAbnormal
                  ? 'bg-amber-50/70'
                  : metrics.isDirty
                  ? 'bg-sky-50/40'
                  : '';

                const estMoney =
                  metrics.consumption !== null
                    ? Math.round(metrics.consumption * Number(row.unit_price || 0))
                    : null;

                return (
                  <tr key={row.id} className={`transition-colors ${rowHighlight}`}>
                    <TD>
                      <p className="font-semibold text-slate-900 whitespace-nowrap">
                        Căn {row.apartment_code}{' '}
                        <span className="text-xs font-normal text-slate-500">
                          ({row.building_code})
                        </span>
                      </p>
                      <span className="font-mono text-[11px] text-slate-500 whitespace-nowrap">{row.meter_code}</span>
                    </TD>

                    <TD>
                      <div className="flex items-center gap-1.5">
                        {isElec ? (
                          <Badge variant="amber">
                            <Zap className="w-3 h-3" /> Điện ({row.unit})
                          </Badge>
                        ) : (
                          <Badge variant="sky">
                            <Droplets className="w-3 h-3" /> Nước ({row.unit})
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-slate-500 mt-1 whitespace-nowrap">
                        {formatMoney(row.unit_price)} / {row.unit}
                      </p>
                    </TD>

                    <TD className="text-right font-mono tabular-nums font-medium text-slate-700 whitespace-nowrap">
                      <div>{metrics.prevReading}</div>
                      {row.last_known_consumption !== null &&
                      row.last_known_consumption !== undefined ? (
                        <div className="text-[11px] text-slate-400">
                          Kỳ trước: {Number(row.last_known_consumption)} {row.unit}
                        </div>
                      ) : null}
                    </TD>

                    <TD className="text-center">
                      <input
                        type="number"
                        step="0.01"
                        min={metrics.prevReading}
                        disabled={!canManageMeters}
                        value={drafts[row.id] ?? ''}
                        onChange={(e) =>
                          setDrafts((prev) => ({ ...prev, [row.id]: e.target.value }))
                        }
                        placeholder={`>= ${metrics.prevReading}`}
                        className={`w-36 h-9 px-3 rounded-lg border font-mono tabular-nums text-sm font-semibold text-center focus:outline-none focus:ring-2 ${
                          metrics.isInvalid
                            ? 'border-rose-400 bg-rose-50 text-rose-800 focus:ring-rose-500/20'
                            : metrics.isAbnormal
                            ? 'border-amber-400 bg-white text-amber-900 focus:ring-amber-500/20'
                            : 'border-slate-200 bg-white text-slate-900 focus:border-primary-500 focus:ring-primary-500/20'
                        } disabled:bg-slate-50 disabled:text-slate-500`}
                      />
                      {metrics.isInvalid ? (
                        <p className="text-[11px] text-rose-600 font-medium mt-1 whitespace-nowrap">
                          Nhỏ hơn chỉ số cũ ({metrics.prevReading})
                        </p>
                      ) : null}
                    </TD>

                    <TD className="text-right whitespace-nowrap">
                      {metrics.consumption !== null ? (
                        <div>
                          <span
                            className={`font-mono tabular-nums font-bold ${
                              metrics.isAbnormal ? 'text-amber-700' : 'text-slate-900'
                            }`}
                          >
                            {metrics.consumption} {row.unit}
                          </span>
                          {metrics.diffPct !== null ? (
                            <p
                              className={`text-[11px] font-medium ${
                                Math.abs(metrics.diffPct) > 30
                                  ? 'text-rose-600'
                                  : 'text-slate-400'
                              }`}
                            >
                              {metrics.diffPct > 0 ? `+${metrics.diffPct}%` : `${metrics.diffPct}%`}{' '}
                              vs kỳ trước
                            </p>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </TD>

                    <TD className="text-right font-mono tabular-nums font-semibold text-slate-800 whitespace-nowrap">
                      {estMoney !== null ? formatMoney(estMoney) : '—'}
                    </TD>

                    <TD className="text-center">
                      {metrics.isAbnormal ? (
                        <div className="space-y-1 max-w-[220px] mx-auto">
                          <Badge
                            variant={
                              metrics.diffPct !== null && Math.abs(metrics.diffPct) >= 60
                                ? 'red'
                                : 'amber'
                            }
                          >
                            <AlertTriangle className="w-3 h-3" /> Biến động &gt;30%
                          </Badge>
                          {canManageMeters ? (
                            <input
                              type="text"
                              value={notes[row.id] ?? ''}
                              onChange={(e) =>
                                setNotes((prev) => ({ ...prev, [row.id]: e.target.value }))
                              }
                              placeholder="Ghi chú lý do biến động..."
                              className="w-full h-7 px-2 text-xs rounded border border-amber-300 bg-white text-slate-700 focus:outline-none focus:border-amber-500"
                            />
                          ) : row.period_abnormal_note ? (
                            <p className="text-xs text-amber-800">{row.period_abnormal_note}</p>
                          ) : null}
                        </div>
                      ) : row.period_reading_id ? (
                        <Badge variant="emerald" dot>
                          Đã chốt
                        </Badge>
                      ) : (
                        <span className="text-xs text-slate-400 whitespace-nowrap">Chưa ghi</span>
                      )}
                    </TD>

                    <TD className="w-px whitespace-nowrap text-center">
                      <Button
                        size="xs"
                        variant={row.period_image_url ? 'soft' : 'outline'}
                        icon={Camera}
                        onClick={() => openSingleModal(row)}
                      >
                        {row.period_image_url ? 'Có ảnh' : 'Chi tiết'}
                      </Button>
                    </TD>
                  </tr>
                );
              })}
            </TBody>
          </Table>
        )}
      </div>

      {/* Modal ghi chi tiết 1 đồng hồ + Upload ảnh + Lịch sử */}
      <Modal
        open={detailModalOpen}
        onClose={() => setDetailModalOpen(false)}
        title={
          selectedMeter
            ? `Chi tiết công tơ ${selectedMeter.meter_code} (Căn ${selectedMeter.apartment_code})`
            : 'Chi tiết đồng hồ'
        }
        subtitle={
          selectedMeter
            ? `Kỳ chốt: ${period} • Chỉ số đầu kỳ: ${getPreviousBaseline(selectedMeter)} ${selectedMeter.unit}`
            : ''
        }
        size="lg"
        footer={
          canManageMeters ? (
            <>
              <Button
                variant="outline"
                onClick={() => setDetailModalOpen(false)}
                disabled={savingSingle}
              >
                Đóng
              </Button>
              <Button variant="primary" onClick={handleSaveSingle} loading={savingSingle}>
                Lưu chỉ số & Ảnh công tơ
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => setDetailModalOpen(false)}>
              Đóng
            </Button>
          )
        }
      >
        {selectedMeter ? (
          <div className="space-y-6">
            {canManageMeters ? (
              <form onSubmit={handleSaveSingle} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Input
                    label={`Chỉ số cũ (${selectedMeter.unit})`}
                    disabled
                    value={getPreviousBaseline(selectedMeter)}
                  />
                  <Input
                    label={`Chỉ số mới kỳ ${period} (${selectedMeter.unit})`}
                    type="number"
                    step="0.01"
                    required
                    value={singleForm.current_reading}
                    onChange={(e) =>
                      setSingleForm((s) => ({ ...s, current_reading: e.target.value }))
                    }
                  />
                </div>

                <Input
                  label="Ghi chú kiểm tra / Giải trình bất thường"
                  placeholder="VD: Cư dân lắp thêm máy sấy, rò rỉ van bồn cầu đã xử lý..."
                  value={singleForm.abnormal_note}
                  onChange={(e) =>
                    setSingleForm((s) => ({ ...s, abnormal_note: e.target.value }))
                  }
                />

                <FileUpload
                  label="Ảnh chụp mặt đồng hồ đối chứng"
                  multiple={false}
                  value={singleForm.image}
                  onChange={(img) => setSingleForm((s) => ({ ...s, image: img }))}
                />
              </form>
            ) : selectedMeter.period_image_url ? (
              <div className="space-y-2">
                <p className="text-xs font-medium text-slate-600">Ảnh chụp công tơ kỳ {period}</p>
                <div className="w-48 h-48 rounded-xl border border-slate-200 overflow-hidden">
                  <AuthImage
                    src={selectedMeter.period_image_url}
                    alt="Ảnh công tơ"
                    className="w-full h-full object-cover"
                  />
                </div>
              </div>
            ) : null}

            {/* Lịch sử các kỳ trước */}
            <div className="space-y-2 pt-4 border-t border-slate-200">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                Lịch sử ghi chỉ số của công tơ này
              </h4>
              {historyLoading ? (
                <p className="text-xs text-slate-400 py-4">Đang tải lịch sử...</p>
              ) : historyList.length === 0 ? (
                <p className="text-xs text-slate-400 py-4">Chưa có lịch sử ghi nhận nào.</p>
              ) : (
                <div className="border border-slate-200 rounded-xl overflow-hidden">
                  <Table>
                    <THead>
                      <tr>
                        <TH className="text-center">Kỳ</TH>
                        <TH className="text-right">Chỉ số cũ</TH>
                        <TH className="text-right">Chỉ số mới</TH>
                        <TH className="text-right">Tiêu thụ</TH>
                        <TH className="text-center">Người ghi / Thời gian</TH>
                      </tr>
                    </THead>
                    <TBody>
                      {historyList.slice(0, 8).map((h) => (
                        <tr key={h.id}>
                          <TD className="text-center font-mono font-semibold whitespace-nowrap">{h.period}</TD>
                          <TD className="text-right font-mono tabular-nums whitespace-nowrap">{Number(h.previous_reading)}</TD>
                          <TD className="text-right font-mono tabular-nums font-semibold whitespace-nowrap">
                            {Number(h.current_reading)}
                          </TD>
                          <TD className="text-right whitespace-nowrap">
                            <span className="font-mono tabular-nums font-semibold">
                              {Number(h.consumption)} {selectedMeter.unit}
                            </span>
                            {h.is_abnormal ? (
                              <Badge variant="amber" className="ml-1.5">
                                Bất thường
                              </Badge>
                            ) : null}
                          </TD>
                          <TD className="text-center text-xs text-slate-500 whitespace-nowrap">
                            {h.recorded_by_name || 'Hệ thống'} • {formatDateTime(h.recorded_at)}
                          </TD>
                        </tr>
                      ))}
                    </TBody>
                  </Table>
                </div>
              )}
            </div>
          </div>
        ) : null}
      </Modal>

      {/* Modal khởi tạo đồng hồ mới */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Khởi tạo đồng hồ Điện / Nước mới"
        subtitle="Thiết lập công tơ đo đếm riêng cho căn hộ (mỗi căn tối đa 1 đồng hồ điện và 1 đồng hồ nước)."
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              Hủy
            </Button>
            <Button variant="primary" onClick={handleCreateMeter} loading={creating}>
              Tạo đồng hồ
            </Button>
          </>
        }
      >
        <form onSubmit={handleCreateMeter} className="space-y-4">
          <Select
            label="Căn hộ lắp đặt"
            required
            value={createForm.apartment_id}
            onChange={(e) => setCreateForm((s) => ({ ...s, apartment_id: e.target.value }))}
            placeholder="-- Chọn căn hộ --"
            options={apartments.map((a) => ({
              value: a.id,
              label: `${a.building_code ? `${a.building_code} - ` : ''}Căn ${a.code} (${a.status})`,
            }))}
          />

          <Select
            label="Loại đồng hồ"
            required
            value={createForm.meter_type}
            onChange={(e) => {
              const nextType = e.target.value;
              setCreateForm((s) => ({
                ...s,
                meter_type: nextType,
                unit_price: nextType === 'ELECTRICITY' ? '3800' : '22000',
              }));
            }}
            options={[
              { value: 'ELECTRICITY', label: 'Đồng hồ Điện (kWh)' },
              { value: 'WATER', label: 'Đồng hồ Nước sạch (m³)' },
            ]}
          />

          <Input
            label="Mã công tơ (tùy chọn)"
            placeholder="Để trống để hệ thống tự sinh theo mã tòa - mã căn"
            value={createForm.meter_code}
            onChange={(e) => setCreateForm((s) => ({ ...s, meter_code: e.target.value }))}
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label={`Đơn giá (₫ / ${createForm.meter_type === 'ELECTRICITY' ? 'kWh' : 'm³'})`}
              type="number"
              min="0"
              required
              value={createForm.unit_price}
              onChange={(e) => setCreateForm((s) => ({ ...s, unit_price: e.target.value }))}
            />
            <Input
              label="Chỉ số bàn giao ban đầu"
              type="number"
              min="0"
              step="0.01"
              required
              value={createForm.initial_reading}
              onChange={(e) => setCreateForm((s) => ({ ...s, initial_reading: e.target.value }))}
            />
          </div>
        </form>
      </Modal>
    </div>
  );
}

export default MeterReadingsPage;
