# PSP onboarding and wallet policies

How a new PSP gets a credit-line wallet in Privy, and what the wallet's policy allows.

**Audience:** whoever onboards PSPs from now on (ops or engineering).
**System:** the `credit-line` service. It uses Privy server wallets, holds USDT on Ethereum mainnet (test USDC on Sepolia), and runs drawdowns automatically.

---

## 1. How it fits together

Each PSP gets **one Privy wallet**. That wallet holds the PSP's credit line in tokens, and drawdowns are paid from it.

```
Treasury (Safe) ──fund once──▶ PSP wallet (Privy) ──drawdown──▶ PSP receiving address (whitelisted)
       ▲                            ▲    │
       └──── interest & fees ───────┘    └── repayments come back to this wallet
```

A drawdown passes three independent checks. All three must pass:

| # | Check | Done by | What it stops |
|---|---|---|---|
| 1 | Address is on the PSP's whitelist, and amount ≤ limit − outstanding principal | Our backend (database) | Over-borrowing across several drawdowns |
| 2 | Wallet **policy**: right token, right chain, ≤ max per drawdown, whitelisted destination | Privy, inside its secure enclave | Our backend being hacked or buggy |
| 3 | Wallet **balance** | The blockchain | Anything above the funded amount |

## 2. Keys and roles

Every PSP wallet has the same two keys attached. They are created once per environment, and their IDs are in `.env`.

| Role | Key | `.env` | Can do | Cannot do |
|---|---|---|---|---|
| **Owner** | Admin key | `PRIVY_ADMIN_QUORUM_ID`, `PRIVY_ADMIN_PRIVATE_KEY` | Change the policy and the signers, move funds anywhere | Nothing is restricted |
| **Signer** | Backend key | `PRIVY_BACKEND_QUORUM_ID`, `PRIVY_BACKEND_PRIVATE_KEY` | Send transfers **only within the PSP's policy** | Change anything, or send outside the policy |

- The **server only has the backend key.** If it leaks, the worst case is a PSP's own funds going to that PSP's whitelisted addresses or to the treasury.
- The **admin private key stays off the server.** It's only needed to *change* a policy later. Creating a PSP needs only the admin key's **ID**, not its private key.

## 3. Before onboarding: one-time setup per environment

- [ ] **Privy app created.** App ID and secret are in `.env`.
- [ ] **Admin and backend keys created** with `npm run admin -- keys`. The four values are in `.env` and backed up in the password vault.
- [ ] **Gas** (*Privy Dashboard → Fee sponsorship*): turn on **Sponsor gas fees** for the chain in use, with credits added. Without this, every PSP wallet must hold ETH for gas.
- [ ] **Token watchlist** (*Privy Dashboard → Settings → Token watchlist*), testnet only: add Sepolia USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`. Mainnet USDT doesn't need this.
- [ ] **Treasury address** set in `.env` (`TREASURY_ADDRESS`).

## 4. Information to collect from the PSP

| Item | Example | Notes |
|---|---|---|
| PSP ID | `psp2` | Letters, numbers, `-` and `_` only. Can't be changed later. |
| Credit limit | `250000` | In tokens (USDT on mainnet). |
| Receiving address(es) | `0xdcF9…120D` | 1–100 Ethereum addresses the PSP controls. **Confirm each one with the PSP through a second channel** (call or signed message), because a wrong address means lost funds. |

## 5. Onboarding steps

### Option A: admin page (recommended)

1. Start the service (`npm start`) and open **http://127.0.0.1:4000**.
2. Fill in **Onboard a PSP**: ID, credit limit, receiving addresses (one per line).
3. Click **Create wallet & policy**. The page shows the new **wallet address**.
4. **Fund** that wallet from the treasury with exactly the credit limit (section 7).
5. **Verify** (section 8).

`npm run admin -- onboard <pspId> <limit> <addr1,addr2>` does the same thing from the command line.

### Option B: fully by hand (Privy API + database)

Use this if the admin page isn't available. Every Privy call uses these headers:

```
Authorization: Basic base64(<PRIVY_APP_ID>:<PRIVY_APP_SECRET>)
privy-app-id: <PRIVY_APP_ID>
Content-Type: application/json
```

Creating a policy and creating a wallet do **not** need an authorization signature. Only later *changes* do.

**Step 1: create the policy.** `POST https://api.privy.io/v1/policies` with the JSON from section 6, filled in for this PSP.
Save the returned `id` as the **policy ID**.
The Privy Dashboard can also create policies, but make sure it ends up with exactly the rules in section 6 and the admin key as owner.

**Step 2: create the wallet with the backend key as a signer.** `POST https://api.privy.io/v1/wallets`

```json
{
  "chain_type": "ethereum",
  "display_name": "psp psp2",
  "external_id": "psp-psp2",
  "owner_id": "<PRIVY_ADMIN_QUORUM_ID>",
  "additional_signers": [
    { "signer_id": "<PRIVY_BACKEND_QUORUM_ID>", "override_policy_ids": ["<policy ID from step 1>"] }
  ]
}
```
Save the returned `id` (**wallet ID**) and `address` (**wallet address**).
Add the header `privy-idempotency-key: onboard-psp2`, so that retrying a call that timed out can't create a second wallet.

**Step 3: register the PSP in our database.** Without this row, the backend refuses all drawdowns for this PSP.

```sql
INSERT INTO psps (id, credit_limit, wallet_id, wallet_address, policy_id, whitelist) VALUES (
  'psp2',
  250000000000,                          -- limit × 1,000,000 (6 decimals): 250,000 → 250000000000
  '<wallet ID>',
  '<wallet address, checksummed>',
  '<policy ID>',
  ARRAY['<receiving address, checksummed>']
);
```

> The limit in the database is in **micro-units** (× 1,000,000). The limit in the Privy policy is in **whole tokens** (`"250000"`). Getting either wrong by 10⁶ is the most likely onboarding mistake.

## 6. The wallet policy

### What it is

One policy per PSP, owned by the admin key and attached to the **backend signer** on that PSP's wallet. Privy checks it inside its secure enclave before signing anything the backend asks for.

It contains exactly two rules, and both are **ALLOW** rules for Privy's `transfer` action:

| Rule | Token | Chain | Amount | Destination |
|---|---|---|---|---|
| **1. Drawdown** | USDT (mainnet) / Sepolia USDC (testnet) | `ethereum` / `ethereum_sepolia` | ≤ credit limit, **per transfer** | One of the PSP's whitelisted addresses |
| **2. Sweep** | same | same | any | The treasury address only |

Rule 2 exists so the backend can move repaid **interest, fees and overpayments** to the treasury automatically. Principal stays in the PSP wallet, which restores the PSP's limit.

### Exact JSON, mainnet

```json
{
  "version": "1.0",
  "name": "psp psp2",
  "chain_type": "ethereum",
  "owner_id": "<PRIVY_ADMIN_QUORUM_ID>",
  "rules": [
    {
      "name": "drawdown to whitelisted PSP address",
      "method": "transfer",
      "action": "ALLOW",
      "conditions": [
        { "field_source": "action_request_body", "field": "source.asset",  "operator": "eq",  "value": "usdt" },
        { "field_source": "action_request_body", "field": "source.chain",  "operator": "eq",  "value": "ethereum" },
        { "field_source": "action_request_body", "field": "source.amount", "operator": "lte", "value": "250000" },
        { "field_source": "action_request_body", "field": "destination.address", "operator": "in",
          "value": ["0xPspAddress1", "0xPspAddress2"] }
      ]
    },
    {
      "name": "sweep interest and fees to treasury",
      "method": "transfer",
      "action": "ALLOW",
      "conditions": [
        { "field_source": "action_request_body", "field": "source.asset", "operator": "eq", "value": "usdt" },
        { "field_source": "action_request_body", "field": "source.chain", "operator": "eq", "value": "ethereum" },
        { "field_source": "action_request_body", "field": "destination.address", "operator": "eq", "value": "<TREASURY_ADDRESS>" }
      ]
    }
  ]
}
```

### Testnet (Sepolia) differences
In **both** rules, replace the two token and chain conditions with:
```json
{ "field_source": "action_request_body", "field": "source.asset_address", "operator": "eq", "value": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
{ "field_source": "action_request_body", "field": "source.chain", "operator": "eq", "value": "ethereum_sepolia" }
```
The policy must check the same field the backend sends: `source.asset` (`usdt`) on mainnet, `source.asset_address` on testnet. A rule that checks the other field never matches, so every drawdown gets rejected.

### How Privy evaluates it
- **Everything not explicitly allowed is denied.** There's no rule for raw transactions (`eth_sendTransaction`), message signing, other tokens, other chains or key export, so the backend can't do any of those.
- **All conditions in a rule must match.** A transfer is allowed if it matches rule 1 **or** rule 2.
- **The amount condition is per transfer, not a running total.** Privy doesn't track outstanding debt. The running total is enforced by our backend (check 1) and by the wallet balance (check 3).
- **Address capitalization matters.** Destination addresses are compared character by character. Always use the **checksummed** form (mixed case, as Etherscan shows it) in the policy, the database and the drawdown request. The admin page and CLI do this automatically; check it carefully when onboarding by hand.
- **Owner:** the admin key. Only a request signed by the admin private key can change this policy. The backend key can't loosen its own rules.

### Changing a PSP's policy later
For example, to change the limit or the whitelisted addresses:
```bash
npm run admin -- set psp2 300000 0xPspAddress1,0xPspAddress3
```
- This needs `PRIVY_ADMIN_PRIVATE_KEY`, so run it on the admin machine, not the server.
- It rewrites **both** rules: the full address list you pass replaces the old one, and the treasury comes from the current `.env`.
- It updates the database to match, and prints how much to top up or pull back from the wallet. It does **not** move funds.
- The dashboard probably can't edit this policy directly: it's owned by the admin key, and approval flows in the dashboard are an Enterprise feature.

## 7. Funding the wallet
- From the treasury, send **exactly the credit limit** in the right token to the PSP's **wallet address** (not to the PSP's receiving address).
- If gas sponsorship is **off**, the wallet also needs a little ETH for gas. Lesson from testing: with 0 ETH, transfers fail. One was later broadcast after ETH arrived and landed on-chain even though Privy had reported it rejected. The backend now catches this case.

## 8. Verify before going live with a PSP

- [ ] **Admin page:** the PSP is listed with the right limit, **Used 0**, and **wallet balance = limit**.
- [ ] **Privy:** the wallet's owner is the admin key, and its signer is the backend key with this PSP's policy attached.
- [ ] **Policy:** has exactly two rules, the addresses are checksummed, and the amount is in whole tokens.
- [ ] **Test drawdown:** a small amount (e.g. 1) to the whitelisted address reaches **disbursed** and has an Etherscan link.
- [ ] **Negative test:** a drawdown to a non-whitelisted address is refused.

## 9. Worked example: psp1 on Sepolia

| | |
|---|---|
| PSP ID | `psp1` |
| Wallet address | `0x128c11dE70934fca9EE5A6eb1E61fC896E5AceFE` |
| Wallet ID | `y7czul8615kknm2wspv42fg7` |
| Policy ID | `lvop4tghipjn4rk25fp7l77b` |
| Limit | 100 test USDC |
| Whitelisted receiver | `0xdcF921244b0621a08B8Ff8Ce8080c4c391BB120D` |
| Treasury | `0xA268642F99E5AA1D0a430a92B883a857Ed891e2C` |

## 10. Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `unknown PSP` | No database row | Step 3 of Option B |
| `address not whitelisted` | Address not in the database whitelist, or a capitalization mismatch | Use the checksummed address; update with `admin set` |
| `exceeds available credit` | Amount > limit − outstanding principal | Expected behavior; wait for repayment or raise the limit |
| `Privy rejected: … policy …` | Request didn't match the policy (token field, chain, amount, address case) | Compare the policy against section 6 |
| `Unsupported (asset, chain) combination` | Testnet token not in the watchlist | Section 3, token watchlist |
| `insufficient funds for gas` | No gas sponsorship and no ETH in the wallet | Turn on sponsorship, or send ETH |
| Status `failed` | A transaction was signed, but it's unclear whether it landed | Check Etherscan for the wallet; the amount stays reserved until a person marks it resolved |
