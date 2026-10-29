import { PrivyClient } from '@privy-io/node';
import pg from 'pg';
import { createPublicClient, formatUnits, getAddress, http } from 'viem';
import { mainnet, sepolia } from 'viem/chains';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

export const privy = new PrivyClient({ appId: env('PRIVY_APP_ID'), appSecret: env('PRIVY_APP_SECRET') });
export const db = new pg.Pool({ connectionString: env('DATABASE_URL') });
// NETWORK=sepolia → Ethereum Sepolia + Circle test USDC (no official USDT on Sepolia).
const testnet = process.env.NETWORK === 'sepolia';
export const eth = createPublicClient({ chain: testnet ? sepolia : mainnet, transport: http(env('ETH_RPC_URL')) });

// Backend key: additional signer on every PSP wallet, limited by that PSP's policy.
export const backendAuth = () => ({ authorization_private_keys: [env('PRIVY_BACKEND_PRIVATE_KEY')] });
// Admin key: owner of wallets + policies. Only the admin CLI needs it; keep it off the API servers.
export const adminAuth = () => ({ authorization_private_keys: [env('PRIVY_ADMIN_PRIVATE_KEY')] });

export const TOKEN = getAddress(testnet
  ? process.env.TOKEN_ADDRESS ?? '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' // Circle USDC, Sepolia
  : '0xdAC17F958D2ee523a2206206994597C13D831ec7'); // USDT, mainnet
// Mainnet uses Privy's named asset; testnet passes the contract address (add it to Dashboard → Asset watchlist).
export const SOURCE = testnet
  ? { asset_address: TOKEN, chain: 'ethereum_sepolia' }
  : { asset: 'usdt', chain: 'ethereum' };
export const TREASURY = () => getAddress(env('TREASURY_ADDRESS'));
export const toUsdt = (micro: bigint) => formatUnits(micro, 6); // Privy wants decimal strings
