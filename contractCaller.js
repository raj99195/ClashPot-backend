/**
 * ClashPot — on-chain settlement via ClashPotEscrow.sol
 *
 * .env:
 *   MST_RPC_URL         = https://mariorpc.mstblockchain.com
 *   BACKEND_PRIVATE_KEY = settler wallet ki private key (0x se shuru)
 *   ESCROW_CONTRACT     = deployed ClashPotEscrow address
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 v2 FIX 1 — PAYOUT ORDER (paise ka bug tha)
 *
 *   Contract me m.p1 wo hai jisne PEHLE deposit kiya.
 *   Server me p1 wo hai jisne PEHLE socket join kiya.
 *   Ye dono zaroori nahi ki same banda ho — dono ko escrow_pending ek saath
 *   milta hai, aur jo pehle wallet confirm kare wahi contract ka p1 ban jaata hai.
 *
 *   Purana code seedha settle(matchId, p1Amount, p2Amount) bhejta tha, matlab
 *   50% matches me jeetne wale ka paisa haarne wale ko chala jaata.
 *
 *   Ab settle se pehle contract se m.p1 / m.p2 ke ADDRESS padhe jaate hain aur
 *   amounts wallet address se map hote hain — slot se nahi.
 *
 * 🔴 v2 FIX 2 — STAKE VERIFICATION
 *
 *   Pehle sirf isFunded() check hota tha — "dono ne deposit kiya" par
 *   "kitna kiya" nahi. Dono mil ke 1 MSTC room me 0.001 daal sakte the;
 *   phir settle() 2 MSTC baantne ki koshish karti aur revert ho jaati.
 *   Ab on-chain stake expected value se compare hota hai.
 * ═══════════════════════════════════════════════════════════════════════════
 */

require("dotenv").config();
const { ethers } = require("ethers");

// Status enum — ClashPotEscrow.sol ke hisaab se
const STATUS = ["None", "Open", "Funded", "Settled", "Refunded"];
const STATUS_FUNDED = 2;

const ESCROW_ABI = [
  "function settle(bytes32 matchId, uint256 p1Amount, uint256 p2Amount) external",
  "function isFunded(bytes32 matchId) external view returns (bool)",
  "function getMatch(bytes32 matchId) external view returns (tuple(address p1, address p2, uint256 stake, uint256 pot, uint64 createdAt, uint64 fundedAt, uint8 status))",
  "function feeBps() external view returns (uint16)",
];

let _contract = null;
let _signer = null;

function getContract() {
  if (_contract) return _contract;

  const rpc = process.env.MST_RPC_URL;
  const privKey = process.env.BACKEND_PRIVATE_KEY;
  const address = process.env.ESCROW_CONTRACT;

  if (!rpc || !privKey || !address) {
    throw new Error("[ContractCaller] Missing env: MST_RPC_URL / BACKEND_PRIVATE_KEY / ESCROW_CONTRACT");
  }

  const provider = new ethers.JsonRpcProvider(rpc);
  _signer = new ethers.Wallet(privKey, provider);
  _contract = new ethers.Contract(address, ESCROW_ABI, _signer);

  console.log("[ContractCaller] Ready. Escrow:", address, "| Settler:", _signer.address);
  return _contract;
}

/** roomKey string → bytes32. Frontend aur contract dono yahi formula use karte hain. */
function matchIdFor(roomKey) {
  return ethers.keccak256(ethers.toUtf8Bytes(roomKey));
}

// ─────────────────────────────────────────────────────────────────────────────
// VERIFY ESCROW — game start se pehle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sirf "funded hai kya" nahi — ye bhi check karta hai ki SAHI amount jama hua.
 *
 * @param roomKey          server ka matchKey
 * @param expectedStakeMST per-player stake (1 / 5 / 10)
 * @returns {ok, reason, p1, p2, potWei}
 */
async function verifyEscrow(roomKey, expectedStakeMST) {
  try {
    const contract = getContract();
    const matchId = matchIdFor(roomKey);
    const m = await contract.getMatch(matchId);

    const status = Number(m.status);

    if (status !== STATUS_FUNDED) {
      return { ok: false, reason: `status=${STATUS[status] || status} (Funded chahiye)` };
    }

    // Stake exactly match karna chahiye
    const expectedStakeWei = ethers.parseUnits(String(expectedStakeMST), 18);
    if (m.stake !== expectedStakeWei) {
      return {
        ok: false,
        reason: `stake mismatch — on-chain=${ethers.formatEther(m.stake)} MSTC, expected=${expectedStakeMST} MSTC`,
      };
    }

    // Pot = stake × 2
    const expectedPotWei = expectedStakeWei * 2n;
    if (m.pot !== expectedPotWei) {
      return {
        ok: false,
        reason: `pot mismatch — on-chain=${ethers.formatEther(m.pot)}, expected=${ethers.formatEther(expectedPotWei)}`,
      };
    }

    console.log(
      `[ContractCaller] ✅ Escrow verified: ${roomKey} | stake=${ethers.formatEther(m.stake)} pot=${ethers.formatEther(m.pot)} MSTC`
    );
    console.log(`  on-chain p1=${m.p1}  p2=${m.p2}`);

    return { ok: true, p1: m.p1, p2: m.p2, potWei: m.pot };
  } catch (e) {
    console.error("[ContractCaller] verifyEscrow failed:", e.message);
    return { ok: false, reason: e.message };
  }
}

/** Backward compat — sirf funded check. verifyEscrow() prefer karo. */
async function isFunded(roomKey) {
  const r = await verifyEscrow(roomKey, null).catch(() => ({ ok: false }));
  return r.ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// SETTLE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Match settle karo.
 *
 * ⚠️ p1Wallet/p2Wallet server ke SLOTS hain. Contract ke m.p1/m.p2 deposit
 *    ORDER hai. Dono alag ho sakte hain — isliye amounts address se map hote hain.
 */
async function scoreBasedPayout(roomKey, p1Wallet, p1Score, p2Wallet, p2Score) {
  const contract = getContract();
  const matchId = matchIdFor(roomKey);

  // ── On-chain state padho ──
  const m = await contract.getMatch(matchId);
  const status = Number(m.status);

  if (status !== STATUS_FUNDED) {
    throw new Error(`Match ${STATUS[status] || status} hai, Funded nahi — settle skip`);
  }

  const potWei = m.pot;
  const feeBps = await contract.feeBps();

  // ── Float → wei (server ka p1/p2) ──
  // p1Wei seedha convert, p2Wei = pot - p1Wei taaki sum EXACT rahe
  const serverP1Wei = ethers.parseUnits(p1Score.toFixed(6), 18);
  const serverP2Wei = potWei - serverP1Wei;

  if (serverP1Wei < 0n || serverP2Wei < 0n) {
    throw new Error(`Negative amount: p1=${p1Score} p2=${p2Score} pot=${ethers.formatEther(potWei)}`);
  }

  // ── 🔴 ADDRESS SE MAP KARO, SLOT SE NAHI ──
  const chainP1 = m.p1.toLowerCase();
  const chainP2 = m.p2.toLowerCase();
  const srvP1 = (p1Wallet || "").toLowerCase();
  const srvP2 = (p2Wallet || "").toLowerCase();

  let amountForChainP1, amountForChainP2;

  if (chainP1 === srvP1 && chainP2 === srvP2) {
    // Order same — server p1 ne pehle deposit kiya
    amountForChainP1 = serverP1Wei;
    amountForChainP2 = serverP2Wei;
    console.log("[ContractCaller] Deposit order = slot order");
  } else if (chainP1 === srvP2 && chainP2 === srvP1) {
    // 🔄 Order ULTA — server p2 ne pehle deposit kiya, amounts swap karo
    amountForChainP1 = serverP2Wei;
    amountForChainP2 = serverP1Wei;
    console.log("[ContractCaller] ⚠ Deposit order ULTA hai — amounts swap kiye");
  } else {
    throw new Error(
      `Wallet mismatch!\n` +
      `  on-chain: p1=${m.p1} p2=${m.p2}\n` +
      `  server:   p1=${p1Wallet} p2=${p2Wallet}`
    );
  }

  // ── Fee ──
  const fee = (potWei * BigInt(feeBps)) / 10000n;
  if (fee > 0n) {
    // Fee dono se proportionally kaato, phir dust p2 se adjust
    const f1 = (amountForChainP1 * BigInt(feeBps)) / 10000n;
    amountForChainP1 -= f1;
    amountForChainP2 = potWei - fee - amountForChainP1;
  }

  // ── Invariant: contract yahi check karta hai ──
  const sum = amountForChainP1 + amountForChainP2 + fee;
  if (sum !== potWei) {
    // 1 wei ka dust — p2 se adjust
    const diff = potWei - sum;
    amountForChainP2 += diff;
    console.warn(`[ContractCaller] Dust ${diff} wei — p2 se adjust kiya`);
  }

  console.log(`[ContractCaller] settle() → ${roomKey}`);
  console.log(`  ${m.p1} → ${ethers.formatEther(amountForChainP1)} MSTC`);
  console.log(`  ${m.p2} → ${ethers.formatEther(amountForChainP2)} MSTC`);
  console.log(`  fee   → ${ethers.formatEther(fee)} MSTC (${feeBps} bps)`);

  const tx = await contract.settle(matchId, amountForChainP1, amountForChainP2, { gasLimit: 250000 });
  const receipt = await tx.wait();
  console.log(`[ContractCaller] ✅ settled! tx=${receipt.hash}`);
  return receipt;
}

// ─────────────────────────────────────────────────────────────────────────────

async function refundPlayers(roomKey, wallets, stakeMST) {
  // Contract me timeout-based refund hai (refundExpired) jo koi bhi call kar sakta hai.
  // Settler ke paas refund ka koi role nahi — jaan-boojh ke, taaki server
  // players ka paisa na chhu sake.
  console.log(`[ContractCaller] refundPlayers — contract timeout pe players khud refundExpired() call karenge`);
  console.log(`  room=${roomKey} wallets=${(wallets || []).join(", ")} stake=${stakeMST}`);
}

// Startup pe connection warm karo (env missing ho to sirf warn)
try { getContract(); } catch (e) { console.warn("[ContractCaller]", e.message); }

module.exports = {
  verifyEscrow,
  isFunded,
  scoreBasedPayout,
  refundPlayers,
  matchIdFor,
};
