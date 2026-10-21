import React, { useState, useEffect } from 'react';
import { ShieldCheck, Plus, ArrowUpRight, ArrowDownLeft, RefreshCw, X, Trash2, AlertCircle, CheckCircle } from 'lucide-react';
import Button from '../../../components/ui/Button';
import Input from '../../../components/ui/Input';
import FormField from '../../../components/ui/FormField';
import DataTable from '../../../components/ui/DataTable';
import StatusBadge from '../../../components/ui/StatusBadge';
import Money from '../../../components/ui/Money';
import AccessDenied from '../../../components/common/AccessDenied';
import api from '../../../services/api';
import { useAuthStore } from '../../../stores/authStore';

export default function DepositsPage() {
  const { getCurrentRole } = useAuthStore();
  const currentRole = getCurrentRole();

  // Phân quyền Cọc: OWNER (R+A hoàn cọc), MANAGER (CRU), RESIDENT (chặn truy cập)
  const canManageDeposit = ['MANAGER', 'OWNER'].includes(currentRole);

  if (currentRole === 'RESIDENT') {
    return (
      <AccessDenied
        currentRole={currentRole}
        allowedRoles={['OWNER', 'MANAGER']}
      />
    );
  }

  const [deposits, setDeposits] = useState([]);

  const [isLoading, setIsLoading] = useState(false);
  const [selectedDeposit, setSelectedDeposit] = useState(null);
  const [isTxnModalOpen, setIsTxnModalOpen] = useState(false);

  // Settlement states (FR-024, AC-017)
  const [isSettlementFormOpen, setIsSettlementFormOpen] = useState(false);
  const [isSettlementViewOpen, setIsSettlementViewOpen] = useState(false);
  const [settlementDetail, setSettlementDetail] = useState(null);
  const [settlementForm, setSettlementForm] = useState({
    outstanding_debt: 0,
    items: [],
    refund_method: 'BANK_TRANSFER',
    bank_info: { bank_name: '', account_number: '', account_holder: '' },
  });

  // Transaction form (chỉ còn thu bổ sung cọc; khấu trừ/hoàn trả qua hồ sơ tất toán FR-024)
  const [txnData, setTxnData] = useState({
    type: 'collect',
    method: 'BANK_TRANSFER',
    amount: 1000000,
    description: 'Thu bổ sung cọc',
  });
  const [formError, setFormError] = useState('');

  const loadDeposits = async () => {
    setIsLoading(true);
    try {
      const res = await api.get('/api/v1/deposits');
      setDeposits(res.data?.data || []);
    } catch (err) {
      console.error('Error loading deposits:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadDeposits();
  }, []);

  const handleOpenTxnModal = (dep) => {
    setSelectedDeposit(dep);
    setTxnData({
      type: 'collect',
      method: 'BANK_TRANSFER',
      amount: 1000000,
      description: 'Thu bổ sung cọc',
    });
    setFormError('');
    setIsTxnModalOpen(true);
  };

  const handleCreateTxn = async (e) => {
    e.preventDefault();
    setFormError('');

    if (!txnData.amount || txnData.amount <= 0) {
      setFormError('Số tiền giao dịch phải lớn hơn 0.');
      return;
    }

    try {
      await api.post(`/api/v1/deposits/${selectedDeposit.id}/transactions`, txnData);
      setIsTxnModalOpen(false);
      loadDeposits();
    } catch (err) {
      setFormError(err.response?.data?.message || 'Lỗi khi xử lý giao dịch cọc.');
    }
  };

  const handleOpenSettlementForm = (dep) => {
    setSelectedDeposit(dep);
    const existing = dep.settlement;
    setSettlementForm({
      outstanding_debt: existing?.outstanding_debt || 0,
      items: existing?.items && existing.items.length > 0 ? existing.items : [
        { category: 'DAMAGE', amount: '', description: '', evidence: '' }
      ],
      refund_method: existing?.refund_method || 'BANK_TRANSFER',
      bank_info: existing?.bank_info || { bank_name: '', account_number: '', account_holder: '' },
    });
    setFormError('');
    setIsSettlementFormOpen(true);
  };

  const handleOpenSettlementView = async (dep) => {
    setSelectedDeposit(dep);
    setSettlementDetail(null);
    setIsSettlementViewOpen(true);
    try {
      const res = await api.get(`/api/v1/deposits/${dep.id}/settlement`);
      setSettlementDetail(res.data?.data);
    } catch (err) {
      console.error('Error loading settlement detail:', err);
      // Fallback to row data
      setSettlementDetail({
        deposit_id: dep.id,
        amount_held: dep.amount_held,
        status: dep.status,
        contract_status: dep.contract_status,
        terminated_at: dep.terminated_at,
        settlement: dep.settlement,
        apartment_code: dep.apartment_code,
        building_name: dep.building_name,
        tenant_name: dep.tenant_name,
      });
    }
  };

  const handleAddItem = () => {
    setSettlementForm((prev) => ({
      ...prev,
      items: [...prev.items, { category: 'DAMAGE', amount: '', description: '', evidence: '' }],
    }));
  };

  const handleRemoveItem = (index) => {
    setSettlementForm((prev) => ({
      ...prev,
      items: prev.items.filter((_, i) => i !== index),
    }));
  };

  const handleItemChange = (index, field, value) => {
    setSettlementForm((prev) => {
      const nextItems = [...prev.items];
      nextItems[index] = { ...nextItems[index], [field]: value };
      return { ...prev, items: nextItems };
    });
  };

  const handleSubmitSettlement = async (e) => {
    e.preventDefault();
    setFormError('');

    const formattedItems = settlementForm.items.map((it) => ({
      category: it.category,
      amount: Number(it.amount),
      description: it.description?.trim(),
      evidence: Array.isArray(it.evidence) ? it.evidence : (it.evidence ? [it.evidence.trim()] : []),
    }));

    for (let i = 0; i < formattedItems.length; i++) {
      const it = formattedItems[i];
      if (!it.amount || it.amount <= 0) {
        setFormError(`Khoản khấu trừ #${i + 1}: Số tiền phải lớn hơn 0.`);
        return;
      }
      if (!it.description) {
        setFormError(`Khoản khấu trừ #${i + 1}: Vui lòng nhập mô tả lý do.`);
        return;
      }
      if (it.evidence.length === 0) {
        setFormError(`Khoản khấu trừ #${i + 1}: Bắt buộc phải có chứng từ/hình ảnh bằng chứng.`);
        return;
      }
    }

    try {
      await api.post(`/api/v1/deposits/${selectedDeposit.id}/settlement`, {
        outstanding_debt: Number(settlementForm.outstanding_debt || 0),
        items: formattedItems,
        refund_method: settlementForm.refund_method,
        bank_info: settlementForm.bank_info,
      });
      setIsSettlementFormOpen(false);
      loadDeposits();
    } catch (err) {
      setFormError(err.response?.data?.message || 'Lỗi khi gửi hồ sơ tất toán.');
    }
  };

  const handleApproveSettlement = async () => {
    if (!window.confirm('Xác nhận phê duyệt hồ sơ tất toán cọc? Số dư cọc bảo lưu sẽ được đưa về 0 (REFUNDED).')) return;
    try {
      await api.post(`/api/v1/deposits/${selectedDeposit.id}/settlement/approve`);
      setIsSettlementViewOpen(false);
      loadDeposits();
    } catch (err) {
      alert(err.response?.data?.message || 'Lỗi khi phê duyệt hồ sơ tất toán.');
    }
  };

  const handleRejectSettlement = async () => {
    const reason = window.prompt('Lý do từ chối hồ sơ tất toán:');
    if (reason === null) return;
    if (!reason.trim()) {
      alert('Vui lòng nhập lý do từ chối.');
      return;
    }
    try {
      await api.post(`/api/v1/deposits/${selectedDeposit.id}/settlement/reject`, { reason: reason.trim() });
      setIsSettlementViewOpen(false);
      loadDeposits();
    } catch (err) {
      alert(err.response?.data?.message || 'Lỗi khi từ chối hồ sơ tất toán.');
    }
  };

  const handleDisputeSettlement = async () => {
    const reason = window.prompt('Lý do phát sinh tranh chấp cọc (DISPUTED):');
    if (reason === null) return;
    if (!reason.trim()) {
      alert('Vui lòng nhập lý do tranh chấp.');
      return;
    }
    try {
      await api.post(`/api/v1/deposits/${selectedDeposit.id}/dispute`, { reason: reason.trim() });
      setIsSettlementViewOpen(false);
      loadDeposits();
    } catch (err) {
      alert(err.response?.data?.message || 'Lỗi khi báo tranh chấp cọc.');
    }
  };

  // Calculation for live settlement form
  const sumItems = (settlementForm.items || []).reduce((acc, it) => acc + (Number(it.amount) || 0), 0);
  const totalDeductions = (Number(settlementForm.outstanding_debt) || 0) + sumItems;
  const depositHeld = Number(selectedDeposit?.amount_held || 0);
  const calculatedRefund = Math.max(0, depositHeld - totalDeductions);
  const calculatedShortfall = Math.max(0, totalDeductions - depositHeld);

  const columns = [
    {
      title: 'Căn hộ & Khách thuê',
      key: 'apartment_code',
      sortable: true,
      render: (val, row) => (
        <div>
          <span className="font-bold text-slate-900 block">Căn {val}</span>
          <span className="text-xs text-slate-500">Khách: {row.tenant_name} · {row.building_name}</span>
        </div>
      ),
    },
    {
      title: 'Số dư cọc đang giữ',
      key: 'amount_held',
      sortable: true,
      render: (val) => (
        <Money amount={val} className="text-base font-bold text-slate-900" />
      ),
    },
    {
      title: 'Tiền thuê HĐ',
      key: 'rent_amount',
      render: (val) => <Money amount={val} className="text-xs text-slate-600" />,
    },
    {
      title: 'Trạng thái cọc',
      key: 'status',
      render: (val) => <StatusBadge status={val} />,
    },
    {
      title: 'Thao tác',
      key: 'actions',
      render: (_, row) => (
        <div className="flex flex-col gap-1.5 min-w-[140px]">
          {row.settlement && (
            <button
              className="px-2.5 py-1 text-xs rounded-lg border border-indigo-200 text-indigo-700 hover:bg-indigo-50 font-medium text-left"
              onClick={() => handleOpenSettlementView(row)}
            >
              {row.status === 'PENDING_APPROVAL' ? '📋 Xem xét tất toán' : '📄 Xem hồ sơ tất toán'}
            </button>
          )}

          {['HELD', 'SETTLEMENT_DRAFT'].includes(row.status) && ['TERMINATED', 'EXPIRED'].includes(row.contract_status) && canManageDeposit && (
            <button
              className="px-2.5 py-1 text-xs rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 font-medium text-left"
              onClick={() => handleOpenSettlementForm(row)}
            >
              {row.status === 'SETTLEMENT_DRAFT' ? '✏️ Sửa hồ sơ tất toán' : '⚖️ Mở hồ sơ tất toán'}
            </button>
          )}

          {row.status === 'HELD' && canManageDeposit && (
            <button
              className="px-2.5 py-1 text-xs rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 font-medium text-left"
              onClick={() => handleOpenTxnModal(row)}
            >
              💵 Thu bổ sung cọc
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight">
            Sổ Quản lý Tiền cọc (M06)
          </h2>
          <p className="text-xs sm:text-sm text-slate-500 mt-1">
            Ghi nhận thu cọc, phân bổ khấu trừ chi phí hư hại hoặc hoàn cọc khi tất toán hợp đồng
          </p>
        </div>
      </div>

      <DataTable
        columns={columns}
        data={deposits}
        isLoading={isLoading}
        searchKeys={['apartment_code', 'tenant_name', 'building_name']}
        emptyTitle="Chưa có khoản cọc nào"
        emptyDescription="Tiền cọc sẽ tự động khởi tạo khi lập hợp đồng thuê mới có phí đặt cọc."
      />

      {/* Modal Thu Bổ Sung Tiền Cọc (Collect) */}
      {isTxnModalOpen && selectedDeposit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 border border-slate-100">
            <div className="flex items-center justify-between mb-4 border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  Thu bổ sung cọc · Căn {selectedDeposit.apartment_code}
                </h3>
                <p className="text-xs text-slate-500">
                  Số dư cọc hiện tại: <Money amount={selectedDeposit.amount_held} className="font-bold text-primary-600" />
                </p>
              </div>
              <button onClick={() => setIsTxnModalOpen(false)}>
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>

            <form onSubmit={handleCreateTxn} className="space-y-4">
              <FormField label="Loại giao dịch" required error={formError}>
                <select
                  value={txnData.type}
                  disabled
                  className="w-full rounded-lg border border-slate-300 py-2 px-3 text-sm bg-slate-50 text-slate-700"
                >
                  <option value="collect">Thu bổ sung tiền cọc (Collect)</option>
                </select>
                <p className="text-xs text-slate-500 mt-1">
                  * Khấu trừ và hoàn trả cọc được thực hiện qua Hồ sơ Tất toán có phê duyệt (FR-024).
                </p>
              </FormField>

              <FormField label="Phương thức thanh toán" required>
                <select
                  value={txnData.method}
                  onChange={(e) => setTxnData({ ...txnData, method: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 py-2 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  <option value="BANK_TRANSFER">Chuyển khoản (Bank Transfer)</option>
                  <option value="CASH">Tiền mặt (Cash)</option>
                  <option value="OTHER">Khác</option>
                </select>
              </FormField>

              <FormField label="Số tiền thu bổ sung (VND)" required>
                <Input
                  type="number"
                  value={txnData.amount}
                  onChange={(e) => setTxnData({ ...txnData, amount: e.target.value })}
                />
              </FormField>

              <FormField label="Lý do / Mô tả chi tiết" required>
                <Input
                  placeholder="Ví dụ: Khách nộp bổ sung tiền cọc đợt 2..."
                  value={txnData.description}
                  onChange={(e) => setTxnData({ ...txnData, description: e.target.value })}
                />
              </FormField>

              <div className="flex justify-end gap-2.5 pt-4 border-t border-slate-100">
                <Button variant="secondary" onClick={() => setIsTxnModalOpen(false)}>
                  Hủy
                </Button>
                <Button type="submit" variant="primary">
                  Xác nhận giao dịch
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Lập / Sửa Hồ Sơ Tất Toán (Settlement Form) */}
      {isSettlementFormOpen && selectedDeposit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full p-6 border border-slate-100 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4 border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  Lập hồ sơ tất toán hoàn cọc · Căn {selectedDeposit.apartment_code}
                </h3>
                <p className="text-xs text-slate-500">
                  Khách: {selectedDeposit.tenant_name} · Tiền cọc đang giữ: <Money amount={selectedDeposit.amount_held} className="font-bold text-indigo-600" />
                </p>
              </div>
              <button onClick={() => setIsSettlementFormOpen(false)}>
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>

            {formError && (
              <div className="mb-4 p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{formError}</span>
              </div>
            )}

            <form onSubmit={handleSubmitSettlement} className="space-y-5">
              <FormField label="Công nợ tồn đọng (tiền thuê/dịch vụ còn nợ) (VND)">
                <Input
                  type="number"
                  min="0"
                  value={settlementForm.outstanding_debt}
                  onChange={(e) => setSettlementForm({ ...settlementForm, outstanding_debt: e.target.value })}
                  placeholder="0"
                />
              </FormField>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                    Các khoản khấu trừ (hư hại tài sản, dọn vệ sinh...)
                  </label>
                  <Button type="button" variant="outline" size="sm" onClick={handleAddItem} leftIcon={Plus}>
                    Thêm khoản trừ
                  </Button>
                </div>

                {settlementForm.items.length === 0 && (
                  <p className="text-xs text-slate-400 italic py-2 text-center border border-dashed rounded-lg">
                    Không có khoản khấu trừ hư hại nào (hoàn trả nguyên vẹn sau khi trừ công nợ nếu có).
                  </p>
                )}

                {settlementForm.items.map((item, idx) => (
                  <div key={idx} className="p-3 rounded-xl border border-slate-200 bg-slate-50/50 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-700">Khoản #{idx + 1}</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveItem(idx)}
                        className="text-rose-600 hover:text-rose-700 text-xs flex items-center gap-1"
                      >
                        <Trash2 className="w-3.5 h-3.5" /> Xóa
                      </button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      <div>
                        <label className="text-[11px] text-slate-500 font-medium block mb-1">Danh mục *</label>
                        <select
                          value={item.category}
                          onChange={(e) => handleItemChange(idx, 'category', e.target.value)}
                          className="w-full rounded-lg border border-slate-300 py-1.5 px-2.5 text-xs bg-white"
                        >
                          <option value="DAMAGE">Hư hại tài sản / Nội thất (DAMAGE)</option>
                          <option value="CLEANING">Chi phí vệ sinh dọn phòng (CLEANING)</option>
                          <option value="UTILITY_DEBT">Nợ tiền điện nước/dịch vụ (UTILITY_DEBT)</option>
                          <option value="OTHER">Chi phí khác theo điều khoản HĐ (OTHER)</option>
                        </select>
                      </div>

                      <div>
                        <label className="text-[11px] text-slate-500 font-medium block mb-1">Số tiền (VND) *</label>
                        <Input
                          type="number"
                          min="1"
                          placeholder="Số tiền khấu trừ..."
                          value={item.amount}
                          onChange={(e) => handleItemChange(idx, 'amount', e.target.value)}
                        />
                      </div>
                    </div>

                    <div>
                      <label className="text-[11px] text-slate-500 font-medium block mb-1">Lý do chi tiết *</label>
                      <Input
                        placeholder="Mô tả cụ thể hư hỏng (vd: vỡ mặt kính bếp từ, sơn lại tường...)"
                        value={item.description}
                        onChange={(e) => handleItemChange(idx, 'description', e.target.value)}
                      />
                    </div>

                    <div>
                      <label className="text-[11px] text-slate-500 font-medium block mb-1">Chứng từ / Bằng chứng (link ảnh, mã đính kèm) *</label>
                      <Input
                        placeholder="vd: bien_ban_ban_giao.jpg hoặc https://..."
                        value={item.evidence}
                        onChange={(e) => handleItemChange(idx, 'evidence', e.target.value)}
                      />
                    </div>
                  </div>
                ))}
              </div>

              {/* Bảng tính phân bổ AC-017 */}
              <div className="p-4 rounded-xl border border-indigo-100 bg-indigo-50/40 space-y-2">
                <p className="text-xs font-bold text-indigo-900 uppercase tracking-wider">
                  Bảng tổng hợp tất toán (Công thức AC-017)
                </p>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <span className="text-slate-600">Số dư cọc hiện giữ:</span>
                  <span className="text-right font-semibold text-slate-900"><Money amount={depositHeld} /></span>

                  <span className="text-slate-600">Công nợ tồn đọng:</span>
                  <span className="text-right font-medium text-rose-600"><Money amount={Number(settlementForm.outstanding_debt || 0)} /></span>

                  <span className="text-slate-600">Tổng khấu trừ hư hại ({settlementForm.items.length} mục):</span>
                  <span className="text-right font-medium text-rose-600"><Money amount={sumItems} /></span>

                  <div className="col-span-2 border-t border-indigo-100 pt-2 flex justify-between items-center text-sm">
                    <span className="font-bold text-emerald-800">Tiền hoàn trả cho khách (Refund):</span>
                    <span className="font-bold text-emerald-700"><Money amount={calculatedRefund} /></span>
                  </div>

                  {calculatedShortfall > 0 && (
                    <div className="col-span-2 bg-rose-50 p-2 rounded-lg border border-rose-200 flex justify-between items-center text-xs text-rose-700">
                      <span className="font-medium">⚠️ Cọc không đủ bù trừ. Công nợ khách phải nộp thêm:</span>
                      <span className="font-bold"><Money amount={calculatedShortfall} /></span>
                    </div>
                  )}
                </div>
              </div>

              {/* Thông tin hoàn tiền */}
              <div className="space-y-3 pt-2 border-t border-slate-100">
                <p className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                  Phương thức & Tài khoản nhận hoàn cọc
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-slate-600 font-medium block mb-1">Phương thức hoàn</label>
                    <select
                      value={settlementForm.refund_method}
                      onChange={(e) => setSettlementForm({ ...settlementForm, refund_method: e.target.value })}
                      className="w-full rounded-lg border border-slate-300 py-2 px-3 text-sm bg-white"
                    >
                      <option value="BANK_TRANSFER">Chuyển khoản ngân hàng</option>
                      <option value="CASH">Tiền mặt</option>
                    </select>
                  </div>
                  {settlementForm.refund_method === 'BANK_TRANSFER' && (
                    <>
                      <div>
                        <label className="text-xs text-slate-600 font-medium block mb-1">Tên ngân hàng</label>
                        <Input
                          placeholder="vd: Vietcombank, MB Bank..."
                          value={settlementForm.bank_info?.bank_name || ''}
                          onChange={(e) => setSettlementForm({
                            ...settlementForm,
                            bank_info: { ...settlementForm.bank_info, bank_name: e.target.value }
                          })}
                        />
                      </div>
                      <div>
                        <label className="text-xs text-slate-600 font-medium block mb-1">Số tài khoản</label>
                        <Input
                          placeholder="vd: 0123456789..."
                          value={settlementForm.bank_info?.account_number || ''}
                          onChange={(e) => setSettlementForm({
                            ...settlementForm,
                            bank_info: { ...settlementForm.bank_info, account_number: e.target.value }
                          })}
                        />
                      </div>
                      <div>
                        <label className="text-xs text-slate-600 font-medium block mb-1">Tên chủ tài khoản</label>
                        <Input
                          placeholder="vd: NGUYEN VAN A..."
                          value={settlementForm.bank_info?.account_holder || ''}
                          onChange={(e) => setSettlementForm({
                            ...settlementForm,
                            bank_info: { ...settlementForm.bank_info, account_holder: e.target.value }
                          })}
                        />
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="flex justify-end gap-2.5 pt-4 border-t border-slate-100">
                <Button type="button" variant="secondary" onClick={() => setIsSettlementFormOpen(false)}>
                  Hủy
                </Button>
                <Button type="submit" variant="primary">
                  Gửi hồ sơ tất toán (Chờ OWNER duyệt)
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Xem Xét / Duyệt Hồ Sơ Tất Toán (Settlement View / Review) */}
      {isSettlementViewOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl max-w-xl w-full p-6 border border-slate-100 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4 border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  Hồ sơ tất toán cọc · Căn {settlementDetail?.apartment_code || selectedDeposit?.apartment_code}
                </h3>
                <p className="text-xs text-slate-500">
                  Khách: {settlementDetail?.tenant_name || selectedDeposit?.tenant_name} · Tòa {settlementDetail?.building_name || selectedDeposit?.building_name}
                </p>
              </div>
              <button onClick={() => setIsSettlementViewOpen(false)}>
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>

            {settlementDetail ? (
              <div className="space-y-4 text-xs">
                {/* Trạng thái */}
                <div className="flex items-center justify-between p-3 rounded-lg bg-slate-50 border border-slate-100">
                  <span className="font-semibold text-slate-700">Trạng thái hồ sơ:</span>
                  <StatusBadge status={settlementDetail.status} />
                </div>

                {/* Bảng kê chi tiết */}
                {settlementDetail.settlement ? (
                  <>
                    <div className="p-3.5 rounded-xl border border-slate-200 bg-white space-y-2">
                      <p className="font-bold text-slate-800 uppercase tracking-wider text-[11px]">
                        Bảng phân bổ tất toán
                      </p>
                      <div className="space-y-1.5">
                        <div className="flex justify-between">
                          <span className="text-slate-600">Công nợ tồn đọng:</span>
                          <span className="font-semibold text-slate-900">
                            <Money amount={settlementDetail.settlement.outstanding_debt || 0} />
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-600">Số tiền hoàn trả khách:</span>
                          <span className="font-bold text-emerald-600 text-sm">
                            <Money amount={settlementDetail.settlement.refund_amount || 0} />
                          </span>
                        </div>
                        {settlementDetail.settlement.shortfall > 0 && (
                          <div className="flex justify-between text-rose-600 font-semibold">
                            <span>Khách phải nộp thêm (Shortfall):</span>
                            <span><Money amount={settlementDetail.settlement.shortfall} /></span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Danh sách khoản khấu trừ */}
                    <div>
                      <p className="font-bold text-slate-800 uppercase tracking-wider text-[11px] mb-2">
                        Chi tiết khấu trừ hư hại ({settlementDetail.settlement.items?.length || 0} mục)
                      </p>
                      {(!settlementDetail.settlement.items || settlementDetail.settlement.items.length === 0) ? (
                        <p className="text-slate-400 italic py-2 text-center border rounded-lg">Không có khoản khấu trừ hư hại nào.</p>
                      ) : (
                        <div className="space-y-2">
                          {settlementDetail.settlement.items.map((it, i) => (
                            <div key={i} className="p-2.5 rounded-lg border border-slate-200 bg-slate-50/50 flex justify-between items-start">
                              <div>
                                <span className="font-semibold text-slate-900 block">{it.description}</span>
                                <span className="text-[11px] text-slate-500">
                                  Danh mục: <strong className="text-slate-700">{it.category}</strong>
                                  {it.evidence && it.evidence.length > 0 && (
                                    <> · Chứng từ: <span className="text-indigo-600">{Array.isArray(it.evidence) ? it.evidence.join(', ') : it.evidence}</span></>
                                  )}
                                </span>
                              </div>
                              <span className="font-bold text-slate-900"><Money amount={it.amount} /></span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Tài khoản nhận hoàn */}
                    <div className="p-3 rounded-lg border border-slate-200 bg-slate-50">
                      <p className="font-bold text-slate-800 uppercase tracking-wider text-[11px] mb-1">
                        Thông tin chi trả hoàn cọc
                      </p>
                      <p className="text-slate-600">
                        Phương thức: <strong>{settlementDetail.settlement.refund_method === 'CASH' ? 'Tiền mặt' : 'Chuyển khoản'}</strong>
                      </p>
                      {settlementDetail.settlement.bank_info?.bank_name && (
                        <p className="text-slate-600 mt-0.5">
                          Ngân hàng: <strong>{settlementDetail.settlement.bank_info.bank_name}</strong> · STK: <strong>{settlementDetail.settlement.bank_info.account_number}</strong> · Chủ TK: <strong>{settlementDetail.settlement.bank_info.account_holder}</strong>
                        </p>
                      )}
                    </div>

                    {/* Lý do từ chối hoặc tranh chấp nếu có */}
                    {settlementDetail.settlement.rejection_reason && (
                      <div className="p-3 rounded-lg border border-rose-200 bg-rose-50 text-rose-700">
                        <p className="font-bold">Lý do từ chối trước đó:</p>
                        <p>{settlementDetail.settlement.rejection_reason}</p>
                      </div>
                    )}
                    {settlementDetail.settlement.dispute_reason && (
                      <div className="p-3 rounded-lg border border-amber-200 bg-amber-50 text-amber-800">
                        <p className="font-bold">Lý do tranh chấp:</p>
                        <p>{settlementDetail.settlement.dispute_reason}</p>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-slate-400 italic text-center py-4">Chưa có dữ liệu chi tiết tất toán.</p>
                )}

                {/* Thao tác duyệt / từ chối */}
                <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                  {settlementDetail.status === 'PENDING_APPROVAL' && currentRole === 'OWNER' && (
                    <>
                      <Button variant="outline" size="sm" onClick={handleRejectSettlement} className="text-rose-600 border-rose-200 hover:bg-rose-50">
                        Từ chối
                      </Button>
                      <Button variant="primary" size="sm" onClick={handleApproveSettlement} leftIcon={CheckCircle} className="bg-emerald-600 hover:bg-emerald-700">
                        Duyệt tất toán & Hoàn cọc
                      </Button>
                    </>
                  )}

                  {settlementDetail.status === 'PENDING_APPROVAL' && currentRole === 'MANAGER' && (
                    <Button variant="outline" size="sm" onClick={handleDisputeSettlement} className="text-amber-700 border-amber-300 hover:bg-amber-50">
                      Báo tranh chấp (DISPUTE)
                    </Button>
                  )}

                  <Button variant="secondary" size="sm" onClick={() => setIsSettlementViewOpen(false)}>
                    Đóng
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-center py-6 text-slate-400">Đang tải hồ sơ...</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
