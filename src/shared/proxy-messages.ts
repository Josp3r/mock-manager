import { t } from './i18n';

export function proxyTestSuccessMessage() {
  return t('本地 HTTP 请求已通过内置代理。浏览器是否使用系统代理及 HTTPS 证书信任仍需在浏览器中确认。',
    'The local HTTP request passed through the bundled proxy. Check browser routing and HTTPS certificate trust in your browser separately.');
}
