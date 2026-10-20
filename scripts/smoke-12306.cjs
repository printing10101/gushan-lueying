// 12306 接口冒烟测试,由 electron . --smoke=rail 触发(主进程内跑,也可纯 node 直接 node scripts/smoke-12306.cjs)。
const OUT_FILE = require('path').join(__dirname, 'smoke-output.txt');
const fs = require('fs');

async function run(log) {
  const rail = require('../lib/rail12306');
  const idx = process.argv.indexOf('--smoke=rail');
  const args = idx > -1 ? process.argv.slice(idx + 1) : process.argv.slice(2);
  const d = new Date(Date.now() + 3 * 864e5);
  const pad = (x) => String(x).padStart(2, '0');
  const defaultDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const [from = '成都东', to = '西安北', date = defaultDate] = args;

  const lines = [];
  const say = (s) => { lines.push(s); log(s); };
  // Electron GUI 程序的 console.log 不回传终端,同时落一份文件
  const flush = () => fs.writeFileSync(OUT_FILE, lines.join('\n'), 'utf8');
  const timer = setTimeout(() => { say('!! 90 秒超时,强制退出'); flush(); process.exit(1); }, 90_000);
  timer.unref();

  try {
    const { trains } = await rail.queryTrains(from, to, date);
    say(`共 ${trains.length} 趟车`);
    for (const t of trains.slice(0, 5)) {
      say(`${t.code} ${t.startTime}→${t.arriveTime} 余票:${JSON.stringify(t.seats)} 票价:${JSON.stringify(t.prices)}`);
    }
    const withPrice = trains.find((t) => t.prices && Object.keys(t.prices).length > 0);
    if (!withPrice) say('!! 所有车次均未解析出票价,官方 f39 编码可能已变更');
    else say(`\n票价抽查 OK: ${withPrice.code} ${JSON.stringify(withPrice.prices)}`);
  } catch (e) {
    say(`!! 失败: ${e.message}`);
  } finally {
    flush();
  }
}

module.exports = { run };

// 纯 node 直接运行时自动执行
if (require.main === module) {
  run((s) => console.log(s)).then(() => process.exit(0));
}
