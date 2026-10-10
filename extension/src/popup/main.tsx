// extension/src/popup/main.tsx — popup entry: wires Popup to chrome.* APIs.

import { createRoot } from 'react-dom/client';

import { brandConfig } from '../env';
import { translate } from '../i18n/index';
import { Popup, type PopupDeps } from './Popup';
import { POPUP_CSS, popupTokens } from './styles';

const brand = brandConfig();
document.documentElement.setAttribute('data-brand', brand.id);
document.title = translate('extension', 'popup.title');
const style = document.createElement('style');
style.textContent = `${popupTokens()}\n${POPUP_CSS}`;
document.head.appendChild(style);

const deps: PopupDeps = {
  send: (msg) => chrome.runtime.sendMessage(msg),
  async activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id === undefined ? null : { id: tab.id, url: tab.url ?? null };
  },
  async tabMessage(tabId, msg) {
    try {
      return (await chrome.tabs.sendMessage(tabId, msg)) ?? null;
    } catch {
      return null;
    }
  },
  async inject(tabId) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      return true;
    } catch {
      return false;
    }
  },
  openTab: (url) => void chrome.tabs.create({ url }),
  close: () => window.close(),
  adapterSet: brand.adapterSet,
  market: brand.market,
};

const root = document.getElementById('root');
if (root) createRoot(root).render(<Popup deps={deps} />);
