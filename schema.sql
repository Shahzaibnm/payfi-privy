-- Amounts are USDT micro-units (6 decimals) stored as NUMERIC(38,0).

CREATE TABLE psps (
  id              TEXT PRIMARY KEY,
  credit_limit    NUMERIC(38,0) NOT NULL,
  wallet_id       TEXT NOT NULL UNIQUE,      -- Privy wallet id
  wallet_address  TEXT NOT NULL UNIQUE,      -- EIP-55 checksummed
  policy_id       TEXT NOT NULL,             -- Privy policy holding the whitelist + limit
  whitelist       TEXT[] NOT NULL            -- mirror of the policy's destination allowlist (checksummed)
);

CREATE TABLE drawdowns (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  psp_id                TEXT NOT NULL REFERENCES psps(id),
  to_address            TEXT NOT NULL,
  principal             NUMERIC(38,0) NOT NULL CHECK (principal > 0),
  principal_outstanding NUMERIC(38,0) NOT NULL,
  interest_outstanding  NUMERIC(38,0) NOT NULL DEFAULT 0,  -- accrued by your portal
  fees_outstanding      NUMERIC(38,0) NOT NULL DEFAULT 0,  -- accrued by your portal
  -- pending: reserved, transfer in flight | disbursed | rejected: nothing sent, reservation released
  -- failed: may have partial on-chain effect, needs a human
  status                TEXT NOT NULL DEFAULT 'pending',
  action_id             TEXT,
  tx_hash               TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE repayments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  psp_id            TEXT NOT NULL REFERENCES psps(id),
  tx_hash           TEXT NOT NULL UNIQUE,     -- a hash can only ever be claimed once
  amount            NUMERIC(38,0) NOT NULL,
  to_principal      NUMERIC(38,0) NOT NULL,
  to_interest_fees  NUMERIC(38,0) NOT NULL,
  unapplied         NUMERIC(38,0) NOT NULL,   -- overpayment
  sweep_action_id   TEXT,                     -- interest+fees+overpayment sent to treasury
  sweep_status      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
