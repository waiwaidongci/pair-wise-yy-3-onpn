# 岩芯样本切片实验室

运行：

```bash
npm start
```

访问 `http://localhost:3025`。支持样本创建、切片任务、制片逐道交接复核、观察记录和交付统计。

## 制片交接规则

- 每张切片按 **取样 → 切割 → 研磨 → 染色** 逐道交接；交接必须登记操作人、耗材批次、观察结果（可指定交接时间，默认当前时间）。
- 上一步交接没有复核（或复核不通过），不能登记下一步交接。
- 复核通过：切片进入下一步（染色通过后进入观察）；复核不通过：切片退回当前步骤，必须填写退回原因，之后需重新交接。
- 以下情况本次交接**不保存**，接口返回 409 并列出全部冲突项：
  - 染色批次在交接时间已过期（或批次不在台账中）；
  - 交接时间早于上一步完成时间（重新交接时也不能早于本步骤上次交接时间）；
  - 上一步尚未复核 / 复核不通过、当前步骤不符、已有待复核交接等。
- 样本列表每张切片展示**当前责任人**、**最近复核结果**（通过/不通过原因/待复核）和**可操作入口**（登记交接、复核通过/退回、保存观察）。

## 代码分层（请求入口、交接判定、保存分别承担）

- 请求入口：`server.js` —— HTTP 路由与页面，只解析请求、调用判定、触发保存。
- 交接判定：`lib/handover.js` —— `judgeHandover` / `judgeReview` 纯函数判定冲突，`applyHandover` / `applyReview` 负责状态迁移，不读写数据库。
- 保存：`lib/store.js` —— `loadDb` / `saveDb` 唯一读写数据文件，内含耗材批次台账和旧数据迁移（旧步骤日志补建为已复核交接）。

## API

- `GET /api/samples`、`GET /api/batches`
- `POST /api/samples`、`POST /api/samples/:id/slices`
- `POST /api/samples/:id/slices/:sliceId/handovers` —— `{ step, operator, batch, observation, at? }`
- `POST /api/samples/:id/slices/:sliceId/reviews` —— `{ step, result: "通过"|"不通过", reviewer, reason?, at? }`
- `POST /api/samples/:id/slices/:sliceId/logs` —— 观察等补充记录
- `POST /api/samples/:id/deliver`
