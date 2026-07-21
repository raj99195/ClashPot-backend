/**
 * ClashPot PvP — authoritative game server
 *
 * FIXES vs purana version:
 *  1. card_picked_broadcast me DONO players ke scores jaate hain
 *     (client pe enemy score hamesha 0.00 dikhta tha)
 *  2. next_turn + nine_cards_deal me server-generated `highlighted` indices
 *     (pehle client khud random 3 chunta tha → dono screens alag + cheatable)
 *  3. pick_card me highlight validation — modified client sabse bada card nahi utha sakta
 *  4. Saare silent `return` hata diye — har reject pe socket.emit("error") + console.warn
 *  5. match_result me winnerSlot ("p1"|"p2"|"draw") — wallet compare bug fix
 *  6. Tie ab draw hai (pehle p2 by default jeet jaata tha)
 *  7. Mid-game disconnect pe pending payout/refund handle
 *  8. Har room ke liye trace log — [room:xyz] prefix se debug easy
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const gameManager = require("./gameManager");
const contractCaller = require("./contractCaller");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

app.use(express.json());

const rooms = {};
const moveTimers = {};
const rematchTimers = {};
const REMATCH_WINDOW_MS = 60000;   // match ke baad itni der tak rematch offer

// ─────────────────────────────────────────
// LOGGING
// ─────────────────────────────────────────

const ts = () => new Date().toISOString().substr(11, 12);
const log = (roomId, msg, extra = "") =>
  console.log(`[${ts()}][room:${roomId || "-"}] ${msg}${extra ? "  |  " + extra : ""}`);
const warn = (roomId, msg, extra = "") =>
  console.warn(`[${ts()}][room:${roomId || "-"}] ⚠ ${msg}${extra ? "  |  " + extra : ""}`);
const err = (roomId, msg, extra = "") =>
  console.error(`[${ts()}][room:${roomId || "-"}] ❌ ${msg}${extra ? "  |  " + extra : ""}`);

/** Client ko error bhejo AUR server pe log karo — silent drop kabhi nahi. */
function reject(socket, roomId, reason, detail = "") {
  warn(roomId, `REJECT (${socket.id}): ${reason}`, detail);
  socket.emit("error", { message: reason });
}

/** Debug endpoints — browser me kholke live state dekh sakte ho. */
app.get("/", (req, res) => res.json({ status: "ClashPot PvP Running", rooms: Object.keys(rooms).length }));

app.get("/debug/rooms", (req, res) => {
  const out = {};
  for (const id in rooms) {
    const r = rooms[id];
    out[id] = {
      players: Object.values(r.players).map((p) => ({ slot: p.slot, wallet: p.walletAddress })),
      scores: r.scores,
      currentTurnSlot: r.currentTurn && r.players[r.currentTurn] ? r.players[r.currentTurn].slot : null,
      turnCount: r.turnCount,
      highlighted: r.highlighted,
      stakeMST: r.stakeMST,
      cards: r.nineCards.map((c, i) => ({ i, name: c.name, value: c.value, picked: !!c.picked })),
    };
  }
  res.json(out);
});

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

function slotId(room, slot) {
  return Object.keys(room.players).find((id) => room.players[id].slot === slot);
}

function scoresBySlot(room) {
  const p1Id = slotId(room, "p1");
  const p2Id = slotId(room, "p2");
  return {
    p1Score: p1Id ? room.scores[p1Id] || 0 : 0,
    p2Score: p2Id ? room.scores[p2Id] || 0 : 0,
  };
}

/**
 * ✅ SERVER-AUTHORITATIVE HIGHLIGHTS
 * Har turn pe 3 random unpicked cards chuno. Client ab khud random nahi karta —
 * isliye dono screens pe same cards glow karte hain, aur pick validate hota hai.
 */
function pickHighlights(room, count = 3) {
  const available = room.nineCards
    .map((c, i) => (c.picked ? -1 : i))
    .filter((i) => i >= 0);

  const chosen = [];
  while (chosen.length < count && available.length > 0) {
    const k = Math.floor(Math.random() * available.length);
    chosen.push(available.splice(k, 1)[0]);
  }

  room.highlighted = chosen;
  return chosen;
}

// ─────────────────────────────────────────
// SOCKET
// ─────────────────────────────────────────

io.on("connection", (socket) => {
  log(null, `Player connected: ${socket.id}`);

  // ── JOIN ROOM ────────────────────────────
  socket.on("join_room", ({ roomId, walletAddress, stakeMST }) => {
    log(roomId, `join_room from ${socket.id}`, `wallet=${walletAddress} stake=${stakeMST}`);

    if (!roomId || !walletAddress) {
      return reject(socket, roomId, "Invalid payload.", `roomId=${roomId} wallet=${walletAddress}`);
    }

    // ⚠️ Real-money match sirf REAL wallet ke saath.
    //    RoomBrowserUI ka fallback "0xDEV<guid>" tab banta hai jab ArcadeX SDK
    //    se wallet nahi milta (jaise game ko iframe ke bahar khola ho).
    //    Aise wallet se khela match settle nahi ho sakta — contract me
    //    depositor ka address kuch aur hota hai aur payout mapping fail hoti hai.
    //    Escrow on ho to yahin rok do, warna paisa fasta hai.
    const escrowEnabled = process.env.SKIP_ESCROW_CHECK !== "true" && !!process.env.ESCROW_CONTRACT;
    const looksReal = /^0x[a-fA-F0-9]{40}$/.test(walletAddress);

    if (escrowEnabled && !looksReal) {
      return reject(socket, roomId,
        "Wallet not connected. Open the game from ArcadeX.",
        `wallet=${walletAddress} — dev fallback se real-money match nahi ho sakta`);
    }
    if (!looksReal) {
      warn(roomId, "Dev wallet detected (escrow off, testing mode)", walletAddress);
    }

    socket.join(roomId);

    if (!rooms[roomId]) {
      const matchKey = roomId + "-" + Date.now();
      rooms[roomId] = {
        players: {},
        moves: {},
        scores: {},
        nineCards: [],
        highlighted: [],
        currentTurn: null,
        turnCount: 0,
        stakeMST: Number(stakeMST) || 1,
        escrowReady: false,
        readyPlayers: new Set(),
        // Escrow tracking
        escrowDeposits: new Set(),   // socket ids jinhone deposit confirm kiya
        escrowVerified: false,       // contract pe isFunded() confirmed
        matchKey,                    // unique key for matchId generation
        rpsWinner: null,
        finished: false,
        rematchVotes: new Set(),   // rematch ke liye kisne haan kaha
      };
      log(roomId, "Room created", `stake=${rooms[roomId].stakeMST} matchKey=${matchKey}`);
    }

    const room = rooms[roomId];

    // Reconnect: same wallet already andar hai. Sirf tab slot transfer karo jab
    // purana socket ACTUALLY disconnect ho chuka ho — warna ek hi machine pe
    // test karte waqt (same dev wallet) p1 ko room se nikaal dega.
    const existingId = Object.keys(room.players).find(
      (id) => room.players[id].walletAddress === walletAddress
    );
    if (existingId && existingId !== socket.id) {
      const stillOnline = io.sockets.sockets.has(existingId);

      if (stillOnline) {
        return reject(socket, roomId, "Wallet already in this room.",
          `existing=${existingId} — dono clients ka wallet same hai? PlayerPrefs check karo`);
      }

      warn(roomId, "Reconnect — slot transfer", `${existingId} → ${socket.id}`);
      const old = room.players[existingId];
      room.players[socket.id] = old;
      room.scores[socket.id] = room.scores[existingId] || 0;
      if (room.currentTurn === existingId) room.currentTurn = socket.id;
      delete room.players[existingId];
      delete room.scores[existingId];
      socket.emit("room_joined", { slot: old.slot, roomId, matchKey: room.matchKey, stakeMST: room.stakeMST });
      return;
    }

    if (Object.keys(room.players).length >= 2) {
      return reject(socket, roomId, "Room full.", `already=${Object.keys(room.players).length}`);
    }

    const slot = Object.keys(room.players).length === 0 ? "p1" : "p2";
    room.players[socket.id] = { walletAddress, slot };
    room.scores[socket.id] = 0;

    socket.emit("room_joined", { slot, roomId, matchKey: room.matchKey, stakeMST: room.stakeMST });
    log(roomId, `${walletAddress} joined as ${slot}`, `socket=${socket.id}`);

    if (Object.keys(room.players).length === 2) {
      io.to(roomId).emit("both_players_ready", { roomId });
      log(roomId, "Both players present");
    }
  });

  // ── PLAYER READY ─────────────────────────
  socket.on("player_ready", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return reject(socket, roomId, `Room '${roomId}' not found.`, "join_room chala tha?");

    room.readyPlayers.add(socket.id);
    log(roomId, `player_ready ${room.readyPlayers.size}/2`, `from=${socket.id}`);

    if (room.readyPlayers.size >= 2) {
      room.escrowReady = true;
      log(roomId, "Both ready — escrow check pending", room.matchKey);
      tryStartGame(roomId);
    }
  });

  // ── ESCROW CONFIRMED ─────────────────────────────────────────────
  // Client deposit karne ke baad bhejta hai. Dono ka deposit aane pe
  // contract se isFunded() verify hota hai, phir game_start jaata hai.
  socket.on("escrow_confirmed", ({ roomId, txHash }) => {
    const room = rooms[roomId];
    if (!room) return reject(socket, roomId, "Room not found");

    room.escrowDeposits.add(socket.id);
    const slot = room.players[socket.id]?.slot || "?";
    log(roomId, `escrow_confirmed ${room.escrowDeposits.size}/2`, `${slot} tx=${txHash || "none"}`);

    // Doosre player ko batao ki iska deposit ho gaya (UI ke liye)
    io.to(roomId).emit("escrow_progress", {
      deposited: room.escrowDeposits.size,
      total: 2,
      slot,
    });

    if (room.escrowDeposits.size >= 2) {
      log(roomId, "Dono deposits aa gaye — contract pe verify kar raha hu");
      tryStartGame(roomId);
    }
  });

  // ── REMATCH REQUEST ──────────────────────────────────────────────
  // Match khatam hone ke baad Try Again dabane pe aata hai.
  // Dono ka aane pe room reset hota hai NAYE matchKey ke saath.
  socket.on("rematch_request", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return reject(socket, roomId, "Rematch window khatam ho gaya.");
    if (!room.finished) return reject(socket, roomId, "Match abhi chal raha hai.");

    room.rematchVotes = room.rematchVotes || new Set();
    room.rematchVotes.add(socket.id);

    const slot = room.players[socket.id]?.slot || "?";
    log(roomId, `rematch_request ${room.rematchVotes.size}/2`, slot);

    io.to(roomId).emit("rematch_progress", {
      votes: room.rematchVotes.size,
      total: 2,
      slot,
    });

    if (room.rematchVotes.size >= 2) resetRoomForRematch(roomId);
  });

  // ── SUBMIT MOVE ──────────────────────────
  socket.on("submit_move", ({ roomId, move }) => {
    const room = rooms[roomId];
    if (!room) return reject(socket, roomId, `Room '${roomId}' not found.`);
    if (!room.escrowReady) return reject(socket, roomId, "Game not started.");
    if (!["rock", "paper", "scissors"].includes(move)) return reject(socket, roomId, "Invalid move.", move);
    if (room.moves[socket.id]) return reject(socket, roomId, "Already submitted.", room.moves[socket.id]);

    room.moves[socket.id] = move;
    socket.emit("move_received", { move });
    log(roomId, `${room.players[socket.id]?.slot} played ${move}`);

    if (Object.keys(room.moves).length === 2) {
      if (moveTimers[roomId]) clearTimeout(moveTimers[roomId]);
      resolveRPS(roomId);
    }
  });

  // ── PICK CARD ────────────────────────────
  socket.on("pick_card", ({ roomId, cardIndex }) => {
    log(roomId, `pick_card received`, `from=${socket.id} index=${cardIndex}`);

    const room = rooms[roomId];
    if (!room) {
      return reject(socket, roomId, `Room '${roomId}' not found.`,
        "Client ka currentRoomId khaali hai? join_room emit hua tha?");
    }
    if (room.finished) return reject(socket, roomId, "Match already finished.");

    if (!room.nineCards.length) {
      return reject(socket, roomId, "Cards not dealt yet.");
    }

    if (room.currentTurn !== socket.id) {
      const expected = room.players[room.currentTurn]?.slot || "none";
      const actual = room.players[socket.id]?.slot || "unknown";
      return reject(socket, roomId, "Not your turn.", `expected=${expected} got=${actual}`);
    }

    const card = room.nineCards[cardIndex];
    if (!card) return reject(socket, roomId, "Invalid card index.", `index=${cardIndex}`);
    if (card.picked) return reject(socket, roomId, "Card already picked.", `index=${cardIndex}`);

    // ✅ Highlight validation — cheat prevention
    if (room.highlighted.length > 0 && !room.highlighted.includes(cardIndex)) {
      return reject(socket, roomId, "Card not highlighted.",
        `index=${cardIndex} allowed=[${room.highlighted}]`);
    }

    // ── Accept ──
    card.picked = true;
    room.scores[socket.id] = parseFloat((room.scores[socket.id] + card.value).toFixed(2));
    room.turnCount++;

    const { p1Score, p2Score } = scoresBySlot(room);

    socket.emit("card_picked_confirmed", {
      cardIndex,
      card,
      newScore: room.scores[socket.id],
    });

    // ✅ Dono ko broadcast — dono scores ke saath
    io.to(roomId).emit("card_picked_broadcast", {
      pickerSlot: room.players[socket.id].slot,
      cardIndex,
      card,
      p1Score,
      p2Score,
      turnCount: room.turnCount,
    });

    log(roomId,
      `${room.players[socket.id].slot} picked [${cardIndex}] ${card.name} (${card.value})`,
      `p1=${p1Score} p2=${p2Score} turn=${room.turnCount}/9`);

    if (room.turnCount >= 9) resolveMatch(roomId);
    else nextTurn(roomId);
  });

  // ── DISCONNECT ───────────────────────────
  socket.on("disconnect", (reason) => {
    log(null, `Disconnected: ${socket.id}`, reason);

    for (const roomId in rooms) {
      const room = rooms[roomId];
      if (!room.players[socket.id]) continue;

      const leaverSlot = room.players[socket.id].slot;
      warn(roomId, `${leaverSlot} left mid-game`, `turnCount=${room.turnCount}`);

      delete room.players[socket.id];

      io.to(roomId).emit("opponent_disconnected", { message: "Opponent left. You win!" });

      // Cards deal ho chuke the to bacha hua player ko pot do, warna refund
      if (!room.finished) {
        if (room.nineCards.length > 0) {
          const remainingId = Object.keys(room.players)[0];
          if (remainingId) {
            room.scores[remainingId] = room.stakeMST * 2;
            log(roomId, "Walkover payout to remaining player",
              `${room.players[remainingId].walletAddress} = ${room.scores[remainingId]}`);
            gameManager.triggerScoreBasedPayout(room.matchKey, room.players, room.scores, room.stakeMST);
          }
        } else {
          gameManager.triggerRefund(roomId, room);
        }
        room.finished = true;
      }

      cleanup(roomId);
      break;
    }
  });
});

// ─────────────────────────────────────────
// ESCROW VERIFICATION + GAME START
// ─────────────────────────────────────────

/**
 * tryStartGame — dono conditions check karke game shuru karta hai:
 *   1. readyPlayers.size >= 2 (dono ne Start dabaya)
 *   2. Contract pe isFunded() = true (dono ka MSTC locked hai)
 *
 * Testing ke liye SKIP_ESCROW_CHECK=true .env mein set karo —
 * tab escrow verify nahi hoga aur seedha game shuru ho jaayega.
 */
async function tryStartGame(roomId) {
  const room = rooms[roomId];
  if (!room || room.finished) return;

  if (room.readyPlayers.size < 2) {
    log(roomId, "tryStartGame: dono ready nahi hain abhi");
    return;
  }

  // SKIP_ESCROW_CHECK=true: local dev / testing ke liye
  if (process.env.SKIP_ESCROW_CHECK === "true") {
    warn(roomId, "SKIP_ESCROW_CHECK=true — escrow verify nahi ho raha!");
    room.escrowReady = true;
    io.to(roomId).emit("game_start", { roomId });
    startMoveTimeout(roomId);
    log(roomId, "🎮 GAME START (escrow skipped)");
    return;
  }

  // Escrow contract check
  try {
    const check = await contractCaller.verifyEscrow(room.matchKey, room.stakeMST);
    if (!check.ok) {
      log(roomId, `Escrow ready nahi — ${check.reason}`,
        `matchKey=${room.matchKey}`);

      // Players ko inform karo ki deposit pending hai
      io.to(roomId).emit("escrow_pending", {
        matchKey: room.matchKey,
        message: "Stake deposit required to start the match."
      });
      return;
    }

    room.escrowVerified = true;
    room.escrowReady = true;
    io.to(roomId).emit("game_start", { roomId });
    startMoveTimeout(roomId);
    log(roomId, "🎮 GAME START (escrow verified)");
  } catch (e) {
    err(roomId, "Escrow isFunded check failed:", e.message);
    // Fallback: ESCROW_CONTRACT missing ho to game start kar do (dev mode)
    if (!process.env.ESCROW_CONTRACT) {
      warn(roomId, "ESCROW_CONTRACT not set — dev mode, starting without escrow");
      room.escrowReady = true;
      io.to(roomId).emit("game_start", { roomId });
      startMoveTimeout(roomId);
      log(roomId, "🎮 GAME START (no escrow contract)");
    }
  }
}

// ─────────────────────────────────────────
// REMATCH
// ─────────────────────────────────────────

/** Match ke baad rematch ka window kholo. Timeout pe room cleanup. */
function startRematchWindow(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  room.rematchVotes = new Set();
  log(roomId, `Rematch window open (${REMATCH_WINDOW_MS / 1000}s)`);

  io.to(roomId).emit("rematch_available", { seconds: REMATCH_WINDOW_MS / 1000 });

  if (rematchTimers[roomId]) clearTimeout(rematchTimers[roomId]);
  rematchTimers[roomId] = setTimeout(() => {
    if (!rooms[roomId]) return;
    log(roomId, "Rematch window closed — koi rematch nahi, cleanup");
    io.to(roomId).emit("rematch_expired", {});
    cleanup(roomId);
  }, REMATCH_WINDOW_MS);
}

/**
 * Room ko naye match ke liye reset karo.
 *
 * ⚠️ matchKey NAYA banana ZAROORI hai — purana matchId contract me Settled
 *    ho chuka hai aur join() uspe "Match not joinable" de dega.
 *    Players wahi rehte hain, stake wahi rehta hai.
 */
function resetRoomForRematch(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  if (rematchTimers[roomId]) { clearTimeout(rematchTimers[roomId]); delete rematchTimers[roomId]; }
  if (moveTimers[roomId])    { clearTimeout(moveTimers[roomId]);    delete moveTimers[roomId]; }

  const oldKey = room.matchKey;
  room.matchKey = `${roomId}-${Date.now()}`;

  room.moves          = {};
  room.nineCards      = [];
  room.highlighted    = [];
  room.currentTurn    = null;
  room.turnCount      = 0;
  room.rpsWinner      = null;
  room.finished       = false;
  room.escrowReady    = false;
  room.escrowVerified = false;
  room.readyPlayers   = new Set();
  room.escrowDeposits = new Set();
  room.rematchVotes   = new Set();

  for (const id of Object.keys(room.players)) room.scores[id] = 0;

  log(roomId, "🔁 REMATCH — room reset", `old=${oldKey} new=${room.matchKey}`);

  io.to(roomId).emit("rematch_start", {
    roomId,
    matchKey: room.matchKey,
    stakeMST: room.stakeMST,
  });
}

// ─────────────────────────────────────────
// RPS RESOLUTION
// ─────────────────────────────────────────

function resolveRPS(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const p1Id = slotId(room, "p1");
  const p2Id = slotId(room, "p2");
  if (!p1Id || !p2Id) {
    err(roomId, "resolveRPS: dono players nahi hain", `p1=${p1Id} p2=${p2Id}`);
    return;
  }

  const move1 = room.moves[p1Id];
  const move2 = room.moves[p2Id];
  const rpsWinner = gameManager.resolveRPS(move1, move2);

  io.to(roomId).emit("rps_result", { p1Move: move1, p2Move: move2, rpsWinner });
  log(roomId, `RPS: ${move1} vs ${move2} → ${rpsWinner}`);

  if (rpsWinner === "draw") {
    setTimeout(() => {
      if (!rooms[roomId]) return;
      rooms[roomId].moves = {};
      log(roomId, "Draw — restarting RPS");
      io.to(roomId).emit("game_start", { roomId });
      startMoveTimeout(roomId);
    }, 6500);
    return;
  }

  room.nineCards = gameManager.generateNineCards(room.stakeMST);
  room.rpsWinner = rpsWinner;
  const winnerId = rpsWinner === "p1" ? p1Id : p2Id;

  setTimeout(() => {
    if (!rooms[roomId]) return;

    room.currentTurn = winnerId;
    const highlighted = pickHighlights(room);   // ✅ pehla turn ke highlights

    io.to(roomId).emit("nine_cards_deal", {
      cards: room.nineCards,
      firstTurn: room.players[winnerId].slot,
      highlighted,
    });

    log(roomId, `9 cards dealt. First turn: ${room.players[winnerId].slot}`,
      `values=[${room.nineCards.map((c) => c.value).join(", ")}] highlighted=[${highlighted}]`);
  }, 2500);
}

// ─────────────────────────────────────────
// NEXT TURN
// ─────────────────────────────────────────

function nextTurn(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const playerIds = Object.keys(room.players);
  if (playerIds.length < 2) {
    warn(roomId, "nextTurn: sirf 1 player bacha — skip");
    return;
  }

  const currentIndex = playerIds.indexOf(room.currentTurn);
  const nextId = playerIds[currentIndex === 0 ? 1 : 0];

  room.currentTurn = nextId;
  const highlighted = pickHighlights(room);   // ✅ naye turn ke naye 3 cards

  io.to(roomId).emit("next_turn", {
    turnSlot: room.players[nextId].slot,
    highlighted,
  });

  log(roomId, `Next turn: ${room.players[nextId].slot}`, `highlighted=[${highlighted}]`);
}

// ─────────────────────────────────────────
// RESOLVE MATCH
// ─────────────────────────────────────────

function resolveMatch(roomId) {
  const room = rooms[roomId];
  if (!room || room.finished) return;
  room.finished = true;

  const p1Id = slotId(room, "p1");
  const p2Id = slotId(room, "p2");

  const p1Score = parseFloat((room.scores[p1Id] || 0).toFixed(2));
  const p2Score = parseFloat((room.scores[p2Id] || 0).toFixed(2));
  const p1Wallet = room.players[p1Id]?.walletAddress || "";
  const p2Wallet = room.players[p2Id]?.walletAddress || "";

  // ✅ Tie ab draw hai (pehle `p1Score > p2Score ? p1 : p2` se p2 by default jeetta tha)
  let winnerSlot = "draw";
  let winnerWallet = "";
  if (p1Score > p2Score) { winnerSlot = "p1"; winnerWallet = p1Wallet; }
  else if (p2Score > p1Score) { winnerSlot = "p2"; winnerWallet = p2Wallet; }

  io.to(roomId).emit("match_result", {
    winnerSlot,
    winnerWallet,
    p1Score,
    p2Score,
    p1Wallet,
    p2Wallet,
  });

  const pot = room.stakeMST * 2;
  const total = parseFloat((p1Score + p2Score).toFixed(2));
  log(roomId, `🏁 MATCH OVER — winner=${winnerSlot}`,
    `p1=${p1Score} p2=${p2Score} total=${total} pot=${pot}`);

  if (Math.abs(total - pot) > 0.01) {
    err(roomId, "PAYOUT MISMATCH — scores ka sum pot ke barabar nahi!",
      `total=${total} pot=${pot} — generateNineCards check karo`);
  }

  // Payout async hai — result aane pe clients ko batao.
  // ⚠️ Pehle ye fire-and-forget tha: settle fail hone pe sirf server console me
  //    error jaata tha aur players ko lagta tha paisa mil gaya. Ab UI batata hai.
  const matchKeyForPayout = room.matchKey;
  gameManager
    .triggerScoreBasedPayout(matchKeyForPayout, room.players, room.scores, room.stakeMST)
    .then((res) => {
      if (res.ok) {
        log(roomId, "💸 Payout confirmed", `tx=${res.txHash}`);
      } else {
        err(roomId, "PAYOUT FAILED — paisa contract me pada hai", res.error);
      }
      io.to(roomId).emit("payout_result", {
        ok: res.ok,
        txHash: res.txHash,
        error: res.error,
        matchKey: matchKeyForPayout,
      });
    })
    .catch((e) => {
      err(roomId, "Payout promise threw", e.message);
      io.to(roomId).emit("payout_result", {
        ok: false, txHash: null, error: e.message, matchKey: matchKeyForPayout,
      });
    });

  // ⚠️ cleanup(roomId) yahan NAHI — pehle rematch ka mauka do.
  //    Window khatam hone pe khud cleanup ho jaayega.
  startRematchWindow(roomId);
}

// ─────────────────────────────────────────
// TIMEOUTS
// ─────────────────────────────────────────

function startMoveTimeout(roomId) {
  if (moveTimers[roomId]) clearTimeout(moveTimers[roomId]);

  moveTimers[roomId] = setTimeout(() => {
    const room = rooms[roomId];
    if (!room) return;

    Object.keys(room.players).forEach((id) => {
      if (!room.moves[id]) {
        const auto = ["rock", "paper", "scissors"][Math.floor(Math.random() * 3)];
        room.moves[id] = auto;
        io.to(id).emit("move_auto", { move: auto, reason: "timeout" });
        warn(roomId, `Auto move for ${room.players[id].slot}: ${auto}`);
      }
    });

    resolveRPS(roomId);
  }, 15000);
}

// Card pick timeout jaan-boojh ke nahi hai — manual pick only (design decision)

// ─────────────────────────────────────────
// CLEANUP
// ─────────────────────────────────────────

function cleanup(roomId) {
  if (moveTimers[roomId])    { clearTimeout(moveTimers[roomId]);    delete moveTimers[roomId]; }
  if (rematchTimers[roomId]) { clearTimeout(rematchTimers[roomId]); delete rematchTimers[roomId]; }
  delete rooms[roomId];
  log(roomId, "Room cleaned up");
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`ClashPot PvP running on port ${PORT}`));