// 交接判定层：只根据传入的切片状态、交接内容和耗材批次台账给出结论。
// 不解析 HTTP 请求、不读写数据库，判定结果交给请求入口决定是否保存。

export const CHAIN = ["取样", "切割", "研磨", "染色"];

export function latestHandover(slice, step) {
  const list = (slice.handovers || []).filter(item => item.step === step);
  return list[list.length - 1] || null;
}

// 判定一次交接能否登记：返回 { ok, conflicts }，conflicts 为空才允许保存。
export function judgeHandover(slice, input, batches) {
  const conflicts = [];
  const idx = CHAIN.indexOf(input.step);
  if (idx === -1) {
    conflicts.push(`交接步骤无效：${input.step || "空"}（应为 ${CHAIN.join("→")} 之一）`);
  } else if (slice.status !== input.step) {
    conflicts.push(`切片当前步骤为「${slice.status}」，不能交接「${input.step}」`);
  }

  const sameStep = idx >= 0 ? latestHandover(slice, input.step) : null;
  if (sameStep && !sameStep.review) {
    conflicts.push(`「${input.step}」已登记交接但尚未复核，需先完成复核`);
  }
  if (sameStep && input.at && new Date(input.at) < new Date(sameStep.at)) {
    conflicts.push(`交接时间 ${input.at} 早于本步骤上次交接时间 ${sameStep.at}`);
  }

  if (idx > 0) {
    const prevStep = CHAIN[idx - 1];
    const prev = latestHandover(slice, prevStep);
    if (!prev) {
      conflicts.push(`上一步「${prevStep}」没有交接记录，不能进入「${input.step}」`);
    } else {
      if (!prev.review) {
        conflicts.push(`上一步「${prevStep}」尚未复核，不能进入「${input.step}」`);
      } else if (prev.review.result !== "通过") {
        conflicts.push(`上一步「${prevStep}」复核不通过（${prev.review.reason || "未填原因"}），需重新交接「${prevStep}」`);
      }
      if (input.at && prev.at && new Date(input.at) < new Date(prev.at)) {
        conflicts.push(`交接时间 ${input.at} 早于上一步「${prevStep}」完成时间 ${prev.at}`);
      }
    }
  }

  const batch = (batches || []).find(item => item.id === input.batch);
  if (input.step === "染色" && !batch) {
    conflicts.push(`染色批次 ${input.batch} 不在耗材批次台账中`);
  }
  if (batch && batch.type === "染色" && input.at && new Date(input.at) > new Date(batch.expiresAt)) {
    conflicts.push(`染色批次 ${batch.id} 已于 ${String(batch.expiresAt).slice(0, 10)} 过期`);
  }

  return { ok: conflicts.length === 0, conflicts };
}

// 判定一次复核能否登记：返回 { ok, reasons, handover }。
export function judgeReview(slice, input) {
  const reasons = [];
  const handover = latestHandover(slice, input.step);
  if (!handover) reasons.push(`「${input.step}」没有可复核的交接记录`);
  else if (handover.review) reasons.push(`「${input.step}」最近一次交接已复核（${handover.review.result}）`);
  if (!["通过", "不通过"].includes(input.result)) reasons.push("复核结果只能是「通过」或「不通过」");
  if (input.result === "不通过" && !(input.reason || "").trim()) reasons.push("复核不通过必须填写退回原因");
  return { ok: reasons.length === 0, reasons, handover };
}

// 判定通过后的状态迁移（仍不写库，由保存层统一落库）。
export function applyHandover(slice, input) {
  const record = {
    step: input.step,
    operator: input.operator,
    batch: input.batch,
    observation: input.observation || "",
    at: input.at,
    review: null
  };
  slice.handovers.push(record);
  slice.logs.push({
    at: input.at,
    step: input.step,
    note: `交接登记｜操作人 ${input.operator}｜耗材批次 ${input.batch}｜观察 ${record.observation || "无"}`
  });
  return record;
}

export function applyReview(slice, handover, input) {
  handover.review = { result: input.result, reviewer: input.reviewer, reason: input.reason || "", at: input.at };
  if (input.result === "通过") {
    const idx = CHAIN.indexOf(handover.step);
    slice.status = idx === CHAIN.length - 1 ? "观察" : CHAIN[idx + 1];
  } else {
    slice.status = handover.step; // 复核不通过：退回当前步骤，原因留在复核记录里
  }
  slice.logs.push({
    at: input.at,
    step: handover.step,
    note: input.result === "通过"
      ? `复核通过｜复核人 ${input.reviewer}`
      : `复核退回｜复核人 ${input.reviewer}｜原因 ${input.reason}`
  });
}

// 列表视图：当前责任人、最近复核结果，供样本列表展示。
export function sliceView(slice, sample) {
  const handovers = slice.handovers || [];
  const last = handovers[handovers.length - 1] || null;
  const reviewed = handovers.filter(item => item.review);
  const lastReviewed = reviewed[reviewed.length - 1] || null;
  return {
    ...slice,
    currentOwner: last ? last.operator : (sample ? sample.owner : null),
    pendingStep: last && !last.review ? last.step : null,
    lastReview: lastReviewed ? { step: lastReviewed.step, ...lastReviewed.review } : null
  };
}

export function sampleView(sample) {
  const slices = (sample.slices || []).map(slice => sliceView(slice, sample));
  const all = slices.flatMap(slice => (slice.handovers || []).map(item => ({ sliceId: slice.id, ...item })));
  const lastHandover = all.slice().sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0))[all.length - 1] || null;
  const reviewed = all
    .filter(item => item.review)
    .sort((a, b) => Date.parse(a.review.at || 0) - Date.parse(b.review.at || 0));
  const lastReviewed = reviewed[reviewed.length - 1] || null;
  return {
    ...sample,
    slices,
    currentOwner: lastHandover ? lastHandover.operator : sample.owner,
    lastReview: lastReviewed ? { sliceId: lastReviewed.sliceId, step: lastReviewed.step, ...lastReviewed.review } : null
  };
}
