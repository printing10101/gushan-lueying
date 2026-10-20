// 静态服务读流出错时的响应收尾。
//
// 关键点:响应头在 createReadStream 之前就已经 writeHead(200) 发出去了;
// 这时再 writeHead(500) 会抛 ERR_HTTP_HEADERS_SENT,把"读文件失败"升级成主进程未捕获异常。
// 所以只能按 headersSent 分流:已发出就 destroy,还没发出才允许补 500。
function endReadError(res, err) {
  if (!res) return;
  if (res.headersSent) {
    if (typeof res.destroy === 'function') res.destroy(err);
    else res.end();
    return;
  }
  res.writeHead(500);
  res.end('read error');
}

module.exports = { endReadError };
