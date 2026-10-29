import { getAddress, parseEventLogs, erc20Abi, type Hash, type Log } from 'viem';
import { backendAuth, db, eth, privy, SOURCE, toUsdt, TOKEN, TREASURY } from './privy.js';

const CONFIRMATIONS = 12n;
export class RepaymentError extends Error {}

/** Sum of USDT sent to `wallet` in a receipt's logs. */
export function usdtReceived(logs: Log[], wallet: string): bigint {
  return parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs })
    .filter((l) => getAddress(l.address) === TOKEN && getAddress(l.args.to) === wallet)
    .reduce((sum, l) => sum + l.args.value, 0n);
}

type Open = { id: string; principal_outstanding: bigint; interest_outstanding: bigint; fees_outstanding: bigint };

/** Oldest drawdown first; within each: fees -> interest -> principal. */
export function allocate(amount: bigint, open: Open[]) {
  let left = amount, toPrincipal = 0n, toInterestFees = 0n;
  const updates = open.map((d) => {
    const take = (owed: bigint) => { const t = owed < left ? owed : left; left -= t; return t; };
    const fees = take(d.fees_outstanding), interest = take(d.interest_outstanding), principal = take(d.principal_outstanding);
    toInterestFees += fees + interest;
    toPrincipal += principal;
    return { id: d.id, fees: d.fees_outstanding - fees, interest: d.interest_outstanding - interest, principal: d.principal_outstanding - principal };
  });
  return { updates, toPrincipal, toInterestFees, unapplied: left };
}

/** PSP submits the hash of a USDT transfer back into its credit wallet. */
export async function submitRepayment(pspId: string, txHash: Hash) {
  const { rows: [psp] } = await db.query('SELECT * FROM psps WHERE id = $1', [pspId]);
  if (!psp) throw new RepaymentError('unknown PSP');

  const receipt = await eth.getTransactionReceipt({ hash: txHash }).catch(() => null);
  if (!receipt || receipt.status !== 'success') throw new RepaymentError('transaction not found or reverted');
  if ((await eth.getBlockNumber()) - receipt.blockNumber < CONFIRMATIONS) throw new RepaymentError('not enough confirmations yet, retry shortly');
  const amount = usdtReceived(receipt.logs, psp.wallet_address);
  if (amount === 0n) throw new RepaymentError('no USDT transfer to your credit wallet in this transaction');

  const conn = await db.connect();
  let repayment;
  try {
    await conn.query('BEGIN');
    await conn.query('SELECT 1 FROM psps WHERE id = $1 FOR UPDATE', [pspId]);
    const { rows } = await conn.query(
      `SELECT id, principal_outstanding, interest_outstanding, fees_outstanding FROM drawdowns
       WHERE psp_id = $1 AND status = 'disbursed'
         AND principal_outstanding + interest_outstanding + fees_outstanding > 0
       ORDER BY created_at`, [pspId]);
    const open = rows.map((r) => ({ id: r.id, principal_outstanding: BigInt(r.principal_outstanding),
      interest_outstanding: BigInt(r.interest_outstanding), fees_outstanding: BigInt(r.fees_outstanding) }));
    const a = allocate(amount, open);
    for (const u of a.updates) {
      await conn.query(
        'UPDATE drawdowns SET principal_outstanding = $2, interest_outstanding = $3, fees_outstanding = $4 WHERE id = $1',
        [u.id, u.principal.toString(), u.interest.toString(), u.fees.toString()]);
    }
    // UNIQUE(tx_hash) makes a second claim of the same hash fail here.
    ({ rows: [repayment] } = await conn.query(
      `INSERT INTO repayments (psp_id, tx_hash, amount, to_principal, to_interest_fees, unapplied)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [pspId, txHash.toLowerCase(), amount.toString(), a.toPrincipal.toString(), a.toInterestFees.toString(), a.unapplied.toString()]));
    await conn.query('COMMIT');
  } catch (e: any) {
    await conn.query('ROLLBACK');
    if (e?.code === '23505') throw new RepaymentError('transaction hash already submitted');
    throw e;
  } finally {
    conn.release();
  }

  await sweep({ ...repayment, wallet_id: psp.wallet_id }).catch(() => {}); // pollSweeps() retries
  return repayment;
}

// Principal stays in the wallet (limit restored). Interest, fees and overpayment go to treasury.
// ponytail: overpayment is swept too; refund it to the PSP manually if needed.
async function sweep(r: { id: string; wallet_id: string; to_interest_fees: string; unapplied: string }) {
  const amount = BigInt(r.to_interest_fees) + BigInt(r.unapplied);
  if (amount === 0n) return;
  const action = await privy.wallets().transfer(r.wallet_id, {
    source: { ...SOURCE, amount: toUsdt(amount) },
    destination: { address: TREASURY() },
    reference_id: `sweep-${r.id}`,
    idempotency_key: `sweep-${r.id}`,
    authorization_context: backendAuth(),
  });
  await db.query(`UPDATE repayments SET sweep_action_id = $2, sweep_status = 'pending' WHERE id = $1`, [r.id, action.id]);
}

/** Retry unsent sweeps and record finished ones. Run alongside pollDrawdowns(). */
export async function pollSweeps() {
  const { rows } = await db.query(
    `SELECT r.*, p.wallet_id FROM repayments r JOIN psps p ON p.id = r.psp_id
     WHERE (r.sweep_action_id IS NULL AND r.to_interest_fees + r.unapplied > 0) OR r.sweep_status = 'pending'`);
  for (const r of rows) {
    if (!r.sweep_action_id) { await sweep(r).catch(() => {}); continue; }
    const a = await privy.wallets().actions.get(r.sweep_action_id, { wallet_id: r.wallet_id });
    if (a.status !== 'pending') await db.query('UPDATE repayments SET sweep_status = $2 WHERE id = $1', [r.id, a.status]);
  }
}
