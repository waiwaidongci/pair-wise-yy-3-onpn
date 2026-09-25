// 保存层：唯一负责数据文件的读写，以及历史数据的迁移补全。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHAIN } from "./handover.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "..", "data", "core-slices.json");

// 耗材批次台账种子数据（含一批已过期染色批次，用于校验演示）
export const seedBatches = [
  { id: "SMP-BAG-2606", type: "取样", name: "岩芯取样袋", expiresAt: "2027-06-30T00:00:00.000Z" },
  { id: "BLD-DIA-2606", type: "切割", name: "金刚石锯片", expiresAt: "2027-06-30T00:00:00.000Z" },
  { id: "ABR-GRN-2606", type: "研磨", name: "金刚砂磨料", expiresAt: "2027-06-30T00:00:00.000Z" },
  { id: "STAIN-ARS-2606", type: "染色", name: "茜素红染液", expiresAt: "2026-12-31T00:00:00.000Z" },
  { id: "STAIN-ARS-2501", type: "染色", name: "茜素红染液（陈批）", expiresAt: "2026-01-31T00:00:00.000Z" }
];

const seed = {
  samples: [
    {
      id: "CORE-001",
      project: "东岭铜矿薄片",
      borehole: "ZK-17",
      coreBox: "BX-09",
      depth: "128.4-128.8m",
      owner: "陆川",
      status: "制片中",
      delivery: "未交付",
      slices: [
        { id: "SL-001-A", method: "茜素红染色", observation: "", status: "研磨", logs: [{ at: "2026-06-12T10:00:00.000Z", step: "取样", note: "截取含矿化条带位置" }, { at: "2026-06-13T11:20:00.000Z", step: "切割", note: "完成粗切" }], handovers: [] }
      ]
    }
  ],
  batches: seedBatches
};

// 历史数据迁移：旧数据只有步骤日志，没有交接记录。
// 为已完成步骤补建"已复核通过"的交接记录，保证交接链从旧数据也能继续走下去。
function normalize(db) {
  let changed = false;
  if (!Array.isArray(db.batches)) {
    db.batches = seedBatches;
    changed = true;
  }
  for (const sample of db.samples || []) {
    for (const slice of sample.slices || []) {
      if (!Array.isArray(slice.logs)) {
        slice.logs = [];
        changed = true;
      }
      if (!Array.isArray(slice.handovers)) {
        slice.handovers = [];
        changed = true;
        const currentIdx = CHAIN.includes(slice.status) ? CHAIN.indexOf(slice.status) : CHAIN.length;
        for (const log of slice.logs) {
          const idx = CHAIN.indexOf(log.step);
          if (idx === -1 || idx >= currentIdx) continue; // 只补当前步骤之前已完成的道次
          slice.handovers.push({
            step: log.step,
            operator: sample.owner || "未记录",
            batch: "LEGACY-无批次记录",
            observation: log.note || "",
            at: log.at,
            review: { result: "通过", reviewer: "历史数据迁移", reason: "", at: log.at }
          });
        }
      }
    }
  }
  return changed;
}

export async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await saveDb(seed);
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  if (normalize(db)) await saveDb(db);
  return db;
}

export async function saveDb(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}
