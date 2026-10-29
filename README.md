# PSP credit line on Privy (USDT, Ethereum)

Each PSP gets one Privy wallet holding its credit limit in USDT. Drawdowns are automated:

1. **Your backend** checks the request: the address is whitelisted and `amount ≤ limit − outstanding principal`. The PSP's row is locked while it checks.
2. **Privy** checks the policy inside its secure enclave before signing. The transfer must be USDT on Ethereum, at most the limit, and go to an address on that PSP's whitelist.
3. **The wallet balance** is a hard cap, because a wallet can never send more than it holds.

Repayments are verified on-chain from the transaction hash the PSP submits. Principal stays in the wallet, which restores the limit. Interest, fees and any overpayment are swept to the treasury.

## Keys
| Key | Role in Privy | Where it lives |
|---|---|---|
| Admin | Owner of every PSP wallet and policy. Changes limits and whitelists, and can move funds anywhere. | Offline or in a vault. Used only by `src/admin.ts`. |
| Backend | Extra signer on each wallet. Its policy only allows the drawdown and sweep rules. | API servers |

If the backend key leaks, the attacker can only send a PSP's funds to that PSP's whitelisted addresses or to your treasury.

## Setup
1. **Privy Dashboard**
   - Create an app and an app secret.
   - Under **Fee sponsorship**, add prepaid credits, turn on *Sponsor gas fees*, and select **Ethereum**. Gas sponsorship requires TEE execution, so wallets never need ETH.
2. **Database:** run `psql $DATABASE_URL -f schema.sql`.
3. **Keys:** with `PRIVY_APP_ID` and `PRIVY_APP_SECRET` set, run `npm run admin -- keys`. Store the four printed values as secrets.
4. **Environment:**
   - API servers: `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_BACKEND_PRIVATE_KEY`, `DATABASE_URL`, `ETH_RPC_URL`, `TREASURY_ADDRESS`.
   - Admin machine: everything above, plus `PRIVY_ADMIN_PRIVATE_KEY`, `PRIVY_ADMIN_QUORUM_ID` and `PRIVY_BACKEND_QUORUM_ID`.
5. **Onboard a PSP:** run `npm run admin -- onboard psp42 250000 0xPspAddr1,0xPspAddr2`, then fund the printed wallet address from the Safe with exactly the limit.
6. **Change a limit or whitelist:** run `npm run admin -- set psp42 300000 0xPspAddr1`. It prints how much to top up or pull back.

## Admin page
`npm start`, then open http://127.0.0.1:4000 to onboard PSPs (creates the Privy wallet and policy), make drawdowns and watch their status. It has no login and only listens on this machine, so don't expose the port.

## Wiring into the portal
- `requestDrawdown(pspId, amountMicroUsdt, toAddress)` handles a PSP's "request funds" action. It throws `DrawdownError` with a readable reason when it refuses.
- `submitRepayment(pspId, txHash)` handles a PSP's repayment hash. It throws `RepaymentError`. It requires 12 confirmations, the real USDT contract, the PSP's credit wallet as recipient, and a hash never submitted before.
- `pollDrawdowns()` and `pollSweeps()` should run every 10–30 seconds. The free plan has no production webhooks, so these pollers track transfer results instead.
- Your portal is responsible for accruing interest and fees into `drawdowns.interest_outstanding` and `drawdowns.fees_outstanding`. Repayments pay the oldest drawdown first, and within each drawdown: fees, then interest, then principal.

## Checks
`npm run typecheck && npm test`. The tests cover repayment allocation and USDT log parsing. Nothing here has run against live Privy yet. Do a first pass on Sepolia: set the chain to `ethereum_sepolia` and use a test token.
