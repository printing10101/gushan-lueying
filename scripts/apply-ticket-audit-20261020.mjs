#!/usr/bin/env node
// 2026-10-20 门票数据审计：只写有明确出处/官方口径的条目。
// 原数字无法拆分或找不到出处的，改成 null + ticketNote（未知，不按 0 计）。
// 用法：node scripts/apply-ticket-audit-20261020.mjs          试运行
//      node scripts/apply-ticket-audit-20261020.mjs --apply  写回 data/trails.json
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'data', 'trails.json');
const APPLY = process.argv.includes('--apply');
const CHECKED_AT = '2026-10-20';

const updates = {
  changpinggou: {
    tickets: 90,
    ticketNote: '长坪沟门票 70 + 观光车 20（官方页面；沟内马匹费另算）。原 270 为旧混合估算，已纠正',
    ticketSource: { source: '四姑娘山景区官方网站·长坪沟', url: 'https://www.sgns.cn/understand/cpg', checkedAt: CHECKED_AT },
  },
  haizigou: {
    tickets: 60,
    ticketNote: '海子沟门票 60（官方页面；沟内马匹费另算；官方页未列观光车，若有以现场为准）。原 80 为旧估算，已纠正',
    ticketSource: { source: '四姑娘山景区官方网站·海子沟', url: 'https://www.sgns.cn/understand/hzg', checkedAt: CHECKED_AT },
  },
  changchuanbi: {
    tickets: null,
    ticketNote: '长坪沟段官方门票+观光车 90；毕棚沟门票/观光车另计。原 270 是混合旧估算，未拆分前按未知处理',
    sourceNote: '四姑娘山官网长坪沟票价：https://www.sgns.cn/understand/cpg（2026-10-20 核对）；毕棚沟侧票价需按其景区现行票制另计',
  },
  'siguniang-dafeng': {
    tickets: null,
    ticketNote: '原 150 未找到官方登山注册/门票组合出处；登山注册管理费与景区门票是两套口径，出发前向四姑娘山户外管理中心确认',
  },
  'siguniang-sanfeng': {
    tickets: null,
    ticketNote: '原 150 未找到官方登山注册/门票组合出处；三峰属技术型攀登，注册管理费与景区门票需分别确认',
  },
  'kanasi-ring': {
    tickets: null,
    ticketNote: '官方分景区票价：喀纳斯 160 + 禾木 50 + 白哈巴 30（旺季），区间车另计；原 300 为混合旧估算，未拆分前按未知处理',
    sourceNote: '喀纳斯景区管委会票价页：https://www.kns.gov.cn/001/001004/20230520/06b83d7b-65e1-4c93-b5e2-a65cfb502998.html（2026-10-20 核对；只核到分景区门票，区间车以现场为准）',
  },
  'huashan-yepa': {
    tickets: 160,
    ticketNote: '2026 旺季（3/1–11/30）全价票 160 元/人·次；淡季/优惠另计，索道与进山车另算',
    ticketSource: { source: '华山景区 2026 旺季价格公告（新浪转引）', url: 'https://www.sina.cn/gc/article/nivhpnm7422404.html', checkedAt: CHECKED_AT },
  },
  'yading-ring': {
    tickets: 146,
    ticketNote: '大门票 146 元；2026-08-01–10-31 官方免大门票（观光车/电瓶车同期暂停收费）。观光车另计 120 元，免票期以预约公告为准',
    ticketSource: { source: '中国新闻网：稻城亚丁 2026-08-01–10-31 限时免门票公告', url: 'https://www.chinanews.com.cn/sh/2026/07-29/10668508.shtml', checkedAt: CHECKED_AT },
  },
  'hutiaoxia-gaolu': {
    tickets: null,
    ticketSource: undefined,
    ticketNote: 'C 档：OTA/百科口径为全票 45 元、学生 22.5 元，但官方票务页未单列价格，按项目纪律不填数字；高路徒步若从丽江侧进入/住中途客栈，按实际入口另核',
  },
  yubang: {
    tickets: null,
    ticketSource: undefined,
    ticketNote: 'C 档：OTA/攻略口径门票 55 元/人，但官方票务页未单列价格，按项目纪律不填数字；进出雨崩的摆渡车/骑马另计，尼农方向进入的门票口径以现场为准',
  },
  'changbaishan-xipo': {
    tickets: 190,
    ticketNote: '大门票 105 + 必购环保车 85 = 190（西坡/北坡/南坡大门票 5 日内通用）；倒站车 80 另计',
    ticketSource: { source: '长白山旅游股份有限公司·景点介绍', url: 'https://www.cbmt.com.cn/news/jingdianjieshao', checkedAt: CHECKED_AT },
  },
  wugongshan: {
    tickets: 70,
    ticketNote: '萍乡武功山门票：当日票 70、预订票 60；索道另计（金顶/中庵各线不同）',
    ticketSource: { source: '萍乡武功山景区官网·景区指南', url: 'https://www.wugongshan.cn/page/strategyList!info.htm?id=1271', checkedAt: CHECKED_AT },
  },
  sanqingshan: {
    tickets: 120,
    ticketNote: '三清山主景区大门票 120 元/人次；索道往返 125 元另计',
    ticketSource: { source: '新浪转引三清山门票/索道口径', url: 'https://www.sina.cn/gc/article/nitmuyi8006742.html', checkedAt: CHECKED_AT },
  },
  fanjingshan: {
    tickets: 110,
    ticketNote: '旺季大门票 110（淡季 90）；东门观光车往返 48 另计，若按含车口径为 158；索道另计',
    ticketSource: { source: '新浪转引梵净山 2026 旺季门票口径', url: 'https://www.sina.cn/gc/article/nitmzhp3091309.html', checkedAt: CHECKED_AT },
  },
  'huangshan-xihai': {
    tickets: 190,
    ticketNote: '平旺季全票 190（2026-01-21–12-19）；冬游 150；索道/换乘另计',
    ticketSource: { source: '光明网：黄山风景区冬游价格政策（2026 平旺季 190）', url: 'https://m.gmw.cn/2025-12/19/content_1304270257.htm', checkedAt: CHECKED_AT },
  },
  'emei-houshan': {
    tickets: 160,
    ticketNote: '旺季全票 160（淡季 110）；金顶索道往返 120、观光车全山往返 90 另计；后山线是否需景区门票按实际入口核实',
    ticketSource: { source: '新浪转引峨眉山 2026 门票口径', url: 'https://www.sina.cn/news/article/comos_nivpnhf7174844.html', checkedAt: CHECKED_AT },
  },
  'taibai-nanbei': {
    tickets: 90,
    ticketNote: '景区门票 90；景交车往返 90、天下索道单程 120 另计；厚畛子/南坡入口的保护区手续另核',
    ticketSource: { source: '太白山旅游官网·2026-10-18 温馨提示', url: 'https://www.tbpark.com/html/2026/raiders_1018/5548.html', checkedAt: CHECKED_AT },
  },
};

const trails = JSON.parse(fs.readFileSync(FILE, 'utf8'));
let changed = 0;
for (const [id, patch] of Object.entries(updates)) {
  const trail = trails[id];
  if (!trail) throw new Error(`找不到线路 ${id}`);
  const before = JSON.stringify({ tickets: trail.tickets, ticketNote: trail.ticketNote, ticketSource: trail.ticketSource });
  Object.assign(trail, patch);
  const after = JSON.stringify({ tickets: trail.tickets, ticketNote: trail.ticketNote, ticketSource: trail.ticketSource });
  if (before !== after) {
    changed += 1;
    console.log(`${id}: ${before} -> ${after}`);
  }
}
console.log(`\n共 ${changed} 条变更${APPLY ? '，写回' : '（试运行，未写文件；加 --apply 写回）'}`);
if (APPLY) fs.writeFileSync(FILE, `${JSON.stringify(trails, null, 2)}\n`, 'utf8');
