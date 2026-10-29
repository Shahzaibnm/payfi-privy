// Internal API + admin page. Binds to localhost only, with no login: never expose this port publicly.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { erc20Abi, formatUnits, parseUnits, type Hash } from 'viem';
import { DrawdownError, pollDrawdowns, requestDrawdown } from './drawdowns.js';
import { OnboardError, onboardPsp } from './onboard.js';
import { db, eth, TOKEN } from './privy.js';
import { pollSweeps, RepaymentError, submitRepayment } from './repayments.js';

const PORT = Number(process.env.PORT ?? 4000);
const PAGE = new URL('../public/index.html', import.meta.url);
const EXPLORER = process.env.NETWORK === 'sepolia' ? 'https://sepolia.etherscan.io' : 'https://etherscan.io';
const fmt = (micro: string | bigint) => formatUnits(BigInt(micro), 6);

async function listPsps() {
  const { rows } = await db.query(
    `SELECT p.*, COALESCE((SELECT SUM(principal_outstanding) FROM drawdowns d
       WHERE d.psp_id = p.id AND d.status IN ('pending', 'disbursed', 'failed')), 0) AS used
     FROM psps p ORDER BY p.id`);
  return Promise.all(rows.map(async (p) => ({
    id: p.id,
    walletAddress: p.wallet_address,
    whitelist: p.whitelist,
    limit: fmt(p.credit_limit),
    used: fmt(p.used),
    available: fmt(BigInt(p.credit_limit) - BigInt(p.used)),
    balance: await eth.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [p.wallet_address] })
      .then((b) => formatUnits(b, 6)).catch(() => null),
  })));
}

async function listDrawdowns() {
  const { rows } = await db.query('SELECT * FROM drawdowns ORDER BY created_at DESC LIMIT 50');
  return rows.map((d) => ({ id: d.id, pspId: d.psp_id, toAddress: d.to_address, amount: fmt(d.principal),
    outstanding: fmt(d.principal_outstanding), status: d.status, txHash: d.tx_hash, createdAt: d.created_at }));
}

createServer(async (req, res) => {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  };
  try {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(readFileSync(PAGE));
    }
    if (req.method === 'GET' && req.url === '/api/psps') return send(200, { explorer: EXPLORER, psps: await listPsps() });
    if (req.method === 'GET' && req.url === '/api/drawdowns') return send(200, await listDrawdowns());

    let raw = '';
    for await (const chunk of req) raw += chunk;
    const b = raw ? JSON.parse(raw) : {};
    if (req.method === 'POST' && req.url === '/api/psps') {
      const addrs = Array.isArray(b.whitelist) ? b.whitelist : String(b.whitelist ?? '').split(/[\s,]+/);
      return send(201, await onboardPsp(String(b.pspId ?? ''), String(b.limit ?? ''), addrs));
    }
    if (req.method === 'POST' && (req.url === '/drawdowns' || req.url === '/api/drawdowns')) {
      // amount as decimal string, e.g. "1500.25"
      if (!/^\d+(\.\d{1,6})?$/.test(String(b.amount))) throw new DrawdownError('amount must be a number with up to 6 decimals');
      return send(202, await requestDrawdown(b.pspId, parseUnits(String(b.amount), 6), b.toAddress));
    }
    if (req.method === 'POST' && (req.url === '/repayments' || req.url === '/api/repayments')) {
      return send(200, await submitRepayment(b.pspId, b.txHash as Hash));
    }
    send(404, { error: 'not found' });
  } catch (e: any) {
    if (e instanceof DrawdownError || e instanceof RepaymentError || e instanceof OnboardError) return send(400, { error: e.message });
    if (e instanceof SyntaxError) return send(400, { error: 'invalid JSON' });
    console.error(e);
    send(500, { error: e?.message ?? 'internal error' });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`credit-line on http://127.0.0.1:${PORT}`));

// No production webhooks on the free plan, so poll Privy for transfer results.
let polling = false;
setInterval(async () => {
  if (polling) return;
  polling = true;
  try {
    await pollDrawdowns();
    await pollSweeps();
  } catch (e) {
    console.error('poll failed', e);
  } finally {
    polling = false;
  }
}, 15_000);
