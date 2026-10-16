import React, { useState, useEffect } from 'react';
import { ShieldCheck, Plus, ArrowUpRight, ArrowDownLeft, RefreshCw, X } from 'lucide-react';
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

  // RBAC PRD 6.2 - Module Cọc:
  // OWNER: R + A(hoàn cọc) | MANAGER: CRU | ACCOUNTANT: CRU | SYS_ADMIN: R | STAFF: '-' | RESIDENT: R(của mình)
  const canManageDeposit = ['MANAGER', 'ACCOUNTANT', 'OWNER', 'SYS_ADMIN'].includes(currentRole);

  if (['STAFF', 'RESIDENT'].includes(currentRole)) {
    return (
      <AccessDenied
        currentRole={currentRole}
        allowedRoles={['OWNER', 'MANAGER', 'ACCOUNTANT', 'SYS_ADMIN']}
      />
    );
  }

  const [deposits, setDeposits] = useState([]);

  const [isLoading, setIsLoading] = useState(false);
  const [selectedDeposit, setSelectedDeposit] = useState(null);
  const [isTxnModalOpen, setIsTxnModalOpen] = useState(false);

  // Transaction form
  const [txnData, setTxnData] = useState({
    type: 'deduct', // deduct | refund | collect
    amount: 1000000,
    description: '',
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
      type: 'deduct',
      amount: Math.min(1000000, Number(dep.amount_held)),
      description: '',
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
      title: 'Trạng thái',
      key: 'status',
      render: (val) => <StatusBadge status={val} />,
    },
    {
      title: 'Thao tác',
      key: 'actions',
      render: (_, row) => canManageDeposit ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => handleOpenTxnModal(row)}
          disabled={row.status === 'REFUNDED'}
        >
          Xử lý cọc
        </Button>
      ) : (
        <span className="text-xs text-slate-400 italic">Chỉ xem</span>
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
            Ghi nhận thu cọc, khấu trừ chi phí hư hại hoặc hoàn cọc khi thanh lý hợp đồng
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

      {/* Modal Xử Lý Giao Dịch Cọc */}
      {isTxnModalOpen && selectedDeposit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 border border-slate-100">
            <div className="flex items-center justify-between mb-4 border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  Xử lý tiền cọc · Căn {selectedDeposit.apartment_code}
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
                  onChange={(e) => setTxnData({ ...txnData, type: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 py-2 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  <option value="deduct">Khấu trừ hư hại / Nợ tiền phòng (Deduct)</option>
                  <option value="refund">Hoàn trả tiền cọc cho khách (Refund)</option>
                  <option value="collect">Thu bổ sung tiền cọc (Collect)</option>
                </select>
              </FormField>

              <FormField label="Số tiền giao dịch (VND)" required>
                <Input
                  type="number"
                  value={txnData.amount}
                  onChange={(e) => setTxnData({ ...txnData, amount: e.target.value })}
                />
              </FormField>

              <FormField label="Lý do / Mô tả chi tiết" required>
                <Input
                  placeholder="Ví dụ: Khấu trừ tiền sơn lại tường phòng ngủ..."
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
    </div>
  );
}
