import test from "node:test";
import assert from "node:assert/strict";
import {
  STEPS,
  judgeHandoff,
  judgeReview,
  applyHandoff,
  applyReview,
  sampleView
} from "../src/handoff.js";

const batches = [
  { batchNo: "STAIN-OLD", category: "染色", expireAt: "2026-03-15T00:00:00.000Z" },
  { batchNo: "STAIN-NEW", category: "染色", expireAt: "2027-01-20T00:00:00.000Z" },
  { batchNo: "GRIND-1", category: "研磨", expireAt: "" }
];

function newSlice() {
  return { id: "SL-T", method: "茜素红染色", step: "取样", phase: "待交接", handoffs: [] };
}
const fullInput = (over = {}) => ({
  step: "取样",
  operator: "陆川",
  reviewer: "周敏",
  consumableBatch: "QC-BAG-1",
  observation: "条带清晰",
  handoffAt: "2026-09-25T10:00:00.000Z",
  ...over
});

test("取样交接：信息完整时判定通过，流转为待复核但不自动进入下一步", () => {
  const slice = newSlice();
  const verdict = judgeHandoff(slice, fullInput(), batches);
  assert.equal(verdict.ok, true);
  applyHandoff(slice, fullInput(), "2026-09-25T10:01:00.000Z");
  assert.equal(slice.phase, "待复核");
  assert.equal(slice.step, "取样");
});

test("上一步未复核：切割交接被拒，冲突包含 previous_not_reviewed", () => {
  const slice = newSlice();
  slice.step = "切割";
  const verdict = judgeHandoff(slice, fullInput({ step: "切割" }), batches);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.conflicts.some((c) => c.code === "previous_not_reviewed"));
  // 判定不通过不改状态
  assert.equal(slice.phase, "待交接");
  assert.equal(slice.handoffs.length, 0);
});

test("待复核状态重复交接：被拒（没有复核结论不能再交）", () => {
  const slice = newSlice();
  applyHandoff(slice, fullInput(), "2026-09-25T10:01:00.000Z");
  const verdict = judgeHandoff(slice, fullInput(), batches);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.conflicts.some((c) => c.code === "review_pending"));
});

test("复核不通过：退回当前步骤，必须有原因，操作人重新成为责任人", () => {
  const slice = newSlice();
  applyHandoff(slice, fullInput(), "2026-09-25T10:01:00.000Z");
  const bad = judgeReview(slice, { reviewer: "周敏", passed: false });
  assert.equal(bad.ok, false);
  assert.ok(bad.conflicts.some((c) => c.code === "reason_required"));

  applyReview(slice, { reviewer: "周敏", passed: false, reason: "位置取错" }, "2026-09-25T11:00:00.000Z");
  assert.equal(slice.phase, "待交接");
  assert.equal(slice.step, "取样");

  const view = sampleView({ id: "S", owner: "高岩", delivery: "未交付", slices: [slice] });
  assert.equal(view.slices[0].currentOwner, "陆川");
  assert.equal(view.slices[0].returnedReason, "位置取错");
  assert.equal(view.slices[0].canHandoff, true);
});

test("复核通过：当前步骤放行到下一道，责任人切给复核人再给下一步操作人", () => {
  const slice = newSlice();
  applyHandoff(slice, fullInput(), "2026-09-25T10:01:00.000Z");
  applyReview(slice, { reviewer: "周敏", passed: true }, "2026-09-25T11:00:00.000Z");
  assert.equal(slice.phase, "待交接");
  assert.equal(slice.step, "切割");
});

test("时间冲突：交接时间早于上一步完成时间时拒绝保存", () => {
  const slice = newSlice();
  // 取样 10:00 完成，11:00 复核通过
  applyHandoff(slice, fullInput({ handoffAt: "2026-09-25T10:00:00.000Z" }), "2026-09-25T10:01:00.000Z");
  applyReview(slice, { reviewer: "周敏", passed: true }, "2026-09-25T11:00:00.000Z");
  // 切割却填 09:00
  const verdict = judgeHandoff(
    slice,
    fullInput({ step: "切割", handoffAt: "2026-09-25T09:00:00.000Z" }),
    batches
  );
  assert.equal(verdict.ok, false);
  assert.ok(verdict.conflicts.some((c) => c.code === "handoff_before_previous"));
});

test("染色批次过期：使用过期批次被拒，换新批次后通过", () => {
  const slice = newSlice();
  // 快速把取样/切割/研磨推到复核通过
  const at = "2026-09-20T08:00:00.000Z";
  STEPS.slice(0, 3).forEach((step, i) => {
    slice.step = step; slice.phase = "待交接";
    const input = fullInput({
      step,
      consumableBatch: i === 2 ? "GRIND-1" : "QC-BAG-1",
      handoffAt: "2026-09-20T" + String(8 + i).padStart(2, "0") + ":00:00.000Z"
    });
    const verdict = judgeHandoff(slice, input, batches);
    assert.equal(verdict.ok, true);
    applyHandoff(slice, input, at);
    applyReview(slice, { reviewer: "周敏", passed: true }, at);
  });
  assert.equal(slice.step, "染色");

  const expired = judgeHandoff(
    slice,
    fullInput({ step: "染色", consumableBatch: "STAIN-OLD", handoffAt: "2026-09-24T09:00:00.000Z" }),
    batches
  );
  assert.equal(expired.ok, false);
  assert.ok(expired.conflicts.some((c) => c.code === "stain_batch_expired"));
  assert.equal(slice.phase, "待交接");

  const fresh = judgeHandoff(
    slice,
    fullInput({ step: "染色", consumableBatch: "STAIN-NEW", handoffAt: "2026-09-24T09:00:00.000Z" }),
    batches
  );
  assert.equal(fresh.ok, true);
});

test("染色复核通过后整片完成，样本进入待观察", () => {
  const slice = newSlice();
  let lastAt = "2026-09-20T08:00:00.000Z";
  STEPS.forEach((step, i) => {
    slice.step = step; slice.phase = "待交接";
    const input = fullInput({
      step,
      consumableBatch: "STAIN-NEW",
      handoffAt: "2026-09-2" + i + "T08:00:00.000Z"
    });
    assert.equal(judgeHandoff(slice, input, batches).ok, true);
    applyHandoff(slice, input, input.handoffAt);
    lastAt = input.handoffAt;
    applyReview(slice, { reviewer: "周敏", passed: true }, input.handoffAt);
  });
  assert.equal(slice.phase, "完成");
  const view = sampleView({ id: "S", owner: "高岩", delivery: "未交付", slices: [slice] });
  assert.equal(view.status, "待观察");
  assert.equal(view.slices[0].canHandoff, false);
  assert.equal(view.slices[0].canReview, false);
});

test("缺字段：操作人/耗材批次/观察结果缺失时一次性返回全部冲突", () => {
  const slice = newSlice();
  const verdict = judgeHandoff(slice, { step: "取样", handoffAt: "2026-09-25T10:00:00.000Z" }, batches);
  assert.equal(verdict.ok, false);
  const codes = verdict.conflicts.map((c) => c.code);
  assert.ok(codes.includes("operator_required"));
  assert.ok(codes.includes("consumable_batch_required"));
  assert.ok(codes.includes("observation_required"));
});
