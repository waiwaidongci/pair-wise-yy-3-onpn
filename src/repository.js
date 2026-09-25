// 保存层：JSON 文件仓储。只管读写、种子数据和旧版 logs 数据迁移，不做业务判定。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STEPS } from "./handoff.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "..", "data", "core-slices.json");

const seed = {
  reagentBatches: [
    {
      batchNo: "RZ-ALIZARIN-260315",
      name: "茜素红染色液",
      category: "染色",
      expireAt: "2026-03-15T00:00:00.000Z"
    },
    {
      batchNo: "RZ-ALIZARIN-261001",
      name: "茜素红染色液",
      category: "染色",
      expireAt: "2026-10-01T00:00:00.000Z"
    },
    {
      batchNo: "RZ-ALIZARIN-270120",
      name: "茜素红染色液（新批）",
      category: "染色",
      expireAt: "2027-01-20T00:00:00.000Z"
    },
    {
      batchNo: "NM-CARBIDE-260901",
      name: "碳化硅研磨粉",
      category: "研磨",
      expireAt: ""
    },
    {
      batchNo: "QC-DISK-260810",
      name: "金刚石切割片",
      category: "切割",
      expireAt: ""
    }
  ],
  samples: [
    {
      id: "CORE-001",
      project: "东岭铜矿薄片",
      borehole: "ZK-17",
      coreBox: "BX-09",
      depth: "128.4-128.8m",
      owner: "陆川",
      delivery: "未交付",
      slices: [
        {
          id: "SL-001-A",
          method: "茜素红染色",
          step: "染色",
          phase: "待交接",
          handoffs: [
            {
              id: "H-001-sample",
              step: "取样",
              operator: "陆川",
              reviewer: "周敏",
              consumableBatch: "QC-BAG-260601",
              observation: "截取含矿化条带位置，岩性为含铜矽卡岩",
              completedAt: "2026-06-12T10:00:00.000Z",
              submittedAt: "2026-06-12T10:05:00.000Z",
              reviews: [
                { reviewer: "周敏", passed: true, reason: "", at: "2026-06-12T11:00:00.000Z" }
              ]
            },
            {
              id: "H-001-cut",
              step: "切割",
              operator: "高岩",
              reviewer: "周敏",
              consumableBatch: "QC-DISK-260810",
              observation: "完成粗切，切缝平整无崩边",
              completedAt: "2026-06-13T11:20:00.000Z",
              submittedAt: "2026-06-13T11:25:00.000Z",
              reviews: [
                { reviewer: "周敏", passed: true, reason: "", at: "2026-06-13T13:00:00.000Z" }
              ]
            },
            {
              id: "H-001-grind",
              step: "研磨",
              operator: "阿依",
              reviewer: "周敏",
              consumableBatch: "NM-CARBIDE-260901",
              observation: "薄片厚度约 0.03mm，局部略厚需要复磨",
              completedAt: "2026-06-14T09:30:00.000Z",
              submittedAt: "2026-06-14T09:35:00.000Z",
              reviews: [
                {
                  reviewer: "周敏",
                  passed: false,
                  reason: "边缘厚度不匀，最厚处超过 0.05mm，退回重新研磨",
                  at: "2026-06-14T10:10:00.000Z"
                },
                {
                  reviewer: "周敏",
                  passed: true,
                  reason: "",
                  at: "2026-06-14T15:40:00.000Z"
                }
              ]
            }
          ]
        }
      ]
    },
    {
      id: "CORE-002",
      project: "北坡金红石普查",
      borehole: "ZK-04",
      coreBox: "BX-02",
      depth: "86.1-86.5m",
      owner: "高岩",
      delivery: "未交付",
      slices: [
        {
          id: "SL-002-A",
          method: "不染色",
          step: "研磨",
          phase: "待复核",
          handoffs: [
            {
              id: "H-002-sample",
              step: "取样",
              operator: "高岩",
              reviewer: "周敏",
              consumableBatch: "QC-BAG-260601",
              observation: "金红石矿脉与角闪片岩分界处取样",
              completedAt: "2026-09-18T08:40:00.000Z",
              submittedAt: "2026-09-18T08:45:00.000Z",
              reviews: [
                { reviewer: "周敏", passed: true, reason: "", at: "2026-09-18T09:20:00.000Z" }
              ]
            },
            {
              id: "H-002-cut",
              step: "切割",
              operator: "高岩",
              reviewer: "周敏",
              consumableBatch: "QC-DISK-260810",
              observation: "沿矿脉走向切取，断面完好",
              completedAt: "2026-09-19T10:00:00.000Z",
              submittedAt: "2026-09-19T10:05:00.000Z",
              reviews: [
                { reviewer: "周敏", passed: true, reason: "", at: "2026-09-19T10:40:00.000Z" }
              ]
            },
            {
              id: "H-002-grind",
              step: "研磨",
              operator: "阿依",
              reviewer: "周敏",
              consumableBatch: "NM-CARBIDE-260901",
              observation: "精磨至 0.03mm，石英干涉色一级灰白",
              completedAt: "2026-09-22T16:10:00.000Z",
              submittedAt: "2026-09-22T16:15:00.000Z",
              reviews: []
            }
          ]
        }
      ]
    },
    {
      id: "CORE-003",
      project: "南沟铅锌矿详查",
      borehole: "ZK-31",
      coreBox: "BX-15",
      depth: "203.7-204.0m",
      owner: "阿依",
      delivery: "未交付",
      slices: [
        {
          id: "SL-003-A",
          method: "茜素红染色",
          step: "取样",
          phase: "待交接",
          handoffs: []
        }
      ]
    }
  ]
};

// 旧版切片（status + logs）迁移为新的交接结构：
// 历史日志视为已送复核并通过，保证现有演示数据可继续推进。
function migrateSlice(slice, owner) {
  if (slice.step && slice.phase && Array.isArray(slice.handoffs)) return slice;
  const handoffs = [];
  for (const [index, log] of (slice.logs || []).entries()) {
    handoffs.push({
      id: `H-legacy-${index}`,
      step: log.step,
      operator: owner || "未登记",
      reviewer: "历史数据补录",
      consumableBatch: "未登记",
      observation: log.note || "历史步骤无观察记录",
      completedAt: log.at,
      submittedAt: log.at,
      reviews: [{ reviewer: "历史数据补录", passed: true, reason: "", at: log.at }]
    });
  }
  const current = STEPS.indexOf(slice.status);
  const passedSet = new Set(handoffs.map((h) => h.step));
  let step;
  if (current >= 0 && !passedSet.has(STEPS[current])) step = STEPS[current];
  else if (current > 0) step = STEPS[current];
  else step = "取样";
  return {
    id: slice.id,
    method: slice.method,
    step,
    phase: "待交接",
    handoffs
  };
}

function migrate(db) {
  db.reagentBatches ||= seed.reagentBatches;
  for (const sample of db.samples || []) {
    sample.slices = (sample.slices || []).map((slice) => migrateSlice(slice, sample.owner));
  }
  return db;
}

export async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
    return structuredClone(seed);
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  return migrate(db);
}

export async function saveDb(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

export function findSample(db, sampleId) {
  return (db.samples || []).find((item) => item.id === sampleId) || null;
}

export function findSlice(sample, sliceId) {
  return (sample?.slices || []).find((item) => item.id === sliceId) || null;
}
