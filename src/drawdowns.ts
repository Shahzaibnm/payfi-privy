import { getAddress } from 'viem';
import { backendAuth, db, eth, privy, SOURCE, toUsdt } from './privy.js';

export class DrawdownError extends Error {}

/** PSP asks for funds. Credit check + reservation in the DB, then Privy enforces the policy and sends. */
export async function requestDrawdown(pspId: string, amount: bigint, toAddress: string) {
  const to = getAddress(toAddress);
  const conn = await db.connect();
  let drawdown;
  try {
    await conn.query('BEGIN');
    // Row lock serialises concurrent requests from the same PSP.
    const { rows: [psp] } = await conn.query('SELECT * FROM psps WHERE id = $1 FOR UPDATE', [pspId]);
    if (!psp) throw new DrawdownError('unknown PSP');
    if (!psp.whitelist.includes(to)) throw new DrawdownError('address not whitelisted');
    const { rows: [{ used }] } = await conn.query(
      `SELECT COALESCE(SUM(principal_outstanding), 0) AS used FROM drawdowns
       WHERE psp_id = $1 AND status IN ('pending', 'disbursed', 'failed')`, [pspId]);
    if (amount <= 0n || amount > BigInt(psp.credit_limit) - BigInt(used)) throw new DrawdownError('exceeds available credit');
    ({ rows: [drawdown] } = await conn.query(
      `INSERT INTO drawdowns (psp_id, to_address, principal, principal_outstanding)
       VALUES ($1, $2, $3, $3) RETURNING *`, [pspId, to, amount.toString()]));
    await conn.query('COMMIT');
  } catch (e) {
    await conn.query('ROLLBACK');
    throw e;
  } finally {
    conn.release();
  }
  return submit(drawdown);
}

async function submit(d: { id: string; psp_id: string; to_address: string; principal: string }) {
  const { rows: [psp] } = await db.query('SELECT wallet_id FROM psps WHERE id = $1', [d.psp_id]);
  try {
    const action = await privy.wallets().transfer(psp.wallet_id, {
      source: { ...SOURCE, amount: toUsdt(BigInt(d.principal)) },
      destination: { address: d.to_address },
      reference_id: d.id,
      idempotency_key: d.id, // same drawdown can never be paid twice, even on retry
      authorization_context: backendAuth(),
    });
    await db.query('UPDATE drawdowns SET action_id = $2 WHERE id = $1', [d.id, action.id]);
    return { id: d.id, status: 'pending' as const };
  } catch (e: any) {
    // 4xx (policy deny, bad params): nothing signed, release the reservation.
    // 5xx / network: leave pending without action_id; pollDrawdowns() resubmits with the same idempotency key.
    if (e?.status >= 400 && e?.status < 500) {
      await db.query(`UPDATE drawdowns SET status = 'rejected' WHERE id = $1`, [d.id]);
      throw new DrawdownError(`Privy rejected: ${e.message}`);
    }
    return { id: d.id, status: 'pending' as const };
  }
}

/** Free plan = no production webhooks, so poll. Run every ~15s. */
export async function pollDrawdowns() {
  const { rows } = await db.query(
    `SELECT d.*, p.wallet_id FROM drawdowns d JOIN psps p ON p.id = d.psp_id
     WHERE d.status = 'pending' AND d.created_at > now() - interval '24 hours'`);
  for (const d of rows) {
    if (!d.action_id) { await submit(d); continue; }
    const a = await privy.wallets().actions.get(d.action_id, { wallet_id: d.wallet_id, include: 'steps' });
    if (a.status === 'pending') continue;
    const txHash = a.steps?.map((s: any) => s.transaction_hash).filter(Boolean).at(-1) ?? null;
    let status = a.status === 'succeeded' ? 'disbursed' : a.status;
    if (status !== 'disbursed' && txHash) {
      // Seen on Sepolia: Privy reported `rejected` (no gas) but the signed tx landed later once the wallet
      // had ETH. Once a tx is signed, trust the chain: a landed tx counts (once per hash), anything else
      // stays reserved as `failed` for a human instead of releasing the credit.
      const landed = (await eth.getTransactionReceipt({ hash: txHash }).catch(() => null))?.status === 'success';
      const { rowCount } = await db.query(`SELECT 1 FROM drawdowns WHERE tx_hash = $1 AND status = 'disbursed'`, [txHash]);
      status = rowCount ? 'rejected' : landed ? 'disbursed' : 'failed';
    }
    await db.query('UPDATE drawdowns SET status = $2, tx_hash = $3 WHERE id = $1', [d.id, status, txHash]);
  }
  // ponytail: pending rows older than 24h (idempotency window) are left for a human; alert on them.
}
