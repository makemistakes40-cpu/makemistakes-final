import { prisma } from "@backend/lib/prisma";
import type { Db } from "mongodb";
import { DEFAULT_PROBLEM_ID } from "./problemId";

export interface ProblemAccessState {
  isPaid: boolean;
  plan: string;
  /**
   * The single problem ID a free-tier student is entitled to:
   * - their one grandfathered unfinished journey (preserved from before this
   *   policy), if they have one; otherwise
   * - the canonical P000001 challenge (every new student's single problem).
   * An in-progress journey NEVER grants access to additional problems.
   * Paid subscribers may access the full catalog (this set is not used).
   */
  freeAccessible: Set<string>;
}

/**
 * Resolves the MakeMistakes-owned problem eligibility state.
 *
 * - Paid subscribers (any non-FREE tier with an ACTIVE subscription) may access
 *   every problem in the catalog; the free-tier single-problem limit is lifted.
 * - Free-tier students are entitled to EXACTLY ONE problem: the single
 *   grandfathered unfinished journey they already had, or P000001. Starting any
 *   other problem requires an upgrade.
 */
export async function resolveProblemAccess(input: {
  db: Db;
  userIds: string[];
  sessionUserId: string | null;
}): Promise<ProblemAccessState> {
  const { db, userIds, sessionUserId } = input;

  let plan = "FREE";
  let status = "ACTIVE";
  if (sessionUserId) {
    try {
      const sub = await prisma.subscription.findUnique({
        where: { userId: sessionUserId },
      });
      if (sub) {
        plan = sub.plan || "FREE";
        status = sub.status || "ACTIVE";
        if (
          sub.expiryDate &&
          new Date() > new Date(sub.expiryDate) &&
          sub.status === "ACTIVE"
        ) {
          status = "EXPIRED";
          plan = "FREE";
        }
      }
    } catch {
      // On any subscription read failure, fail closed to FREE.
      plan = "FREE";
      status = "ACTIVE";
    }
  }

  const isPaid = plan !== "FREE" && status === "ACTIVE";
  const freeAccessible = new Set<string>();

  if (!isPaid) {
    // MakeMistakes-owned free-tier entitlement: EXACTLY ONE problem.
    //
    // The entitlement is persisted once on the canonical Prisma User
    // (entitledProblemId) and is never recalculated after it is set. This is
    // race-safe by construction: the first writer wins via a conditional
    // update, and a loser re-reads the winner's persisted value.
    const entitledProblemId = await resolveEntitledProblemId({
      db,
      userIds,
      sessionUserId,
    });
    if (entitledProblemId) {
      freeAccessible.add(entitledProblemId);
    }
  }

  return { isPaid, plan, freeAccessible };
}

async function resolveEntitledProblemId(input: {
  db: Db;
  userIds: string[];
  sessionUserId: string | null;
}): Promise<string | null> {
  const { db, userIds, sessionUserId } = input;

  // 1. If a persisted entitlement exists, never change it.
  if (sessionUserId) {
    const existing = await prisma.user.findUnique({
      where: { id: sessionUserId },
      select: { entitledProblemId: true },
    });
    if (existing?.entitledProblemId) {
      return existing.entitledProblemId;
    }
  }

  // 2. Determine the candidate: the EARLIEST journey across both the email and
  //    the Prisma userId (createdAt ASC, _id ASC tie-break), else P000001.
  const cursor = db
    .collection("user_journeys")
    .find({ userId: { $in: userIds } }, { projection: { problemId: 1 } })
    .sort({ createdAt: 1, _id: 1 })
    .limit(1);
  const first = await cursor.next();
  const problemId = (first as { problemId?: string } | null)?.problemId;
  const candidate = problemId || DEFAULT_PROBLEM_ID;

  // 3. Persist set-once with an atomic conditional update. If it matches 0
  //    rows, a concurrent request won; re-read the persisted winner.
  if (!sessionUserId) {
    // Unauthenticated/guest path: nothing to persist; return transient value.
    return candidate;
  }

  const update = await prisma.user.updateMany({
    where: { id: sessionUserId, entitledProblemId: null },
    data: { entitledProblemId: candidate },
  });

  if (update.count === 1) {
    return candidate;
  }

  const winner = await prisma.user.findUnique({
    where: { id: sessionUserId },
    select: { entitledProblemId: true },
  });
  return winner?.entitledProblemId ?? candidate;
}
