-- ============================================================================
-- Migration 010: Performance Indexes & RLS Subquery Optimization (Week 11-12)
-- ============================================================================

-- 1. Composite Indexes for Finance & Reporting Queries
CREATE INDEX IF NOT EXISTS idx_invoice_org_period_status ON invoice(org_id, period, status);
CREATE INDEX IF NOT EXISTS idx_invoice_line_subscription_id ON invoice_line(subscription_id) WHERE subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_org_status_paid_at ON payment(org_id, status, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_receivable_org_status_due ON receivable(org_id, status, due_date);

-- 2. Optimize RLS Policies on invoice_line & deposit_transaction to use EXISTS (Index Lookup) instead of IN (Full Subquery Scan)
DROP POLICY IF EXISTS rls_deposit_txn_select ON deposit_transaction;
CREATE POLICY rls_deposit_txn_select ON deposit_transaction FOR SELECT USING (
  (SELECT is_org_admin())
  OR EXISTS (SELECT 1 FROM deposit d WHERE d.id = deposit_transaction.deposit_id)
);

DROP POLICY IF EXISTS rls_invoice_line_select ON invoice_line;
CREATE POLICY rls_invoice_line_select ON invoice_line FOR SELECT USING (
  (SELECT is_org_admin())
  OR EXISTS (SELECT 1 FROM invoice i WHERE i.id = invoice_line.invoice_id)
);

DROP POLICY IF EXISTS rls_invoice_line_insert ON invoice_line;
CREATE POLICY rls_invoice_line_insert ON invoice_line FOR INSERT WITH CHECK (
  (SELECT is_manager())
  AND EXISTS (
    SELECT 1 FROM invoice i
    WHERE i.id = invoice_line.invoice_id
      AND i.building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
);

DROP POLICY IF EXISTS rls_invoice_line_update ON invoice_line;
CREATE POLICY rls_invoice_line_update ON invoice_line FOR UPDATE USING (
  (SELECT is_manager())
  AND EXISTS (
    SELECT 1 FROM invoice i
    WHERE i.id = invoice_line.invoice_id
      AND i.building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
) WITH CHECK (
  (SELECT is_manager())
  AND EXISTS (
    SELECT 1 FROM invoice i
    WHERE i.id = invoice_line.invoice_id
      AND i.building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
);

