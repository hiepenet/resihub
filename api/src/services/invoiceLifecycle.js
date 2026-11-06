import { roundVND } from './pricing.js';
import {
  toDateOnlyYmd,
  addDaysYmd,
  resolveContractLastActiveDay,
  computeContractRentPeriodCharge,
  computeSubscriptionPeriodCharge,
} from './serviceBilling.js';

/**
 * Apply available credit balance FIFO to an invoice (Spec 5.4.2, 5.5.2, FR-033, FR-040).
 * Locks credit rows with status IN ('AVAILABLE', 'PARTIALLY_APPLIED') for update,
 * inserts negative ADJUSTMENT invoice lines attached to credit_id, and updates
 * invoice.credit_offset_amount and total_amount.
 *
 * @param {object} client - Database client (within an active transaction)
 * @param {object} params
 * @param {string} params.contractId - Contract UUID
 * @param {string} params.invoiceId - Invoice UUID
 * @param {number} params.subtotalAmount - Maximum amount to offset
 * @param {string} [params.actorId] - User UUID performing the operation
 * @returns {Promise<{ totalCreditUsed: number, appliedItems: Array<{ creditId: string, amount: number, lineId: string }> }>}
 */
export async function applyAvailableCreditsInTx(
  client,
  { contractId, invoiceId, subtotalAmount, actorId = null }
) {
  if (!invoiceId) throw new Error('invoiceId is required');

  // Verify and lock invoice; non-DRAFT invoices are immutable
  const invRes = await client.query(
    `SELECT id, status FROM invoice WHERE id = $1 FOR UPDATE`,
    [invoiceId]
  );
  if (invRes.rows.length === 0) {
    throw new Error(`Invoice not found: ${invoiceId}`);
  }
  const inv = invRes.rows[0];
  if (inv.status !== 'DRAFT') {
    const err = new Error(
      `IMMUTABLE_AFTER_ISSUED: cannot apply credits to non-DRAFT invoice (status = ${inv.status})`
    );
    err.code = 'IMMUTABLE_AFTER_ISSUED';
    throw err;
  }

  const neededLimit = Math.max(0, Number(subtotalAmount || 0));
  if (neededLimit <= 0 || !contractId) {
    return { totalCreditUsed: 0, appliedItems: [] };
  }

  // FIFO order of available credits
  const creditsRes = await client.query(
    `SELECT * FROM credit_balance
     WHERE contract_id = $1
       AND status IN ('AVAILABLE', 'PARTIALLY_APPLIED')
       AND (amount - applied_amount) > 0
     ORDER BY created_at ASC
     FOR UPDATE`,
    [contractId]
  );

  let remainingNeeded = neededLimit;
  let totalCreditUsed = 0;
  const appliedItems = [];

  for (const cr of creditsRes.rows) {
    if (remainingNeeded <= 0) break;
    const available = Number(cr.amount) - Number(cr.applied_amount);
    if (available <= 0) continue;

    const useAmt = Math.min(remainingNeeded, available);
    const newApplied = Number(cr.applied_amount) + useAmt;
    const newStatus = newApplied >= Number(cr.amount) ? 'APPLIED' : 'PARTIALLY_APPLIED';

    await client.query(
      `UPDATE credit_balance
       SET applied_amount = $1, status = $2, updated_by = $3, updated_at = NOW()
       WHERE id = $4`,
      [newApplied, newStatus, actorId, cr.id]
    );

    const lineRes = await client.query(
      `INSERT INTO invoice_line (
         invoice_id, item_type, description, quantity, unit, unit_price, amount, credit_id
       )
       VALUES ($1, 'ADJUSTMENT', 'Bù trừ số dư tín dụng hợp đồng', 1, 'lần', $2, $2, $3)
       RETURNING id`,
      [invoiceId, -useAmt, cr.id]
    );

    appliedItems.push({
      creditId: cr.id,
      amount: useAmt,
      lineId: lineRes.rows[0].id,
    });

    totalCreditUsed += useAmt;
    remainingNeeded -= useAmt;
  }

  if (totalCreditUsed > 0) {
    await client.query(
      `UPDATE invoice
       SET credit_offset_amount = credit_offset_amount + $1,
           total_amount = GREATEST(0, total_amount - $1),
           updated_at = NOW()
       WHERE id = $2`,
      [totalCreditUsed, invoiceId]
    );
  }

  return { totalCreditUsed, appliedItems };
}

/**
 * Release credit offset from an invoice back to credit_balance (Spec 5.4.2, 5.5.2).
 * Only mutates credit_balance rows in status ('AVAILABLE', 'PARTIALLY_APPLIED', 'APPLIED').
 *
 * @param {object} client - Database client (within an active transaction)
 * @param {object} params
 * @param {string} params.invoiceId - Invoice UUID
 * @param {number|null} [params.maxReleaseAmount] - Optional maximum amount to release (null for all)
 * @param {string} [params.actorId] - User UUID
 * @returns {Promise<{ releasedAmount: number, remainingCreditOffset: number }>}
 */
export async function releaseInvoiceCreditsInTx(
  client,
  { invoiceId, maxReleaseAmount = null, actorId = null }
) {
  if (!invoiceId) {
    return { releasedAmount: 0, remainingCreditOffset: 0 };
  }

  const invRes = await client.query(
    `SELECT id, credit_offset_amount, subtotal_amount, adjustment_amount, status
     FROM invoice WHERE id = $1 FOR UPDATE`,
    [invoiceId]
  );
  if (invRes.rows.length === 0) {
    return { releasedAmount: 0, remainingCreditOffset: 0 };
  }
  const inv = invRes.rows[0];
  const currentOffset = Number(inv.credit_offset_amount || 0);
  if (currentOffset <= 0) {
    return { releasedAmount: 0, remainingCreditOffset: 0 };
  }

  const limitToRelease =
    maxReleaseAmount !== null && maxReleaseAmount !== undefined
      ? Math.min(Math.max(0, Number(maxReleaseAmount)), currentOffset)
      : currentOffset;

  if (limitToRelease <= 0) {
    return { releasedAmount: 0, remainingCreditOffset: currentOffset };
  }

  // Credit lines on invoice: item_type = 'ADJUSTMENT' AND credit_id IS NOT NULL AND amount < 0
  const crLinesRes = await client.query(
    `SELECT il.id AS line_id, il.credit_id, ABS(il.amount) AS line_amt,
            cb.amount AS cb_amount, cb.applied_amount, cb.status AS cb_status
     FROM invoice_line il
     JOIN credit_balance cb ON cb.id = il.credit_id
     WHERE il.invoice_id = $1
       AND il.credit_id IS NOT NULL
       AND il.amount < 0
       AND cb.status IN ('AVAILABLE', 'PARTIALLY_APPLIED', 'APPLIED')
     ORDER BY cb.created_at DESC, il.id DESC
     FOR UPDATE OF cb`,
    [invoiceId]
  );

  let remainingToRelease = limitToRelease;
  let totalReleased = 0;

  for (const row of crLinesRes.rows) {
    if (remainingToRelease <= 0) break;
    const lineAmt = Number(row.line_amt);
    const cbApplied = Number(row.applied_amount);
    const rel = Math.min(remainingToRelease, lineAmt, cbApplied);
    if (rel <= 0) continue;

    const newApplied = Math.max(0, cbApplied - rel);
    const newStatus = newApplied > 0 ? 'PARTIALLY_APPLIED' : 'AVAILABLE';

    await client.query(
      `UPDATE credit_balance
       SET applied_amount = $1, status = $2, updated_by = $3, updated_at = NOW()
       WHERE id = $4`,
      [newApplied, newStatus, actorId, row.credit_id]
    );

    // If DRAFT, adjust or remove line
    if (inv.status === 'DRAFT') {
      if (rel >= lineAmt) {
        await client.query(`DELETE FROM invoice_line WHERE id = $1`, [row.line_id]);
      } else {
        const newLineAmt = lineAmt - rel;
        await client.query(
          `UPDATE invoice_line
           SET unit_price = $1, amount = $1
           WHERE id = $2`,
          [-newLineAmt, row.line_id]
        );
      }
    }

    totalReleased += rel;
    remainingToRelease -= rel;
  }

  const newOffset = Math.max(0, currentOffset - totalReleased);

  if (inv.status === 'DRAFT' && totalReleased > 0) {
    await client.query(
      `UPDATE invoice
       SET credit_offset_amount = $1,
           total_amount = GREATEST(0, total_amount + $2),
           updated_at = NOW()
       WHERE id = $3`,
      [newOffset, totalReleased, invoiceId]
    );
  } else {
    await client.query(
      `UPDATE invoice
       SET credit_offset_amount = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [newOffset, invoiceId]
    );
  }

  return { releasedAmount: totalReleased, remainingCreditOffset: newOffset };
}

/**
 * Recalculate totals on a DRAFT invoice (Spec 5.4.2, FR-033, FR-034).
 * Preserves manual discount lines (credit_id IS NULL) separate from credit offset lines (credit_id IS NOT NULL).
 * Releases surplus credit_balance when subtotal + manualAdj < credit_offset_amount.
 * Auto-voids zero-subtotal draft invoice when autoVoidIfZero is true and invoice is unpaid.
 *
 * @param {object} client - Database client (within an active transaction)
 * @param {object} params
 * @param {string} params.invoiceId - Invoice UUID
 * @param {string} [params.actorId] - User UUID
 * @param {boolean} [params.autoVoidIfZero=false] - Auto-void invoice if subtotal is 0 and unpaid
 * @param {string|null} [params.voidReason=null] - Reason for voiding
 * @returns {Promise<{ invoice: object, lines: object[], releasedCreditAmount: number, autoVoided: boolean }>}
 */
export async function recalculateDraftInvoiceTotalsInTx(
  client,
  { invoiceId, actorId = null, autoVoidIfZero = false, voidReason = null }
) {
  if (!invoiceId) throw new Error('invoiceId is required');

  const invRes = await client.query(
    `SELECT * FROM invoice WHERE id = $1 FOR UPDATE`,
    [invoiceId]
  );
  if (invRes.rows.length === 0) {
    throw new Error(`Invoice not found: ${invoiceId}`);
  }
  const oldInv = invRes.rows[0];
  if (oldInv.status !== 'DRAFT') {
    throw new Error(`Cannot recalculate non-DRAFT invoice (status = ${oldInv.status})`);
  }

  const linesRes = await client.query(
    `SELECT * FROM invoice_line WHERE invoice_id = $1 ORDER BY created_at ASC`,
    [invoiceId]
  );
  const oldLines = linesRes.rows;

  // Subtotal = sum of non-ADJUSTMENT lines
  const grossSubtotal = roundVND(
    oldLines
      .filter((l) => l.item_type !== 'ADJUSTMENT')
      .reduce((s, l) => s + Number(l.amount || 0), 0)
  );

  // Manual adjustment = sum of ADJUSTMENT lines where credit_id IS NULL
  const manualAdj = roundVND(
    oldLines
      .filter((l) => l.item_type === 'ADJUSTMENT' && !l.credit_id)
      .reduce((s, l) => s + Number(l.amount || 0), 0)
  );

  const grossPayable = Math.max(0, grossSubtotal + manualAdj);
  const currentCreditOffset = Number(oldInv.credit_offset_amount || 0);

  let releasedCreditAmount = 0;
  let finalCreditOffset = currentCreditOffset;

  // If grossPayable is less than current credit offset, release surplus credits
  if (grossPayable < currentCreditOffset) {
    const surplus = currentCreditOffset - grossPayable;
    const relRes = await releaseInvoiceCreditsInTx(client, {
      invoiceId,
      maxReleaseAmount: surplus,
      actorId,
    });
    releasedCreditAmount = relRes.releasedAmount;
    finalCreditOffset = relRes.remainingCreditOffset;
  }

  const isZero = grossSubtotal === 0;
  const isUnpaid = Number(oldInv.paid_amount || 0) === 0;
  let autoVoided = false;

  if (autoVoidIfZero && isZero && isUnpaid) {
    if (finalCreditOffset > 0) {
      const relAll = await releaseInvoiceCreditsInTx(client, {
        invoiceId,
        maxReleaseAmount: null,
        actorId,
      });
      releasedCreditAmount += relAll.releasedAmount;
      finalCreditOffset = relAll.remainingCreditOffset;
    }

    await client.query('SELECT fn_sync_late_fee_trackers_on_invoice_void($1)', [invoiceId]);

    await client.query(
      `UPDATE invoice
       SET status = 'VOID',
           subtotal_amount = 0,
           adjustment_amount = 0,
           total_amount = 0,
           credit_offset_amount = 0,
           updated_at = NOW()
       WHERE id = $1`,
      [invoiceId]
    );

    autoVoided = true;

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'UPDATE_INVOICE_STATUS', 'invoice', $2, $3, $4)`,
      [
        actorId,
        invoiceId,
        JSON.stringify({ status: 'DRAFT', subtotal_amount: oldInv.subtotal_amount }),
        JSON.stringify({
          status: 'VOID',
          reason: voidReason || 'Auto voided zero amount draft',
        }),
      ]
    );
  } else {
    const finalTotal = Math.max(0, grossPayable - finalCreditOffset);

    await client.query(
      `UPDATE invoice
       SET subtotal_amount = $1,
           adjustment_amount = $2,
           total_amount = $3,
           credit_offset_amount = $4,
           updated_at = NOW()
       WHERE id = $5`,
      [grossSubtotal, manualAdj, finalTotal, finalCreditOffset, invoiceId]
    );

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'UPDATE_DRAFT_INVOICE_LINES', 'invoice', $2, $3, $4)`,
      [
        actorId,
        invoiceId,
        JSON.stringify({
          subtotal_amount: Number(oldInv.subtotal_amount || 0),
          adjustment_amount: Number(oldInv.adjustment_amount || 0),
          total_amount: Number(oldInv.total_amount || 0),
          credit_offset_amount: Number(oldInv.credit_offset_amount || 0),
        }),
        JSON.stringify({
          subtotal_amount: grossSubtotal,
          adjustment_amount: manualAdj,
          total_amount: finalTotal,
          credit_offset_amount: finalCreditOffset,
        }),
      ]
    );
  }

  const updatedInvRes = await client.query(`SELECT * FROM invoice WHERE id = $1`, [invoiceId]);
  const finalLinesRes = await client.query(
    `SELECT * FROM invoice_line WHERE invoice_id = $1 ORDER BY created_at ASC`,
    [invoiceId]
  );

  return {
    invoice: updatedInvRes.rows[0],
    lines: finalLinesRes.rows,
    releasedCreditAmount,
    autoVoided,
  };
}

/**
 * Send notification to building managers/owners about pending invoice adjustment (Task 1 / 3).
 * Works on both appPool (with MANAGER session) and adminPool (internal postgres session).
 *
 * @param {object} client - Database client
 * @param {object} params
 */
export async function notifyBuildingInvoiceAdjustmentApprovers(
  client,
  { orgId, buildingId, invoiceId, invoiceCode, adjustmentId, actionType, deltaAmount, actorId = null }
) {
  if (!buildingId) return;

  const type = 'INVOICE_ADJUSTMENT_PENDING';
  const code = invoiceCode || String(invoiceId).slice(0, 8);
  const title =
    actionType === 'VOID'
      ? 'Đề nghị hủy hóa đơn chờ duyệt'
      : 'Đề nghị điều chỉnh hóa đơn chờ duyệt';
  const deltaStr =
    deltaAmount !== undefined && deltaAmount !== null
      ? `${Number(deltaAmount) > 0 ? '+' : ''}${Number(deltaAmount).toLocaleString('vi-VN')} ₫`
      : '';
  const message =
    actionType === 'VOID'
      ? `Hóa đơn ${code} có đề nghị hủy cần phê duyệt.`
      : `Hóa đơn ${code} có đề nghị điều chỉnh số tiền ${deltaStr} cần phê duyệt.`;

  const metadata = {
    invoice_id: invoiceId,
    invoice_code: invoiceCode,
    adjustment_id: adjustmentId,
    action_type: actionType,
    delta_amount: deltaAmount,
    actor_id: actorId,
  };

  await client.query(
    `SELECT fn_notify_building_finance_actors($1, $2, $3, $4, $5::jsonb)`,
    [buildingId, type, title, message, JSON.stringify(metadata)]
  );
}

/**
 * Synchronize subscription termination with invoices across 3 scenarios (Spec 5.3.1, 5.4, PRD AC-015.1):
 * - Scenario 1 (UNBILLED): Future or unbilled periods -> no invoice changes.
 * - Scenario 2 (DRAFT_UPDATED): DRAFT invoice updated in place with pro-rata charges, surplus credit release, audit_log.
 * - Scenario 3 (ADJUSTMENT_CREATED): ISSUED/PAID invoice -> immutable invoice_line + PENDING_APPROVAL invoice_adjustment + notification.
 * Past periods (prior to termination period) are completely preserved.
 *
 * @param {object} client - Database client (within an active transaction)
 * @param {object} params
 * @param {object} params.subscription - The terminated subscription
 * @param {object} params.contract - Contract record
 * @param {string} [params.actorId] - User UUID
 * @param {string} [params.reason] - Termination / adjustment reason
 * @returns {Promise<{ scenario: 'UNBILLED' | 'DRAFT_UPDATED' | 'ADJUSTMENT_CREATED' | 'MIXED' | 'NO_CHANGE', updatedDraftInvoiceIds: string[], voidedDraftInvoiceIds: string[], createdAdjustments: object[] }>}
 */
export async function syncSubscriptionTerminationInvoicesInTx(
  client,
  { subscription, contract, actorId = null, reason = null }
) {
  const contractId = contract?.id || subscription?.contract_id;
  const buildingId = contract?.building_id || subscription?.building_id;
  const endYmd = subscription?.end_date ? toDateOnlyYmd(subscription.end_date) : '';
  const endPeriod = endYmd ? endYmd.slice(0, 7) : '';

  // Query all active non-VOID invoices for this contract in termination period or later
  // Past periods (period < endPeriod) are preserved!
  const invoiceParams = [contractId];
  let periodFilter = '';
  if (endPeriod) {
    invoiceParams.push(endPeriod);
    periodFilter = `AND period >= $2`;
  }

  const invoicesRes = await client.query(
    `SELECT * FROM invoice
     WHERE contract_id = $1
       AND status <> 'VOID'
       ${periodFilter}
     ORDER BY period ASC
     FOR UPDATE`,
    invoiceParams
  );

  const updatedDraftInvoiceIds = [];
  const voidedDraftInvoiceIds = [];
  const createdAdjustments = [];
  let foundAnyMatchingInvoice = false;

  for (const inv of invoicesRes.rows) {
    // Find invoice_line corresponding to this subscription strictly
    const linesRes = await client.query(
      `SELECT * FROM invoice_line
       WHERE invoice_id = $1
         AND subscription_id = $2`,
      [inv.id, subscription.id]
    );

    if (linesRes.rows.length === 0) continue;
    foundAnyMatchingInvoice = true;
    const line = linesRes.rows[0];

    // Compute expected subscription charge for this period
    const charge = computeSubscriptionPeriodCharge({
      subscription,
      periodYm: inv.period,
      contractBuildingId: buildingId,
      lockedUnitPrice: line.unit_price,
      lockedQuantity: line.quantity,
    });

    const newAmt = charge.amount;
    const billedAmt = Number(line.amount || 0);
    const delta = newAmt - billedAmt;

    if (inv.status === 'DRAFT') {
      if (delta === 0) {
        continue;
      }

      if (newAmt === 0) {
        await client.query(`DELETE FROM invoice_line WHERE id = $1`, [line.id]);
      } else {
        await client.query(
          `UPDATE invoice_line
           SET description = $1, quantity = $2, unit_price = $3, amount = $4, formula_meta = $5
           WHERE id = $6`,
          [
            charge.description,
            charge.quantity,
            charge.unitPrice,
            newAmt,
            JSON.stringify(charge.formulaMeta),
            line.id,
          ]
        );
      }

      const recalc = await recalculateDraftInvoiceTotalsInTx(client, {
        invoiceId: inv.id,
        actorId,
        autoVoidIfZero: true,
        voidReason: reason || 'Hủy dịch vụ: hóa đơn nháp rỗng 0 ₫',
      });

      if (recalc.autoVoided) {
        voidedDraftInvoiceIds.push(inv.id);
      } else {
        updatedDraftInvoiceIds.push(inv.id);
      }
    } else {
      // Non-DRAFT invoice: line is IMMUTABLE! Create invoice_adjustment
      if (delta === 0) {
        continue;
      }

      // Check partial unique index: (invoice_id, subscription_id) WHERE subscription_id IS NOT NULL AND status = 'PENDING_APPROVAL'
      const existingAdjRes = await client.query(
        `SELECT * FROM invoice_adjustment
         WHERE invoice_id = $1 AND subscription_id = $2 AND status = 'PENDING_APPROVAL'
         FOR UPDATE`,
        [inv.id, subscription.id]
      );

      let adj;
      let isNewOrUpdated = false;
      if (existingAdjRes.rows.length > 0) {
        const existingAdj = existingAdjRes.rows[0];
        if (Number(existingAdj.delta_amount) !== delta) {
          const updAdj = await client.query(
            `UPDATE invoice_adjustment
             SET delta_amount = $1, formula_meta = $2, reason = $3, updated_by = $4, updated_at = NOW()
             WHERE id = $5
             RETURNING *`,
            [
              delta,
              JSON.stringify(charge.formulaMeta),
              reason || 'Điều chỉnh giảm phí dịch vụ do chấm dứt',
              actorId,
              existingAdj.id,
            ]
          );
          adj = updAdj.rows[0];
          isNewOrUpdated = true;
        } else {
          adj = existingAdj;
          isNewOrUpdated = false;
        }
      } else {
        const insAdj = await client.query(
          `INSERT INTO invoice_adjustment (
             org_id, building_id, invoice_id, subscription_id,
             adjustment_target, action_type, delta_amount, reason, formula_meta,
             status, created_by, updated_by
           )
           VALUES ($1, $2, $3, $4, 'SERVICE', 'ADJUST', $5, $6, $7, 'PENDING_APPROVAL', $8, $8)
           RETURNING *`,
          [
            inv.org_id,
            inv.building_id,
            inv.id,
            subscription.id,
            delta,
            reason || 'Điều chỉnh giảm phí dịch vụ do chấm dứt',
            JSON.stringify(charge.formulaMeta),
            actorId,
          ]
        );
        adj = insAdj.rows[0];
        isNewOrUpdated = true;
      }

      if (isNewOrUpdated) {
        await notifyBuildingInvoiceAdjustmentApprovers(client, {
          orgId: inv.org_id,
          buildingId: inv.building_id,
          invoiceId: inv.id,
          invoiceCode: inv.invoice_code,
          adjustmentId: adj.id,
          actionType: 'ADJUST',
          deltaAmount: delta,
          actorId,
        });

        createdAdjustments.push(adj);
      }
    }
  }

  let scenario;
  const hasDraftChanges = updatedDraftInvoiceIds.length > 0 || voidedDraftInvoiceIds.length > 0;
  const hasAdjustments = createdAdjustments.length > 0;

  if (hasDraftChanges && hasAdjustments) {
    scenario = 'MIXED';
  } else if (hasDraftChanges) {
    scenario = 'DRAFT_UPDATED';
  } else if (hasAdjustments) {
    scenario = 'ADJUSTMENT_CREATED';
  } else if (foundAnyMatchingInvoice) {
    scenario = 'NO_CHANGE';
  } else {
    scenario = 'UNBILLED';
  }

  return {
    scenario,
    updatedDraftInvoiceIds,
    voidedDraftInvoiceIds,
    createdAdjustments,
  };
}

/**
 * Option 6A Contract Closure: Closes contract billing, terminates subscriptions,
 * syncs RENT + SERVICE charges on DRAFT and ISSUED invoices (Spec 5.3.2, 5.4).
 *
 * @param {object} client - Database client (within an active transaction)
 * @param {object} params
 * @param {object} params.contract - Contract record
 * @param {string|null} [params.explicitEndYmd] - Explicit termination date
 * @param {string|null} [params.roomTransferChildStartDate] - Child contract start date for room transfers
 * @param {boolean} [params.isNaturalExpiry] - Whether natural lease expiration
 * @param {boolean} [params.isRoomTransfer] - Whether room transfer
 * @param {string} [params.actorId] - User UUID
 * @param {string|null} [params.adjustmentCreatorId] - User UUID to record as creator of adjustments
 * @param {string} [params.reason] - Termination reason
 * @returns {Promise<{ movedIn: boolean, lastActiveDayYmd: string, terminatedSubscriptionIds: string[], updatedDraftInvoiceIds: string[], voidedDraftInvoiceIds: string[], createdAdjustments: object[] }>}
 */
export async function closeContractBillingAndSubscriptionsInTx(
  client,
  {
    contract,
    explicitEndYmd = null,
    roomTransferChildStartDate = null,
    isNaturalExpiry = false,
    isRoomTransfer = false,
    actorId = null,
    adjustmentCreatorId = null,
    reason = null,
  }
) {
  const { movedIn, lastActiveDayYmd } = resolveContractLastActiveDay(contract, {
    explicitEndYmd,
    roomTransferChildStartDate,
    isNaturalExpiry,
    isRoomTransfer,
  });

  const adjCreator = adjustmentCreatorId || actorId;

  // Terminate all active/pending subscriptions on this contract
  const subsRes = await client.query(
    `SELECT ss.*, sc.name AS service_name, sc.code AS service_code
     FROM service_subscription ss
     LEFT JOIN service_catalog sc ON sc.id = ss.service_id
     WHERE ss.contract_id = $1
       AND ss.status IN ('ACTIVE', 'PENDING_APPROVAL', 'CANCELLATION_PENDING')
     FOR UPDATE OF ss`,
    [contract.id]
  );

  const terminatedSubscriptionIds = [];
  const updatedSubscriptions = [];

  for (const sub of subsRes.rows) {
    let subEndDate = null;
    if (!movedIn) {
      const subStart = toDateOnlyYmd(sub.start_date);
      subEndDate = subStart ? addDaysYmd(subStart, -1) : (lastActiveDayYmd || '1970-01-01');
    } else {
      const origEnd = sub.end_date ? toDateOnlyYmd(sub.end_date) : null;
      subEndDate = origEnd && origEnd < lastActiveDayYmd ? origEnd : lastActiveDayYmd;
    }

    await client.query(
      `UPDATE service_subscription
       SET status = 'TERMINATED',
           end_date = $1,
           is_price_locked = TRUE,
           updated_at = NOW()
       WHERE id = $2`,
      [subEndDate, sub.id]
    );

    terminatedSubscriptionIds.push(sub.id);
    updatedSubscriptions.push({
      ...sub,
      status: 'TERMINATED',
      end_date: subEndDate,
      is_price_locked: true,
    });
  }

  // Sync contract invoices
  const invoicesRes = await client.query(
    `SELECT * FROM invoice
     WHERE contract_id = $1
       AND status <> 'VOID'
     ORDER BY period ASC
     FOR UPDATE`,
    [contract.id]
  );

  const endPeriod = lastActiveDayYmd ? lastActiveDayYmd.slice(0, 7) : '';
  const updatedDraftInvoiceIds = [];
  const voidedDraftInvoiceIds = [];
  const createdAdjustments = [];

  for (const inv of invoicesRes.rows) {
    // Only process invoices where period >= endPeriod (if movedIn). If !movedIn, process all.
    if (movedIn && endPeriod && inv.period < endPeriod) {
      continue;
    }

    const linesRes = await client.query(
      `SELECT * FROM invoice_line WHERE invoice_id = $1 ORDER BY created_at ASC`,
      [inv.id]
    );
    const lines = linesRes.rows;

    if (inv.status === 'DRAFT') {
      // 1. Sync RENT line
      const rentLine = lines.find((l) => l.item_type === 'RENT');
      if (rentLine) {
        if (!movedIn) {
          await client.query(`DELETE FROM invoice_line WHERE id = $1`, [rentLine.id]);
        } else {
          const rentCharge = computeContractRentPeriodCharge({
            contract,
            periodYm: inv.period,
            lastActiveDayYmd,
            lockedRentAmount: rentLine.unit_price,
          });
          if (rentCharge.amount === 0) {
            await client.query(`DELETE FROM invoice_line WHERE id = $1`, [rentLine.id]);
          } else {
            await client.query(
              `UPDATE invoice_line
               SET description = $1, quantity = $2, unit_price = $3, amount = $4, formula_meta = $5
               WHERE id = $6`,
              [
                rentCharge.description,
                rentCharge.quantity || 1,
                rentCharge.unitPrice,
                rentCharge.amount,
                JSON.stringify(rentCharge.formulaMeta),
                rentLine.id,
              ]
            );
          }
        }
      }

      // 2. Sync SERVICE lines with subscription_id (ad-hoc lines with subscription_id IS NULL are untouched!)
      const subLines = lines.filter((l) => l.item_type === 'SERVICE' && l.subscription_id);
      for (const sLine of subLines) {
        const sub =
          updatedSubscriptions.find((s) => s.id === sLine.subscription_id) ||
          (
            await client.query('SELECT * FROM service_subscription WHERE id = $1', [
              sLine.subscription_id,
            ])
          ).rows[0];

        if (!sub) continue;

        const subCharge = computeSubscriptionPeriodCharge({
          subscription: sub,
          periodYm: inv.period,
          contractBuildingId: contract.building_id,
          lockedUnitPrice: sLine.unit_price,
          lockedQuantity: sLine.quantity,
        });

        if (subCharge.amount === 0) {
          await client.query(`DELETE FROM invoice_line WHERE id = $1`, [sLine.id]);
        } else {
          await client.query(
            `UPDATE invoice_line
             SET description = $1, quantity = $2, unit_price = $3, amount = $4, formula_meta = $5
             WHERE id = $6`,
            [
              subCharge.description,
              subCharge.quantity,
              subCharge.unitPrice,
              subCharge.amount,
              JSON.stringify(subCharge.formulaMeta),
              sLine.id,
            ]
          );
        }
      }

      const recalc = await recalculateDraftInvoiceTotalsInTx(client, {
        invoiceId: inv.id,
        actorId,
        autoVoidIfZero: true,
        voidReason: reason || 'Đóng hợp đồng sớm: hóa đơn nháp rỗng 0 ₫',
      });

      if (recalc.autoVoided) {
        voidedDraftInvoiceIds.push(inv.id);
      } else {
        updatedDraftInvoiceIds.push(inv.id);
      }
    } else {
      // Non-DRAFT invoices: lines are IMMUTABLE!
      if (!movedIn) {
        // Unpaid ISSUED invoice gets PENDING_APPROVAL VOID adjustment
        if (Number(inv.paid_amount || 0) === 0) {
          const existingVoidRes = await client.query(
            `SELECT * FROM invoice_adjustment
             WHERE invoice_id = $1 AND action_type = 'VOID' AND status = 'PENDING_APPROVAL'
             FOR UPDATE`,
            [inv.id]
          );
          if (existingVoidRes.rows.length === 0) {
            const adjIns = await client.query(
              `INSERT INTO invoice_adjustment (
                 org_id, building_id, invoice_id, adjustment_target, action_type, delta_amount,
                 reason, status, created_by, updated_by
               )
               VALUES ($1, $2, $3, 'MANUAL', 'VOID', 0, $4, 'PENDING_APPROVAL', $5, $5)
               RETURNING *`,
              [
                inv.org_id,
                inv.building_id,
                inv.id,
                reason || 'Hủy hóa đơn do chấm dứt hợp đồng trước ngày vào ở',
                adjCreator,
              ]
            );
            const adj = adjIns.rows[0];
            await notifyBuildingInvoiceAdjustmentApprovers(client, {
              orgId: inv.org_id,
              buildingId: inv.building_id,
              invoiceId: inv.id,
              invoiceCode: inv.invoice_code,
              adjustmentId: adj.id,
              actionType: 'VOID',
              deltaAmount: 0,
              actorId,
            });
            createdAdjustments.push(adj);
          }
        }
      } else {
        // Moved in: check RENT adjustment
        const rentLine = lines.find((l) => l.item_type === 'RENT');
        if (rentLine) {
          const rentCharge = computeContractRentPeriodCharge({
            contract,
            periodYm: inv.period,
            lastActiveDayYmd,
            lockedRentAmount: rentLine.unit_price,
          });
          const rentDelta = rentCharge.amount - Number(rentLine.amount || 0);

          if (rentDelta !== 0) {
            const existingRentAdjRes = await client.query(
              `SELECT * FROM invoice_adjustment
               WHERE invoice_id = $1 AND adjustment_target = 'RENT' AND status = 'PENDING_APPROVAL'
               FOR UPDATE`,
              [inv.id]
            );

            if (existingRentAdjRes.rows.length === 0) {
              const adjIns = await client.query(
                `INSERT INTO invoice_adjustment (
                   org_id, building_id, invoice_id, adjustment_target, action_type, delta_amount,
                   reason, formula_meta, status, created_by, updated_by
                 )
                 VALUES ($1, $2, $3, 'RENT', 'ADJUST', $4, $5, $6, 'PENDING_APPROVAL', $7, $7)
                 RETURNING *`,
                [
                  inv.org_id,
                  inv.building_id,
                  inv.id,
                  rentDelta,
                  reason || 'Điều chỉnh tiền thuê do chấm dứt hợp đồng',
                  JSON.stringify(rentCharge.formulaMeta),
                  adjCreator,
                ]
              );
              const adj = adjIns.rows[0];
              await notifyBuildingInvoiceAdjustmentApprovers(client, {
                orgId: inv.org_id,
                buildingId: inv.building_id,
                invoiceId: inv.id,
                invoiceCode: inv.invoice_code,
                adjustmentId: adj.id,
                actionType: 'ADJUST',
                deltaAmount: rentDelta,
                actorId,
              });
              createdAdjustments.push(adj);
            }
          }
        }

        // Check SERVICE adjustments for lines with subscription_id
        const subLines = lines.filter((l) => l.item_type === 'SERVICE' && l.subscription_id);
        for (const sLine of subLines) {
          const sub =
            updatedSubscriptions.find((s) => s.id === sLine.subscription_id) ||
            (
              await client.query('SELECT * FROM service_subscription WHERE id = $1', [
                sLine.subscription_id,
              ])
            ).rows[0];

          if (!sub) continue;

          const subCharge = computeSubscriptionPeriodCharge({
            subscription: sub,
            periodYm: inv.period,
            contractBuildingId: contract.building_id,
            lockedUnitPrice: sLine.unit_price,
            lockedQuantity: sLine.quantity,
          });
          const subDelta = subCharge.amount - Number(sLine.amount || 0);

          if (subDelta !== 0) {
            const existingSubAdjRes = await client.query(
              `SELECT * FROM invoice_adjustment
               WHERE invoice_id = $1 AND subscription_id = $2 AND status = 'PENDING_APPROVAL'
               FOR UPDATE`,
              [inv.id, sub.id]
            );

            if (existingSubAdjRes.rows.length === 0) {
              const adjIns = await client.query(
                `INSERT INTO invoice_adjustment (
                   org_id, building_id, invoice_id, subscription_id, adjustment_target, action_type, delta_amount,
                   reason, formula_meta, status, created_by, updated_by
                 )
                 VALUES ($1, $2, $3, $4, 'SERVICE', 'ADJUST', $5, $6, $7, 'PENDING_APPROVAL', $8, $8)
                 RETURNING *`,
                [
                  inv.org_id,
                  inv.building_id,
                  inv.id,
                  sub.id,
                  subDelta,
                  reason || 'Điều chỉnh dịch vụ do chấm dứt hợp đồng',
                  JSON.stringify(subCharge.formulaMeta),
                  adjCreator,
                ]
              );
              const adj = adjIns.rows[0];
              await notifyBuildingInvoiceAdjustmentApprovers(client, {
                orgId: inv.org_id,
                buildingId: inv.building_id,
                invoiceId: inv.id,
                invoiceCode: inv.invoice_code,
                adjustmentId: adj.id,
                actionType: 'ADJUST',
                deltaAmount: subDelta,
                actorId,
              });
              createdAdjustments.push(adj);
            }
          }
        }
      }
    }
  }

  return {
    movedIn,
    lastActiveDayYmd,
    terminatedSubscriptionIds,
    updatedDraftInvoiceIds,
    voidedDraftInvoiceIds,
    createdAdjustments,
  };
}

/**
 * Transfer credits from one contract to another (e.g. room transfer or renewal).
 * Retains retainAmount on the source contract and transfers only the excess.
 *
 * @param {object} client - Database client (within an active transaction)
 * @param {object} params
 * @param {string} params.fromContractId - Source contract UUID
 * @param {string} params.toContractId - Target contract UUID
 * @param {string} [params.toBuildingId] - Target building UUID
 * @param {number} [params.retainAmount=0] - Amount to retain on source contract
 * @param {string} [params.actorId] - User UUID
 * @param {string} [params.reason] - Transfer reason
 * @returns {Promise<{ transferredTotal: number, retainedTotal: number, count: number }>}
 */
export async function transferContractCreditsInTx(
  client,
  { fromContractId, toContractId, toBuildingId = null, retainAmount = 0, actorId = null, reason = null }
) {
  if (!fromContractId || !toContractId) {
    throw new Error('fromContractId and toContractId are required');
  }

  const creditsRes = await client.query(
    `SELECT * FROM credit_balance
     WHERE contract_id = $1
       AND status IN ('AVAILABLE', 'PARTIALLY_APPLIED')
       AND (amount - applied_amount) > 0
     ORDER BY created_at ASC
     FOR UPDATE`,
    [fromContractId]
  );

  const totalAvail = creditsRes.rows.reduce(
    (s, r) => s + (Number(r.amount) - Number(r.applied_amount)),
    0
  );
  const targetRetain = Math.max(0, Number(retainAmount || 0));

  if (totalAvail <= targetRetain) {
    return { transferredTotal: 0, retainedTotal: totalAvail, count: 0 };
  }

  let remainingRetain = targetRetain;
  let transferredTotal = 0;
  let count = 0;

  for (const cr of creditsRes.rows) {
    const avail = Number(cr.amount) - Number(cr.applied_amount);
    if (avail <= 0) continue;

    let retainFromThis = 0;
    if (remainingRetain > 0) {
      retainFromThis = Math.min(avail, remainingRetain);
      remainingRetain -= retainFromThis;
    }

    const transferFromThis = avail - retainFromThis;
    if (transferFromThis > 0) {
      const newApplied = Number(cr.applied_amount) + transferFromThis;
      if (newApplied >= Number(cr.amount) && retainFromThis === 0 && Number(cr.applied_amount) === 0) {
        await client.query(
          `UPDATE credit_balance
           SET status = 'TRANSFERRED', applied_amount = amount, updated_by = $1, updated_at = NOW()
           WHERE id = $2`,
          [actorId, cr.id]
        );
      } else {
        const newStatus = newApplied >= Number(cr.amount) ? 'APPLIED' : 'PARTIALLY_APPLIED';
        await client.query(
          `UPDATE credit_balance
           SET applied_amount = $1, status = $2, updated_by = $3, updated_at = NOW()
           WHERE id = $4`,
          [newApplied, newStatus, actorId, cr.id]
        );
      }

      await client.query(
        `INSERT INTO credit_balance (
           org_id, building_id, contract_id, tenant_id, parent_credit_id,
           reason_type, amount, applied_amount, status, description, created_by, updated_by
         )
         VALUES ($1, $2, $3, $4, $5, 'TRANSFERRED_IN', $6, 0, 'AVAILABLE', $7, $8, $8)`,
        [
          cr.org_id,
          toBuildingId || cr.building_id,
          toContractId,
          cr.tenant_id,
          cr.id,
          transferFromThis,
          reason || 'Chuyển số dư tín dụng từ hợp đồng cũ',
          actorId,
        ]
      );

      transferredTotal += transferFromThis;
      count++;
    }
  }

  return { transferredTotal, retainedTotal: targetRetain, count };
}
