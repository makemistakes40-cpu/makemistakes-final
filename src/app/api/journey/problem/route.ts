import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { getAuthSession } from "@/lib/authSession";
import { normalizeProblemId } from "@/lib/problemId";
import { evaluateUserUnlock, formatAdvancedLockError } from "@/lib/unlockEligibility";
import { resolveProblemAccess } from "@/lib/problemAccess";

/** Normalize Mongo problem docs for the Build engine (difficulty / learning / build). */
function toProblemPayload(doc: Record<string, any>) {
  const { _id, ...rest } = doc;
  return {
    ...rest,
    problemId: rest.problemId,
    title: rest.title || "",
    problemStatement: rest.problemStatement || rest.title || "",
    category: rest.category,
    difficulty: rest.difficulty ?? rest.learning?.level ?? null,
    learning: rest.learning ?? (rest.difficulty ? { level: rest.difficulty } : null),
    build: rest.build ?? undefined,
    relatedInformation: rest.relatedInformation,
    quiz: rest.quiz,
    metadata: rest.metadata,
    country: rest.country,
    source: rest.source,
  };
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    const rawUserId = (searchParams.get("userId") || "").toString().trim().toLowerCase();

    if (!id) {
      return NextResponse.json({ error: "Missing required 'id' parameter" }, { status: 400 });
    }

    if (!process.env.DATABASE_URL) {
      return NextResponse.json({ error: "DATABASE_URL is not configured" }, { status: 500 });
    }

    // Strict session verification: derive identity exclusively from verified session
    const session = await getAuthSession(req);
    const authIdentifiers: string[] = [];
    if (session?.email?.trim()) authIdentifiers.push(session.email.trim().toLowerCase());
    if (session?.userId?.trim() && !authIdentifiers.includes(session.userId.trim())) {
      authIdentifiers.push(session.userId.trim());
    }

    const hasUser = authIdentifiers.length > 0;
    const userFilter = authIdentifiers.length === 1
      ? { userId: authIdentifiers[0] }
      : hasUser
      ? { userId: { $in: authIdentifiers } }
      : null;

    const db = await getDb();
    const collection = db.collection("problems");

    // MakeMistakes-owned free-tier eligibility gate. Free-tier students may
    // access the canonical P000001 challenge plus any problem they have already
    // started; attempting to start any other problem requires an upgrade.
    if (hasUser) {
      const access = await resolveProblemAccess({
        db,
        userIds: authIdentifiers,
        sessionUserId: (session?.userId?.trim() as string | null) || null,
      });
      const pid = normalizeProblemId(id);
      if (!access.isPaid && !access.freeAccessible.has(pid)) {
        return NextResponse.json(
          {
            locked: true,
            upgradeRequired: true,
            error:
              "This challenge is part of a paid plan. Upgrade to access additional problems.",
          },
          { status: 403 }
        );
      }
    }

    const problem: any = await collection.findOne({ problemId: id });

    if (!problem) {
      return NextResponse.json(
        {
          error: `Problem '${id}' was not found. The Problem Library is currently empty or waiting for problem import.`,
        },
        { status: 404 }
      );
    }

    const diff = problem.difficulty || problem.learning?.level;

    // Check Advanced problem unlock security using shared unlock eligibility engine
    if (diff === "Advanced") {
      const userJourneysCollection = db.collection("user_journeys");
      const completionsCollection = db.collection("problem_completions");

      // Check if user has already started or completed this specific problem
      let hasActiveSession = false;
      if (hasUser) {
        const [existingJourney, existingCompletion] = await Promise.all([
          userJourneysCollection.findOne({ userId: { $in: authIdentifiers }, problemId: id }),
          completionsCollection.findOne({ userId: { $in: authIdentifiers }, problemId: id }),
        ]);
        hasActiveSession = Boolean(existingJourney || existingCompletion);
      }

      if (!hasActiveSession) {
        const { unlockProgress } = await evaluateUserUnlock(db, userFilter);

        if (!unlockProgress.advancedUnlocked) {
          return NextResponse.json(
            {
              locked: true,
              error: formatAdvancedLockError(unlockProgress),
              unlockProgress,
            },
            { status: 403 }
          );
        }
      }
    }

    return NextResponse.json(toProblemPayload(problem as Record<string, any>));
  } catch (err: any) {
    console.error("Error in /api/journey/problem:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
