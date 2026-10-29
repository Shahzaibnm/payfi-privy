// Admin CLI — the only code that holds the admin (owner) key.
//   tsx src/admin.ts keys                                     one-time: generate + register admin & backend keys
//   tsx src/admin.ts onboard <pspId> <limitUsdt> <addr,addr>  create policy + wallet for a PSP
//   tsx src/admin.ts set     <pspId> <limitUsdt> <addr,addr>  change a PSP's limit / whitelist
import { generateP256KeyPair } from '@privy-io/node';
import { adminAuth, db, privy, toUsdt } from './privy.js';
import { onboardPsp, parseOnboard, rules } from './onboard.js';

const [cmd, pspId, limitArg, addrs] = process.argv.slice(2);

if (cmd === 'keys') {
  for (const name of ['admin', 'backend']) {
    const { privateKey, publicKey } = await generateP256KeyPair();
    const kq = await privy.keyQuorums().create({ display_name: `credit-line ${name}`, public_keys: [publicKey], authorization_threshold: 1 });
    console.log(`PRIVY_${name.toUpperCase()}_PRIVATE_KEY=${privateKey}\nPRIVY_${name.toUpperCase()}_QUORUM_ID=${kq.id}`);
  }
} else if (cmd === 'onboard') {
  const psp = await onboardPsp(pspId, limitArg, addrs.split(','));
  console.log(`PSP ${pspId}: wallet ${psp.walletAddress}. Fund it with ${limitArg} from the treasury.`);
} else if (cmd === 'set') {
  const { limit, whitelist } = parseOnboard(pspId, limitArg, addrs.split(','));
  const { rows: [psp] } = await db.query('SELECT * FROM psps WHERE id = $1', [pspId]);
  await privy.policies().update(psp.policy_id, { rules: rules(limit, whitelist), authorization_context: adminAuth() });
  await db.query('UPDATE psps SET credit_limit = $2, whitelist = $3 WHERE id = $1', [pspId, limit.toString(), whitelist]);
  const delta = limit - BigInt(psp.credit_limit);
  console.log(delta >= 0n ? `Top up ${toUsdt(delta)} from the treasury.` : `Move ${toUsdt(-delta)} back to treasury (admin key).`);
} else {
  console.log('usage: keys | onboard <pspId> <limit> <addrs> | set <pspId> <limit> <addrs>');
}
await db.end();
