"use server";
// Cleanup server actions → `web/lib/services/reviews.ts` (shared with future agent routes).
import { redirect } from "next/navigation";
import { num, runAction, str, type ActionResult } from "@/lib/actions";
import { badRequest } from "@/lib/http";
import {
  answerReceiptReview,
  answerTrashCam,
  confirmItem,
  dismissReview,
  mergeItems,
  type LineAnswer,
} from "@/lib/services/reviews";

const need = (v: string | null, what: string): string => {
  if (!v) throw badRequest(`${what} is required`);
  return v;
};

/** One confirm for the whole receipt: each `line:<id>` field is keep / ignore / leave / item:<id>. */
export async function answerReceiptAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  const res = await runAction("answer_receipt_review", async ({ db, ctx }) => {
    const answers: LineAnswer[] = [];
    for (const [key, value] of f.entries()) {
      if (!key.startsWith("line:") || typeof value !== "string") continue;
      const lineId = key.slice(5);
      if (value === "keep" || value === "ignore") answers.push({ lineId, answer: value });
      else if (value.startsWith("item:"))
        answers.push({ lineId, answer: "item", itemId: value.slice(5) });
      // "leave": no answer — the line stays unmatched.
    }
    await answerReceiptReview(db, need(str(f, "reviewId"), "Review"), answers, ctx);
  });
  if (res?.ok) redirect("/cleanup?done=receipt");
  return res;
}

export async function mergeAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  return runAction("merge_items", async ({ db, ctx }) => {
    const unitQuantity = num(f, "unitQuantity");
    await mergeItems(
      db,
      {
        reviewId: str(f, "reviewId"),
        itemId: need(str(f, "itemId"), "Item"),
        intoItemId: need(str(f, "intoItemId"), "Which item it is"),
        unitQuantity,
      },
      ctx,
    );
    return "Merged.";
  });
}

export async function confirmItemAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  return runAction("confirm_item", async ({ db, ctx }) => {
    await confirmItem(
      db,
      { reviewId: need(str(f, "reviewId"), "Review"), name: str(f, "name") },
      ctx,
    );
    return "Saved.";
  });
}

export async function answerTrashCamAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  return runAction("answer_trash_cam", async ({ db, ctx }) => {
    await answerTrashCam(
      db,
      { reviewId: need(str(f, "reviewId"), "Review"), itemId: need(str(f, "itemId"), "Item") },
      ctx,
    );
    return "Marked as out.";
  });
}

export async function dismissAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  return runAction("dismiss_review", async ({ db, ctx }) => {
    await dismissReview(db, need(str(f, "reviewId"), "Review"), ctx);
  });
}
