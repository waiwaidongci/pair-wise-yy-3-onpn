// 请求入口层：只负责解析 HTTP 请求、调用交接判定、判定通过后交给保存层落库。
import http from "node:http";
import { loadDb, saveDb } from "./lib/store.js";
import { CHAIN, judgeHandover, judgeReview, applyHandover, applyReview, sampleView } from "./lib/handover.js";

const port = Number(process.env.PORT || 3025);
const statuses = ["待切割", "制片中", "待观察", "已交付"];

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function updateSampleStatus(sample) {
  const sliceStatuses = sample.slices.map(slice => slice.status);
  if (sliceStatuses.length && sliceStatuses.every(step => step === "观察")) sample.status = "待观察";
  if (sample.delivery === "已交付") sample.status = "已交付";
  else if (sliceStatuses.some(step => ["取样", "切割", "研磨", "染色"].includes(step))) sample.status = "制片中";
  else sample.status = "待切割";
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>岩芯样本切片实验室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#242822; --muted:#687062; --line:#d7ddd1; --accent:#526f43; --stone:#73706a; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:16px; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:390px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(310px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .slice { border-top:1px solid var(--line); padding-top:10px; display:grid; gap:8px; }
    .act { display:grid; gap:8px; border-top:1px dashed var(--line); padding-top:10px; }
    .row { display:flex; gap:8px; } .row button { flex:1; }
    .ghost { background:#fff; color:var(--accent); border:1px solid var(--accent); }
    .msg { display:none; margin:14px 28px 0; padding:10px 14px; border-radius:6px; }
    .msg.err { display:block; background:#fbeaea; color:#8c2f2f; border:1px solid #e5b8b8; }
    .msg.ok { display:block; background:#eaf4e5; color:#2f5c2f; border:1px solid #b8d8b0; }
    @media (max-width:950px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .stats{grid-template-columns:1fr 1fr;} .msg{margin:12px 16px 0;} }
  </style>
</head>
<body>
  <header><div><h1>岩芯样本切片实验室</h1><div class="meta">样本、切片任务、制片交接复核和交付</div></div><button id="reload">刷新</button></header>
  <div id="msg" class="msg"></div>
  <main>
    <form id="form">
      <h2>创建岩芯样本</h2>
      <label>项目</label><input name="project" required>
      <label>钻孔编号</label><input name="borehole" required>
      <label>岩芯箱号</label><input name="coreBox" required>
      <label>取样深度</label><input name="depth" required>
      <label>负责人</label><input name="owner" required>
      <label>初始切片编号</label><input name="sliceId" required>
      <label>染色方法</label><input name="method" required>
      <button>保存样本</button>
    </form>
    <section>
      <div class="stats" id="stats"></div>
      <div class="grid" id="samples"></div>
    </section>
  </main>
  <script>
    const statuses = ${JSON.stringify(statuses)};
    const chain = ${JSON.stringify(CHAIN)};
    const form = document.querySelector("#form");
    const stats = document.querySelector("#stats");
    const samplesEl = document.querySelector("#samples");
    const msg = document.querySelector("#msg");
    let samples = [];
    let batches = [];
    function esc(value) {
      return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    }
    function fmt(at) {
      const time = new Date(at);
      return Number.isNaN(time.getTime()) ? String(at || "") : time.toLocaleString("zh-CN", { hour12: false });
    }
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers: { "Content-Type": "application/json" } } : options);
      const data = await res.json();
      if (!res.ok) {
        const detail = data.conflicts && data.conflicts.length ? "：" + data.conflicts.join("；") : "";
        throw new Error((data.error || "请求失败") + detail);
      }
      return data;
    }
    function showMsg(text, ok) { msg.textContent = text; msg.className = ok ? "msg ok" : "msg err"; }
    async function run(action) {
      try { await action(); showMsg("已保存", true); await load(); }
      catch (error) { showMsg(error.message, false); }
    }
    function field(key, name) { return document.querySelector('[data-' + name + '="' + key + '"]').value; }
    function findSlice(sampleId, sliceId) { return samples.find(s => s.id === sampleId).slices.find(s => s.id === sliceId); }
    function reviewLabel(review) {
      if (!review) return "待复核";
      return review.result + (review.reason ? "（" + review.reason + "）" : "") + " · " + review.reviewer;
    }
    function lastReviewText(review) {
      return review ? review.step + " " + review.result + (review.reason ? "（" + review.reason + "）" : "") : "暂无";
    }
    function sliceHtml(sample, slice) {
      const key = sample.id + "|" + slice.id;
      const history = (slice.handovers && slice.handovers.length)
        ? slice.handovers.map(h => '<div class="meta">▸ ' + esc(h.step) + '｜操作人 ' + esc(h.operator) + '｜批次 ' + esc(h.batch) + '｜' + esc(fmt(h.at)) + '<br>观察：' + esc(h.observation || "—") + '｜复核：' + esc(reviewLabel(h.review)) + '</div>').join("")
        : '<div class="meta">暂无交接记录</div>';
      const reviewText = slice.lastReview ? lastReviewText(slice.lastReview) : (slice.pendingStep ? slice.pendingStep + " 待复核" : "暂无");
      let action = "";
      if (slice.pendingStep) {
        action = '<div class="act"><b>复核「' + esc(slice.pendingStep) + '」交接</b>'
          + '<input data-reviewer="' + key + '" placeholder="复核人">'
          + '<input data-reason="' + key + '" placeholder="退回原因（复核不通过时必填）">'
          + '<div class="row"><button data-approve="' + key + '">复核通过</button><button class="ghost" data-reject="' + key + '">复核退回</button></div></div>';
      } else if (chain.includes(slice.status)) {
        action = '<div class="act"><b>登记「' + esc(slice.status) + '」交接</b>'
          + '<input data-operator="' + key + '" placeholder="操作人">'
          + '<select data-batch="' + key + '"><option value="">选择耗材批次</option>' + batches.map(b => '<option value="' + esc(b.id) + '">' + esc(b.id) + '｜' + esc(b.name) + '｜' + esc(b.type) + '｜有效期至 ' + esc((b.expiresAt || "").slice(0, 10)) + '</option>').join("") + '</select>'
          + '<textarea data-obs="' + key + '" placeholder="观察结果"></textarea>'
          + '<label>交接时间（留空为当前时间）</label><input type="datetime-local" data-at="' + key + '">'
          + '<button data-handover="' + key + '">登记交接</button></div>';
      } else {
        action = '<div class="act"><b>观察结果</b><textarea data-finalobs="' + key + '" placeholder="观察结果">' + esc(slice.observation || "") + '</textarea><button data-observe="' + key + '">保存观察</button></div>';
      }
      return '<div class="slice"><b>' + esc(slice.id) + '</b> <span class="pill">' + esc(slice.status) + '</span>'
        + '<div class="meta">' + esc(slice.method) + '｜当前责任人：' + esc(slice.currentOwner || sample.owner) + '｜最近复核：' + esc(reviewText) + '</div>'
        + history + action + '</div>';
    }
    function render() {
      stats.innerHTML = statuses.map(s => '<div class="stat"><span>' + s + '</span><strong>' + samples.filter(item => item.status === s).length + '</strong></div>').join("");
      samplesEl.innerHTML = samples.map(sample => '<article class="card"><h3>' + esc(sample.project) + '</h3><span class="pill">' + esc(sample.status) + '</span>'
        + '<div class="meta">' + esc(sample.borehole) + ' · ' + esc(sample.coreBox) + ' · ' + esc(sample.depth) + ' · 负责人 ' + esc(sample.owner) + '</div>'
        + '<div class="meta">当前责任人：' + esc(sample.currentOwner || sample.owner) + '｜最近复核：' + esc(lastReviewText(sample.lastReview)) + '</div>'
        + '<label>新增切片</label><input data-new-slice="' + sample.id + '" placeholder="切片编号"><input data-method="' + sample.id + '" placeholder="染色方法"><button data-add="' + sample.id + '">添加切片</button>'
        + sample.slices.map(slice => sliceHtml(sample, slice)).join("")
        + '<button data-deliver="' + sample.id + '">标记交付</button></article>').join("");
      document.querySelectorAll("[data-add]").forEach(btn => btn.onclick = () => run(async () => {
        const id = btn.dataset.add;
        await api("/api/samples/" + id + "/slices", { method: "POST", body: JSON.stringify({ id: document.querySelector('[data-new-slice="' + id + '"]').value, method: document.querySelector('[data-method="' + id + '"]').value || "未指定" }) });
      }));
      document.querySelectorAll("[data-handover]").forEach(btn => btn.onclick = () => run(async () => {
        const [sampleId, sliceId] = btn.dataset.handover.split("|");
        const key = sampleId + "|" + sliceId;
        const slice = findSlice(sampleId, sliceId);
        await api("/api/samples/" + sampleId + "/slices/" + sliceId + "/handovers", { method: "POST", body: JSON.stringify({ step: slice.status, operator: field(key, "operator"), batch: field(key, "batch"), observation: field(key, "obs"), at: field(key, "at") || undefined }) });
      }));
      document.querySelectorAll("[data-approve]").forEach(btn => btn.onclick = () => run(async () => {
        const [sampleId, sliceId] = btn.dataset.approve.split("|");
        const key = sampleId + "|" + sliceId;
        const slice = findSlice(sampleId, sliceId);
        await api("/api/samples/" + sampleId + "/slices/" + sliceId + "/reviews", { method: "POST", body: JSON.stringify({ step: slice.pendingStep, result: "通过", reviewer: field(key, "reviewer"), reason: field(key, "reason") }) });
      }));
      document.querySelectorAll("[data-reject]").forEach(btn => btn.onclick = () => run(async () => {
        const [sampleId, sliceId] = btn.dataset.reject.split("|");
        const key = sampleId + "|" + sliceId;
        const slice = findSlice(sampleId, sliceId);
        await api("/api/samples/" + sampleId + "/slices/" + sliceId + "/reviews", { method: "POST", body: JSON.stringify({ step: slice.pendingStep, result: "不通过", reviewer: field(key, "reviewer"), reason: field(key, "reason") }) });
      }));
      document.querySelectorAll("[data-observe]").forEach(btn => btn.onclick = () => run(async () => {
        const [sampleId, sliceId] = btn.dataset.observe.split("|");
        const key = sampleId + "|" + sliceId;
        await api("/api/samples/" + sampleId + "/slices/" + sliceId + "/logs", { method: "POST", body: JSON.stringify({ step: "观察", note: field(key, "finalobs") || "观察完成" }) });
      }));
      document.querySelectorAll("[data-deliver]").forEach(btn => btn.onclick = () => run(async () => {
        await api("/api/samples/" + btn.dataset.deliver + "/deliver", { method: "POST", body: JSON.stringify({}) });
      }));
    }
    async function load() {
      const [sampleList, batchList] = await Promise.all([api("/api/samples"), api("/api/batches")]);
      samples = sampleList;
      batches = batchList;
      render();
    }
    document.querySelector("#reload").onclick = () => load().catch(error => showMsg(error.message, false));
    form.onsubmit = event => {
      event.preventDefault();
      run(async () => {
        await api("/api/samples", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
        form.reset();
      });
    };
    load().catch(error => showMsg(error.message, false));
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
    }
    if (req.method === "GET" && url.pathname === "/api/samples") return sendJson(res, 200, db.samples.map(sampleView));
    if (req.method === "GET" && url.pathname === "/api/batches") return sendJson(res, 200, db.batches);
    if (req.method === "POST" && url.pathname === "/api/samples") {
      const input = await body(req);
      const sample = { id: `CORE-${Date.now()}`, project: input.project, borehole: input.borehole, coreBox: input.coreBox, depth: input.depth, owner: input.owner, status: "待切割", delivery: "未交付", slices: [{ id: input.sliceId, method: input.method, observation: "", status: "取样", logs: [{ at: new Date().toISOString(), step: "取样", note: "创建初始切片任务" }], handovers: [] }] };
      updateSampleStatus(sample);
      db.samples.unshift(sample);
      await saveDb(db);
      return sendJson(res, 201, sampleView(sample));
    }
    const addSlice = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices$/);
    if (addSlice && req.method === "POST") {
      const sample = db.samples.find(item => item.id === addSlice[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const input = await body(req);
      sample.slices.push({ id: input.id, method: input.method || "未指定", observation: "", status: "取样", logs: [{ at: new Date().toISOString(), step: "取样", note: "新增切片任务" }], handovers: [] });
      updateSampleStatus(sample);
      await saveDb(db);
      return sendJson(res, 201, sampleView(sample));
    }
    // 交接登记：判定不通过则不保存，返回全部冲突项
    const handoverMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/handovers$/);
    if (handoverMatch && req.method === "POST") {
      const sample = db.samples.find(item => item.id === handoverMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const slice = sample.slices.find(item => item.id === handoverMatch[2]);
      if (!slice) return sendJson(res, 404, { error: "slice_not_found" });
      const input = await body(req);
      const missing = [];
      if (!(input.operator || "").trim()) missing.push("操作人");
      if (!(input.batch || "").trim()) missing.push("耗材批次");
      if (!(input.observation || "").trim()) missing.push("观察结果");
      if (missing.length) return sendJson(res, 400, { error: `请填写：${missing.join("、")}` });
      if (input.at && Number.isNaN(Date.parse(input.at))) return sendJson(res, 400, { error: "交接时间格式无效" });
      const record = {
        step: (input.step || "").trim(),
        operator: input.operator.trim(),
        batch: input.batch.trim(),
        observation: input.observation.trim(),
        at: input.at ? new Date(input.at).toISOString() : new Date().toISOString()
      };
      const verdict = judgeHandover(slice, record, db.batches);
      if (!verdict.ok) return sendJson(res, 409, { error: "handover_conflict", conflicts: verdict.conflicts });
      applyHandover(slice, record);
      updateSampleStatus(sample);
      await saveDb(db);
      return sendJson(res, 201, sampleView(sample));
    }
    // 复核：通过则进入下一步，不通过则退回当前步骤并留下原因
    const reviewMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/reviews$/);
    if (reviewMatch && req.method === "POST") {
      const sample = db.samples.find(item => item.id === reviewMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const slice = sample.slices.find(item => item.id === reviewMatch[2]);
      if (!slice) return sendJson(res, 404, { error: "slice_not_found" });
      const input = await body(req);
      if (!(input.reviewer || "").trim()) return sendJson(res, 400, { error: "请填写复核人" });
      if (input.at && Number.isNaN(Date.parse(input.at))) return sendJson(res, 400, { error: "复核时间格式无效" });
      const record = {
        step: (input.step || "").trim(),
        result: input.result,
        reviewer: input.reviewer.trim(),
        reason: (input.reason || "").trim(),
        at: input.at ? new Date(input.at).toISOString() : new Date().toISOString()
      };
      const verdict = judgeReview(slice, record);
      if (!verdict.ok) return sendJson(res, 409, { error: "review_rejected", conflicts: verdict.reasons });
      applyReview(slice, verdict.handover, record);
      updateSampleStatus(sample);
      await saveDb(db);
      return sendJson(res, 200, sampleView(sample));
    }
    const logMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/logs$/);
    if (logMatch && req.method === "POST") {
      const sample = db.samples.find(item => item.id === logMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const slice = sample.slices.find(item => item.id === logMatch[2]);
      if (!slice) return sendJson(res, 404, { error: "slice_not_found" });
      const input = await body(req);
      if (input.step === "观察") slice.observation = input.note || slice.observation;
      slice.logs.push({ at: new Date().toISOString(), step: input.step, note: input.note || "" });
      updateSampleStatus(sample);
      await saveDb(db);
      return sendJson(res, 200, sampleView(sample));
    }
    const deliverMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/deliver$/);
    if (deliverMatch && req.method === "POST") {
      const sample = db.samples.find(item => item.id === deliverMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      sample.delivery = "已交付";
      updateSampleStatus(sample);
      await saveDb(db);
      return sendJson(res, 200, sampleView(sample));
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Core slice lab app listening on http://localhost:${port}`));
