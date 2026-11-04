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
  Sparkles,
  Lock,
} from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { MoneyInput } from '../../../components/ui/MoneyInput';
import { Select } from '../../../components/ui/Select';
import { Modal } from '../../../components/ui/Modal';
import { Badge } from '../../../components/ui/Badge';
import { Card } from '../../../components/ui/Card';
import { Table, THead, TBody, TH, TD } from '../../../components/ui/Table';
import { FileUpload, AuthImage } from '../../../components/ui/FileUpload';
import { AISuggestionField } from '../../../components/ui/AISuggestionField';
import { PageHeader } from '../../../components/common/PageHeader';
import { StatsCard } from '../../../components/common/StatsCard';
import { SearchBar } from '../../../components/common/SearchBar';
import { EmptyState } from '../../../components/common/EmptyState';
import { metersService } from '../../../services/meters.service';
import { buildingsService } from '../../../services/buildings.service';
import { aiService } from '../../../services/ai.service';
import { usePermission } from '../../../hooks/usePermission';
import { useToast } from '../../../hooks/useToast';
import { useAuthStore } from '../../../stores/authStore';
import { APARTMENT_STATUS } from '../../../constants/statuses';
import { formatMoney, formatDateTime, getCurrentPeriod } from '../../../utils/format';
import {
  compressImageFileToDataUri,
  mapAiErrorToVietnamese,
} from '../../../utils/aiHelpers';
import {
  evaluateClientMeterAnomaly,
  resolveBatchConfirmFeedback,
  resolveAnomalyThresholdPct,
  computeMeterEstimatedAmount,
  isMeterRowLockedForEdit,
  resolveMeterTurnoverBadgeMeta,
  resolveMeterSlotView,
} from '../../../utils/billing';
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

function resolveRowBaselineAvg(row) {
  if (row.baseline_avg_consumption !== null && row.baseline_avg_consumption !== undefined) {
    return Number(row.baseline_avg_consumption);
  }
  if (row.last_known_consumption !== null && row.last_known_consumption !== undefined) {
    return Number(row.last_known_consumption);
  }
  return null;
}

function evaluateRowMetrics(row, draftValue, thresholdPct = 30) {
  const prevReading = getPreviousBaseline(row);
  const baselineAvg = resolveRowBaselineAvg(row);
  const anomaly = evaluateClientMeterAnomaly({
    prevReading,
    currentReading: draftValue,
    baselineAvg,
    thresholdPct,
  });

  const hasDraft = anomaly.hasInput;
  const currentNum = hasDraft && !anomaly.isInvalid ? Number(draftValue) : null;
  let isAbnormal = anomaly.isAbnormal;
  if (
    !isAbnormal &&
    Boolean(row.period_is_abnormal) &&
    String(draftValue) === String(row.period_current_reading ?? '')
  ) {
    isAbnormal = true;
  }

  const isDirty =
    hasDraft && String(Number(draftValue)) !== String(Number(row.period_current_reading ?? -1));
  const readingStatus = row.period_reading_status || (row.period_reading_id ? 'CONFIRMED' : null);

  return {
    prevReading,
    hasDraft,
    currentNum,
    isInvalid: anomaly.isInvalid,
    consumption: anomaly.consumption,
    baselineAvg: anomaly.baselineAvg,
    diffPct: anomaly.diffPct,
    isAbnormal,
    isDirty,
    readingStatus,
  };
}

function renderReadingStatusBadge(status, thresholdPct = 30) {
  if (status === 'CONFIRMED') {
    return (
      <Badge variant="emerald" dot>
        Đã chốt (CONFIRMED)
      </Badge>
    );
  }
  if (status === 'FLAGGED') {
    return (
      <Badge variant="red" dot>
        Tạm giữ &gt;{thresholdPct}% (FLAGGED)
      </Badge>
    );
  }
  if (status === 'DRAFT') {
    return (
      <Badge variant="sky" dot>
        Bản nháp (DRAFT)
      </Badge>
    );
  }
  return <span className="text-xs text-slate-400 whitespace-nowrap">Chưa ghi</span>;
}

export function MeterReadingsPage() {
  const toast = useToast();
  const { isManager } = usePermission();
  // PRD 6.2: Chỉ MANAGER mới được khởi tạo, ghi nhận và xác nhận chốt chỉ số đồng hồ (SYS_ADMIN / OWNER chỉ đọc)
  const canWriteMeters = isManager;
  const selectedBuildingId = useAuthStore((s) => s.selectedBuildingId);

  const [period, setPeriod] = useState(getCurrentPeriod());
  const [meterType, setMeterType] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [abnormalOnly, setAbnormalOnly] = useState(false);
  const [search, setSearch] = useState('');

  const [meters, setMeters] = useState([]);
  const [anomalyThresholdPct, setAnomalyThresholdPct] = useState(30);
  const [drafts, setDrafts] = useState({});
  const [notes, setNotes] = useState({});
  const [aiOcrByMeter, setAiOcrByMeter] = useState({});
  const [loading, setLoading] = useState(true);
  const [savingBatch, setSavingBatch] = useState(false);
  const [confirmingBatch, setConfirmingBatch] = useState(false);
  const [confirmingRowId, setConfirmingRowId] = useState(null);

  // Modal ghi chi tiết 1 đồng hồ + ảnh công tơ + lịch sử
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [selectedMeter, setSelectedMeter] = useState(null);
  const [selectedSlotContractId, setSelectedSlotContractId] = useState('');
  const [historyList, setHistoryList] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [singleForm, setSingleForm] = useState({
    current_reading: '',
    abnormal_note: '',
    image: '',
  });
  const [savingSingle, setSavingSingle] = useState(false);

  const activeModalMeter = useMemo(
    () => (selectedMeter ? resolveMeterSlotView(selectedMeter, selectedSlotContractId) : null),
    [selectedMeter, selectedSlotContractId]
  );
  const isModalSlotLocked = isMeterRowLockedForEdit(activeModalMeter, canWriteMeters);

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
        status: statusFilter || undefined,
        period,
        search: search.trim() || undefined,
      });
      const list = res.data || [];
      setMeters(list);
      setAnomalyThresholdPct(resolveAnomalyThresholdPct(res.anomaly_threshold_pct));

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
      setAiOcrByMeter({});
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải danh sách đồng hồ điện/nước.'));
    } finally {
      setLoading(false);
    }
  }, [selectedBuildingId, meterType, statusFilter, period, search, toast]);

  useEffect(() => {
    const t = setTimeout(() => {
      fetchMeters();
    }, 200);
    return () => clearTimeout(t);
  }, [fetchMeters]);

  const enrichedRows = useMemo(() => {
    let mapped = meters.map((m) => ({
      ...m,
      metrics: evaluateRowMetrics(m, drafts[m.id], anomalyThresholdPct),
    }));
    if (statusFilter) {
      mapped = mapped.filter((r) => r.metrics.readingStatus === statusFilter);
    }
    if (abnormalOnly) {
      mapped = mapped.filter((r) => r.metrics.isAbnormal || Boolean(r.period_is_abnormal));
    }
    return mapped;
  }, [meters, drafts, statusFilter, abnormalOnly, anomalyThresholdPct]);

  const dirtyValidRows = useMemo(() => {
    return meters.filter((m) => {
      const meta = evaluateRowMetrics(m, drafts[m.id], anomalyThresholdPct);
      return !m.period_reading_billed && meta.isDirty && !meta.isInvalid;
    });
  }, [meters, drafts, anomalyThresholdPct]);

  const unconfirmedRows = useMemo(() => {
    return meters.filter(
      (m) =>
        !m.period_reading_billed &&
        Boolean(m.period_reading_id) &&
        ['DRAFT', 'FLAGGED'].includes(m.period_reading_status || '')
    );
  }, [meters]);

  const hasInvalidDrafts = useMemo(() => {
    return meters.some(
      (m) => !m.period_reading_billed && evaluateRowMetrics(m, drafts[m.id], anomalyThresholdPct).isInvalid
    );
  }, [meters, drafts, anomalyThresholdPct]);

  const stats = useMemo(() => {
    const total = meters.length;
    const confirmed = meters.filter(
      (m) =>
        Boolean(m.period_reading_id) &&
        (m.period_reading_status || 'CONFIRMED') === 'CONFIRMED'
    ).length;
    const pendingConfirm = meters.filter(
      (m) =>
        Boolean(m.period_reading_id) &&
        ['DRAFT', 'FLAGGED'].includes(m.period_reading_status || '')
    ).length;
    const unrecorded = Math.max(0, total - confirmed - pendingConfirm);
    const abnormalCount = meters.filter(
      (m) =>
        evaluateRowMetrics(m, drafts[m.id], anomalyThresholdPct).isAbnormal ||
        Boolean(m.period_is_abnormal)
    ).length;
    return { total, confirmed, pendingConfirm, unrecorded, abnormalCount };
  }, [meters, drafts, anomalyThresholdPct]);

  const handleMeterOcrScan = async (meter, rawFileOrDataUri, { intoSingleModal = false } = {}) => {
    if (!canWriteMeters || !meter || !rawFileOrDataUri) return;
    setAiOcrByMeter((prev) => ({
      ...prev,
      [meter.id]: {
        ...(prev[meter.id] || {}),
        loading: true,
        errorBanner: null,
      },
    }));
    try {
      const imageBase64 = await compressImageFileToDataUri(rawFileOrDataUri);
      if (intoSingleModal) {
        setSingleForm((prev) => ({ ...prev, image: imageBase64 }));
      }
      const res = await aiService.ocrMeterReading({
        meter_id: meter.id,
        period,
        image_base64: imageBase64,
      });
      const data = res?.data || res;
      const out = data?.output || {};
      const hasValidReading = out.reading !== null && out.reading !== undefined && Number.isFinite(Number(out.reading));

      if (!hasValidReading) {
        // AC-014.1: Ảnh mờ/lóa -> giữ nguyên ô nhập trống, yêu cầu nhập tay
        setAiOcrByMeter((prev) => ({
          ...prev,
          [meter.id]: {
            suggestionId: data?.suggestion_id || null,
            reading: null,
            confidence: data?.confidence ?? null,
            warnings: Array.isArray(data?.warnings) ? data.warnings : [],
            reason:
              out.reason ||
              'Ảnh chụp công tơ bị mờ/lóa hoặc độ tin cậy thấp — AI không tự điền số, vui lòng nhập tay.',
            needsHumanReview: true,
            confirmed: false,
            edited: false,
            imageBase64,
            loading: false,
            errorBanner: null,
          },
        }));
        toast.warning(
          out.reason ||
            `Công tơ ${meter.meter_code}: AI không chắc chắn do ảnh mờ/lóa — vui lòng nhập chỉ số thủ công.`
        );
        return;
      }

      const valStr = String(Number(out.reading));
      setDrafts((prev) => ({ ...prev, [meter.id]: valStr }));
      if (intoSingleModal) {
        setSingleForm((prev) => ({ ...prev, current_reading: valStr, image: imageBase64 }));
      }
      setAiOcrByMeter((prev) => ({
        ...prev,
        [meter.id]: {
          suggestionId: data?.suggestion_id || null,
          reading: Number(out.reading),
          confidence: data?.confidence ?? null,
          warnings: Array.isArray(data?.warnings) ? data.warnings : [],
          reason: out.reason || '',
          needsHumanReview: Boolean(data?.needs_human_review),
          confirmed: false,
          edited: false,
          imageBase64,
          loading: false,
          errorBanner: null,
        },
      }));
      toast.success(
        `AI đề xuất chỉ số ${valStr} ${meter.unit} cho công tơ ${meter.meter_code} — vui lòng kiểm tra và lưu.`
      );
    } catch (err) {
      const mappedErr = mapAiErrorToVietnamese(err);
      setAiOcrByMeter((prev) => ({
        ...prev,
        [meter.id]: {
          ...(prev[meter.id] || {}),
          loading: false,
          errorBanner: `${mappedErr.title}: ${mappedErr.guidance}`,
        },
      }));
    }
  };

  const handleSaveBatch = async (targetStatus = 'CONFIRMED') => {
    if (!canWriteMeters) return;
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
        status: targetStatus,
        readings: dirtyValidRows.map((m) => ({
          meter_id: m.id,
          period,
          ...(m.target_contract_id ? { contract_id: m.target_contract_id } : {}),
          status: targetStatus,
          current_reading: Number(drafts[m.id]),
          abnormal_note: notes[m.id]?.trim() || undefined,
          ...(aiOcrByMeter[m.id]?.suggestionId
            ? { ai_suggestion_id: aiOcrByMeter[m.id].suggestionId }
            : {}),
          ...(aiOcrByMeter[m.id]?.imageBase64
            ? { image_base64: aiOcrByMeter[m.id].imageBase64 }
            : {}),
        })),
      };
      const res = await metersService.recordBatch(payload);
      if (res.abnormal_count > 0) {
        toast.warning(
          res.message ||
            `Đã lưu với ${res.abnormal_count} cảnh báo bất thường (>${anomalyThresholdPct}%).`
        );
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

  const handleConfirmBatch = async () => {
    if (!canWriteMeters || unconfirmedRows.length === 0) return;
    setConfirmingBatch(true);
    try {
      const res = await metersService.confirmBatch({
        period,
        building_id: selectedBuildingId || undefined,
        reading_ids: unconfirmedRows.map((r) => r.period_reading_id),
      });
      const feedback = resolveBatchConfirmFeedback(res);
      if (feedback.level === 'warning') {
        toast.warning(feedback.message);
      } else {
        toast.success(feedback.message);
      }
      fetchMeters();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể xác nhận chốt chỉ số hàng loạt.'));
    } finally {
      setConfirmingBatch(false);
    }
  };

  const handleConfirmSingleRow = async (row) => {
    if (!canWriteMeters || !row.period_reading_id) return;
    const noteText = (notes[row.id] ?? row.period_abnormal_note ?? '').trim();
    if ((row.period_is_abnormal || row.metrics?.isAbnormal) && !noteText) {
      toast.warning(
        `Công tơ ${row.meter_code} có biến động >${anomalyThresholdPct}%. Vui lòng nhập ghi chú giải trình trước khi xác nhận chốt.`
      );
      return;
    }
    setConfirmingRowId(row.period_reading_id);
    try {
      const res = await metersService.confirmReading(row.period_reading_id, {
        abnormal_note: noteText || undefined,
      });
      toast.success(res.message || `Đã xác nhận chốt chỉ số công tơ ${row.meter_code}.`);
      fetchMeters();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể xác nhận chốt chỉ số.'));
    } finally {
      setConfirmingRowId(null);
    }
  };

  const handleSlotContractChange = (nextContractId) => {
    setSelectedSlotContractId(nextContractId);
    if (!selectedMeter) return;
    const slotView = resolveMeterSlotView(selectedMeter, nextContractId);
    const isDefaultTarget = String(nextContractId || '') === String(selectedMeter.target_contract_id || '');
    setSingleForm({
      current_reading:
        isDefaultTarget && drafts[selectedMeter.id] !== undefined && drafts[selectedMeter.id] !== ''
          ? drafts[selectedMeter.id]
          : slotView.period_current_reading !== null && slotView.period_current_reading !== undefined
          ? String(Number(slotView.period_current_reading))
          : '',
      abnormal_note:
        (isDefaultTarget ? notes[selectedMeter.id] : '') || slotView.period_abnormal_note || '',
      image: slotView.period_image_url || '',
    });
  };

  const openSingleModal = async (meter) => {
    const initContractId = meter.target_contract_id || '';
    const slotView = resolveMeterSlotView(meter, initContractId);
    setSelectedMeter(meter);
    setSelectedSlotContractId(initContractId);
    setSingleForm({
      current_reading:
        drafts[meter.id] !== undefined && drafts[meter.id] !== ''
          ? drafts[meter.id]
          : slotView.period_current_reading !== null && slotView.period_current_reading !== undefined
          ? String(Number(slotView.period_current_reading))
          : '',
      abnormal_note: notes[meter.id] || slotView.period_abnormal_note || '',
      image: slotView.period_image_url || '',
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

  const handleSaveSingle = async (e, targetStatus = 'CONFIRMED') => {
    e?.preventDefault();
    const targetMeter = activeModalMeter || selectedMeter;
    if (!canWriteMeters || !targetMeter || isModalSlotLocked) return;
    const prev = getPreviousBaseline(targetMeter);
    const val = Number(singleForm.current_reading);

    if (singleForm.current_reading === '' || Number.isNaN(val) || val < prev) {
      toast.warning(`Chỉ số mới phải lớn hơn hoặc bằng chỉ số cũ (${prev}).`);
      return;
    }

    const preview = evaluateClientMeterAnomaly({
      prevReading: prev,
      currentReading: val,
      baselineAvg: resolveRowBaselineAvg(targetMeter),
      thresholdPct: anomalyThresholdPct,
    });
    if (targetStatus === 'CONFIRMED' && preview.isAbnormal && !singleForm.abnormal_note.trim()) {
      toast.warning(
        `Sản lượng biến động >${anomalyThresholdPct}% so với trung bình 3 kỳ trước. Vui lòng nhập ghi chú giải trình để chốt.`
      );
      return;
    }

    setSavingSingle(true);
    try {
      const payload = {
        period,
        contract_id: selectedSlotContractId || undefined,
        status: targetStatus,
        current_reading: val,
        abnormal_note: singleForm.abnormal_note.trim() || undefined,
        ...(aiOcrByMeter[selectedMeter.id]?.suggestionId
          ? { ai_suggestion_id: aiOcrByMeter[selectedMeter.id].suggestionId }
          : {}),
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

  const handleConfirmFromModal = async () => {
    const targetMeter = activeModalMeter || selectedMeter;
    if (!canWriteMeters || !targetMeter?.period_reading_id || isModalSlotLocked) return;
    if (targetMeter.period_is_abnormal && !singleForm.abnormal_note.trim()) {
      toast.warning('Vui lòng nhập ghi chú giải trình bất thường trước khi xác nhận chốt.');
      return;
    }
    setSavingSingle(true);
    try {
      const res = await metersService.confirmReading(targetMeter.period_reading_id, {
        abnormal_note: singleForm.abnormal_note.trim() || undefined,
      });
      toast.success(res.message || 'Đã xác nhận chốt chỉ số đồng hồ.');
      setDetailModalOpen(false);
      fetchMeters();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể xác nhận chốt chỉ số.'));
    } finally {
      setSavingSingle(false);
    }
  };

  const openCreateModal = async () => {
    if (!canWriteMeters) return;
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
    if (!canWriteMeters) return;
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
        title="Ghi & Xác nhận Chỉ số Điện / Nước"
        subtitle={`Ghi nháp, đối soát biến động >${anomalyThresholdPct}% trên trung bình 3 kỳ gần nhất và xác nhận chốt chỉ số trước khi sinh hóa đơn.`}
        actions={
          <>
            <Button variant="outline" icon={RefreshCw} onClick={fetchMeters}>
              Làm mới
            </Button>
            {canWriteMeters ? (
              <>
                <Button variant="outline" icon={Plus} onClick={openCreateModal}>
                  Khởi tạo đồng hồ
                </Button>
                {unconfirmedRows.length > 0 ? (
                  <Button
                    variant="soft"
                    icon={CheckCircle2}
                    loading={confirmingBatch}
                    onClick={handleConfirmBatch}
                  >
                    Xác nhận chốt ({unconfirmedRows.length})
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  icon={Save}
                  loading={savingBatch}
                  disabled={dirtyValidRows.length === 0 && !hasInvalidDrafts}
                  onClick={() => handleSaveBatch('DRAFT')}
                >
                  Lưu nháp {dirtyValidRows.length > 0 ? `(${dirtyValidRows.length})` : ''}
                </Button>
                <Button
                  variant="primary"
                  icon={CheckCircle2}
                  loading={savingBatch}
                  disabled={dirtyValidRows.length === 0 && !hasInvalidDrafts}
                  onClick={() => handleSaveBatch('CONFIRMED')}
                >
                  Lưu &amp; Chốt chỉ số {dirtyValidRows.length > 0 ? `(${dirtyValidRows.length})` : ''}
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
          title="Đã chốt (CONFIRMED)"
          value={`${stats.confirmed} / ${stats.total}`}
          subtext={`Nháp / Tạm giữ: ${stats.pendingConfirm} đồng hồ`}
          icon={CheckCircle2}
          color="emerald"
        />
        <StatsCard
          title="Chưa ghi chỉ số"
          value={stats.unrecorded}
          subtext="Cần chốt CONFIRMED trước khi sinh hóa đơn"
          icon={Zap}
          color="indigo"
        />
        <StatsCard
          title={`Cảnh báo bất thường (>${anomalyThresholdPct}%)`}
          value={stats.abnormalCount}
          subtext="So với TB tối đa 3 kỳ CONFIRMED gần nhất"
          icon={AlertTriangle}
          color={stats.abnormalCount > 0 ? 'rose' : 'amber'}
          onClick={() => setAbnormalOnly((v) => !v)}
        />
      </div>

      {/* Bộ lọc */}
      <Card className="p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 items-center">
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

          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            options={[
              { value: '', label: 'Tất cả trạng thái chốt' },
              { value: 'CONFIRMED', label: 'Đã chốt (CONFIRMED)' },
              { value: 'DRAFT', label: 'Bản nháp (DRAFT)' },
              { value: 'FLAGGED', label: `Tạm giữ >${anomalyThresholdPct}% (FLAGGED)` },
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
            <span>Chỉ hiện bất thường (&gt;{anomalyThresholdPct}%)</span>
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
                ? `Không có đồng hồ nào có biến động sản lượng bất thường (>${anomalyThresholdPct}%) trong kỳ này.`
                : 'Hãy khởi tạo đồng hồ điện/nước cho căn hộ để bắt đầu ghi nhận chỉ số hàng kỳ.'
            }
            action={
              canWriteMeters && !abnormalOnly ? (
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
                <TH>Loại &amp; Đơn giá</TH>
                <TH className="text-right">Chỉ số cũ &amp; TB 3 kỳ</TH>
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
                  : metrics.isAbnormal || metrics.readingStatus === 'FLAGGED'
                  ? 'bg-amber-50/70'
                  : metrics.isDirty
                  ? 'bg-sky-50/40'
                  : '';

                const estMoney = computeMeterEstimatedAmount(metrics.consumption, row);
                const appliedPrice = row.effective_unit_price ?? row.unit_price;
                const rowLocked = isMeterRowLockedForEdit(row, canWriteMeters);
                const turnoverBadge = resolveMeterTurnoverBadgeMeta(row);

                const canQuickConfirm =
                  !rowLocked &&
                  Boolean(row.period_reading_id) &&
                  ['DRAFT', 'FLAGGED'].includes(metrics.readingStatus || '') &&
                  !metrics.isDirty;

                return (
                  <tr key={row.id} className={`transition-colors ${rowHighlight}`}>
                    <TD>
                      <p className="font-semibold text-slate-900 whitespace-nowrap">
                        Căn {row.apartment_code}{' '}
                        <span className="text-xs font-normal text-slate-500">
                          ({row.building_code})
                        </span>
                      </p>
                      <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
                        <span className="font-mono text-[11px] text-slate-500 whitespace-nowrap">
                          {row.meter_code}
                        </span>
                        {turnoverBadge.isMultiSlot ? (
                          <Badge variant="indigo">{turnoverBadge.slotLabel}</Badge>
                        ) : null}
                      </div>
                      {turnoverBadge.contractCode ? (
                        <p className="text-[11px] text-slate-500 mt-0.5 whitespace-nowrap">
                          <span className="font-mono font-semibold text-slate-700">
                            {turnoverBadge.contractCode}
                          </span>
                          {turnoverBadge.tenantName ? ` • ${turnoverBadge.tenantName}` : ''}
                        </p>
                      ) : null}
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
                        {formatMoney(appliedPrice)} / {row.unit}
                        {row.effective_price_source === 'CONTRACT_OVERRIDE' ? (
                          <span className="ml-1 text-[10px] font-semibold text-indigo-700 bg-indigo-50 px-1 py-0.5 rounded">
                            Giá HĐ
                          </span>
                        ) : row.effective_price_source === 'BUILDING_CATALOG' ? (
                          <span className="ml-1 text-[10px] font-semibold text-emerald-700 bg-emerald-50 px-1 py-0.5 rounded">
                            Giá tòa
                          </span>
                        ) : null}
                      </p>
                    </TD>

                    <TD className="text-right font-mono tabular-nums font-medium text-slate-700 whitespace-nowrap">
                      <div>{metrics.prevReading}</div>
                      {metrics.baselineAvg !== null ? (
                        <div className="text-[11px] text-slate-400">
                          TB 3 kỳ: {metrics.baselineAvg} {row.unit}
                        </div>
                      ) : null}
                    </TD>

                    <TD className="text-center">
                      <AISuggestionField
                        active={Boolean(
                          canWriteMeters &&
                            aiOcrByMeter[row.id] &&
                            aiOcrByMeter[row.id].reading !== null &&
                            aiOcrByMeter[row.id].reading !== undefined
                        )}
                        confirmed={Boolean(aiOcrByMeter[row.id]?.confirmed)}
                        edited={Boolean(aiOcrByMeter[row.id]?.edited)}
                        confidence={aiOcrByMeter[row.id]?.confidence}
                        threshold={0.85}
                        warningText={
                          aiOcrByMeter[row.id]?.warnings?.length
                            ? aiOcrByMeter[row.id].reason ||
                              `Cảnh báo hậu kiểm AI: ${aiOcrByMeter[row.id].warnings.join(', ')}`
                            : ''
                        }
                        onConfirm={() =>
                          setAiOcrByMeter((prev) => ({
                            ...prev,
                            [row.id]: {
                              ...prev[row.id],
                              confirmed: true,
                              edited:
                                Number(drafts[row.id]) !== Number(prev[row.id]?.reading),
                            },
                          }))
                        }
                        onDismiss={() =>
                          setAiOcrByMeter((prev) => {
                            const next = { ...prev };
                            delete next[row.id];
                            return next;
                          })
                        }
                        className="inline-block text-left max-w-[240px]"
                      >
                        <input
                          type="number"
                          step="0.01"
                          min={metrics.prevReading}
                          disabled={rowLocked}
                          value={drafts[row.id] ?? ''}
                          onChange={(e) => {
                            const val = e.target.value;
                            setDrafts((prev) => ({ ...prev, [row.id]: val }));
                            setAiOcrByMeter((prev) =>
                              prev[row.id]?.reading !== null && prev[row.id]?.reading !== undefined
                                ? {
                                    ...prev,
                                    [row.id]: {
                                      ...prev[row.id],
                                      confirmed: true,
                                      edited: Number(val) !== Number(prev[row.id].reading),
                                    },
                                  }
                                : prev
                            );
                          }}
                          placeholder={`>= ${metrics.prevReading}`}
                          className={`w-36 h-9 px-3 rounded-lg border font-mono tabular-nums text-sm font-semibold text-center focus:outline-none focus:ring-2 ${
                            metrics.isInvalid
                              ? 'border-rose-400 bg-rose-50 text-rose-800 focus:ring-rose-500/20'
                              : metrics.isAbnormal
                              ? 'border-amber-400 bg-white text-amber-900 focus:ring-amber-500/20'
                              : 'border-slate-200 bg-white text-slate-900 focus:border-primary-500 focus:ring-primary-500/20'
                          } disabled:bg-slate-50 disabled:text-slate-500`}
                        />
                      </AISuggestionField>
                      {metrics.isInvalid ? (
                        <p className="text-[11px] text-rose-600 font-medium mt-1 whitespace-nowrap">
                          Nhỏ hơn chỉ số cũ ({metrics.prevReading})
                        </p>
                      ) : null}
                      {aiOcrByMeter[row.id]?.reading === null && aiOcrByMeter[row.id]?.reason ? (
                        <p className="text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded-md px-2 py-1 mt-1 max-w-[230px] mx-auto leading-snug">
                          {aiOcrByMeter[row.id].reason}
                        </p>
                      ) : null}
                      {aiOcrByMeter[row.id]?.errorBanner ? (
                        <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2 py-1 mt-1 max-w-[230px] mx-auto leading-snug">
                          {aiOcrByMeter[row.id].errorBanner}
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
                                Math.abs(metrics.diffPct) > anomalyThresholdPct
                                  ? 'text-rose-600'
                                  : 'text-slate-400'
                              }`}
                            >
                              {metrics.diffPct > 0 ? `+${metrics.diffPct}%` : `${metrics.diffPct}%`}{' '}
                              vs TB 3 kỳ
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
                      <div className="space-y-1 max-w-[220px] mx-auto">
                        <div>
                          {renderReadingStatusBadge(metrics.readingStatus, anomalyThresholdPct)}
                        </div>
                        {row.period_reading_billed ? (
                          <div>
                            <Badge variant="slate">
                              <Lock className="w-3 h-3" /> Đã lập HĐ
                            </Badge>
                          </div>
                        ) : null}
                        {metrics.isAbnormal ? (
                          <div>
                            <Badge
                              variant={
                                metrics.diffPct !== null &&
                                Math.abs(metrics.diffPct) >= anomalyThresholdPct * 2
                                  ? 'red'
                                  : 'amber'
                              }
                            >
                              <AlertTriangle className="w-3 h-3" /> Biến động &gt;
                              {anomalyThresholdPct}%
                            </Badge>
                          </div>
                        ) : null}
                        {metrics.isAbnormal || metrics.readingStatus === 'FLAGGED' ? (
                          !rowLocked ? (
                            <input
                              type="text"
                              value={notes[row.id] ?? ''}
                              onChange={(e) =>
                                setNotes((prev) => ({ ...prev, [row.id]: e.target.value }))
                              }
                              placeholder="Ghi chú giải trình bất thường..."
                              className="w-full h-7 px-2 text-xs rounded border border-amber-300 bg-white text-slate-700 focus:outline-none focus:border-amber-500"
                            />
                          ) : row.period_abnormal_note ? (
                            <p className="text-xs text-amber-800">{row.period_abnormal_note}</p>
                          ) : null
                        ) : null}
                      </div>
                    </TD>

                    <TD className="w-px whitespace-nowrap text-center">
                      <div className="inline-flex items-center gap-1.5">
                        {!rowLocked ? (
                          <label
                            className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors cursor-pointer ${
                              aiOcrByMeter[row.id]?.loading
                                ? 'bg-indigo-50 text-indigo-400 border-indigo-200 pointer-events-none'
                                : 'bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border-indigo-200'
                            }`}
                            title="Chụp hoặc chọn ảnh mặt đồng hồ để AI đọc chỉ số nháp (AI-02)"
                          >
                            {aiOcrByMeter[row.id]?.loading ? (
                              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Sparkles className="w-3.5 h-3.5" />
                            )}
                            <span>{aiOcrByMeter[row.id]?.loading ? 'Đang đọc...' : 'Ảnh AI'}</span>
                            <input
                              type="file"
                              accept="image/jpeg,image/png,image/webp"
                              capture="environment"
                              className="hidden"
                              disabled={Boolean(aiOcrByMeter[row.id]?.loading)}
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                e.target.value = '';
                                if (f) handleMeterOcrScan(row, f);
                              }}
                            />
                          </label>
                        ) : null}
                        {canQuickConfirm ? (
                          <Button
                            size="xs"
                            variant="soft"
                            icon={CheckCircle2}
                            loading={confirmingRowId === row.period_reading_id}
                            onClick={() => handleConfirmSingleRow(row)}
                          >
                            Xác nhận chốt
                          </Button>
                        ) : null}
                        <Button
                          size="xs"
                          variant={row.period_image_url ? 'soft' : 'outline'}
                          icon={Camera}
                          onClick={() => openSingleModal(row)}
                        >
                          {row.period_image_url ? 'Có ảnh' : 'Chi tiết'}
                        </Button>
                      </div>
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
          activeModalMeter
            ? `Kỳ chốt: ${period} • Chỉ số đầu kỳ: ${getPreviousBaseline(activeModalMeter)} ${activeModalMeter.unit}`
            : ''
        }
        size="lg"
        footer={
          canWriteMeters ? (
            <>
              <Button
                variant="outline"
                onClick={() => setDetailModalOpen(false)}
                disabled={savingSingle}
              >
                Đóng
              </Button>
              {activeModalMeter?.period_reading_id &&
              !isModalSlotLocked &&
              ['DRAFT', 'FLAGGED'].includes(activeModalMeter.period_reading_status || '') ? (
                <Button
                  variant="soft"
                  icon={CheckCircle2}
                  onClick={handleConfirmFromModal}
                  loading={savingSingle}
                >
                  Xác nhận chốt
                </Button>
              ) : null}
              <Button
                variant="outline"
                icon={Save}
                onClick={(e) => handleSaveSingle(e, 'DRAFT')}
                loading={savingSingle}
                disabled={isModalSlotLocked}
              >
                Lưu nháp
              </Button>
              <Button
                variant="primary"
                icon={CheckCircle2}
                onClick={(e) => handleSaveSingle(e, 'CONFIRMED')}
                loading={savingSingle}
                disabled={isModalSlotLocked}
              >
                Lưu &amp; Chốt chỉ số
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => setDetailModalOpen(false)}>
              Đóng
            </Button>
          )
        }
      >
        {selectedMeter && activeModalMeter ? (
          <div className="space-y-6">
            {Array.isArray(selectedMeter.overlapping_contracts) &&
            selectedMeter.overlapping_contracts.length > 1 ? (
              <Select
                label="Đợt hợp đồng trong kỳ"
                value={selectedSlotContractId}
                onChange={(e) => handleSlotContractChange(e.target.value)}
                options={selectedMeter.overlapping_contracts.map((slot) => ({
                  value: slot.contract_id,
                  label: `Đợt ${slot.slot_index}/${slot.total_slots} • ${slot.contract_code || slot.contract_id}${
                    slot.tenant_name ? ` (${slot.tenant_name})` : ''
                  } • ${slot.overlap_start} → ${slot.overlap_end}${
                    slot.is_billed ? ' [Đã lập HĐ]' : slot.reading_id ? ` [${slot.reading_status}]` : ' [Chưa ghi]'
                  }`,
                }))}
              />
            ) : null}

            {activeModalMeter.period_reading_billed ? (
              <div className="p-3 rounded-lg bg-slate-100 border border-slate-200 text-xs text-slate-700 flex items-center gap-2">
                <Lock className="w-4 h-4 text-slate-600 shrink-0" />
                <span>
                  Chỉ số của đợt hợp đồng này đã được lập hóa đơn phát hành (Đã lập HĐ), không thể chỉnh sửa hoặc ghi đè.
                </span>
              </div>
            ) : null}

            {canWriteMeters ? (
              <form onSubmit={(e) => handleSaveSingle(e, 'CONFIRMED')} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Input
                    label={`Chỉ số cũ (${activeModalMeter.unit})`}
                    disabled
                    value={getPreviousBaseline(activeModalMeter)}
                  />
                  <AISuggestionField
                    active={Boolean(
                      !isModalSlotLocked &&
                        aiOcrByMeter[selectedMeter.id] &&
                        aiOcrByMeter[selectedMeter.id].reading !== null &&
                        aiOcrByMeter[selectedMeter.id].reading !== undefined
                    )}
                    confirmed={Boolean(aiOcrByMeter[selectedMeter.id]?.confirmed)}
                    edited={Boolean(aiOcrByMeter[selectedMeter.id]?.edited)}
                    confidence={aiOcrByMeter[selectedMeter.id]?.confidence}
                    threshold={0.85}
                    warningText={aiOcrByMeter[selectedMeter.id]?.reason || ''}
                    onConfirm={() =>
                      setAiOcrByMeter((prev) => ({
                        ...prev,
                        [selectedMeter.id]: {
                          ...prev[selectedMeter.id],
                          confirmed: true,
                          edited:
                            Number(singleForm.current_reading) !==
                            Number(prev[selectedMeter.id]?.reading),
                        },
                      }))
                    }
                    onDismiss={() =>
                      setAiOcrByMeter((prev) => {
                        const next = { ...prev };
                        delete next[selectedMeter.id];
                        return next;
                      })
                    }
                  >
                    <Input
                      label={`Chỉ số mới kỳ ${period} (${activeModalMeter.unit})`}
                      type="number"
                      step="0.01"
                      required
                      disabled={isModalSlotLocked}
                      value={singleForm.current_reading}
                      onChange={(e) => {
                        const val = e.target.value;
                        setSingleForm((s) => ({ ...s, current_reading: val }));
                        setAiOcrByMeter((prev) =>
                          prev[selectedMeter.id]?.reading !== null &&
                          prev[selectedMeter.id]?.reading !== undefined
                            ? {
                                ...prev,
                                [selectedMeter.id]: {
                                  ...prev[selectedMeter.id],
                                  confirmed: true,
                                  edited:
                                    Number(val) !== Number(prev[selectedMeter.id].reading),
                                },
                              }
                            : prev
                        );
                      }}
                    />
                  </AISuggestionField>
                </div>

                {aiOcrByMeter[selectedMeter.id]?.reading === null &&
                aiOcrByMeter[selectedMeter.id]?.reason ? (
                  <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                    <span>{aiOcrByMeter[selectedMeter.id].reason}</span>
                  </div>
                ) : null}

                {aiOcrByMeter[selectedMeter.id]?.errorBanner ? (
                  <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
                    {aiOcrByMeter[selectedMeter.id].errorBanner}
                  </div>
                ) : null}

                <Input
                  label="Ghi chú kiểm tra / Giải trình bất thường"
                  placeholder="VD: Cư dân lắp thêm máy sấy, rò rỉ van bồn cầu đã xử lý..."
                  disabled={isModalSlotLocked}
                  value={singleForm.abnormal_note}
                  onChange={(e) =>
                    setSingleForm((s) => ({ ...s, abnormal_note: e.target.value }))
                  }
                />

                <div className="space-y-2">
                  <FileUpload
                    label="Ảnh chụp mặt đồng hồ đối chứng"
                    multiple={false}
                    disabled={isModalSlotLocked}
                    value={singleForm.image}
                    onChange={(img) => setSingleForm((s) => ({ ...s, image: img }))}
                  />
                  {!isModalSlotLocked &&
                  singleForm.image &&
                  singleForm.image.startsWith('data:image/') ? (
                    <Button
                      type="button"
                      variant="soft"
                      size="sm"
                      icon={Sparkles}
                      loading={Boolean(aiOcrByMeter[selectedMeter.id]?.loading)}
                      onClick={() =>
                        handleMeterOcrScan(activeModalMeter, singleForm.image, {
                          intoSingleModal: true,
                        })
                      }
                    >
                      Đọc chỉ số từ ảnh bằng AI (AI-02)
                    </Button>
                  ) : null}
                </div>
              </form>
            ) : activeModalMeter.period_image_url ? (
              <div className="space-y-2">
                <p className="text-xs font-medium text-slate-600">Ảnh chụp công tơ kỳ {period}</p>
                <div className="w-48 h-48 rounded-xl border border-slate-200 overflow-hidden">
                  <AuthImage
                    src={activeModalMeter.period_image_url}
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
                <div className="border border-slate-200 rounded-xl overflow-hidden max-h-80 overflow-y-auto">
                  <Table>
                    <THead>
                      <tr>
                        <TH className="text-center">Kỳ</TH>
                        <TH className="text-right">Chỉ số cũ</TH>
                        <TH className="text-right">Chỉ số mới</TH>
                        <TH className="text-right">Tiêu thụ &amp; Ghi chú</TH>
                        <TH className="text-center">Trạng thái</TH>
                        <TH className="text-center">Ảnh</TH>
                        <TH className="text-center">Người ghi / Thời gian</TH>
                      </tr>
                    </THead>
                    <TBody>
                      {historyList.map((h) => (
                        <tr key={h.id}>
                          <TD className="text-center font-mono font-semibold whitespace-nowrap">
                            <div>{h.period}</div>
                            {h.contract_code ? (
                              <div className="text-[11px] font-normal text-indigo-600">
                                {h.contract_code}
                              </div>
                            ) : null}
                          </TD>
                          <TD className="text-right font-mono tabular-nums whitespace-nowrap">
                            {Number(h.previous_reading)}
                          </TD>
                          <TD className="text-right font-mono tabular-nums font-semibold whitespace-nowrap">
                            {Number(h.current_reading)}
                          </TD>
                          <TD className="text-right">
                            <div className="whitespace-nowrap">
                              <span className="font-mono tabular-nums font-semibold">
                                {Number(h.consumption)} {selectedMeter.unit}
                              </span>
                              {h.is_abnormal ? (
                                <Badge variant="amber" className="ml-1.5">
                                  Bất thường
                                </Badge>
                              ) : null}
                            </div>
                            {h.abnormal_note ? (
                              <p className="text-[11px] text-amber-800 whitespace-pre-line break-words mt-0.5 max-w-[220px] ml-auto">
                                {h.abnormal_note}
                              </p>
                            ) : null}
                          </TD>
                          <TD className="text-center">
                            {renderReadingStatusBadge(h.status || 'CONFIRMED', anomalyThresholdPct)}
                          </TD>
                          <TD className="text-center">
                            {h.image_url ? (
                              <div className="w-10 h-10 mx-auto rounded-lg border border-slate-200 overflow-hidden bg-slate-100">
                                <AuthImage
                                  src={h.image_url}
                                  alt={`Kỳ ${h.period}`}
                                  className="w-full h-full object-cover"
                                />
                              </div>
                            ) : (
                              <span className="text-xs text-slate-400">—</span>
                            )}
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
              label: `${a.building_code ? `${a.building_code} - ` : ''}Căn ${a.code} (${
                APARTMENT_STATUS[a.status]?.label || a.status
              })`,
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
            <MoneyInput
              label={`Đơn giá (₫ / ${createForm.meter_type === 'ELECTRICITY' ? 'kWh' : 'm³'})`}
              required
              placeholder="VD: 3.800"
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
