import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Sparkles,
  UploadCloud,
  RefreshCw,
  Trash2,
  CheckCircle2,
  Save,
  AlertTriangle,
  Lock,
  Zap,
  Droplets,
  ZoomIn,
  Info,
} from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Badge } from '../ui/Badge';
import { Table, THead, TBody, TH, TD } from '../ui/Table';
import { buildingsService } from '../../services/buildings.service';
import { metersService } from '../../services/meters.service';
import { aiService } from '../../services/ai.service';
import { useToast } from '../../hooks/useToast';
import { formatMoney } from '../../utils/format';
import {
  compressImageFileToDataUri,
  mapAiErrorToVietnamese,
  formatConfidenceBadge,
} from '../../utils/aiHelpers';
import { extractErrorMessage } from '../../utils/validation';
import {
  MAX_BATCH_METER_PHOTOS,
  DEFAULT_OCR_CONCURRENCY,
  matchMeterFromFilename,
  resolveMeterAfterOcr,
  rematchBatchPhotoItemsForBuilding,
  runBoundedConcurrencyQueue,
  evaluateBatchPhotoImportItems,
  buildBatchPhotoSavePayload,
} from '../../utils/meterBatchPhotoHelpers';

const ACCEPTED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function makeLocalRowId() {
  return `bmo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function renderValidationBadge(row, anomalyThresholdPct = 30) {
  switch (row.validationState) {
    case 'OCR_PROCESSING':
      return (
        <Badge variant="indigo" dot>
          Đang đọc AI...
        </Badge>
      );
    case 'MISSING_METER':
      return (
        <Badge variant="amber" dot>
          Chọn công tơ
        </Badge>
      );
    case 'LOCKED_BILLED':
      return (
        <Badge variant="slate">
          <span className="inline-flex items-center gap-1">
            <Lock className="h-3 w-3" /> Đã lập HĐ
          </span>
        </Badge>
      );
    case 'DUPLICATE_METER_TARGET':
      return (
        <Badge variant="red" dot>
          Trùng công tơ
        </Badge>
      );
    case 'MISSING_READING':
      return (
        <Badge variant="amber" dot>
          Chưa có số mới
        </Badge>
      );
    case 'INVALID_READING':
      return (
        <Badge variant="red" dot>
          Nhỏ hơn số cũ
        </Badge>
      );
    case 'READY_ABNORMAL':
      return (
        <Badge variant="amber" dot>
          Biến động &gt;{anomalyThresholdPct}%
        </Badge>
      );
    case 'READY':
      return (
        <Badge variant="emerald" dot>
          Sẵn sàng lưu
        </Badge>
      );
    default:
      return null;
  }
}

export function MeterBatchPhotoImportModal({
  open,
  onClose,
  initialBuildingId = '',
  period,
  anomalyThresholdPct = 30,
  canWriteMeters = false,
  onSaved,
}) {
  const toast = useToast();
  const fileInputRef = useRef(null);
  const sessionGenRef = useRef(0);
  const buildingMetersRef = useRef([]);

  const [buildings, setBuildings] = useState([]);
  const [buildingsLoading, setBuildingsLoading] = useState(false);
  const [targetBuildingId, setTargetBuildingId] = useState(initialBuildingId || '');

  const [buildingMeters, setBuildingMeters] = useState([]);
  const [metersLoading, setMetersLoading] = useState(false);

  const [items, setItems] = useState([]);
  const [isDragging, setIsDragging] = useState(false);
  const [queueProgress, setQueueProgress] = useState({ total: 0, completed: 0, running: false });
  const [savingStatus, setSavingStatus] = useState('');
  const [previewItem, setPreviewItem] = useState(null);

  useEffect(() => {
    buildingMetersRef.current = buildingMeters;
  }, [buildingMeters]);

  const loadBuildingMeters = useCallback(
    async (bldgId) => {
      if (!bldgId) {
        setBuildingMeters([]);
        return [];
      }
      setMetersLoading(true);
      try {
        const res = await metersService.list({
          building_id: bldgId,
          period,
        });
        const list = Array.isArray(res?.data) ? res.data : [];
        setBuildingMeters(list);
        return list;
      } catch (err) {
        toast.error(extractErrorMessage(err, 'Không thể tải danh sách công tơ của tòa nhà.'));
        setBuildingMeters([]);
        return [];
      } finally {
        setMetersLoading(false);
      }
    },
    [period, toast]
  );

  // Khi mở modal: đồng bộ tòa nhà mục tiêu & tải danh sách tòa nhà
  useEffect(() => {
    if (!open) {
      sessionGenRef.current += 1;
      return;
    }
    let cancelled = false;
    setBuildingsLoading(true);
    buildingsService
      .list()
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res?.data) ? res.data : [];
        setBuildings(list);
        const preferred =
          initialBuildingId && list.some((b) => String(b.id) === String(initialBuildingId))
            ? initialBuildingId
            : list.length === 1
              ? list[0].id
              : '';
        setTargetBuildingId((prev) => {
          if (initialBuildingId && list.some((b) => String(b.id) === String(initialBuildingId))) {
            return initialBuildingId;
          }
          if (prev && list.some((b) => String(b.id) === String(prev))) {
            return prev;
          }
          return preferred;
        });
      })
      .catch(() => {
        if (!cancelled) setBuildings([]);
      })
      .finally(() => {
        if (!cancelled) setBuildingsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, initialBuildingId]);

  // Tải danh sách công tơ mỗi khi đổi tòa nhà hoặc kỳ chốt
  useEffect(() => {
    if (!open) return;
    sessionGenRef.current += 1;
    if (!targetBuildingId) {
      setBuildingMeters([]);
      return;
    }
    loadBuildingMeters(targetBuildingId).then((loadedMeters) => {
      setItems((prev) =>
        rematchBatchPhotoItemsForBuilding(prev, loadedMeters, targetBuildingId)
      );
    });
  }, [open, targetBuildingId, period, loadBuildingMeters]);

  const meterOptions = useMemo(() => {
    const sorted = [...buildingMeters].sort((a, b) => {
      const codeCmp = String(a.apartment_code || '').localeCompare(
        String(b.apartment_code || ''),
        'vi',
        { numeric: true }
      );
      if (codeCmp !== 0) return codeCmp;
      return String(a.meter_type || '').localeCompare(String(b.meter_type || ''));
    });

    return [
      { value: '', label: '-- Chọn công tơ đích --' },
      ...sorted.map((m) => {
        const typeLabel = m.meter_type === 'WATER' ? 'Nước (m³)' : 'Điện (kWh)';
        const lockSuffix = m.period_reading_billed ? ' [Đã khóa HĐ]' : '';
        return {
          value: m.id,
          label: `Căn ${m.apartment_code} • ${typeLabel} (${m.meter_code})${lockSuffix}`,
        };
      }),
    ];
  }, [buildingMeters]);

  const evaluated = useMemo(
    () =>
      evaluateBatchPhotoImportItems(items, buildingMeters, {
        anomalyThresholdPct,
        canWriteMeters,
      }),
    [items, buildingMeters, anomalyThresholdPct, canWriteMeters]
  );

  const runOcrForRow = useCallback(
    async (rowSnapshot, activeBuildingId, genId) => {
      if (sessionGenRef.current !== genId) return;

      setItems((prev) =>
        prev.map((r) =>
          r.localId === rowSnapshot.localId
            ? { ...r, ocrStatus: 'PROCESSING', ocrError: '' }
            : r
        )
      );

      const currentMeters = buildingMetersRef.current;
      const matchedMeter = rowSnapshot.meterId
        ? currentMeters.find((m) => String(m.id) === String(rowSnapshot.meterId)) || null
        : null;

      const ocrPayload = {
        period,
        image_base64: rowSnapshot.imageDataUri,
      };
      if (matchedMeter) {
        ocrPayload.meter_id = matchedMeter.id;
        if (matchedMeter.target_contract_id) {
          ocrPayload.contract_id = matchedMeter.target_contract_id;
        }
      } else {
        ocrPayload.building_id = activeBuildingId;
        if (rowSnapshot.apartmentId) {
          ocrPayload.apartment_id = rowSnapshot.apartmentId;
        }
      }

      try {
        const res = await aiService.ocrMeterReading(ocrPayload);
        if (sessionGenRef.current !== genId) return;

        const data = res?.data || {};
        const out = data?.output || {};
        const latestMeters = buildingMetersRef.current;

        setItems((prev) =>
          prev.map((curr) => {
            if (curr.localId !== rowSnapshot.localId) return curr;
            const autoMeterId = curr.manualMeterAssigned
              ? curr.meterId
              : resolveMeterAfterOcr({
                  item: curr,
                  ocrData: data,
                  buildingMeters: latestMeters,
                });
            const hasAiReading = out.reading !== null && out.reading !== undefined;
            const nextDraft =
              curr.userEditedReading && String(curr.draftReading || '').trim() !== ''
                ? curr.draftReading
                : hasAiReading
                  ? String(Number(out.reading))
                  : curr.draftReading;

            return {
              ...curr,
              meterId: autoMeterId || curr.meterId || null,
              draftReading: nextDraft,
              ocrStatus: hasAiReading ? 'DONE' : 'NEEDS_MANUAL',
              suggestionId: data.suggestion_id || null,
              confidence: data.confidence ?? null,
              detectedMeterType: out.detected_meter_type || null,
              aiReason: out.reason || '',
              aiWarnings: Array.isArray(data.warnings) ? data.warnings : [],
              needsHumanReview: Boolean(data.needs_human_review),
              ocrError: '',
            };
          })
        );
      } catch (err) {
        if (sessionGenRef.current !== genId) return;
        const mapped = mapAiErrorToVietnamese(err);
        setItems((prev) =>
          prev.map((curr) =>
            curr.localId === rowSnapshot.localId
              ? {
                  ...curr,
                  ocrStatus: 'FAILED',
                  ocrError: `${mapped.title}: ${mapped.guidance}`,
                }
              : curr
          )
        );
        throw err;
      }
    },
    [period]
  );

  const handleFilesSelected = async (rawFileList) => {
    if (!canWriteMeters) return;
    if (queueProgress.running) {
      toast.warning(
        'Hệ thống đang đọc lô ảnh hiện tại, vui lòng đợi hoàn tất trước khi thêm ảnh mới.'
      );
      return;
    }
    if (!targetBuildingId) {
      toast.warning('Vui lòng chọn Tòa nhà mục tiêu trước khi tải ảnh công tơ lên.');
      return;
    }

    const incoming = Array.from(rawFileList || []);
    if (incoming.length === 0) return;

    const validFiles = incoming.filter((f) =>
      ACCEPTED_MIMES.has(String(f.type || '').toLowerCase())
    );
    if (validFiles.length < incoming.length) {
      toast.warning(
        `Đã bỏ qua ${incoming.length - validFiles.length} tệp không phải ảnh JPG/PNG/WEBP.`
      );
    }
    if (validFiles.length === 0) return;

    const remainingSlots = Math.max(0, MAX_BATCH_METER_PHOTOS - items.length);
    if (remainingSlots === 0) {
      toast.warning(
        `Mỗi đợt đối soát tối đa ${MAX_BATCH_METER_PHOTOS} ảnh. Vui lòng lưu hoặc xóa bớt dòng trước khi thêm ảnh mới.`
      );
      return;
    }

    const acceptedSlice = validFiles.slice(0, remainingSlots);
    if (validFiles.length > remainingSlots) {
      toast.warning(
        `Chỉ nhận ${remainingSlots} ảnh đầu tiên để đảm bảo giới hạn tối đa ${MAX_BATCH_METER_PHOTOS} ảnh/đợt.`
      );
    }

    const genId = sessionGenRef.current;
    const currentMeters = buildingMetersRef.current;

    const preparedRows = [];
    for (const file of acceptedSlice) {
      try {
        const imageDataUri = await compressImageFileToDataUri(file);
        const match = matchMeterFromFilename(file.name, currentMeters);
        preparedRows.push({
          localId: makeLocalRowId(),
          buildingId: targetBuildingId,
          fileName: file.name,
          imageDataUri,
          matchKind: match.matchKind,
          meterId: match.meterId,
          apartmentId: match.apartmentId,
          apartmentCode: match.apartmentCode,
          meterTypeHint: match.meterTypeHint,
          manualMeterAssigned: false,
          draftReading: '',
          userEditedReading: false,
          abnormalNote: '',
          ocrStatus: 'PENDING',
          suggestionId: null,
          confidence: null,
          detectedMeterType: null,
          aiReason: '',
          aiWarnings: [],
          needsHumanReview: false,
          ocrError: '',
        });
      } catch (err) {
        toast.error(`Không thể đọc ảnh "${file.name}": ${err?.message || 'Lỗi tệp ảnh'}`);
      }
    }

    if (preparedRows.length === 0 || sessionGenRef.current !== genId) return;

    setItems((prev) => [...prev, ...preparedRows]);
    setQueueProgress({ total: preparedRows.length, completed: 0, running: true });

    await runBoundedConcurrencyQueue(
      preparedRows,
      DEFAULT_OCR_CONCURRENCY,
      async (rowItem) => {
        try {
          await runOcrForRow(rowItem, targetBuildingId, genId);
        } finally {
          if (sessionGenRef.current === genId) {
            setQueueProgress((p) => ({
              ...p,
              completed: Math.min(p.total, p.completed + 1),
            }));
          }
        }
      }
    );

    if (sessionGenRef.current === genId) {
      setQueueProgress((p) => ({ ...p, running: false }));
    }
  };

  const handleRetrySingleRow = async (row) => {
    if (!canWriteMeters || !targetBuildingId || queueProgress.running) return;
    const genId = sessionGenRef.current;
    try {
      await runOcrForRow(row, targetBuildingId, genId);
    } catch {
      // Lỗi đã được ghi nhận vào row.ocrError trên dòng tương ứng
    }
  };

  const handleRemoveRow = (localId) => {
    setItems((prev) => prev.filter((r) => r.localId !== localId));
  };

  const handleClearAll = () => {
    sessionGenRef.current += 1;
    setQueueProgress({ total: 0, completed: 0, running: false });
    setItems([]);
  };

  const handleCloseModal = () => {
    if (savingStatus) return;
    sessionGenRef.current += 1;
    setQueueProgress({ total: 0, completed: 0, running: false });
    setPreviewItem(null);
    setItems([]);
    onClose?.();
  };

  const handleSaveBatchFromPhotos = async (targetStatus = 'DRAFT') => {
    if (!canWriteMeters || evaluated.saveableRows.length === 0) return;

    setSavingStatus(targetStatus);
    try {
      const payload = buildBatchPhotoSavePayload({
        saveableRows: evaluated.saveableRows,
        period,
        targetStatus,
      });

      const res = await metersService.recordBatch(payload);
      const savedLocalIds = new Set(evaluated.saveableRows.map((r) => r.localId));
      const remainingRows = items.filter((r) => !savedLocalIds.has(r.localId));

      onSaved?.();

      if (remainingRows.length === 0) {
        if (res?.flagged_count > 0 || res?.abnormal_count > 0) {
          toast.warning(
            res.message ||
              `Đã lưu ${payload.readings.length} chỉ số (có chỉ số biến động >${anomalyThresholdPct}%).`
          );
        } else {
          toast.success(
            res?.message || `Đã import thành công ${payload.readings.length} chỉ số công tơ.`
          );
        }
        setItems([]);
        onClose?.();
      } else {
        setItems(remainingRows);
        await loadBuildingMeters(targetBuildingId);
        toast.warning(
          `Đã lưu ${payload.readings.length} chỉ số hợp lệ. Còn ${remainingRows.length} ảnh chưa đủ điều kiện được giữ lại trên bảng để kiểm tra tiếp.`
        );
      }
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể lưu lô chỉ số từ ảnh chụp.'));
    } finally {
      setSavingStatus('');
    }
  };

  const progressPct =
    queueProgress.total > 0
      ? Math.round((queueProgress.completed / queueProgress.total) * 100)
      : 0;

  return (
    <>
      <Modal
        open={open}
        onClose={handleCloseModal}
        size="full"
        title="Import Chỉ số Điện / Nước Hàng loạt từ Ảnh Chụp (AI OCR)"
        subtitle={`Kỳ chốt: ${period} • AI tự động nhận diện công tơ từ tên file & mặt đồng hồ, chờ Quản lý đối soát trước khi lưu (Tối đa ${MAX_BATCH_METER_PHOTOS} ảnh/đợt)`}
        footer={
          <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
              <Badge variant="emerald">Hợp lệ: {evaluated.summary.saveableCount}</Badge>
              {evaluated.summary.abnormalSaveableCount > 0 ? (
                <Badge variant="amber">
                  Cảnh báo &gt;{anomalyThresholdPct}%: {evaluated.summary.abnormalSaveableCount}
                </Badge>
              ) : null}
              {evaluated.summary.duplicateCount > 0 ? (
                <Badge variant="red">Trùng công tơ: {evaluated.summary.duplicateCount}</Badge>
              ) : null}
              {evaluated.summary.skippedCount > 0 ? (
                <Badge variant="slate">
                  Chưa đủ ĐK / Bỏ qua: {evaluated.summary.skippedCount}
                </Badge>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2.5">
              {items.length > 0 ? (
                <Button
                  variant="ghost"
                  onClick={handleClearAll}
                  disabled={Boolean(savingStatus)}
                >
                  Xóa danh sách
                </Button>
              ) : null}
              <Button
                variant="outline"
                onClick={handleCloseModal}
                disabled={Boolean(savingStatus)}
              >
                Đóng
              </Button>
              <Button
                variant="outline"
                icon={Save}
                loading={savingStatus === 'DRAFT'}
                disabled={
                  Boolean(savingStatus) ||
                  queueProgress.running ||
                  evaluated.summary.saveableCount === 0
                }
                onClick={() => handleSaveBatchFromPhotos('DRAFT')}
              >
                Lưu nháp hợp lệ ({evaluated.summary.saveableCount})
              </Button>
              <Button
                variant="primary"
                icon={CheckCircle2}
                loading={savingStatus === 'CONFIRMED'}
                disabled={
                  Boolean(savingStatus) ||
                  queueProgress.running ||
                  evaluated.summary.saveableCount === 0
                }
                onClick={() => handleSaveBatchFromPhotos('CONFIRMED')}
              >
                Lưu &amp; Chốt hợp lệ ({evaluated.summary.saveableCount})
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-5">
          {/* Bước 1: Chọn Tòa nhà & Quy ước đặt tên file */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
            <div className="lg:col-span-4">
              <Select
                label="Tòa nhà áp dụng đợt chụp ảnh"
                required
                disabled={buildingsLoading || queueProgress.running || Boolean(savingStatus)}
                value={targetBuildingId}
                onChange={(e) => setTargetBuildingId(e.target.value)}
                options={[
                  {
                    value: '',
                    label: buildingsLoading ? 'Đang tải tòa nhà...' : '-- Chọn tòa nhà --',
                  },
                  ...buildings.map((b) => ({
                    value: b.id,
                    label: `${b.code ? `${b.code} - ` : ''}${b.name}`,
                  })),
                ]}
              />
              <p className="mt-1.5 text-xs text-slate-500">
                {targetBuildingId
                  ? metersLoading
                    ? 'Đang tải danh sách công tơ của tòa nhà...'
                    : `Đã nạp ${buildingMeters.length} công tơ thuộc tòa nhà cho kỳ ${period}.`
                  : 'Chọn tòa nhà trước để hệ thống khớp thẳng tên phòng (VD: A1001) không cần mã tòa.'}
              </p>
            </div>

            <div className="lg:col-span-8 rounded-xl border border-indigo-200 bg-indigo-50/60 p-3.5 text-xs text-indigo-950">
              <div className="flex items-start gap-2.5">
                <Info className="h-4 w-4 text-indigo-600 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-semibold text-indigo-900">
                    Mẹo đặt tên ảnh để tự động nhận diện phòng &amp; công tơ nhanh nhất:
                  </p>
                  <ul className="list-disc pl-4 space-y-0.5 text-indigo-800">
                    <li>
                      Có tên phòng + loại đồng hồ:{' '}
                      <code className="rounded bg-white/80 px-1.5 py-0.5 font-mono text-[11px]">
                        A1001_dien.jpg
                      </code>
                      ,{' '}
                      <code className="rounded bg-white/80 px-1.5 py-0.5 font-mono text-[11px]">
                        A1001_nuoc.png
                      </code>
                      ,{' '}
                      <code className="rounded bg-white/80 px-1.5 py-0.5 font-mono text-[11px]">
                        A1001-E.jpg
                      </code>
                      ,{' '}
                      <code className="rounded bg-white/80 px-1.5 py-0.5 font-mono text-[11px]">
                        A1001-W.jpg
                      </code>
                    </li>
                    <li>
                      Chỉ ghi tên phòng:{' '}
                      <code className="rounded bg-white/80 px-1.5 py-0.5 font-mono text-[11px]">
                        A1001 (1).jpg
                      </code>
                      ,{' '}
                      <code className="rounded bg-white/80 px-1.5 py-0.5 font-mono text-[11px]">
                        A1001 (2).jpg
                      </code>{' '}
                      — AI sẽ tự nhìn đơn vị <strong>kWh / m³</strong> trên mặt đồng hồ để phân biệt Điện hay Nước!
                    </li>
                    <li>
                      Ảnh từ điện thoại chưa kịp đổi tên (<code className="font-mono">IMG_4021.jpg</code>) vẫn đọc chỉ số AI bình thường và chọn lại công tơ ngay tại cột <strong>Công tơ đích</strong>.
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          </div>

          {/* Vùng kéo-thả / chọn nhiều ảnh */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              if (targetBuildingId && !metersLoading && !queueProgress.running) {
                setIsDragging(true);
              }
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              if (queueProgress.running) {
                toast.warning(
                  'Hệ thống đang đọc lô ảnh hiện tại, vui lòng đợi hoàn tất trước khi thêm ảnh mới.'
                );
                return;
              }
              if (!targetBuildingId || metersLoading) {
                toast.warning('Vui lòng chọn tòa nhà và đợi danh sách công tơ tải xong.');
                return;
              }
              handleFilesSelected(e.dataTransfer?.files);
            }}
            className={`rounded-xl border-2 border-dashed p-5 text-center transition-colors ${
              !targetBuildingId || metersLoading || queueProgress.running
                ? 'border-slate-200 bg-slate-50 opacity-70'
                : isDragging
                  ? 'border-brand-500 bg-brand-50/50'
                  : 'border-slate-300 bg-slate-50/50 hover:border-brand-400 hover:bg-white'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              disabled={queueProgress.running || Boolean(savingStatus)}
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => {
                handleFilesSelected(e.target.files);
                e.target.value = '';
              }}
            />
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-indigo-100 text-indigo-600">
                <UploadCloud className="h-5 w-5" />
              </div>
              <div className="text-left">
                <p className="text-sm font-semibold text-slate-800">
                  Kéo thả nhiều ảnh mặt đồng hồ vào đây hoặc bấm chọn tệp từ máy
                </p>
                <p className="text-xs text-slate-500">
                  Hỗ trợ JPG, PNG, WEBP • Đã chọn {items.length}/{MAX_BATCH_METER_PHOTOS} ảnh trong đợt này
                </p>
              </div>
              <Button
                type="button"
                variant="soft"
                icon={Sparkles}
                disabled={
                  !targetBuildingId ||
                  metersLoading ||
                  queueProgress.running ||
                  items.length >= MAX_BATCH_METER_PHOTOS ||
                  Boolean(savingStatus)
                }
                onClick={() => fileInputRef.current?.click()}
              >
                Chọn ảnh công tơ
              </Button>
            </div>
          </div>

          {/* Thanh tiến trình OCR hàng loạt */}
          {queueProgress.total > 0 && queueProgress.running ? (
            <div className="rounded-xl border border-indigo-200 bg-indigo-50/70 px-4 py-3">
              <div className="flex items-center justify-between text-xs font-medium text-indigo-900 mb-1.5">
                <span className="inline-flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-indigo-600 animate-pulse" />
                  AI đang đọc chỉ số công tơ ({queueProgress.completed}/{queueProgress.total} ảnh)...
                </span>
                <span>{progressPct}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-indigo-100">
                <div
                  className="h-full bg-indigo-600 transition-all duration-300"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          ) : null}

          {/* Cảnh báo nếu có dòng >30% thiếu ghi chú khi muốn Chốt luôn */}
          {evaluated.summary.abnormalMissingNoteCount > 0 ? (
            <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
              <div>
                Có <strong>{evaluated.summary.abnormalMissingNoteCount}</strong> công tơ biến động vượt ngưỡng{' '}
                <strong>&gt;{anomalyThresholdPct}%</strong> chưa nhập ghi chú giải trình. Nếu bấm{' '}
                <strong>Lưu &amp; Chốt hợp lệ</strong> ngay, hệ thống sẽ tự động giữ các dòng đó ở trạng thái{' '}
                <strong>Tạm giữ (FLAGGED)</strong> theo quy tắc an toàn FR-031; nhập ghi chú giải trình để chốt thẳng sang{' '}
                <strong>CONFIRMED</strong>.
              </div>
            </div>
          ) : null}

          {/* Bảng đối soát ảnh & chỉ số */}
          {evaluated.rows.length > 0 ? (
            <div className="rounded-xl border border-slate-200 overflow-hidden bg-white">
              <Table>
                <THead>
                  <tr>
                    <TH className="w-20">Ảnh</TH>
                    <TH className="min-w-[200px]">Tệp &amp; Gợi ý AI</TH>
                    <TH className="min-w-[270px]">Công tơ đích</TH>
                    <TH className="text-right whitespace-nowrap">Số cũ</TH>
                    <TH className="w-40">Số mới ({period})</TH>
                    <TH className="text-right whitespace-nowrap">Tiêu thụ &amp; Tạm tính</TH>
                    <TH className="min-w-[210px]">Ghi chú giải trình</TH>
                    <TH>Trạng thái</TH>
                    <TH className="text-right">Thao tác</TH>
                  </tr>
                </THead>
                <TBody>
                  {evaluated.rows.map((row) => {
                    const confMeta =
                      row.confidence !== null && row.confidence !== undefined
                        ? formatConfidenceBadge(row.confidence, 0.8)
                        : null;
                    const rowDisabled =
                      row.validationState === 'LOCKED_BILLED' ||
                      row.validationState === 'OCR_PROCESSING' ||
                      Boolean(savingStatus);

                    return (
                      <tr
                        key={row.localId}
                        className={
                          row.validationState === 'DUPLICATE_METER_TARGET' ||
                          row.validationState === 'INVALID_READING'
                            ? 'bg-red-50/40'
                            : row.isAbnormal
                              ? 'bg-amber-50/40'
                              : ''
                        }
                      >
                        <TD>
                          <button
                            type="button"
                            onClick={() => setPreviewItem(row)}
                            className="group relative block h-14 w-14 overflow-hidden rounded-lg border border-slate-200 bg-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
                            title="Bấm để phóng to ảnh công tơ"
                          >
                            <img
                              src={row.imageDataUri}
                              alt={row.fileName}
                              className="h-full w-full object-cover"
                            />
                            <span className="absolute inset-0 flex items-center justify-center bg-slate-900/40 opacity-0 transition-opacity group-hover:opacity-100">
                              <ZoomIn className="h-4 w-4 text-white" />
                            </span>
                          </button>
                        </TD>

                        <TD>
                          <div className="space-y-1 max-w-[230px]">
                            <p
                              className="truncate text-xs font-semibold text-slate-900"
                              title={row.fileName}
                            >
                              {row.fileName}
                            </p>
                            <div className="flex flex-wrap items-center gap-1">
                              {row.detectedMeterType === 'ELECTRICITY' ? (
                                <span className="inline-flex items-center gap-0.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                                  <Zap className="h-2.5 w-2.5" /> AI: Điện
                                </span>
                              ) : row.detectedMeterType === 'WATER' ? (
                                <span className="inline-flex items-center gap-0.5 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-800">
                                  <Droplets className="h-2.5 w-2.5" /> AI: Nước
                                </span>
                              ) : row.matchKind === 'APARTMENT_ONLY' && row.apartmentCode ? (
                                <span className="inline-flex items-center rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                                  Khớp căn {row.apartmentCode}
                                </span>
                              ) : null}

                              {confMeta ? (
                                <span
                                  className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                                    confMeta.tone === 'emerald'
                                      ? 'bg-emerald-50 text-emerald-700'
                                      : confMeta.tone === 'amber'
                                        ? 'bg-amber-50 text-amber-700'
                                        : 'bg-rose-50 text-rose-700'
                                  }`}
                                >
                                  AI {confMeta.percentText}
                                </span>
                              ) : null}
                            </div>

                            {row.hasTypeMismatchWarning ? (
                              <p className="text-[11px] font-medium text-rose-600">
                                Ảnh chụp nghi là đồng hồ{' '}
                                {row.detectedMeterType === 'WATER' ? 'Nước' : 'Điện'}, khác loại công tơ đang chọn!
                              </p>
                            ) : null}

                            {row.ocrError ? (
                              <p className="text-[11px] text-rose-600 line-clamp-2" title={row.ocrError}>
                                {row.ocrError}
                              </p>
                            ) : row.aiReason ? (
                              <p className="text-[11px] text-slate-500 line-clamp-2" title={row.aiReason}>
                                {row.aiReason}
                              </p>
                            ) : null}
                          </div>
                        </TD>

                        <TD>
                          <Select
                            value={row.meterId || ''}
                            disabled={Boolean(savingStatus) || row.validationState === 'OCR_PROCESSING'}
                            onChange={(e) => {
                              const nextMeterId = e.target.value || null;
                              setItems((prev) =>
                                prev.map((it) =>
                                  it.localId === row.localId
                                    ? {
                                        ...it,
                                        meterId: nextMeterId,
                                        manualMeterAssigned: true,
                                      }
                                    : it
                                )
                              );
                            }}
                            options={meterOptions}
                          />
                        </TD>

                        <TD className="text-right font-mono text-xs text-slate-600 whitespace-nowrap">
                          {row.meter ? `${row.prevReading} ${row.meter.unit}` : '—'}
                        </TD>

                        <TD>
                          <Input
                            type="number"
                            step="0.01"
                            min={row.prevReading ?? 0}
                            disabled={rowDisabled}
                            placeholder="Nhập chỉ số..."
                            value={row.draftReading}
                            onChange={(e) => {
                              const val = e.target.value;
                              setItems((prev) =>
                                prev.map((it) =>
                                  it.localId === row.localId
                                    ? {
                                        ...it,
                                        draftReading: val,
                                        userEditedReading: true,
                                      }
                                    : it
                                )
                              );
                            }}
                            error={
                              row.isInvalidReading && row.prevReading !== null
                                ? `Phải >= ${row.prevReading}`
                                : ''
                            }
                          />
                        </TD>

                        <TD className="text-right whitespace-nowrap">
                          {row.meter && row.consumption !== null ? (
                            <div>
                              <span
                                className={`font-semibold ${
                                  row.isAbnormal ? 'text-amber-700' : 'text-slate-900'
                                }`}
                              >
                                +{row.consumption} {row.meter.unit}
                              </span>
                              {row.estimatedAmount !== null ? (
                                <p className="text-[11px] font-medium text-emerald-700">
                                  ≈ {formatMoney(row.estimatedAmount)}
                                </p>
                              ) : null}
                              {row.diffPct !== null ? (
                                <p
                                  className={`text-[10px] ${
                                    row.isAbnormal
                                      ? 'font-semibold text-amber-700'
                                      : 'text-slate-400'
                                  }`}
                                >
                                  {row.diffPct > 0 ? `+${row.diffPct}%` : `${row.diffPct}%`} so với TB 3 kỳ
                                </p>
                              ) : null}
                            </div>
                          ) : (
                            <span className="text-xs text-slate-400">—</span>
                          )}
                        </TD>

                        <TD>
                          <Input
                            disabled={rowDisabled}
                            placeholder={
                              row.isAbnormal
                                ? `Giải trình biến động >${anomalyThresholdPct}%...`
                                : 'Ghi chú (nếu có)...'
                            }
                            value={row.abnormalNote}
                            onChange={(e) => {
                              const val = e.target.value;
                              setItems((prev) =>
                                prev.map((it) =>
                                  it.localId === row.localId
                                    ? { ...it, abnormalNote: val }
                                    : it
                                )
                              );
                            }}
                          />
                        </TD>

                        <TD>{renderValidationBadge(row, anomalyThresholdPct)}</TD>

                        <TD className="text-right whitespace-nowrap">
                          <div className="inline-flex items-center justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={RefreshCw}
                              disabled={
                                Boolean(savingStatus) ||
                                queueProgress.running ||
                                row.validationState === 'OCR_PROCESSING'
                              }
                              onClick={() => handleRetrySingleRow(row)}
                              title="Thử đọc lại ảnh này bằng AI"
                            >
                              Thử lại
                            </Button>
                            <button
                              type="button"
                              disabled={Boolean(savingStatus)}
                              onClick={() => handleRemoveRow(row.localId)}
                              className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 transition-colors disabled:opacity-40"
                              title="Xóa ảnh khỏi danh sách import"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </TD>
                      </tr>
                    );
                  })}
                </TBody>
              </Table>
            </div>
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white py-10 text-center text-sm text-slate-500">
              Chưa có ảnh công tơ nào trong danh sách đối soát. Hãy chọn tòa nhà và kéo thả ảnh vào khung phía trên.
            </div>
          )}
        </div>
      </Modal>

      {/* Lightbox xem phóng to ảnh công tơ */}
      <Modal
        open={Boolean(previewItem)}
        onClose={() => setPreviewItem(null)}
        size="lg"
        title={previewItem ? `Xem ảnh gốc: ${previewItem.fileName}` : 'Xem ảnh gốc'}
        subtitle={
          previewItem?.meter
            ? `Công tơ đích: ${previewItem.meter.meter_code} (Căn ${previewItem.meter.apartment_code}) • Số cũ: ${previewItem.prevReading} ${previewItem.meter.unit}`
            : 'Đối chiếu chữ số thực tế trên mặt đồng hồ'
        }
        footer={
          <Button variant="outline" onClick={() => setPreviewItem(null)}>
            Đóng xem ảnh
          </Button>
        }
      >
        {previewItem ? (
          <div className="flex flex-col items-center gap-3">
            <img
              src={previewItem.imageDataUri}
              alt={previewItem.fileName}
              className="max-h-[65vh] w-auto rounded-xl border border-slate-200 object-contain shadow-sm"
            />
            {previewItem.aiReason ? (
              <p className="text-xs text-slate-600">{previewItem.aiReason}</p>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </>
  );
}

export default MeterBatchPhotoImportModal;
