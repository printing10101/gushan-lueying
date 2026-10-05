// ESLint flat config(ESLint 9 格式)。目标不是「零 warning」的洁癖,而是挡住
// 几类会静默出错、且测试不容易抓到的写法。挑规则时每条都对应一个真实教训。
//
// 为什么只覆盖 electron/ lib/ src/ 而不覆盖 test/ 与 scripts/:
// test/ 里大量 assert.deepEqual 会故意构造多余字段;scripts/ 是一次性数据维护
// 脚本,风格宽松无害。护栏要加在产品代码上,不是加在测试上。
export default [
  {
    files: ['electron/**/*.js', 'lib/**/*.js', 'src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        // 浏览器侧(lib/*.js 经 <script> 加载,src/app.js 是页面脚本)
        window: 'readonly', document: 'readonly', console: 'readonly',
        localStorage: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
        fetch: 'readonly', performance: 'readonly', Event: 'readonly',
        FormData: 'readonly', URL: 'readonly', Blob: 'readonly',
        AMap: 'readonly', Option: 'readonly', confirm: 'readonly',
        alert: 'readonly', navigator: 'readonly', FileReader: 'readonly',
        // node 侧(主进程 + lib 的 module.exports 路径)
        require: 'readonly', module: 'writable', exports: 'writable',
        process: 'readonly', Buffer: 'readonly', __dirname: 'readonly',
        __filename: 'readonly', setInterval: 'readonly', AbortSignal: 'readonly',
      },
    },
    rules: {
      // —— 这几条每条都对应一次真实事故 ——
      // no-unused-vars: 改 lib 导出名时留下的残引用(本次 6 处全部要手工改),
      //   是静默 undefined 的主要来源。
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        // 顶层 catch 不带参数是有意的写法(见 lib/http.js / lib/store.js)
        caughtErrors: 'none',
      }],
      // no-constant-condition: 空 while(true) 轮询 + 忘记 break 会挂死主进程。
      'no-constant-condition': ['error', { checkLoops: false }],
      // no-fallthrough: 交通/预算分支里漏 break 会让金额算错,且不报错。
      'no-fallthrough': 'error',
      // no-dupe-keys / no-dupe-else-if: 对象字面量重键会静默取后者。
      'no-dupe-keys': 'error',
      'no-dupe-else-if': 'error',
      // eqeqeq: == 会让 null/undefined 与 0 混判,正是「数据不足」类 bug 的温床。
      eqeqeq: ['error', 'smart'],
      // no-eval / no-implied-eval: 渲染进程注入脚本的放大器。
      'no-eval': 'error',
      'no-implied-eval': 'error',
      // no-return-await / no-async-promise-executor 之类不必要,不加噪。

      // —— 建议但先只警告,不清零 ——
      // no-await-in-loop: 目前 6 处全部是刻意串行,不是漏改——
      //   lib/planner.js:环线各段依次调高德 API,并发会触发限流且要用量配额;
      //   lib/rail12306.js:12306 查询共享 cookie 与频次限制,并发会被判为爬虫;
      //   lib/recommend.js:147 其实已经是 Promise.all 并发,lint 看不穿 worker 池写法。
      // 保留 warn 而非 error:将来真出现「忘了加 await」的串行瓶颈时它会提醒,
      // 但现在不该逼着人去拆掉限流保护。
      'no-await-in-loop': 'warn',
      'prefer-const': 'warn',
      'no-var': 'warn',
    },
  },
];