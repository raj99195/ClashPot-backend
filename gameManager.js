const contractCaller = require("./contractCaller");

// ─────────────────────────────────────────
// RPS
// ─────────────────────────────────────────

function resolveRPS(move1, move2) {
  if (move1 === move2) return "draw";
  const winsAgainst = { rock: "scissors", scissors: "paper", paper: "rock" };
  return winsAgainst[move1] === move2 ? "p1" : "p2";
}

// ─────────────────────────────────────────
// 9 CARDS — sum EXACTLY = pot (stake × 2)
//
// FIXES vs purana version:
//  1. Recursion → bounded loop. Pehle `return generateNineCards()` unbounded tha;
//     expected sum ~11.4 units vs pot 20 units, isliye balance card aksar range
//     se bahar jaata tha → sekron retries, kabhi-kabhi stack overflow.
//  2. Guaranteed fallback set — loop fail ho to bhi hamesha valid 9 cards milte hain.
//  3. getPrefabName ab stake-aware hai. Pehle stake=5 pe "Card-500+" banta tha
//     jo prefab exist hi nahi karta.
// ─────────────────────────────────────────

const UNIT_STEPS = [1, 2.5, 5, 10];              // 10% / 25% / 50% / 100% of stake
const NEG_STEPS = [-1, -2.5, -5];                // -100% wala nahi (pot kabhi negative na ho)
const MAX_ATTEMPTS = 500;

function round2(n) {
  return parseFloat(n.toFixed(2));
}

function generateNineCards(stakeMST = 1) {
  const stake = Number(stakeMST) || 1;
  const unit = stake / 10;
  const potUnits = 20;                            // pot = 2 × stake = 20 units

  const allSteps = [...UNIT_STEPS, ...NEG_STEPS];
  const minStep = Math.min(...NEG_STEPS);
  const maxStep = Math.max(...UNIT_STEPS);

  let unitCards = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const eight = [];
    let sum = 0;
    for (let i = 0; i < 8; i++) {
      const v = allSteps[Math.floor(Math.random() * allSteps.length)];
      eight.push(v);
      sum += v;
    }

    const balance = round2(potUnits - sum);

    // 9th card allowed range me hona chahiye AUR allowed steps me se ek
    if (balance >= minStep && balance <= maxStep && allSteps.includes(balance)) {
      unitCards = [...eight, balance];
      console.log(`[GameManager] Cards generated in ${attempt + 1} attempt(s)`);
      break;
    }
  }

  if (!unitCards) {
    // ✅ Guaranteed fallback: 32.5 − 12.5 = 20 units exactly
    unitCards = [10, 10, 5, 5, 2.5, -5, -2.5, -2.5, -2.5];
    console.warn(`[GameManager] ⚠ Random generation failed in ${MAX_ATTEMPTS} attempts — fallback set use kiya`);
  }

  // Shuffle (Fisher–Yates — .sort(() => Math.random()-0.5) biased hota hai)
  for (let i = unitCards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [unitCards[i], unitCards[j]] = [unitCards[j], unitCards[i]];
  }

  const values = unitCards.map((u) => round2(u * unit));
  const total = round2(values.reduce((a, b) => a + b, 0));
  const pot = round2(stake * 2);

  console.log(`[GameManager] 9 cards: [${values.join(", ")}]  sum=${total} MST (pot=${pot})`);

  if (Math.abs(total - pot) > 0.01) {
    console.error(`[GameManager] ❌ SUM MISMATCH: ${total} != ${pot} — payout galat hoga!`);
  }

  return values.map((val) => ({
    name: getPrefabName(val, stake),
    value: val,
    description: val >= 0 ? "Positive card" : "Negative card",
    picked: false,
  }));
}

/**
 * Value → prefab name. Prefabs: Card-10+, Card-25+, Card-50+, Card-100+ (aur '-' versions).
 * Bucket = value ka stake ke percentage me nearest allowed step.
 */
function getPrefabName(val, stakeMST) {
  const pct = Math.round((Math.abs(val) / stakeMST) * 100);
  const bucket = [10, 25, 50, 100].reduce((a, b) =>
    Math.abs(b - pct) < Math.abs(a - pct) ? b : a
  );
  return `Card-${bucket}${val >= 0 ? "+" : "-"}`;
}

// ─────────────────────────────────────────
// PAYOUT
// ─────────────────────────────────────────

async function triggerScoreBasedPayout(matchKey, players, scores, stakeMST) {
  try {
    const playerIds = Object.keys(players);
    const p1Id = playerIds.find((id) => players[id].slot === "p1");
    const p2Id = playerIds.find((id) => players[id].slot === "p2");

    const p1Score = round2(scores[p1Id] || 0);
    const p2Score = round2(scores[p2Id] || 0);
    const p1Wallet = players[p1Id]?.walletAddress || "";
    const p2Wallet = players[p2Id]?.walletAddress || "";

    console.log(`[GameManager] Payout → matchKey=${matchKey} | ${p1Wallet}=${p1Score} MST, ${p2Wallet}=${p2Score} MST`);

    await contractCaller.scoreBasedPayout(matchKey, p1Wallet, p1Score, p2Wallet, p2Score);
    console.log(`[GameManager] ✅ Payout tx sent for ${matchKey}`);
  } catch (e) {
    console.error(`[GameManager] ❌ Payout failed for ${matchKey}:`, e.message);
  }
}

async function triggerRefund(roomId, room) {
  try {
    const wallets = Object.values(room.players).map((p) => p.walletAddress);
    console.log(`[GameManager] Refund → ${wallets.join(", ")} @ ${room.stakeMST} MST`);
    await contractCaller.refundPlayers(roomId, wallets, room.stakeMST);
    console.log(`[GameManager] ✅ Refund tx sent for ${roomId}`);
  } catch (e) {
    console.error(`[GameManager] ❌ Refund failed for ${roomId}:`, e.message);
  }
}

module.exports = {
  resolveRPS,
  generateNineCards,
  getPrefabName,
  triggerScoreBasedPayout,
  triggerRefund,
};