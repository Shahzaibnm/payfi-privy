import { getAddress, parseUnits } from 'viem';
import { db, privy, SOURCE, toUsdt, TREASURY } from './privy.js';

export class OnboardError extends Error {}

type Rules = Parameters<ReturnType<typeof privy.policies>['create']>[0]['rules'];

export function rules(limit: bigint, whitelist: string[]): Rules {
  // Must use the same field (asset vs asset_address) the transfer request sends, or the rule never matches.
  const common = Object.entries(SOURCE).map(([k, value]) =>
    ({ field_source: 'action_request_body', field: `source.${k}`, operator: 'eq', value }) as const);
  return [
    {
      name: 'drawdown to whitelisted PSP address',
      method: 'transfer',
      action: 'ALLOW',
      conditions: [
        ...common,
        { field_source: 'action_request_body', field: 'source.amount', operator: 'lte', value: toUsdt(limit) },
        { field_source: 'action_request_body', field: 'destination.address', operator: 'in', value: whitelist },
      ],
    },
    {
      name: 'sweep interest and fees to treasury',
      method: 'transfer',
      action: 'ALLOW',
      conditions: [...common, { field_source: 'action_request_body', field: 'destination.address', operator: 'eq', value: TREASURY() }],
    },
  ];
}

/** Validates input; addresses come back checksummed (transfer rules compare destination.address case-sensitively). */
export function parseOnboard(pspId: string, limitArg: string, addrs: string[]) {
  if (!/^[a-z0-9_-]{1,40}$/i.test(pspId ?? '')) throw new OnboardError('PSP id: letters, numbers, - and _ only');
  if (!/^\d+(\.\d{1,6})?$/.test(limitArg ?? '') || Number(limitArg) <= 0) throw new OnboardError('limit must be a positive amount');
  const whitelist = [...new Set(addrs.map((a) => a.trim()).filter(Boolean))].map((a) => {
    try { return getAddress(a); } catch { throw new OnboardError(`invalid address: ${a}`); }
  });
  if (whitelist.length === 0 || whitelist.length > 100) throw new OnboardError('give 1–100 receiving addresses');
  return { limit: parseUnits(limitArg, 6), whitelist };
}

/** Creates the PSP's policy + wallet in Privy and records it. Needs no admin private key, only the quorum ids. */
export async function onboardPsp(pspId: string, limitArg: string, addrs: string[]) {
  const { limit, whitelist } = parseOnboard(pspId, limitArg, addrs);
  const { rowCount } = await db.query('SELECT 1 FROM psps WHERE id = $1', [pspId]);
  if (rowCount) throw new OnboardError(`PSP ${pspId} already exists`);

  const policy = await privy.policies().create({
    name: `psp ${pspId}`, version: '1.0', chain_type: 'ethereum',
    owner_id: process.env.PRIVY_ADMIN_QUORUM_ID, rules: rules(limit, whitelist),
  });
  const wallet = await privy.wallets().create({
    chain_type: 'ethereum', display_name: `psp ${pspId}`, external_id: `psp-${pspId}`,
    owner_id: process.env.PRIVY_ADMIN_QUORUM_ID,
    additional_signers: [{ signer_id: process.env.PRIVY_BACKEND_QUORUM_ID!, override_policy_ids: [policy.id] }],
    idempotency_key: `onboard-${pspId}`,
  });
  const walletAddress = getAddress(wallet.address);
  await db.query(
    'INSERT INTO psps (id, credit_limit, wallet_id, wallet_address, policy_id, whitelist) VALUES ($1,$2,$3,$4,$5,$6)',
    [pspId, limit.toString(), wallet.id, walletAddress, policy.id, whitelist],
  );
  return { id: pspId, walletAddress, policyId: policy.id, whitelist, limit: toUsdt(limit) };
}
