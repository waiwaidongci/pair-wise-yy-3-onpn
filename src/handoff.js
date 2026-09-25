// 交接判定层：纯领域逻辑，不接触 HTTP，也不负责落盘。
// 每张切片按 取样 → 切割 → 研磨 → 染色 逐道交接；
// 上一道复核通过后才能交接下一道；复核不通过则退回当前步骤。

export const STEPS = ["取样", "切割", "研磨", "染色"];

const hasText = (value) => typeof value === "string" && value.trim().length > 0;

export function lastHandoff(slice, step = slice.step) {
  const list = (slice.handoffs || []).filter((item) => item.step === step);
  return list.length ? list[list.length - 1] : null;
}

export function passedHandoff(slice, step) {
  return (
    (slice.handoffs || []).find(
      (item) =>
        item.step === step && (item.reviews || []).some((review) => review.passed === true)
    ) || null
  );
}

export function latestReview(slice) {
  let latest = null;
  for (const handoff of slice.handoffs || []) {
    for (const review of handoff.reviews || []) {
      if (!latest || new Date(review.at).getTime() > new Date(latest.at).getTime()) {
        latest = { ...review, step: handoff.step };
      }
    }
  }
  return latest;
}

/**
 * 交接判定：返回 { ok, conflicts }。
 * 不修改 slice —— 判定不通过时调用方必须原样返回，不得保存。
 * 冲突项一次性收齐，便于入口逐条指出。
 */
export function judgeHandoff(slice, input, reagentBatches = []) {
  const conflicts = [];
  const push = (code, field, message, detail) =>
    conflicts.push(detail ? { code, field, message, detail } : { code, field, message });

  if (slice.phase === "完成") {
    push("slice_finished", null, "该切片已完成全部制片工序，不能再交接");
  }
  if (slice.phase === "待复核") {
    push(
      "review_pending",
      "step",
      `「${slice.step}」已送复核尚未有结论，上一步没有复核通过，不能进入下一步`
    );
  }
  if (hasText(input.step) && input.step !== slice.step) {
    push("step_mismatch", "step", `当前应交接的工序为「${slice.step}」，收到的是「${input.step}」`);
  }
  if (!hasText(input.operator)) push("operator_required", "operator", "操作人必填");
  if (!hasText(input.consumableBatch)) {
    push("consumable_batch_required", "consumableBatch", "耗材批次必填");
  }
  if (!hasText(input.observation)) push("observation_required", "observation", "观察结果必填");

  const at = hasText(input.handoffAt) ? new Date(input.handoffAt) : null;
  if (!at || Number.isNaN(at.getTime())) {
    push("handoff_at_required", "handoffAt", "交接时间缺失或格式无效");
  }

  const stepIndex = STEPS.indexOf(slice.step);
  if (at && stepIndex > 0) {
    const previousStep = STEPS[stepIndex - 1];
    const previous = passedHandoff(slice, previousStep);
    if (!previous) {
      push(
        "previous_not_reviewed",
        "step",
        `上一道「${previousStep}」还没有复核通过，不能交接「${slice.step}」`
      );
    } else if (at.getTime() < new Date(previous.completedAt).getTime()) {
      push(
        "handoff_before_previous",
        "handoffAt",
        `交接时间早于上一步「${previousStep}」的完成时间（${previous.completedAt}）`,
        { previousStep, previousCompletedAt: previous.completedAt }
      );
    }
  }

  // 只有染色工序校验染色批次有效期
  if (slice.step === "染色" && hasText(input.consumableBatch) && at) {
    const batch = reagentBatches.find((item) => item.batchNo === input.consumableBatch);
    if (!batch) {
      push(
        "stain_batch_not_found",
        "consumableBatch",
        `染色批次「${input.consumableBatch}」查不到登记记录`
      );
    } else if (new Date(batch.expireAt).getTime() < at.getTime()) {
      push(
        "stain_batch_expired",
        "consumableBatch",
        `染色批次「${batch.batchNo}」已于 ${String(batch.expireAt).slice(0, 10)} 过期，本次染色交接不允许使用`,
        { batchNo: batch.batchNo, expireAt: batch.expireAt }
      );
    }
  }

  return { ok: conflicts.length === 0, conflicts };
}

/**
 * 复核判定：只处理“待复核”的交接单；
 * 不通过必须填写原因，用于退回当前步骤。
 */
export function judgeReview(slice, input) {
  const conflicts = [];
  const push = (code, field, message) => conflicts.push({ code, field, message });

  if (slice.phase !== "待复核") {
    push("no_pending_handoff", null, "当前没有等待复核的交接，不能复核");
  }
  if (!hasText(input.reviewer)) push("reviewer_required", "reviewer", "复核人必填");
  if (typeof input.passed !== "boolean") {
    push("result_required", "passed", "复核结果（通过/不通过）必填");
  }
  if (input.passed === false && !hasText(input.reason)) {
    push("reason_required", "reason", "复核不通过必须填写退回原因");
  }
  return { ok: conflicts.length === 0, conflicts };
}

// —— 判定通过后的状态流转（仅改内存对象，由仓储负责保存）——

let handoffSeq = 0;
export function applyHandoff(slice, input, atIso) {
  const handoff = {
    id: `H-${Date.now().toString(36)}-${(handoffSeq++).toString(36)}`,
    step: slice.step,
    operator: input.operator.trim(),
    reviewer: hasText(input.reviewer) ? input.reviewer.trim() : "当班复核员",
    consumableBatch: input.consumableBatch.trim(),
    observation: input.observation.trim(),
    completedAt: new Date(input.handoffAt).toISOString(),
    submittedAt: atIso,
    reviews: []
  };
  (slice.handoffs ||= []).push(handoff);
  slice.phase = "待复核";
  return handoff;
}

export function applyReview(slice, input, atIso) {
  const handoff = lastHandoff(slice);
  const review = {
    reviewer: input.reviewer.trim(),
    passed: input.passed === true,
    reason: input.passed === true ? "" : (input.reason || "").trim(),
    at: atIso
  };
  (handoff.reviews ||= []).push(review);

  if (review.passed) {
    const index = STEPS.indexOf(slice.step);
    if (index === STEPS.length - 1) {
      slice.phase = "完成";
      slice.completedAt = atIso;
    } else {
      slice.step = STEPS[index + 1];
      slice.phase = "待交接";
    }
  } else {
    // 复核不通过：留在当前步骤，交还给操作人重做
    slice.phase = "待交接";
  }
  return review;
}

// —— 读取视图：给样本列表补充当前责任人、最近复核结果、可操作入口等派生字段 ——

function formatReview(review) {
  if (!review) return null;
  return {
    step: review.step,
    passed: review.passed,
    reviewer: review.reviewer,
    reason: review.reason || "",
    at: review.at
  };
}

export function sliceView(slice, fallbackOwner) {
  const done = slice.phase === "完成";
  const pending = slice.phase === "待复核" ? lastHandoff(slice) : null;
  const current = lastHandoff(slice);
  const returned =
    slice.phase === "待交接" && current && (current.reviews || []).some((r) => r.passed === false)
      ? current
      : null;

  let currentOwner;
  let ownerRole;
  if (done) {
    currentOwner = "—";
    ownerRole = "已完成";
  } else if (pending) {
    currentOwner = pending.reviewer;
    ownerRole = "复核人";
  } else if (returned) {
    currentOwner = returned.operator;
    ownerRole = "操作人（退回重做）";
  } else {
    currentOwner = fallbackOwner || "待安排";
    ownerRole = "负责人";
  }

  const pipeline = STEPS.map((step) => {
    const passed = !!passedHandoff(slice, step);
    const attempts = (slice.handoffs || []).filter((h) => h.step === step);
    const rejected = attempts.some((h) => (h.reviews || []).some((r) => r.passed === false));
    const active = !done && step === slice.step;
    return {
      step,
      state: passed ? "passed" : active ? (rejected ? "returned" : "current") : "locked",
      rejected
    };
  });

  const review = latestReview(slice);
  return {
    id: slice.id,
    method: slice.method,
    step: done ? "完成" : slice.step,
    phase: slice.phase,
    done,
    currentOwner,
    ownerRole,
    canHandoff: slice.phase === "待交接",
    canReview: slice.phase === "待复核",
    pendingHandoff: pending
      ? {
          operator: pending.operator,
          reviewer: pending.reviewer,
          consumableBatch: pending.consumableBatch,
          observation: pending.observation,
          completedAt: pending.completedAt
        }
      : null,
    returnedReason: returned ? (returned.reviews || []).filter((r) => !r.passed).at(-1)?.reason || "" : "",
    latestReview: formatReview(review),
    pipeline
  };
}

export function sampleStatus(sample) {
  if (sample.delivery === "已交付") return "已交付";
  if (sample.slices.length && sample.slices.every((slice) => slice.phase === "完成")) {
    return "待观察";
  }
  return "制片中";
}

export function sampleView(sample) {
  const slices = sample.slices.map((slice) => sliceView(slice, sample.owner));
  const owners = [...new Set(slices.map((slice) => slice.currentOwner).filter((name) => name !== "—"))];
  const reviews = slices
    .map((slice) => slice.latestReview)
    .filter(Boolean)
    .sort((a, b) => new Date(b.at) - new Date(a.at));
  return {
    ...sample,
    status: sampleStatus(sample),
    currentOwner: owners.length ? owners.join("、") : "—",
    latestReview: reviews[0] || null,
    slices
  };
}
