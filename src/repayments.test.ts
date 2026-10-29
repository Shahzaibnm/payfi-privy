import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAbiParameters, getAddress, pad, type Log } from 'viem';

process.env.PRIVY_APP_ID ??= 'x'; process.env.PRIVY_APP_SECRET ??= 'x';
process.env.DATABASE_URL ??= 'postgres://x'; process.env.ETH_RPC_URL ??= 'http://x';
const { allocate, usdtReceived } = await import('./repayments.js');
const { TOKEN: USDT } = await import('./privy.js');

const d = (id: string, p: bigint, i: bigint, f: bigint) =>
  ({ id, principal_outstanding: p, interest_outstanding: i, fees_outstanding: f });

test('allocate: oldest first, fees -> interest -> principal, overpayment unapplied', () => {
  const r = allocate(1_150n, [d('a', 1_000n, 50n, 10n), d('b', 500n, 0n, 0n)]);
  assert.deepEqual(r.updates, [
    { id: 'a', fees: 0n, interest: 0n, principal: 0n },
    { id: 'b', fees: 0n, interest: 0n, principal: 410n },
  ]);
  assert.equal(r.toInterestFees, 60n);
  assert.equal(r.toPrincipal, 1_090n);
  assert.equal(r.unapplied, 0n);
  assert.equal(allocate(100n, []).unapplied, 100n);
  assert.equal(allocate(5n, [d('a', 100n, 3n, 4n)]).updates[0].interest, 2n); // partial: fees first
});

test('usdtReceived: sums only USDT Transfers to the wallet', () => {
  const wallet = getAddress('0x1111111111111111111111111111111111111111');
  const other = getAddress('0x2222222222222222222222222222222222222222');
  const topic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const log = (address: string, to: string, value: bigint) => ({
    address, topics: [topic, pad(other), pad(to as `0x${string}`)],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  }) as unknown as Log;
  assert.equal(usdtReceived([log(USDT, wallet, 7n), log(USDT, other, 5n), log(other, wallet, 9n), log(USDT, wallet, 3n)], wallet), 10n);
});
