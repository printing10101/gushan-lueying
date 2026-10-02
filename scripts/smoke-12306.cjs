// 12306 接口冒烟测试,由 electron . --smoke=rail 触发(在主进程内跑,net.fetch 才可用)。
const OUT_FILE = require('path').join(__dirname, 'smoke-output.txt');
const fs = require('fs');

async function run(log) {
  const rail = require('../lib/rail12306');
  const args = process.argv.slice(process.argv.indexOf('--smoke=rail') + 1);
  const [from = '成都东', to = '西安北', date = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10)] = args;

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
      say(`${t.code} ${t.startTime}→${t.arriveTime} 历时${t.lishi} 可购:${t.canWebBuy} 余票:${JSON.stringify(t.seats)}`);
    }
    const first = trains.find((t) => t.canWebBuy) || trains[0];
    if (first) {
      const { prices, raw } = await rail.trainPrice(first.trainNo, date, first.fromNo, first.toNo, first.seatTypes);
      say(`\n${first.code} 票价解析结果: ${JSON.stringify(prices)}`);
      say('原始返回中疑似价格的键值对:');
      for (const [k, v] of Object.entries(raw)) {
        if (/^[A-Z0-9]{1,3}$/.test(k)) say(`  ${k} = ${JSON.stringify(v)}`);
      }
    }
  } catch (e) {
    say(`!! 失败: ${e.message}`);
  } finally {
    flush();
  }
}

module.exports = { run };
