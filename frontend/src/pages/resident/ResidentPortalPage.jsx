import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { RefreshCw, AlertCircle } from 'lucide-react';
import { ResidentLayout } from '../../components/layout/ResidentLayout';
import { PageSkeleton } from '../../components/ui/Skeleton';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { residentService } from '../../services/resident.service';
import { extractErrorMessage } from '../../utils/validation';

import { OverviewTab } from './tabs/OverviewTab';
import { ContractTab } from './tabs/ContractTab';
import { InvoicesTab } from './tabs/InvoicesTab';
import { ServicesTab } from './tabs/ServicesTab';
import { MaintenanceTab } from './tabs/MaintenanceTab';
import { NotificationsTab } from './tabs/NotificationsTab';
import { ContactTab } from './tabs/ContactTab';
import { ProfileTab } from './tabs/ProfileTab';

const VALID_TABS = [
  'overview',
  'contract',
  'invoices',
  'services',
  'maintenance',
  'notifications',
  'contact',
  'profile',
];

export function ResidentPortalPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const rawTab = searchParams.get('tab');
  const activeTab = VALID_TABS.includes(rawTab) ? rawTab : 'overview';
  const actionParam = searchParams.get('action') || '';
  const contractIdParam = searchParams.get('contract_id') || '';

  const [overview, setOverview] = useState(null);
  const [openRequestsCount, setOpenRequestsCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const computeOpenRequests = useCallback((rows = []) => {
    const count = rows.filter((r) =>
      ['NEW', 'ASSIGNED', 'IN_PROGRESS'].includes(r.status)
    ).length;
    setOpenRequestsCount(count);
  }, []);

  const fetchOverviewData = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      setError('');
      try {
        const [ovRes, srRes] = await Promise.allSettled([
          residentService.getOverview(contractIdParam),
          residentService.listServiceRequests(contractIdParam),
        ]);

        if (ovRes.status === 'fulfilled') {
          const data = ovRes.value?.data || null;
          setOverview(
            data
              ? {
                  ...data,
                  active_contract: data.active_contract || data.contract || null,
                  contact_config: data.contact_config || data.manager_contact || null,
                }
              : null
          );
        } else {
          throw ovRes.reason;
        }

        if (srRes.status === 'fulfilled') {
          computeOpenRequests(srRes.value?.data || []);
        }
      } catch (err) {
        setError(extractErrorMessage(err, 'Không thể tải dữ liệu Cổng cư dân.'));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [computeOpenRequests, contractIdParam]
  );

  useEffect(() => {
    fetchOverviewData(false);
  }, [fetchOverviewData]);

  const handleNavigateTab = useCallback(
    (nextTab, extra = {}) => {
      const safeTab = VALID_TABS.includes(nextTab) ? nextTab : 'overview';
      const nextParams = { tab: safeTab };
      if (contractIdParam) {
        nextParams.contract_id = contractIdParam;
      }
      if (extra && typeof extra === 'object') {
        Object.entries(extra).forEach(([k, v]) => {
          if (v !== undefined && v !== null && v !== '') {
            nextParams[k] = String(v);
          }
        });
      }
      setSearchParams(nextParams);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [contractIdParam, setSearchParams]
  );

  const handleClearActionParam = useCallback(() => {
    if (!searchParams.get('action')) return;
    const nextParams = { tab: activeTab };
    if (contractIdParam) {
      nextParams.contract_id = contractIdParam;
    }
    setSearchParams(nextParams, { replace: true });
  }, [activeTab, contractIdParam, searchParams, setSearchParams]);

  const handleSelectContract = useCallback(
    (nextContractId) => {
      const nextParams = { tab: activeTab };
      if (nextContractId) {
        nextParams.contract_id = String(nextContractId);
      }
      setSearchParams(nextParams);
    },
    [activeTab, setSearchParams]
  );

  const handleRefreshOverview = useCallback(() => {
    return fetchOverviewData(true);
  }, [fetchOverviewData]);

  const apartmentBadge = useMemo(() => {
    const c = overview?.active_contract || overview?.contract;
    if (c?.apartment_code) {
      return `Căn ${c.apartment_code}${c.building_name ? ` — ${c.building_name}` : ''}`;
    }
    const r = overview?.reservation;
    if (r?.apartment_code) {
      return `Giữ chỗ Căn ${r.apartment_code}${r.building_name ? ` — ${r.building_name}` : ''}`;
    }
    return 'Tài khoản Cư dân';
  }, [overview]);

  const renderTabContent = () => {
    if (loading) {
      return <PageSkeleton />;
    }

    if (error && !overview) {
      return (
        <Card className="py-12 text-center space-y-4">
          <div className="w-12 h-12 rounded-2xl bg-rose-50 text-rose-600 flex items-center justify-center mx-auto">
            <AlertCircle className="w-6 h-6" />
          </div>
          <div className="space-y-1">
            <h3 className="text-base font-bold text-slate-900">
              Không thể kết nối dữ liệu Cổng cư dân
            </h3>
            <p className="text-xs text-slate-500 max-w-md mx-auto">{error}</p>
          </div>
          <div>
            <Button icon={RefreshCw} onClick={() => fetchOverviewData(false)}>
              Thử tải lại
            </Button>
          </div>
        </Card>
      );
    }

    const commonProps = {
      overview,
      onRefreshOverview: handleRefreshOverview,
      onNavigateTab: handleNavigateTab,
      actionParam,
      onClearActionParam: handleClearActionParam,
    };

    switch (activeTab) {
      case 'overview':
        return (
          <OverviewTab
            {...commonProps}
            openRequestsCount={openRequestsCount}
          />
        );
      case 'contract':
        return <ContractTab {...commonProps} />;
      case 'invoices':
        return <InvoicesTab {...commonProps} />;
      case 'services':
        return <ServicesTab {...commonProps} />;
      case 'maintenance':
        return (
          <MaintenanceTab
            {...commonProps}
            onRequestsChanged={computeOpenRequests}
          />
        );
      case 'notifications':
        return <NotificationsTab {...commonProps} />;
      case 'contact':
        return <ContactTab {...commonProps} />;
      case 'profile':
        return <ProfileTab {...commonProps} />;
      default:
        return (
          <OverviewTab
            {...commonProps}
            openRequestsCount={openRequestsCount}
          />
        );
    }
  };

  return (
    <ResidentLayout
      activeTab={activeTab}
      onChangeTab={(tabId) => handleNavigateTab(tabId)}
      apartmentBadge={apartmentBadge}
      activeContracts={overview?.active_contracts || []}
      selectedContractId={
        overview?.selected_contract_id ||
        overview?.active_contract?.contract_id ||
        contractIdParam
      }
      onSelectContract={handleSelectContract}
    >
      {renderTabContent()}
    </ResidentLayout>
  );
}

export default ResidentPortalPage;
