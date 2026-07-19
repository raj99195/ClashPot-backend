/**
 * ClashPot — on-chain settlement via ClashPotEscrow.sol
 *
 * Ye file server.js se require hoti hai.
 * Environment variables (.env):
 *   MST_RPC_URL        = https://mariorpc.mstblockchain.com
 *   BACKEND_PRIVATE_KEY = settler wallet ki private key (0x se shuru)
 *   ESCROW_CONTRACT    = deployed ClashPotEscrow address
 *
 * ⚠️ FLOAT → WEI CONVERSION
 *   8.75 + 1.25 = 10.00 — seedha parseUnits karo to floating point se
 *   9.999999999999998 aa sakta hai aur settle() revert ho jaayega.
 *   Safe formula: p1Wei = parseUnits(p1Score) ; p2Wei = pot - p1Wei
 *   Isse exactly pot == p1Wei + p2Wei guarantee hota hai.
 */

require("dotenv").config();
const { ethers } = require("ethers");

// ── Minimal ABI — sirf wahi functions jo hum call karte hain ──────────────
const ESCROW_ABI = [
  "function settle(bytes32 matchId, uint256 p1Amount, uint256 p2Amount) external",
  "function isFunded(bytes32 matchId) external view returns (bool)",
  "function getMatch(bytes32 matchId) external view returns (tuple(address p1, address p2, uint256 stake, uint256 pot, uint64 createdAt, uint64 fundedAt, uint8 status))",
  "function matchIdFor(string calldata roomId) external pure returns (bytes32)",
  "function feeBps() external view returns (uint16)",
];

// ── Lazy init — pehli call pe connection banao ────────────────────────────
let _provider = null;
let _signer   = null;
let _contract = null;

function getContract() {
  if (_contract) return _contract;

  const rpc     = process.env.MST_RPC_URL;
  const privKey = process.env.BACKEND_PRIVATE_KEY;
  const address = process.env.ESCROW_CONTRACT;

  if (!rpc || !privKey || !address) {
    throw new Error(
      "[ContractCaller] Missing env: MST_RPC_URL / BACKEND_PRIVATE_KEY / ESCROW_CONTRACT"
    );
  }

  _provider = new ethers.JsonRpcProvider(rpc);
  _signer   = new ethers.Wallet(privKey, _provider);
  _contract = new ethers.Contract(address, ESCROW_ABI, _signer);

  console.log("[ContractCaller] Initialized. Escrow:", address, "| Settler:", _signer.address);
  return _contract;
}

// ── matchId helper — roomId string → bytes32 keccak ──────────────────────
// Client side (Unity) aur server side dono yahi formula use karein.
function matchIdFor(roomKey) {
  return ethers.keccak256(ethers.toUtf8Bytes(roomKey));
}

// ── isFunded — server game shuru karne se pehle ye check karega ──────────
async function isFunded(roomKey) {
  try {
    const contract = getContract();
    const matchId  = matchIdFor(roomKey);
    const funded   = await contract.isFunded(matchId);
    console.log(`[ContractCaller] isFunded(${roomKey}): ${funded}`);
    return funded;
  } catch (e) {
    console.error("[ContractCaller] isFunded failed:", e.message);
    return false;
  }
}

// ── scoreBasedPayout — match result ke baad call hota hai ─────────────────
//
// p1Score / p2Score: float MST values (e.g. 8.75, 1.25)
// stakeMST: per-player stake (e.g. 5)
// pot = stakeMST * 2 (e.g. 10)
//
// Float → Wei safe conversion:
//   p1Wei = parseUnits(p1Score.toFixed(18))  — lekin .toFixed(18) bhi
//           floating point artifacts de sakta hai (8.75 → 8.749999...)
//   SAFE:  p1Wei = parseUnits(p1Score.toFixed(6), 18)  — 6 decimal enough
//          p2Wei = pot_wei - p1Wei                      — exact complement
//
async function scoreBasedPayout(roomKey, p1Wallet, p1Score, p2Wallet, p2Score) {
  try {
    const contract = getContract();
    const matchId  = matchIdFor(roomKey);

    // Pot = p1Score + p2Score (server ne guarantee kiya hai ye sum = stake*2)
    const potMST = p1Score + p2Score;
    const potWei = ethers.parseUnits(potMST.toFixed(6), 18);

    // ✅ Safe float → wei: p1 seedha convert, p2 = pot - p1 (exact sum)
    const p1Wei  = ethers.parseUnits(p1Score.toFixed(6), 18);
    const p2Wei  = potWei - p1Wei;

    // Fee contract se padho (0 hoga unless admin ne set kiya)
    const feeBps    = await contract.feeBps();
    const feeAmount = (potWei * BigInt(feeBps)) / 10000n;
    const p1Adj     = p1Wei - (p1Wei * BigInt(feeBps)) / 10000n;
    const p2Adj     = p2Wei - (p2Wei * BigInt(feeBps)) / 10000n;

    // Contract check: p1Adj + p2Adj + fee == pot
    const sumCheck = p1Adj + p2Adj + feeAmount;
    if (sumCheck !== potWei) {
      // Rounding se 1 wei off ho sakta hai — p2 se adjust karo
      const diff = potWei - sumCheck;
      console.warn(`[ContractCaller] Wei sum off by ${diff} — p2 se adjust kar raha hu`);
      const p2Final = p2Adj + diff;

      console.log(`[ContractCaller] settle() → matchId=${matchId}`);
      console.log(`  p1=${p1Wallet} gets ${ethers.formatEther(p1Adj)} MSTC`);
      console.log(`  p2=${p2Wallet} gets ${ethers.formatEther(p2Final)} MSTC`);
      console.log(`  fee=${ethers.formatEther(feeAmount)} MSTC (${feeBps}bps)`);

      const tx = await contract.settle(matchId, p1Adj, p2Final, {
        gasLimit: 200000,
      });
      const receipt = await tx.wait();
      console.log(`[ContractCaller] ✅ settled! tx=${receipt.hash}`);
      return receipt;
    }

    console.log(`[ContractCaller] settle() → matchId=${matchId}`);
    console.log(`  p1=${p1Wallet} gets ${ethers.formatEther(p1Adj)} MSTC`);
    console.log(`  p2=${p2Wallet} gets ${ethers.formatEther(p2Adj)} MSTC`);
    console.log(`  fee=${ethers.formatEther(feeAmount)} MSTC (${feeBps}bps)`);

    const tx = await contract.settle(matchId, p1Adj, p2Adj, {
      gasLimit: 200000,
    });
    const receipt = await tx.wait();
    console.log(`[ContractCaller] ✅ settled! tx=${receipt.hash}`);
    return receipt;

  } catch (e) {
    console.error("[ContractCaller] ❌ settle failed:", e.message);

    // Common reasons:
    if (e.message.includes("Not funded"))
      console.error("  → Dono players ne deposit nahi kiya tha");
    if (e.message.includes("Amounts must equal pot"))
      console.error("  → Float→wei conversion mismatch — rounding issue");
    if (e.message.includes("insufficient funds"))
      console.error("  → Settler wallet mein gas ke liye MSTC nahi");

    throw e;
  }
}

// ── refundPlayers — server down / opponent left (fallback) ────────────────
// Note: contract mein automatic refund hai (refundExpired) jab timeout ho.
// Ye function sirf logging ke liye — contract-level refund player khud call karta hai.
async function refundPlayers(roomKey, wallets, stakeMST) {
  console.log(`[ContractCaller] refundPlayers — contract timeout pe auto-refund hoga`);
  console.log(`  room=${roomKey} wallets=${wallets.join(",")} stake=${stakeMST}`);
  // Players manually refundExpired() call kar sakte hain timeout ke baad.
  // Server-triggered refund nahi hota (settler ke paas refund function nahi hai).
}

// ── Startup check ─────────────────────────────────────────────────────────
function init() {
  try {
    getContract();
  } catch (e) {
    console.warn("[ContractCaller]", e.message);
  }
}

init();

module.exports = {
  isFunded,
  scoreBasedPayout,
  refundPlayers,
  matchIdFor,
};
