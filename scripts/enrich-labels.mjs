// 一次性回填:给线路库补 tickets / risks / supplies 参考信息(自用口径,不必等社区共识)。
// 规则:
//   1. 已有值的条目绝不动(人工标注永远优先);
//   2. OVERRIDES 逐条给出我确实掌握的信息,风险写具体,不给万金油话术;
//   3. 没有逐条信息的按 TYPE_DEFAULTS 兜底(按线路类型给口径性提示);
//   4. tickets 只对 长线重装/高原转山/沙漠 默认填 0(此类几乎从不设门票),
//      管控/禁入/关闭的线路一律不自动填票(多为手续/封闭,填 0 会误导);
//   5. 把握不足的字段保持空缺——宁缺毋编,自用也要能信。
//   6. 所有数字是粗略参考价(门票+常见区间车/管理费口径),出发前自行核实。
// 幂等,可重复跑。用法:node scripts/enrich-labels.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);

const TRAILS_FILE = new URL('../data/trails.json', import.meta.url); // 锚定仓库位置,不依赖 CWD
const trails = JSON.parse(fs.readFileSync(TRAILS_FILE, 'utf8'));

// ---------- 逐条标注(仅列我确实掌握的) ----------
const OVERRIDES = {
  // 新疆
  wusun: { tickets: 0, risks: ['黑英山口连续涉水二十余次,水温刺骨', '天堂湖段塌方落石', '阿克布拉克达坂天气多变'], supplies: '无补给,全程重装或雇马帮' },
  'langta-c': { tickets: 0, risks: ['连翻七座达坂,崖壁路段需绳索保护经验', '呼图壁河峡谷落石', '好天气窗口难等'], supplies: '无补给,全程重装' },
  'langta-v': { tickets: 0, risks: ['冰坡与碎石坡密集,滑坠风险高', '溜索/渡口需谨慎评估', '天气多变'], supplies: '无补给,全程重装' },
  'langta-cv': { tickets: 0, risks: ['12 天超长程,对体能与窗口期要求极高', 'C 线与 V 线全部风险叠加', '中途无撤离点,出事只能自力'], supplies: '无补给,全程重装,需精心规划窗口期' },
  xiate: { risks: ['木扎尔特冰川裂缝与融水河道', '古堡段塌方落石', '空旷河谷雷雨危险'], supplies: '无补给,全程重装或雇马帮' },
  bogeda: { tickets: 0, risks: ['冰川裂缝区需结组经验', '碎石达坂滑坠', '午后常见冰雹暴雪'], supplies: '无补给,全程重装' },
  kalajun: { tickets: 0, risks: ['草原雷雨无处躲', '马道岔路多易走偏'], supplies: '沿线牧民点与毡房可补给,可雇马帮轻装' },
  mengkede: { tickets: 0, risks: ['孟克德达坂天气多变', '河谷段涉水'], supplies: '无补给,全程重装' },
  cheshi: { tickets: 0, risks: ['琼达坂一日四季', '峡谷碎石坡'], supplies: '两端村镇补给,中途无售卖' },
  'kanasi-ring': { tickets: 300, risks: ['秋季早晚严寒,昼夜温差大', '景区岔路多,走野线需轨迹'], supplies: '贾登峪/禾木/喀纳斯村食宿补给完善,轻装可行' },
  kumtag: { tickets: 30, risks: ['高温脱水,5-9 月严禁正午爬沙山', '沙丘耗氧量大', '全程无水源'], supplies: '无水源,人均每天备水 4L 以上' },
  'xiata-scenic': { tickets: 60, supplies: '区间车与栈道直达,镇上有餐饮售卖' },
  // 西藏
  gangrenboqi: { tickets: 0, risks: ['卓玛拉垭口 5630m,高反显著', '转山道昼夜温差大', '天气骤变'], supplies: '塔钦补给完善,转山道有茶馆可食宿' },
  gamagou: { risks: ['全程 4000m+,高反', '郎玛拉垭口天气多变', '边境手续需提前办理'], supplies: '无补给,全程重装,需向导与边境手续' },
  xixiabangma: { risks: ['冰塔林与冰川边缘裂缝', '介久错段天气多变', '高反'], supplies: '无补给,全程重装' },
  kulakangri: { risks: ['垭口 5000m 级高反', '湖畔风大温低', '边境地区需手续'], supplies: '无补给,全程重装' },
  taniantaweng: { tickets: 0, risks: ['多个 5000m 级垭口', '冰川湖群段天气多变', '必须成熟轨迹或向导'], supplies: '无补给,全程重装,建议雇向导' },
  motuo: { tickets: 0, risks: ['多雄拉山口天气极不稳定', '雨季蚂蟥与蛇虫', '塌方落石'], supplies: '拉格—汗密—背崩有客栈可食宿,轻装可行' },
  nalacuo: { risks: ['密林穿行易迷路', '雨季蚂蟥', '天气多变'], supplies: '无补给,全程重装' },
  sapu: { risks: ['平均海拔近 5000m,高反不可轻视', '湖畔风大温低', '天气多变'], supplies: '无补给,自备露营装备,萨普村可住宿' },
  'zhufeng-dongpo': { tickets: 0, risks: ['全程 4000m+,高反', '措学仁玛段天气多变', '长距离无补给'], supplies: '无补给,全程重装' },
  'gandan-sangye': { tickets: 0, risks: ['翻雪山垭口天气多变', '长距离荒野无遮蔽'], supplies: '自备水粮,两端寺院有食宿' },
  'chubu-yangbajing': { tickets: 0, risks: ['垭口天气多变'], supplies: '自备水粮,两端有寺院与村镇' },
  // 四川
  'gongga-ring': { tickets: 0, risks: ['日乌且垭口 4900m 风雪与高反', '天气多变', '长距离无补给'], supplies: '无补给,全程重装;上木居/子梅村可应急' },
  'gongga-xinan': { tickets: 0, risks: ['子梅垭口 4500m+ 高反', '包车接驳段路况差'], supplies: '上木居/贡嘎山镇有食宿,可包车大幅减负' },
  lenggacuo: { tickets: 0, risks: ['海拔 4400m+ 高反', '日落时段山口风大温骤降'], supplies: '玉龙西村有食宿,可骑马上山' },
  luoke: { tickets: 146, risks: ['喀拉克垭口 4722m 天气多变', '出口亚丁段陡升', '长距离无水源点'], supplies: '无补给,全程重装;出口亚丁村食宿完善' },
  'yading-ring': { tickets: 146, risks: ['垭口 5000m 级高反', '景区外野路需轨迹', '天气多变'], supplies: '景区内补给点少,重装自给' },
  'genie-c': { tickets: 0, risks: ['多个 4800m+ 垭口', '哈嘎拉垭口碎石', '高原天气多变'], supplies: '则巴村/热梯村可补给与租马,可雇马帮轻装' },
  'genie-ring': { tickets: 0, risks: ['长距离高原行走', '垭口天气多变', '部分路段轨迹模糊'], supplies: '沿线牧民点稀少,基本重装自给' },
  qizanggou: { tickets: 0, risks: ['红星海子段天气多变', '水草地泥泞', '熊类活动区,食物须挂藏'], supplies: '无补给,全程重装' },
  yala: { tickets: 0, risks: ['雅拉垭口天气多变', '碎石坡', '夜间低温'], supplies: '无补给,全程重装' },
  majiagou: { supplies: '景区栈道,门口有售卖,可住玛嘉沟村' },
  sanao: { tickets: 0, risks: ['达坂风大', '天气多变'], supplies: '黑水县补给,营地无水源需背水' },
  jiudingshan: { tickets: 0, risks: ['高山天气多变', '黑龙池段风大'], supplies: '山脚有农家,山上自备水粮' },
  dawan: { tickets: 0, risks: ['山顶湿地天气多变', '大天池段无遮蔽'], supplies: '山脚村镇补给,山顶无售卖' },
  nama: { tickets: 0, risks: ['碎石坡接短冰坡,需技术装备', '5588m 高反显著', '天气窗口难等'], supplies: '上日乌且村有协作站,以雇向导协作为主' },
  niubeishan: { risks: ['山顶风大温低', '雾天盘山路驾驶小心'], supplies: '山顶有商铺住宿,价格偏高' },
  'emei-houshan': { tickets: 160, risks: ['后山密林易迷路', '猴群抢食', '野路无救援'], supplies: '自备水粮,出景区后补给完善' },
  banjifeng: { tickets: 0, risks: ['冰川雪坡需结组与技术装备', '5430m 高反', '天气窗口'], supplies: '日隆镇补给完善,营地需自给' },
  moerduo: { tickets: 0, risks: ['转山道长距离', '天气多变'], supplies: '丹巴县城与沿线村寨可补给' },
  nianbaoyuze: { risks: ['全面关闭,擅入面临处罚且破坏生态'] },
  lianbaoyeze: { risks: ['海拔 4000m 高反', '栈道外乱石区易迷路'], supplies: '景区有售卖,阿坝县食宿' },
  ani: { tickets: 0, risks: ['冰川贴路,注意裂缝与融水', '全程 4500m+ 高反', '补给稀少天气极端'], supplies: '补给稀少,重装自给,玛沁县备足物资' },
  gangshika: { tickets: 0, risks: ['登顶需技术装备与协作', '大本营 4300m+ 高反', '天气多变'], supplies: '门源县补给,大本营自给,可雇协作' },
  lenglongling: { risks: ['祁连山脊天气多变', '长距离水源点少'], supplies: '无补给,重装自给' },
  // 云南
  yubang: { tickets: 55, risks: ['冰湖/神瀑段天气多变', '雨季塌方', '骡马通道泥泞'], supplies: '雨崩村食宿补给完善,轻装可行' },
  'meili-wai': { risks: ['多克拉垭口高反', '转经路全程长距离', '冬季严寒'], supplies: '沿线村庄与茶馆可补给,需提前规划住宿点' },
  'meili-bei': { tickets: 0, risks: ['坡均营地直面冰壁,留意落冰', '垭口天气多变', '长距离无信号'], supplies: '无补给,全程重装' },
  'hutiaoxia-gaolu': { tickets: 45, risks: ['峡谷落石', '夏季高温脱水', '崖壁路段窄,会车让行'], supplies: '沿线客栈(28 拐/Halfway/中峡)食宿完善,轻装可行' },
  niru: { risks: ['七彩瀑布段湿滑', '密林岔路多', '南宝牧场段天气多变'], supplies: '尼汝村有食宿,穿越段自备水粮' },
  biluo: { risks: ['翻越分水岭天气多变', '垭口冬季积雪', '长距离无补给'], supplies: '无补给,全程重装' },
  'cangshan-shijiu': { risks: ['山脊风大无遮蔽', '马龙峰段碎石攀爬', '天气骤变'], supplies: '自备水粮,大理古城补给' },
  abuji: { risks: ['4410m 高反', '天气多变'], supplies: '香格里拉补给,徒步段自备水粮' },
  qianhushan: { risks: ['高原天气多变', '岔路多'], supplies: '自备水粮,小中甸镇补给' },
  'gaoligong-nanzhai': { risks: ['南斋公房段大雾', '古道湿滑', '二战遗迹段塌方'], supplies: '自备水粮,百花岭/腾冲两端补给' },
  jiaozi: { risks: ['4223m 高反', '山顶天气多变'], supplies: '景区有售卖,轿子山镇食宿' },
  xueling: { risks: ['4247m 高反', '冬季雪坡冰滑', '山脊风大'], supplies: '自备水粮,法者乡补给' },
  haba: { tickets: 0, risks: ['登顶段冰坡,需冰爪冰镐', '高反显著', '天气窗口难等'], supplies: '哈巴村食宿与协作成熟,登顶需向导' },
  jizushan: { supplies: '寺院与沿线有斋饭食宿,山下宾川补给' },
  bingzhongluo: { supplies: '雾里村/秋那桶有客栈,丙中洛镇补给完善' },
  'yuanyang-titian': { supplies: '多依树/坝达民宿完善,沿线有售卖' },
  luoping: { supplies: '金鸡峰/牛街周边餐饮民宿完善' },
  // 青海 / 甘肃
  'zhagana-ring': { risks: ['石林垭口天气多变', '崖边小路湿滑', '岔路多'], supplies: '扎尕那村食宿完善,环线中途无补给需重装' },
  ganjia: { supplies: '景区有售卖,夏河县食宿' },
  huangheshilin: { supplies: '景区驴车接驳,龙湾村食宿' },
  'taibai-nanbei': { tickets: 90, risks: ['拔仙台天气多变,夏季亦降雪', '石海段失温', '部分管控留意通行'], supplies: '沿线有接待站(小文公/大文公),轻装可行' },
  'huashan-yepa': { tickets: 160, risks: ['夜爬台阶陡峭拥挤,体力消耗大', '长空栈道等高空项目必须挂安全绳', '冬季结冰湿滑'], supplies: '沿线有售卖(山上价高),华阴市补给' },
  lujiaoliang: { tickets: 0, risks: ['箭竹林易迷路', '天气多变'], supplies: '自备水粮,分水岭补给' },
  jiawutai: { supplies: '沿线有农家售卖,山脚补给' },
  'qinchu-gudao': { supplies: '沿线有农家,营盘镇补给' },
  bingjing: { risks: ['乱石坡陡升易崴脚', '冬季冰瀑湿滑失温'], supplies: '自备水粮,朱雀森林公园门口补给' },
  // 山西 / 河南
  'wutai-chao': { tickets: 0, risks: ['台顶风大温低,夏季亦需羽绒服', '天气骤变'], supplies: '台顶寺院可挂单吃斋饭,台怀镇补给完善' },
  'wangmangling-xiyagou': { tickets: 110, risks: ['红岩峡谷崖边路', '挂壁公路段留意车流'], supplies: '王莽岭/锡崖沟食宿完善' },
  laoniwan: { supplies: '老牛湾村食宿,沿线无售卖' },
  'hengshan-hou': { risks: ['后山步道年久失修', '天气多变'], supplies: '自备水粮,浑源县补给' },
  luyashan: { risks: ['荷叶坪高山天气多变', '冰洞段湿滑'], supplies: '东寨镇食宿补给' },
  nantaihang: { tickets: 0, risks: ['崖壁小路落石', '雨季山洪', '抱犊段断崖需绕行'], supplies: '沿线村庄(马武寨/抱犊村/西莲)农家食宿,轻装可行' },
  'songshan-shaoshi': { risks: ['连天峰段手脚并用,坠崖风险', '野路无救援'], supplies: '自备水粮,登封市补给' },
  laojunshan: { tickets: 100, risks: ['台阶量大,合理分配体力', '冬季结冰湿滑'], supplies: '山顶有住宿餐饮(价格高),栾川县补给' },
  guoliang: { tickets: 107, supplies: '郭亮村食宿完善' },
  // 河北 / 北京 / 天津
  xiaowutai: { risks: ['天气极端多变,失温事故史', '金莲花期人满为患', '西沟/南台段陡升'], supplies: '无补给,重装自给;山口村落补给' },
  jinshanling: { supplies: '景区有售卖,门景区食宿' },
  chenjiabao: { risks: ['墙体坍塌段攀爬', '天气多变'], supplies: '自备水粮,陈家堡村补给' },
  wulonggou: { risks: ['城墙骑脊段攀爬', '天气多变'], supplies: '自备水粮,涞源县补给' },
  wulingshan: { risks: ['山高林密天气多变', '云海路段湿滑'], supplies: '景区有售卖,兴隆县补给' },
  chashan: { risks: ['高山昼夜温差大', '岔路多'], supplies: '茶山村有农家,山上无售卖' },
  houcheng: { risks: ['丹霞岩壁风化落石', '崖顶无遮蔽'], supplies: '自备水粮,后城镇补给' },
  jiankou: { risks: ['天梯/鹰飞倒仰等险段坠崖风险高', '砖石松动,雨雪天严禁上墙', '野路无救援'], supplies: '自备水粮,西栅子村农家补给' },
  huangcaoliang: { risks: ['长城段墙体残破', '天气多变'], supplies: '自备水粮,斋堂镇补给' },
  dongling: { risks: ['冬季大风低温,山脊无遮蔽', '天气多变'], supplies: '江水河村食宿,山上无售卖' },
  haituo: { risks: ['管控区域,行前确认通行政策', '鞍部风大'], supplies: '自备水粮,周边村镇补给' },
  baihuashan: { supplies: '景区有售卖,两端补给' },
  yunmengshan: { risks: ['瀑布峡谷湿滑', '密林岔路'], supplies: '自备水粮,密云端补给' },
  huangyaguan: { tickets: 65, risks: ['长城段攀爬', '天气多变'], supplies: '景区有售卖,蓟州区食宿' },
  xiangbala: { supplies: '市区可达,自备水粮' },
  'sanfeng-huan': { supplies: '阳台山/鹫峰有售卖,自备水粮即可' },
  // 东北 / 内蒙古
  zhuizishan: { risks: ['垛口原生态,墙体攀爬', '天气多变'], supplies: '自备水粮,绥中县补给' },
  laolikelake: { risks: ['冬季 -20℃ 以下严寒失温', '粉雪深陷行进慢'], supplies: '景区有售卖,和龙市/延吉补给' },
  'changbaishan-xipo': { tickets: 105, risks: ['1400 级台阶体力消耗', '山顶天气瞬变风大', '夏季紫外线强'], supplies: '景区有售卖,松江河镇食宿' },
  'xuexiang-chuanyue': { tickets: 115, risks: ['羊草山风口严寒', '雪深行进慢', '雪乡段人多'], supplies: '雪谷/雪乡食宿完善,轻装可行' },
  jingbohu: { supplies: '景区有售卖,宁安市食宿' },
  kubuqi: { tickets: 0, risks: ['夏季高温禁穿,脱水中暑', '夜间降温大', '全程无水源'], supplies: '人均每天备水 4L,两端补给' },
  'tengger-wuhu': { tickets: 0, risks: ['高温脱水', '沙丘连绵消耗大', '湖水需净化后才可少量使用'], supplies: '无水源,全程自给;两端有接待站' },
  badanjilin: { tickets: 0, risks: ['必鲁图沙山攀爬消耗极大', '腹地无救援,需越野车接应', '高温'], supplies: '无水源无补给,全程自给' },
  'ejina-huyang': { tickets: 240, risks: ['秋季昼夜温差大', '旺季人多'], supplies: '区间车与售卖完善,达来呼布镇食宿' },
  wulanbutong: { tickets: 120, supplies: '乌兰布统乡食宿补给完善' },
  aershan: { tickets: 180, risks: ['火山口天气多变', '林区防火期管控'], supplies: '景区服务区售卖,伊尔施镇食宿' },
  // 宁夏 / 华中
  helanshan: { risks: ['西北强日照脱水', '山脊风大', '碎石坡'], supplies: '无补给,重装自给,提前备水' },
  liupanshan: { supplies: '景区有售卖,泾源县食宿' },
  'shennongjia-laojun': { risks: ['原始森林无路,易迷路', '老君寨天气多变', '保护区管控'], supplies: '无补给,重装自给,木鱼镇备足物资' },
  'qingjiang-guhechuang': { risks: ['溶洞/天坑段湿滑黑暗,必须带头灯', '绝壁小路'], supplies: '沐抚/板桥镇食宿,徒步段自备水粮' },
  luyuanping: { risks: ['1528 级石阶下坑,膝盖负荷大', '地缝湿滑'], supplies: '鹿院坪村内农家食宿' },
  jiuciling: { tickets: 0, risks: ['原始雨林泥泞陡升', '天气多变,救援记录多', '千家峒段岔路'], supplies: '无补给,重装自给,道县/灌阳端补给' },
  'bamianshan-hunan': { risks: ['高山草甸风大', '天气多变'], supplies: '山腰八面山村农家,自备部分水粮' },
  'nanfengmian-lingfeng': { risks: ['山脊线长距离无水源', '天气多变'], supplies: '井冈山端补给,途中无售卖' },
  hupingshan: { risks: ['原始森林迷路', '保护区管控', '天气多变'], supplies: '无补给,重装自给,壶瓶山镇备物资' },
  gaoxiling: { tickets: 0, risks: ['丹霞崖边路,勿靠近边缘拍照', '雨天湿滑'], supplies: '郴州/高椅岭村食宿' },
  yintiaoling: { risks: ['大巴山原始森林迷路', '天气多变'], supplies: '无补给,重装自给,巫山县备物资' },
  sanxiazhidian: { risks: ['夔门绝壁栈道,恐高者量力', '夏季高温'], supplies: '白帝城/三峡之巅有售卖,奉节县食宿' },
  // 江西 / 贵州 / 重庆
  wugongshan: { tickets: 70, risks: ['高山草甸雷雨天无处躲避', '发云界—金顶长距离', '节假日人多'], supplies: '沿线客栈密布(发云界/金顶),轻装可行' },
  sanqingshan: { tickets: 120, risks: ['高空栈道恐高者量力', '云雾天湿滑'], supplies: '山顶有住宿餐饮,山下金沙索道处有镇子' },
  'qiyunshan-gan': { tickets: 0, risks: ['罗霄山脊长距离无水源', '天气多变'], supplies: '自备水粮,遂川县端补给' },
  huanggangshan: { risks: ['武夷主脊天气多变', '公路长距离缓升', '保护区管控'], supplies: '桐木关端补给,自备水粮' },
  maolan: { risks: ['喀斯特漏斗与溶洞易迷路', '湿热蛇虫', '保护区管控'], supplies: '茂兰镇食宿,穿越段自备水粮' },
  leigongshan: { risks: ['秃杉林湿滑', '天气多变'], supplies: '雷山县补给,山上自备水粮' },
  jiucaiping: { risks: ['2777m 山顶风大', '天气多变'], supplies: '景区有售卖,赫章县食宿' },
  fanjingshan: { tickets: 110, risks: ['八千级台阶,体力消耗大', '红云金顶限流排队', '天气瞬变'], supplies: '山顶有索道与售卖,江口县食宿,需提前预约' },
  'jiabang-titian': { risks: ['寨间石板路雨天湿滑', '天气多变'], supplies: '加榜乡民宿食宿完善,轻装可行' },
  doupengshan: { risks: ['原始林岔路', '望天池段天气多变'], supplies: '自备水粮,都匀市补给' },
  'wumeng-caoyuan': { risks: ['高山风大', '天气多变'], supplies: '景区有售卖,坪地乡食宿' },
  'chishui-foiguangyan': { supplies: '景区有售卖,赤水市食宿' },
  wanfenglin: { tickets: 80, supplies: '纳灰村农家乐完善,观光车代步' },
  // 华东
  'huizhang-gudao': { tickets: 68, risks: ['江南第一关石阶陡', '雨天湿滑'], supplies: '沿线江南第一关/蓝天凹有客栈,轻装可行' },
  'huangshan-xihai': { tickets: 190, risks: ['西海大峡谷陡降陡升', '雷雨天禁行栈道与索道', '冬季部分区域封闭'], supplies: '山顶食宿完善(价格高),汤口镇补给' },
  longxushan: { tickets: 0, risks: ['刀锋山脊风大路滑,需全程专注', '岩屑坡滑坠'], supplies: '自备水粮,绩溪县补给' },
  baimajian: { supplies: '山脚景区有售卖与食宿' },
  'wuyue-gudao': { tickets: 0, supplies: '千顷关/浙西天池有售卖,宁国端补给' },
  'junzhang-gudao': { tickets: 0, risks: ['太湖之滨湿热,夏季蚊虫', '岔路多'], supplies: '沿线有补给点,无锡市区便利' },
  'sheshan-jiufeng': { tickets: 0, supplies: '佘山景区售卖便利,地铁可达' },
  qingliangfeng: { risks: ['南山脊乱石坡', '冬季失温', '保护区管控需报备'], supplies: '无补给,自给;永来村/银龙坞补给' },
  'tianmu-qijian': { risks: ['七尖起伏密,累计爬升大', '天气多变'], supplies: '沿途天目村等有农家,可轻装' },
  'sanjian-jianxi': { risks: ['冬季雾凇路滑', '山脊风大'], supplies: '自备水粮,浙基田/上溪端补给' },
  qianba: { risks: ['连穿累计爬升大', '百山祖段天气多变', '保护区管控'], supplies: '炉岙村有农家,自备部分' },
  kuacangshan: { risks: ['风车山脊风大', '天气多变'], supplies: '自备水粮,两端补给' },
  baigangjian: { risks: ['山脊线岔路', '天气多变'], supplies: '自备水粮,雁荡山景区端补给' },
  moganshan: { supplies: '民国别墅群餐饮完善,德清县便利' },
  gongyanyan: { risks: ['机耕路长距离', '天气多变'], supplies: '公盂村农家食宿,补给有限自备部分' },
  nanxijiang: { risks: ['溯溪段汛期山洪', '湿石湿滑'], supplies: '源头村落稀少自备,岩头镇补给' },
  // 福建 / 广东 / 广西 / 海南
  daiyunshan: { risks: ['闽中屋脊天气多变', '原始林岔路'], supplies: '无补给,自给,德化县备水粮' },
  wuyishan: { tickets: 140, risks: ['天游峰台阶陡', '夏季湿热', '竹筏另计'], supplies: '景区售卖完善,武夷山市便利' },
  chuandiding: { tickets: 0, risks: ["'广东驴友毕业线',天气多变易迷路", '乱石坡陡滑', '罗坑段湿热'], supplies: '无补给,重装自给,罗坑镇补给' },
  sanshuixian: { tickets: 0, risks: ['13km 十个山头连翻,累计消耗大', '全程暴晒无遮蔽,夏季严禁正午', '全程无补给'], supplies: '全程无补给,备足 2L 以上饮水' },
  wutongshan: { risks: ['好汉坡陡升', '夏季湿热', '台风天禁上'], supplies: '山脚有售卖,市区便利' },
  dananshan: { tickets: 0, risks: ['高山草甸无遮蔽暴晒', '天气多变'], supplies: '自备水粮,东涌/西涌端补给' },
  tianlushan: { risks: ['杜鹃花期人多', '天气多变'], supplies: '自备水粮,新兴县补给' },
  huangniushi: { tickets: 0, risks: ['原始丛林岔路多', '湿热蚊虫'], supplies: '自备水粮,连平县端补给' },
  luofushan: { tickets: 60, risks: ['夜爬台阶量大', '山顶夜温低'], supplies: '山中道观有斋饭售卖,博罗县便利' },
  'danxia-bazhai': { risks: ['崖壁古寨门段攀爬', '丹霞岩面雨天湿滑'], supplies: '自备水粮,丹霞山景区/仁化县补给' },
  tiantangding: { risks: ['原始次生林岔路', '天气多变'], supplies: '自备水粮,从化端补给' },
  qiniangshan: { tickets: 0, risks: ['山脊野路陡升', '深圳湿热', '台风天禁上'], supplies: '地质公园端有售卖,自备水粮' },
  maoershan: { risks: ['华南之巅天气多变', '原始林岔路'], supplies: '山脚有农家,自备部分' },
  shengtangshan: { risks: ['石峰段攀爬', '天气多变'], supplies: '自备水粮,金秀县食宿' },
  yuanbaoshan: { risks: ['原始森林岔路', '冷杉区天气多变'], supplies: '山下苗寨农家,自备部分' },
  'longji-titian': { tickets: 80, supplies: '大寨/平安寨食宿完善,轻装' },
  'yangdi-xingping': { tickets: 0, risks: ['沿江路汛期水位上涨', '夏季暴晒'], supplies: '杨堤/兴坪食宿完善,沿途渔村有售卖' },
  wuzhishan: { risks: ['热带雨林原始攀爬', '湿热蛇虫', '保护区管控'], supplies: '无补给,自给,水满乡备水' },
  jianfengling: { tickets: 60, risks: ['热带雨林湿热', '主峰段天气多变'], supplies: '天池片区食宿,鸣凤谷段自备水粮' },
  // 港澳台
  maclehose: { tickets: 0, risks: ['夏季高温暴晒,部分段无遮蔽', '周末西贡段人多'], supplies: '沿线士多与露营地齐备,分段轻装' },
  'hongkong-trail': { tickets: 0, supplies: '沿线士多便利,市区可达' },
  'phoenix-trail': { tickets: 0, risks: ['凤凰山山顶风大温低', '夏季高温'], supplies: '昂坪/梅窝补给便利' },
  'wilson-trail': { tickets: 0, risks: ['八仙岭段爬升大', '夏季湿热'], supplies: '沿线补给点较多,自备水粮' },
  'colane-trail': { tickets: 0, supplies: '路环市区便利' },
  yushan: { risks: ['3952m 高反', '排云山庄床位需抽签', '天气多变'], supplies: '需入园许可证,塔塔加端补给' },
  'xueshan-tw': { risks: ['黑森林段易迷路', '圈谷天气多变', '需入园许可证'], supplies: '需入园许可,369 山庄需预订,自备水粮' },
  'nanhu-dashan': { risks: ['五岩峰拉绳攀爬', '松风岭坠崖风险', '需入园许可证'], supplies: '需入园许可,南湖山庄需预订,自给为主' },
  beidawu: { risks: ['大武祠段攀爬', '山顶云雾突变', '需入山许可'], supplies: '需入山许可,登山口补给,自备水粮' },
  jiaminghu: { risks: ['3310m 高反', '向阳山脊风大', '需入园许可'], supplies: '需入园许可,嘉明湖山庄需抽签,自备水粮' },
  hehuanshan: { tickets: 0, risks: ['公路直达易低估海拔,注意高反', '山顶风大温低'], supplies: '清境农场/松雪楼食宿,补给便利' },
};

// ---------- 按类型兜底(仅补没有逐条信息的) ----------
const TYPE_DEFAULTS = {
  长线重装: {
    tickets: 0,
    risks: ['达坂/垭口天气多变', '长距离无补给无救援', '失温与滑坠风险'],
    supplies: '无补给,全程重装自给(或雇马帮)',
  },
  雪山攀登: {
    tickets: 0,
    risks: ['冰坡滑坠,需冰爪冰镐等技术装备', '高反显著', '登顶看天气窗口'],
    supplies: '大本营自给,沿线无售卖,商业协作另计',
  },
  高原转山: {
    tickets: 0,
    risks: ['海拔 4000m+ 高反', '天气骤变'],
    supplies: '起点村镇补给,转山道自备水粮',
  },
  峡谷穿越: {
    risks: ['峡谷落石与雨季山洪', '夏季高温脱水'],
    supplies: '自备水粮,进出峡谷端有村镇',
  },
  沙漠: {
    tickets: 0,
    risks: ['高温脱水,夏季严禁穿越', '无水源,配水按 4L/人/天', '沙丘消耗大,导航易偏'],
    supplies: '无水源无补给,全程自给',
  },
  古道: {
    risks: ['天气多变', '部分路段荒废需轨迹'],
    supplies: '两端村镇补给,轻装可行',
  },
  长城: {
    risks: ['墙体坍塌攀爬有风险,雨雪天禁上', '部分路段临近崖边'],
    supplies: '自备水粮,沿线无售卖',
  },
  山地纵走: {
    risks: ['天气多变', '山脊风大'],
    supplies: '山脚补给,山上自备水粮',
  },
  景区步道: {
    supplies: '景区内售卖与食宿完善',
  },
  城市周边: {
    supplies: '近郊补给便利,自备水粮即可',
  },
};

const SKIP_TICKETS_STATUS = new Set(['管控', '禁入', '关闭']);
const stats = { tickets: 0, risks: 0, supplies: 0 };

for (const [id, t] of Object.entries(trails)) {
  const ov = OVERRIDES[id] || {};
  const def = TYPE_DEFAULTS[t.type] || {};

  if (ov.tickets !== undefined && t.tickets == null) {
    t.tickets = ov.tickets;
    stats.tickets++;
  } else if (t.tickets == null && def.tickets !== undefined
    && !SKIP_TICKETS_STATUS.has(t.status)) {
    t.tickets = def.tickets;
    stats.tickets++;
  }

  if (ov.risks !== undefined && !Array.isArray(t.risks)) {
    t.risks = Array.isArray(ov.risks) ? ov.risks : [ov.risks];
    stats.risks++;
  } else if (!Array.isArray(t.risks) && Array.isArray(def.risks)) {
    t.risks = def.risks;
    stats.risks++;
  }

  if (ov.supplies !== undefined && !t.supplies) {
    t.supplies = ov.supplies;
    stats.supplies++;
  } else if (!t.supplies && def.supplies) {
    t.supplies = def.supplies;
    stats.supplies++;
  }
}

// 幂等:零回填不重写文件(避免无意义 diff)
if (stats.tickets + stats.risks + stats.supplies > 0) {
  fs.writeFileSync(TRAILS_FILE, JSON.stringify(trails, null, 2) + '\n', 'utf8');
}
console.log(`回填完成: tickets ${stats.tickets} 条, risks ${stats.risks} 条, supplies ${stats.supplies} 条${stats.tickets + stats.risks + stats.supplies ? '' : '(无变更,未写文件)'}`);
