import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  FileText,
  Printer,
  Download,
  RefreshCw,
  LogOut,
  ShieldCheck,
  History,
  FileDiff,
  CheckCircle2,
  Clock,
  Calendar,
  Building2,
  Users,
  AlertTriangle,
  ArrowUpRight,
  ArrowDownLeft,
} from 'lucide-react';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { Modal } from '../../../components/ui/Modal';
import { Skeleton } from '../../../components/ui/Skeleton';
import { StatusBadge } from '../../../components/common/StatusBadge';
import { EmptyState } from '../../../components/common/EmptyState';
import { residentService } from '../../../services/resident.service';
import { contractsService } from '../../../services/contracts.service';
import { useToast } from '../../../hooks/useToast';
import { formatMoney, formatDate, formatDateTime, toInputDate } from '../../../utils/format';
import { extractErrorMessage } from '../../../utils/validation';

const DIFF_FIELD_LABELS = {
  rent_amount: 'Giá thuê hàng tháng',
  deposit_amount: 'Tiền đặt cọc',
  end_date: 'Ngày kết thúc HĐ',
  start_date: 'Ngày bắt đầu HĐ',
  billing_day: 'Ngày chốt kỳ',
  payment_due_days: 'Hạn thanh toán (ngày)',
  note: 'Ghi chú',
};

const DEPOSIT_TX_LABELS = {
  collect: { label: 'Thu tiền cọc', sign: '+', variant: 'emerald' },
  transfer: { label: 'Kết chuyển cọc', sign: '+', variant: 'sky' },
  refund: { label: 'Hoàn trả cọc', sign: '-', variant: 'indigo' },
  deduct: { label: 'Khấu trừ cọc', sign: '-', variant: 'amber' },
  forfeit: { label: 'Thu hồi cọc vi phạm', sign: '-', variant: 'red' },
};

const REQUEST_STATUS_MAP = {
  SUBMITTED: { label: 'Chờ BQL xử lý', variant: 'amber' },
  APPROVED: { label: 'Đã chấp thuận', variant: 'emerald' },
  REJECTED: { label: 'Từ chối', variant: 'red' },
  CANCELLED: { label: 'Đã hủy', variant: 'slate' },
};

function formatDiffValue(key, val) {
  if (val === null || val === undefined) return '—';
  if (key.includes('amount')) return formatMoney(val);
  if (key.includes('date')) return formatDate(val);
  return String(val);
}

export function ContractTab({ overview, onRefreshOverview, onNavigateTab }) {
  const toast = useToast();
  const iframeRef = useRef(null);

  const contract = overview?.active_contract || overview?.contract || null;
  const contractHistory = Array.isArray(overview?.contract_history) ? overview.contract_history : [];
  const amendments = Array.isArray(overview?.amendments) ? overview.amendments : [];

  const [depositData, setDepositData] = useState({ deposit: null, transactions: [] });
  const [contractRequests, setContractRequests] = useState([]);
  const [occupants, setOccupants] = useState([]);
  const [loadingExtra, setLoadingExtra] = useState(true);

  // Print A4 Template Modal
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateHtml, setTemplateHtml] = useState('');

  // Renewal / Termination Request Modal
  const [reqModalOpen, setReqModalOpen] = useState(false);
  const [reqSubmitting, setReqSubmitting] = useState(false);
  const [reqForm, setReqForm] = useState({
    type: 'RENEWAL',
    desired_date: '',
    note: '',
  });

  const loadContractDetails = useCallback(async () => {
    setLoadingExtra(true);
    try {
      const promises = [
        residentService.listDepositTransactions(),
        residentService.listContractRequests(),
      ];
      if (contract?.contract_id) {
        promises.push(contractsService.listOccupants(contract.contract_id));
      }
      const [depRes, reqRes, occRes] = await Promise.allSettled(promises);

      if (depRes.status === 'fulfilled') {
        setDepositData(depRes.value?.data || { deposit: null, transactions: [] });
      }
      if (reqRes.status === 'fulfilled') {
        setContractRequests(reqRes.value?.data || []);
      }
      if (occRes && occRes.status === 'fulfilled') {
        setOccupants(occRes.value?.data || []);
      }
    } finally {
      setLoadingExtra(false);
    }
  }, [contract?.contract_id]);

  useEffect(() => {
    loadContractDetails();
  }, [loadContractDetails]);

  const handleOpenTemplate = async (targetContractId) => {
    const cid = targetContractId || contract?.contract_id;
    if (!cid) return;
    setTemplateOpen(true);
    setTemplateLoading(true);
    setTemplateHtml('');
    try {
      const html = await contractsService.getTemplateHtml(cid);
      setTemplateHtml(html);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải bản in hợp đồng A4.'));
      setTemplateOpen(false);
    } finally {
      setTemplateLoading(false);
    }
  };

  const handlePrintA4 = () => {
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.focus();
      iframeRef.current.contentWindow.print();
    }
  };

  const handleDownloadHtml = () => {
    if (!templateHtml) return;
    const code = contract?.apartment_code || 'HopDong';
    const blob = new Blob([templateHtml], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `HopDong_${code}_A4.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const openRequestModal = (type = 'RENEWAL') => {
    let defaultDate = '';
    if (type === 'RENEWAL' && contract?.end_date) {
      const d = new Date(contract.end_date);
      if (!Number.isNaN(d.getTime())) {
        d.setFullYear(d.getFullYear() + 1);
        defaultDate = toInputDate(d);
      }
    } else if (type === 'TERMINATION') {
      const d = new Date();
      d.setDate(d.getDate() + 30);
      defaultDate = toInputDate(d);
    }

    setReqForm({
      type,
      desired_date: defaultDate,
      note: '',
    });
    setReqModalOpen(true);
  };

  const handleSubmitContractRequest = async (e) => {
    e.preventDefault();
    if (reqForm.type === 'TERMINATION' && !reqForm.desired_date) {
      toast.warning('Vui lòng chọn ngày mong muốn chấm dứt hợp đồng.');
      return;
    }

    setReqSubmitting(true);
    try {
      const res = await residentService.createContractRequest({
        type: reqForm.type,
        desired_date: reqForm.desired_date || undefined,
        note: reqForm.note?.trim() || undefined,
      });
      toast.success(res?.message || 'Đã gửi đề nghị hợp đồng tới Ban Quản Lý.');
      setReqModalOpen(false);
      await Promise.allSettled([loadContractDetails(), onRefreshOverview?.()]);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể gửi đề nghị hợp đồng.'));
    } finally {
      setReqSubmitting(false);
    }
  };

  if (!contract && contractHistory.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={FileText}
          title="Chưa có hợp đồng thuê"
          description="Bạn hiện chưa có hợp đồng thuê căn hộ nào. Hãy chọn căn hộ trống tại mục Tổng quan để gửi hồ sơ đăng ký thuê."
          action={
            <Button onClick={() => onNavigateTab?.('overview')}>
              Xem căn hộ trống
            </Button>
          }
        />
      </Card>
    );
  }

  const timelineSteps = contract
    ? [
        {
          label: 'Khởi tạo & Ký kết',
          date: formatDate(contract.contract_created_at || contract.start_date),
          done: true,
        },
        {
          label: 'Bàn giao & Hiệu lực',
          date: formatDate(contract.start_date),
          done: true,
        },
        {
          label:
            contract.contract_status === 'RENEWAL_PENDING'
              ? 'Chờ duyệt gia hạn'
              : contract.contract_status === 'TERMINATION_PENDING'
              ? 'Chờ duyệt chấm dứt'
              : 'Đang thực hiện',
          date: 'Hiện tại',
          active: true,
          done: true,
        },
        {
          label: 'Đáo hạn hợp đồng',
          date: formatDate(contract.end_date),
          done: false,
        },
      ]
    : [];

  const depositInfo = depositData?.deposit;
  const depositTransactions = Array.isArray(depositData?.transactions)
    ? depositData.transactions
    : [];

  return (
    <div className="space-y-6">
      {/* Current Active Contract Details */}
      {contract ? (
        <Card>
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-slate-100">
            <div className="space-y-1">
              <div className="flex items-center gap-2.5 flex-wrap">
                <h2 className="text-lg font-bold text-slate-900">
                  Hợp đồng thuê #{contract.contract_id?.slice(0, 8).toUpperCase()}
                </h2>
                <StatusBadge status={contract.contract_status} domain="contract" />
                {contract.parent_contract_id ? (
                  <Badge variant="indigo">
                    Nối tiếp HĐ #{contract.parent_contract_id.slice(0, 8).toUpperCase()}
                  </Badge>
                ) : null}
              </div>
              <p className="text-xs text-slate-500 flex items-center gap-1.5">
                <Building2 className="w-3.5 h-3.5 text-slate-400" />
                <span>
                  Căn {contract.apartment_code} — {contract.building_name}
                </span>
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="soft"
                size="sm"
                icon={Printer}
                onClick={() => handleOpenTemplate(contract.contract_id)}
              >
                Xem / Tải bản in A4
              </Button>
              {contract.contract_status === 'ACTIVE' ? (
                <>
                  <Button
                    variant="primary"
                    size="sm"
                    icon={RefreshCw}
                    onClick={() => openRequestModal('RENEWAL')}
                  >
                    Xin gia hạn HĐ
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    icon={LogOut}
                    onClick={() => openRequestModal('TERMINATION')}
                    className="text-rose-600 hover:text-rose-700 hover:bg-rose-50 border-rose-200"
                  >
                    Xin chấm dứt trước hạn
                  </Button>
                </>
              ) : null}
            </div>
          </div>

          {/* Status Timeline */}
          <div className="py-5 border-b border-slate-100">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3.5">
              Tiến trình hợp đồng
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {timelineSteps.map((step, idx) => (
                <div
                  key={idx}
                  className={`p-3 rounded-xl border ${
                    step.active
                      ? 'bg-primary-50/70 border-primary-200'
                      : step.done
                      ? 'bg-emerald-50/40 border-emerald-200/70'
                      : 'bg-slate-50 border-slate-200/70'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    {step.done ? (
                      <CheckCircle2
                        className={`w-4 h-4 shrink-0 ${
                          step.active ? 'text-primary-600' : 'text-emerald-600'
                        }`}
                      />
                    ) : (
                      <Clock className="w-4 h-4 text-slate-400 shrink-0" />
                    )}
                    <span className="text-xs font-semibold text-slate-800 truncate">
                      {step.label}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-1 pl-5.5">{step.date}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Key Contract Terms */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 pt-5">
            <div>
              <p className="text-xs text-slate-500">Ngày bắt đầu</p>
              <p className="text-sm font-semibold text-slate-900 mt-0.5">
                {formatDate(contract.start_date)}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Ngày kết thúc</p>
              <p className="text-sm font-semibold text-slate-900 mt-0.5">
                {formatDate(contract.end_date)}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Giá thuê / tháng</p>
              <p className="text-sm font-bold text-primary-600 mt-0.5">
                {formatMoney(contract.rent_amount)}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Tiền cọc hợp đồng</p>
              <p className="text-sm font-bold text-indigo-600 mt-0.5">
                {formatMoney(contract.deposit_amount)}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Ngày chốt hóa đơn</p>
              <p className="text-sm font-semibold text-slate-900 mt-0.5">
                Ngày {contract.billing_day || 1} hàng tháng
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Hạn thanh toán</p>
              <p className="text-sm font-semibold text-slate-900 mt-0.5">
                {contract.payment_due_days || 5} ngày sau phát hành
              </p>
            </div>
          </div>

          {contract.contract_note ? (
            <div className="mt-4 p-3 rounded-xl bg-slate-50 border border-slate-200/60 text-xs text-slate-600">
              <span className="font-semibold text-slate-700">Ghi chú hợp đồng: </span>
              {contract.contract_note}
            </div>
          ) : null}

          {/* Co-occupants if any */}
          {occupants.length > 0 ? (
            <div className="mt-5 pt-4 border-t border-slate-100">
              <p className="text-xs font-semibold text-slate-700 flex items-center gap-1.5 mb-2.5">
                <Users className="w-4 h-4 text-slate-400" />
                Thành viên đăng ký ở cùng ({occupants.length})
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {occupants.map((occ) => (
                  <div
                    key={occ.tenant_id}
                    className="px-3 py-2 rounded-lg bg-slate-50 border border-slate-200/70 flex items-center justify-between text-xs"
                  >
                    <div>
                      <p className="font-semibold text-slate-800">{occ.full_name}</p>
                      <p className="text-slate-500">{occ.phone || '—'}</p>
                    </div>
                    <Badge variant="slate">{occ.relationship || 'Thành viên'}</Badge>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* Submitted Contract Requests (Renewal / Termination) */}
      {contractRequests.length > 0 ? (
        <Card>
          <CardHeader
            title="Đề nghị Gia hạn / Chấm dứt đã gửi"
            subtitle="Theo dõi phản hồi từ Ban Quản Lý đối với các đề nghị hợp đồng của bạn"
          />
          <div className="space-y-2.5">
            {contractRequests.map((cr) => {
              const st = REQUEST_STATUS_MAP[cr.status] || { label: cr.status, variant: 'slate' };
              return (
                <div
                  key={cr.id}
                  className="p-3.5 rounded-xl border border-slate-200/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={cr.type === 'RENEWAL' ? 'sky' : 'red'}>
                        {cr.type === 'RENEWAL' ? 'Xin gia hạn HĐ' : 'Xin chấm dứt HĐ trước hạn'}
                      </Badge>
                      <Badge variant={st.variant} dot>
                        {st.label}
                      </Badge>
                      <span className="text-xs text-slate-400">
                        Gửi lúc {formatDateTime(cr.created_at)}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600">
                      Ngày mong muốn:{' '}
                      <span className="font-semibold text-slate-800">
                        {formatDate(cr.desired_date)}
                      </span>
                      {cr.note ? ` • Ghi chú: ${cr.note}` : ''}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      ) : null}

      {/* Deposit Ledger & Transactions */}
      <Card>
        <CardHeader
          title="Sổ cọc & Lịch sử giao dịch cọc"
          subtitle="Minh bạch số dư tiền cọc đang bảo lưu và toàn bộ biến động thu/hoàn/khấu trừ"
          action={
            depositInfo?.status ? (
              <StatusBadge status={depositInfo.status} domain="deposit" />
            ) : null
          }
        />

        {loadingExtra ? (
          <div className="space-y-2.5">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-4 rounded-xl bg-indigo-50/50 border border-indigo-100">
              <div>
                <p className="text-xs text-slate-500">Mức cọc quy định trên HĐ</p>
                <p className="text-base font-bold text-slate-900 mt-0.5">
                  {formatMoney(contract?.deposit_amount || depositData?.contract?.deposit_amount || 0)}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Số dư cọc thực giữ hiện tại</p>
                <p className="text-base font-bold text-indigo-700 mt-0.5">
                  {formatMoney(depositInfo?.amount_held ?? contract?.deposit_held_amount ?? 0)}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Số giao dịch đã duyệt</p>
                <p className="text-base font-bold text-slate-900 mt-0.5">
                  {depositTransactions.length} giao dịch
                </p>
              </div>
            </div>

            {depositTransactions.length === 0 ? (
              <p className="text-xs text-slate-500 text-center py-6">
                Chưa có lịch sử giao dịch sổ cọc nào được ghi nhận.
              </p>
            ) : (
              <div className="divide-y divide-slate-100 border border-slate-200/80 rounded-xl overflow-hidden">
                {depositTransactions.map((tx) => {
                  const meta = DEPOSIT_TX_LABELS[tx.type] || {
                    label: tx.type,
                    sign: '',
                    variant: 'slate',
                  };
                  const isPlus = meta.sign === '+';
                  return (
                    <div
                      key={tx.id}
                      className="p-3.5 bg-white hover:bg-slate-50/70 flex items-center justify-between gap-3"
                    >
                      <div className="flex items-start gap-3 min-w-0">
                        <div
                          className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                            isPlus
                              ? 'bg-emerald-50 text-emerald-600'
                              : 'bg-amber-50 text-amber-600'
                          }`}
                        >
                          {isPlus ? (
                            <ArrowDownLeft className="w-4 h-4" />
                          ) : (
                            <ArrowUpRight className="w-4 h-4" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-semibold text-slate-900">
                              {tx.description || tx.note || meta.label}
                            </span>
                            <Badge variant={meta.variant}>{meta.label}</Badge>
                          </div>
                          <p className="text-[11px] text-slate-500 mt-0.5">
                            {formatDateTime(tx.created_at)}
                            {tx.method ? ` • Phương thức: ${tx.method}` : ''}
                          </p>
                        </div>
                      </div>
                      <span
                        className={`text-sm font-bold shrink-0 ${
                          isPlus ? 'text-emerald-600' : 'text-rose-600'
                        }`}
                      >
                        {meta.sign}
                        {formatMoney(tx.amount)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Amendments & Contract History Chain */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Amendments */}
        <Card>
          <CardHeader
            title="Phụ lục điều chỉnh hợp đồng"
            subtitle="Các phụ lục thay đổi điều khoản đã được phê duyệt"
          />
          {amendments.length === 0 ? (
            <EmptyState
              icon={FileDiff}
              title="Chưa có phụ lục điều chỉnh"
              description="Hợp đồng hiện giữ nguyên các điều khoản gốc từ khi ký kết."
            />
          ) : (
            <div className="space-y-3">
              {amendments.map((am) => {
                const diffObj =
                  typeof am.diff === 'object' && am.diff !== null ? am.diff : {};
                return (
                  <div
                    key={am.id}
                    className="p-3.5 rounded-xl border border-slate-200/80 bg-slate-50/50 space-y-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant="indigo">Phụ lục lần #{am.version_no}</Badge>
                      <span className="text-xs text-slate-500">
                        Hiệu lực: <strong className="text-slate-700">{formatDate(am.effective_from)}</strong>
                      </span>
                    </div>
                    {am.reason ? (
                      <p className="text-xs text-slate-700 font-medium">{am.reason}</p>
                    ) : null}
                    {Object.keys(diffObj).length > 0 ? (
                      <div className="space-y-1 pt-1 border-t border-slate-200/60 text-xs text-slate-600">
                        {Object.entries(diffObj).map(([k, v]) => {
                          const fromVal = v && typeof v === 'object' && 'from' in v ? v.from : null;
                          const toVal = v && typeof v === 'object' && 'to' in v ? v.to : v;
                          return (
                            <div key={k} className="flex items-center justify-between gap-2">
                              <span className="text-slate-500">
                                {DIFF_FIELD_LABELS[k] || k}:
                              </span>
                              <span className="font-semibold text-slate-800">
                                {fromVal !== null ? `${formatDiffValue(k, fromVal)} → ` : ''}
                                {formatDiffValue(k, toVal)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        {/* Contract Renewal / History Chain */}
        <Card>
          <CardHeader
            title="Chuỗi lịch sử hợp đồng"
            subtitle="Toàn bộ các kỳ hợp đồng gốc và gia hạn nối tiếp"
          />
          {contractHistory.length === 0 ? (
            <EmptyState
              icon={History}
              title="Chưa có lịch sử hợp đồng"
              description="Các hợp đồng đã ký sẽ hiển thị tại đây."
            />
          ) : (
            <div className="space-y-3">
              {contractHistory.map((ch) => (
                <div
                  key={ch.id}
                  className={`p-3.5 rounded-xl border transition-colors ${
                    ch.id === contract?.contract_id
                      ? 'border-primary-300 bg-primary-50/30'
                      : 'border-slate-200/80 bg-white'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-bold text-slate-900">
                          HĐ #{ch.id.slice(0, 8).toUpperCase()} — Căn {ch.apartment_code}
                        </span>
                        <StatusBadge status={ch.status} domain="contract" />
                      </div>
                      <p className="text-xs text-slate-500 mt-0.5">{ch.building_name}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="xs"
                      icon={Printer}
                      onClick={() => handleOpenTemplate(ch.id)}
                    >
                      Bản in
                    </Button>
                  </div>

                  <div className="mt-2.5 pt-2.5 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
                    <span className="inline-flex items-center gap-1">
                      <Calendar className="w-3.5 h-3.5 text-slate-400" />
                      {formatDate(ch.start_date)} → {formatDate(ch.end_date)}
                    </span>
                    <span className="font-semibold text-slate-800">
                      {formatMoney(ch.rent_amount)}/tháng
                    </span>
                  </div>

                  {ch.parent_contract_id ? (
                    <p className="text-[11px] text-indigo-600 font-medium mt-1.5">
                      ↳ Gia hạn / Chuyển tiếp từ HĐ #{ch.parent_contract_id.slice(0, 8).toUpperCase()}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Modal Xem / In Hợp đồng A4 */}
      <Modal
        open={templateOpen}
        onClose={() => setTemplateOpen(false)}
        title="Bản in Hợp đồng thuê căn hộ chuẩn A4"
        subtitle="Xem trước, tải về hoặc in / xuất PDF trực tiếp"
        size="xl"
        footer={
          <>
            <Button variant="outline" onClick={() => setTemplateOpen(false)}>
              Đóng
            </Button>
            <Button
              variant="soft"
              icon={Download}
              onClick={handleDownloadHtml}
              disabled={!templateHtml}
            >
              Tải bản HTML
            </Button>
            <Button
              variant="primary"
              icon={Printer}
              onClick={handlePrintA4}
              disabled={!templateHtml}
            >
              In / Lưu PDF (A4)
            </Button>
          </>
        }
      >
        {templateLoading ? (
          <div className="space-y-3 py-8">
            <Skeleton className="h-8 w-2/3 mx-auto" />
            <Skeleton className="h-96 w-full" />
          </div>
        ) : (
          <div className="border border-slate-200 rounded-xl overflow-hidden bg-slate-100">
            <iframe
              ref={iframeRef}
              title="Contract A4 Template"
              srcDoc={templateHtml}
              className="w-full h-[65vh] bg-white"
            />
          </div>
        )}
      </Modal>

      {/* Modal Gửi đề nghị Gia hạn / Chấm dứt HĐ */}
      <Modal
        open={reqModalOpen}
        onClose={() => setReqModalOpen(false)}
        title={
          reqForm.type === 'RENEWAL'
            ? 'Gửi yêu cầu Xin gia hạn Hợp đồng'
            : 'Gửi yêu cầu Xin chấm dứt Hợp đồng trước hạn'
        }
        subtitle={`Căn hộ ${contract?.apartment_code || ''} — Ngày hết hạn hiện tại: ${formatDate(
          contract?.end_date
        )}`}
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setReqModalOpen(false)} disabled={reqSubmitting}>
              Hủy
            </Button>
            <Button
              variant={reqForm.type === 'TERMINATION' ? 'danger' : 'primary'}
              onClick={handleSubmitContractRequest}
              loading={reqSubmitting}
            >
              Gửi đề nghị tới BQL
            </Button>
          </>
        }
      >
        <form onSubmit={handleSubmitContractRequest} className="space-y-4">
          <Select
            label="Loại đề nghị"
            value={reqForm.type}
            onChange={(e) => setReqForm((s) => ({ ...s, type: e.target.value }))}
            options={[
              { value: 'RENEWAL', label: 'Xin gia hạn tiếp hợp đồng thuê' },
              { value: 'TERMINATION', label: 'Xin chấm dứt hợp đồng trước hạn' },
            ]}
          />

          {reqForm.type === 'TERMINATION' ? (
            <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-2.5 text-xs text-amber-800">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <p className="leading-relaxed">
                <strong>Lưu ý quy định báo trước (AC-006.1):</strong> Đề nghị chấm dứt hợp đồng trước hạn cần gửi trước tối thiểu <strong>30 ngày</strong> để Ban Quản Lý sắp xếp lịch kiểm tra nghiệm thu phòng và tất toán tiền cọc.
              </p>
            </div>
          ) : (
            <div className="p-3.5 rounded-xl bg-sky-50 border border-sky-200 flex items-start gap-2.5 text-xs text-sky-800">
              <ShieldCheck className="w-4 h-4 text-sky-600 shrink-0 mt-0.5" />
              <p className="leading-relaxed">
                Ban Quản Lý sẽ tiếp nhận yêu cầu gia hạn, trao đổi điều khoản kỳ mới và khởi tạo hợp đồng gia hạn nối tiếp cho bạn.
              </p>
            </div>
          )}

          <Input
            type="date"
            required={reqForm.type === 'TERMINATION'}
            label={
              reqForm.type === 'RENEWAL'
                ? 'Ngày kết thúc mới mong muốn'
                : 'Ngày dự kiến bàn giao trả phòng'
            }
            min={toInputDate(new Date())}
            value={reqForm.desired_date}
            onChange={(e) => setReqForm((s) => ({ ...s, desired_date: e.target.value }))}
          />

          <Input
            multiline
            rows={3}
            label="Lý do / Ghi chú gửi Ban Quản Lý"
            placeholder={
              reqForm.type === 'RENEWAL'
                ? 'Ví dụ: Tôi muốn gia hạn thêm 12 tháng, giữ nguyên các dịch vụ đang đăng ký...'
                : 'Ví dụ: Chuyển công tác sang khu vực khác, mong BQL hỗ trợ kiểm tra bàn giao...'
            }
            value={reqForm.note}
            onChange={(e) => setReqForm((s) => ({ ...s, note: e.target.value }))}
          />
        </form>
      </Modal>
    </div>
  );
}

export default ContractTab;
