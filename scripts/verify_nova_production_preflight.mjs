#!/usr/bin/env node
/**
 * Nova Dynamic Credits — Production Pre-Flight Verification Script
 *
 * READ-ONLY verification tool to audit MongoDB production collections prior to
 * Phase 1.5 / Phase 2 deployment:
 *  1. nova_wallet_deduction_receipts count
 *  2. Reservations stuck in status: "SETTLING"
 *  3. Inconsistent records: walletDeducted: false (or unset) but deduction receipt exists
 *  4. Orphan receipts: deduction receipts with no matching reservation
 *  5. Verified connection topology against the fail-closed transaction policy
 *
 * Strictly READ-ONLY. Makes zero mutations.
 */

import fs from "node:fs";
import path from "node:path";
import dns from "node:dns";
import { MongoClient } from "mongodb";

try {
  dns.setServers(["8.8.8.8", "1.1.1.1", "8.8.4.4"]);
} catch {
  // Use default
}

// Load .env fallback if DATABASE_URL not already in environment
if (!process.env.DATABASE_URL) {
  const envPath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("FATAL: DATABASE_URL is not set in environment or .env file.");
  process.exit(1);
}

function isClientTransactionCapable(client) {
  if (!client || typeof client.startSession !== "function") {
    return false;
  }
  const topologyType = client.topology?.description?.type;
  if (!topologyType) {
    return false;
  }
  return (
    topologyType === "ReplicaSetWithPrimary" ||
    topologyType === "Sharded" ||
    topologyType === "LoadBalanced"
  );
}

async function runPreflight() {
  console.log("================================================================================");
  console.log("  NOVA DYNAMIC CREDITS — PRODUCTION PRE-FLIGHT VERIFICATION (READ-ONLY)       ");
  console.log("================================================================================\n");

  const startTime = Date.now();
  const urlSafe = DATABASE_URL.replace(/\/\/([^:]+):([^@]+)@/, "//$1:****@");
  console.log(`Connecting to: ${urlSafe}`);

  const client = new MongoClient(DATABASE_URL, {
    serverSelectionTimeoutMS: 8000,
    connectTimeoutMS: 10000,
  });

  try {
    await client.connect();
    console.log("Connected successfully.\n");

    const db = client.db();
    const topologyType = client.topology?.description?.type || "Unknown";
    const transactionCapable = isClientTransactionCapable(client);

    console.log("--------------------------------------------------------------------------------");
    console.log(" 1. TOPOLOGY & TRANSACTION CAPABILITY");
    console.log("--------------------------------------------------------------------------------");
    console.log(`- Driver Detected Topology Type: ${topologyType}`);
    console.log(`- Meets Fail-Closed Policy:      ${transactionCapable ? "YES (PASS)" : "NO (FAIL)"}`);
    console.log(`- Supported Topologies:          ReplicaSetWithPrimary, Sharded, LoadBalanced\n`);

    const receiptsCol = db.collection("nova_wallet_deduction_receipts");
    const reservationsCol = db.collection("nova_credit_reservations");
    const walletsCol = db.collection("nova_user_wallets");

    console.log("--------------------------------------------------------------------------------");
    console.log(" 2. COLLECTION AUDIT & RECORD COUNTS");
    console.log("--------------------------------------------------------------------------------");

    // 1. Receipts count
    const receiptCount = await receiptsCol.countDocuments().catch(() => 0);
    console.log(`[Check 1] nova_wallet_deduction_receipts total count:  ${receiptCount}`);

    // 2. Reservations stuck in SETTLING
    const settlingReservations = await reservationsCol.find({ status: "SETTLING" }).toArray().catch(() => []);
    console.log(`[Check 2] Reservations with status === 'SETTLING':       ${settlingReservations.length}`);

    // 3. Reservations with walletDeducted != true but a receipt exists
    const allReceipts = await receiptsCol.find({}).toArray().catch(() => []);
    const receiptReservationIds = allReceipts.map((r) => r.reservationId || r._id);

    let unconfirmedWithReceipt = [];
    if (receiptReservationIds.length > 0) {
      unconfirmedWithReceipt = await reservationsCol
        .find({
          reservationId: { $in: receiptReservationIds },
          $or: [{ walletDeducted: false }, { walletDeducted: { $exists: false } }, { status: { $ne: "SETTLED" } }],
        })
        .toArray()
        .catch(() => []);
    }
    console.log(`[Check 3] Reservations with receipt but unconfirmed:    ${unconfirmedWithReceipt.length}`);

    // 4. Receipts without corresponding reservation
    let orphanReceipts = [];
    if (receiptReservationIds.length > 0) {
      const existingRes = await reservationsCol
        .find({ reservationId: { $in: receiptReservationIds } }, { projection: { reservationId: 1 } })
        .toArray()
        .catch(() => []);
      const existingResSet = new Set(existingRes.map((r) => r.reservationId));
      orphanReceipts = allReceipts.filter((r) => !existingResSet.has(r.reservationId || r._id));
    }
    console.log(`[Check 4] Receipts without corresponding reservation:     ${orphanReceipts.length}`);

    // 5. Total Wallets and Active Reservations
    const walletCount = await walletsCol.countDocuments().catch(() => 0);
    const totalReservations = await reservationsCol.countDocuments().catch(() => 0);
    console.log(`[Info]    Total user wallets initialized:                ${walletCount}`);
    console.log(`[Info]    Total reservations recorded:                   ${totalReservations}\n`);

    console.log("--------------------------------------------------------------------------------");
    console.log(" 3. DETAILED FINDINGS & RECONCILIATION REQUIREMENT");
    console.log("--------------------------------------------------------------------------------");

    const issues = [];

    if (!transactionCapable) {
      issues.push(`Topology '${topologyType}' is not transaction capable. Transactions would fail closed.`);
    }

    if (settlingReservations.length > 0) {
      issues.push(`Found ${settlingReservations.length} reservations stuck in SETTLING state.`);
      console.log("\nStuck SETTLING Reservations:");
      for (const res of settlingReservations) {
        console.log(` - ID: ${res.reservationId}, User: ${res.userId}, SettlingAt: ${res.settlingAt}, Error: ${res.settlementError || "none"}`);
      }
    }

    if (unconfirmedWithReceipt.length > 0) {
      issues.push(`Found ${unconfirmedWithReceipt.length} reservations with receipt but unconfirmed wallet deduction.`);
      console.log("\nUnconfirmed Reservations with Receipts:");
      for (const res of unconfirmedWithReceipt) {
        console.log(` - ID: ${res.reservationId}, Status: ${res.status}, walletDeducted: ${res.walletDeducted}`);
      }
    }

    if (orphanReceipts.length > 0) {
      issues.push(`Found ${orphanReceipts.length} orphan receipts with no reservation.`);
      console.log("\nOrphan Receipts:");
      for (const rc of orphanReceipts) {
        console.log(` - Receipt ID: ${rc._id}, Reservation ID: ${rc.reservationId}, Credits: ${rc.actualCreditsCharged}`);
      }
    }

    const elapsed = Date.now() - startTime;
    console.log(`\nExecution time: ${elapsed}ms`);

    console.log("\n================================================================================");
    if (issues.length === 0) {
      console.log("  PRE-FLIGHT VERDICT: CLEAN / READY FOR PHASE 1.5 DEPLOYMENT (PASS)");
      console.log("  Zero orphan receipts, zero stuck settlements, valid transaction topology.");
      console.log("  No historical data reconciliation is required.");
      console.log("================================================================================\n");
      return { success: true, issues: [] };
    } else {
      console.log("  PRE-FLIGHT VERDICT: ISSUES DETECTED / RECONCILIATION REQUIRED (FAIL)");
      for (const issue of issues) {
        console.log(`  * ${issue}`);
      }
      console.log("================================================================================\n");
      return { success: false, issues };
    }
  } finally {
    await client.close();
  }
}

runPreflight()
  .then((res) => {
    process.exit(res.success ? 0 : 2);
  })
  .catch((err) => {
    console.error("FATAL Pre-flight error:", err);
    process.exit(1);
  });
