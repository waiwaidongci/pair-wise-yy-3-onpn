import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDb, saveDb, findSample, findSlice } from "./src/repository.js";
import { applyHandoff, applyReview, judgeHandoff, judgeReview, sampleView } from "./src/handoff.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3025);
const pagePath = join(__dirname, "public", "index.html");

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
const hasText = (value) => typeof value === "string" && value.trim().length > 0;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(await readFile(pagePath, "utf8"));
    }

    // —— 样本列表：当前责任人、最近复核结果、可操作入口都由视图层派生 ——
    if (req.method === "GET" && url.pathname === "/api/samples") {
      return sendJson(res, 200, db.samples.map(sampleView));
    }

    if (req.method === "GET" && url.pathname === "/api/reagent-batches") {
      return sendJson(res, 200, db.reagentBatches);
    }

    // 创建样本
    if (req.method === "POST" && url.pathname === "/api/samples") {
      const input = await body(req);
      const conflicts = [];
      for (const field of ["project", "borehole", "coreBox", "depth", "owner", "sliceId", "method"]) {
        if (!hasText(input[field])) conflicts.push({ code: "field_required", field, message: `${field} 必填` });
      }
      if (conflicts.length) return sendJson(res, 409, { conflicts });
      const sample = {
        id: `CORE-${Date.now()}`,
        project: input.project.trim(),
        borehole: input.borehole.trim(),
        coreBox: input.coreBox.trim(),
        depth: input.depth.trim(),
        owner: input.owner.trim(),
        delivery: "未交付",
        slices: [
          { id: input.sliceId.trim(), method: input.method.trim(), step: "取样", phase: "待交接", handoffs: [] }
        ]
      };
      db.samples.unshift(sample);
      await saveDb(db);
      return sendJson(res, 201, sampleView(sample));
    }

    const addSlice = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices$/);
    if (addSlice && req.method === "POST") {
      const sample = findSample(db, addSlice[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const input = await body(req);
      if (!hasText(input.id)) {
        return sendJson(res, 409, { conflicts: [{ code: "field_required", field: "id", message: "切片编号必填" }] });
      }
      if (sample.slices.some((slice) => slice.id === input.id.trim())) {
        return sendJson(res, 409, { conflicts: [{ code: "slice_duplicate", field: "id", message: "切片编号已存在" }] });
      }
      sample.slices.push({
        id: input.id.trim(),
        method: hasText(input.method) ? input.method.trim() : "未指定",
        step: "取样",
        phase: "待交接",
        handoffs: []
      });
      await saveDb(db);
      return sendJson(res, 201, sampleView(sample));
    }

    const handoffMatch = url.pathname.match(
      /^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/handoffs$/
    );
    if (handoffMatch && req.method === "POST") {
      const sample = findSample(db, handoffMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const slice = findSlice(sample, handoffMatch[2]);
      if (!slice) return sendJson(res, 404, { error: "slice_not_found" });
      const input = await body(req);

      // 交接判定：有冲突直接返回，绝不保存
      const verdict = judgeHandoff(slice, input, db.reagentBatches);
      if (!verdict.ok) return sendJson(res, 409, { conflicts: verdict.conflicts });

      const atIso = new Date().toISOString();
      applyHandoff(slice, input, atIso);
      await saveDb(db); // 判定通过后才保存
      return sendJson(res, 201, sampleView(sample));
    }

    const reviewMatch = url.pathname.match(
      /^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/reviews$/
    );
    if (reviewMatch && req.method === "POST") {
      const sample = findSample(db, reviewMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const slice = findSlice(sample, reviewMatch[2]);
      if (!slice) return sendJson(res, 404, { error: "slice_not_found" });
      const input = await body(req);

      const verdict = judgeReview(slice, input);
      if (!verdict.ok) return sendJson(res, 409, { conflicts: verdict.conflicts });

      const atIso = new Date().toISOString();
      applyReview(slice, input, atIso);
      await saveDb(db);
      return sendJson(res, 200, sampleView(sample));
    }

    const deliverMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/deliver$/);
    if (deliverMatch && req.method === "POST") {
      const sample = findSample(db, deliverMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const unfinished = sample.slices.filter((slice) => slice.phase !== "完成");
      if (unfinished.length) {
        return sendJson(res, 409, {
          conflicts: [
            {
              code: "slices_unfinished",
              field: null,
              message: `还有 ${unfinished.length} 张切片未完成染色复核，不能交付（${unfinished.map((s) => s.id).join("、")}）`
            }
          ]
        });
      }
      sample.delivery = "已交付";
      await saveDb(db);
      return sendJson(res, 200, sampleView(sample));
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Core slice lab app listening on http://localhost:${port}`));
