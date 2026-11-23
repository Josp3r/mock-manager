import { proxyTestSuccessMessage } from '../shared/proxy-messages';
import { t } from '../shared/i18n';
import { createServer, request } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export async function testProxyConnection(host: string, port: number): Promise<{ok: boolean; message: string}> {
  const nonce = randomUUID();
  const server = createServer((req, res) => {
    if (req.url !== '/' + nonce) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'text/plain'); res.end(nonce);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
    });
    const target = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${nonce}`;
    await new Promise<void>((resolve, reject) => {
      const req = request({ hostname: host, port, path: target, method: 'GET', agent: false,
        headers: { host: new URL(target).host, connection: 'close' } }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk.toString(); if (text.length > 4096) req.destroy(new Error(t("代理测试响应过大。", "The proxy test response is too large."))); });
        res.once('error', reject);
        res.once('end', () => res.statusCode === 200 && text === nonce ? resolve() : reject(new Error(t("代理未返回预期的本地测试响应。", "The proxy did not return the expected local test response."))));
      });
      const timeout = setTimeout(() => req.destroy(new Error(t("代理测试超时，请检查内置引擎状态。", "The proxy test timed out. Check the bundled engine status."))), 5000);
      req.once('close', () => clearTimeout(timeout)); req.once('error', reject); req.end();
    });
    return {ok: true, message: proxyTestSuccessMessage()};
  } catch (error) {
    return {ok: false, message: error instanceof Error ? error.message : t("代理连接测试失败。", "The proxy connection test failed.")};
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
