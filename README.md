# 孤山掠影

自驾×徒步混合行程规划桌面应用(自用)。

**一句话**:选区域(川西)+ 出发站 + 日期 + 天数 → 一屏得到:往返火车实时票价(12306)、逐日自驾里程/油费/过路费(高德)、徒步日安排(私有线路库)、16 天天气窗口,以及总预算表。所有价格可溯源(存档在 `data/trips/`),缺失响亮报错,绝不编造。

## 技术形态

- Electron + 纯 JS(无框架无构建器),主进程管数据与外部 API,渲染进程用高德 JS API 画图。
- 数据全部是 `data/` 下的 JSON,直接用编辑器就能改线路库。
- LLM 刻意不参与拼装(确定性逻辑),以后做攻略字段抽取时再接 llama-server。

## 使用前必须做

1. `npm install`
2. 到 [lbs.amap.com](https://lbs.amap.com) 注册个人开发者,创建应用,添加两个 Key:
   - **Web服务** → 填入 `data/config.json` 的 `amapKeyWeb`(首次运行会自动从 example 复制)
   - **Web端(JS API)** → 填入 `amapKeyJs`
3. 按你的车改 `data/config.json` 的 `fuel`(百公里油耗、油价)。

## 命令

```bash
npm run app          # 启动应用
npm test             # 单元测试(纯函数部分)
npm run smoke:rail   # 12306 接口冒烟:余票+票价字段是否仍有效(结果在 scripts/smoke-output.txt)
npm run dist         # 打包 portable exe → dist/
```

## 数据文件

| 文件 | 作用 |
|---|---|
| `data/config.json` | 高德 Key、油耗、单日驾车上限 |
| `data/regions.json` | 区域库:枢纽、自驾环线节点(经纬度)、最佳季节 |
| `data/trails.json` | 徒步线路库:天数、爬升、难度、门票、补给 |
| `data/stations.json` | 12306 站名↔电报码缓存(自动生成) |
| `data/trips/` | 每次生成的行程存档(含查询原始数据) |

## 已知边界(自用纪律)

- 12306 只读、不登录、低频 + 10 分钟缓存。**票价来自余票响应内嵌的价格编码字段**(第 39 字段,座位代码+4位价格+5位标记,已用 G/D/K 车实证),不再调用会对非浏览器请求返回 405 的 queryTicketPrice 接口。
- 高德免费额度自用绰绰有余;路线规划结果会随版本微调,属正常。
- 机票价格不做(OTA 加密数据),以后用"预估 + 跳转"兜底。
- 打包后的 exe 在 `dist/Gushan-portable.exe`;重装系统或换机后先 `npm install && npm run dist`,再以管理员外的普通权限运行 `scripts/make-shortcut.ps1`(带 BOM,勿用无 BOM 编辑器重存)重建桌面快捷方式。
