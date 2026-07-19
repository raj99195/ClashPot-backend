const { ethers } = require("ethers");

// ─────────────────────────────────────────
// CONFIG — set these in your .env file
// ─────────────────────────────────────────

const MST_RPC_URL    = process.env.MST_RPC_URL;
const PRIVATE_KEY    = process.env.BACKEND_PRIVATE_KEY;
const ESCROW_ADDRESS = process.env.ESCROW_CONTRACT;

// ─────────────────────────────────────────
// ABI — only what backend needs to call
// ─────────────────────────────────────────

const ESCROW_ABI = [
  "function releasePrize(string roomId, address winner) external",
  "function refundBoth(string roomId) external",
  "function getMatch(string roomId) external view returns (address p1, address p2, uint256 stake, bool settled)",
];

// ─────────────────────────────────────────
// INIT
// ─────────────────────────────────────────

let provider, signer, escrowContract;

function init() {
  if (!MST_RPC_URL || !PRIVATE_KEY || !ESCROW_ADDRESS) {
    console.error("[ContractCaller] Missing env: MST_RPC_URL / BACKEND_PRIVATE_KEY / ESCROW_CONTRACT");
    return false;
  }
  try {
    provider = new ethers.JsonRpcProvider(MST_RPC_URL);
    signer   = new ethers.Wallet(PRIVATE_KEY, provider);
    escrowContract = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, signer);
    console.log(`[ContractCaller] Ready | Signer: ${signer.address}`);
    return true;
  } catch (err) {
    console.error("[ContractCaller] Init failed:", err.message);
    return false;
  }
}

init();

// ─────────────────────────────────────────
// RELEASE PRIZE
// ─────────────────────────────────────────

/**
 * Releases full pot to winner.
 * Backend wallet must be authorized on the escrow contract.
 */
async function releasePrize(roomId, winnerWallet, totalMST) {
  if (!escrowContract) throw new Error("Contract not initialized");

  console.log(`[ContractCaller] releasePrize | ${roomId} → ${winnerWallet} | ${totalMST} MST`);

  // Check not already settled
  try {
    const match = await escrowContract.getMatch(roomId);
    if (match.settled) {
      console.warn(`[ContractCaller] Room ${roomId} already settled. Skipping.`);
      return;
    }
  } catch (_) {}

  const tx = await escrowContract.releasePrize(roomId, winnerWallet, { gasLimit: 200000 });
  console.log(`[ContractCaller] releasePrize tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`[ContractCaller] Confirmed block: ${receipt.blockNumber}`);
  return receipt;
}

// ─────────────────────────────────────────
// REFUND BOTH (draw)
// ─────────────────────────────────────────

/**
 * Refunds both players their original stake.
 */
async function refundPlayers(roomId, wallets, stakeMST) {
  if (!escrowContract) throw new Error("Contract not initialized");

  console.log(`[ContractCaller] refundBoth | ${roomId} | ${wallets.join(", ")} | ${stakeMST} MST each`);

  const tx = await escrowContract.refundBoth(roomId, { gasLimit: 200000 });
  console.log(`[ContractCaller] refundBoth tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`[ContractCaller] Refund confirmed block: ${receipt.blockNumber}`);
  return receipt;
}

module.exports = { releasePrize, refundPlayers };
