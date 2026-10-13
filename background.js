// 清掉常見的前綴、emoji、多餘空白，讓 Maps 比較好搜
function cleanQuery(text) {
  return (text || "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, " ")
    .replace(/^\s*(地址|店家地址|店址|住址|位置|地點|店名|Address|Location|住所)\s*[:：]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function mapsUrl(query) {
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(query);
}

async function openInMaps(text, fromTab) {
  const q = cleanQuery(text);
  if (!q) return;
  await chrome.tabs.create({
    url: mapsUrl(q),
    index: fromTab ? fromTab.index + 1 : undefined,
    openerTabId: fromTab ? fromTab.id : undefined,
  });
}

async function savePlace(text, source) {
  const q = cleanQuery(text);
  if (!q) return false;
  const { places = [] } = await chrome.storage.local.get("places");
  if (places.some((p) => p.query === q)) return "dup";
  places.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    query: q,
    title: source?.title || "",
    url: source?.url || "",
    savedAt: Date.now(),
  });
  await chrome.storage.local.set({ places });
  updateBadge(places.length);
  return true;
}

async function saveListEnabled() {
  return (await chrome.storage.local.get("saveList")).saveList === true;
}

async function updateBadge(n) {
  if (!(await saveListEnabled())) n = 0;
  chrome.action.setBadgeText({ text: n ? String(n) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#1a73e8" });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "maps-open",
    title: "在 Google Maps 搜尋「%s」",
    contexts: ["selection"],
  });
  chrome.contextMenus.create({
    id: "maps-save",
    title: "存進 Maps Picker 清單",
    contexts: ["selection"],
    visible: false,
  });
  saveListEnabled().then((on) => chrome.contextMenus.update("maps-save", { visible: on }));
  chrome.contextMenus.create({
    id: "ocr-region",
    title: "框選畫面文字辨識（⌥⇧X）",
    contexts: ["page", "image", "video", "frame", "link"],
  });
  chrome.storage.local.get("places").then(({ places = [] }) => updateBadge(places.length));
});

// 彈出視窗切換「＋ 存」待存清單時，同步右鍵選單和徽章數字
chrome.storage.onChanged.addListener((c) => {
  if (!c.saveList) return;
  chrome.contextMenus.update("maps-save", { visible: !!c.saveList.newValue });
  chrome.storage.local.get("places").then(({ places = [] }) => updateBadge(places.length));
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get("places").then(({ places = [] }) => updateBadge(places.length));
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "ocr-region") {
    startRegion(tab);
  } else if (info.menuItemId === "maps-open") {
    openInMaps(info.selectionText, tab);
  } else if (info.menuItemId === "maps-save") {
    // 透過 content script 取來源（YouTube 會附上影片時間點）
    let source = { title: tab?.title, url: info.pageUrl };
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: "get-source" }, { frameId: 0 });
      if (r) source = r;
    } catch (_) {}
    const res = await savePlace(info.selectionText, source);
    notifyTab(tab, res);
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!tab?.id) return;
  if (command === "ocr-region") return startRegion(tab);
  let r;
  try {
    r = await chrome.tabs.sendMessage(tab.id, { type: "get-selection" }, { frameId: 0 });
  } catch (_) {
    return; // chrome:// 等頁面無法注入
  }
  if (!r?.text) return;
  if (command === "open-selection") openInMaps(r.text, tab);
  if (command === "save-selection" && (await saveListEnabled())) notifyTab(tab, await savePlace(r.text, r.source));
});

function notifyTab(tab, res) {
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "toast", result: res }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "open") {
    openInMaps(msg.text, sender.tab);
  } else if (msg.type === "save") {
    savePlace(msg.text, msg.source).then(sendResponse);
    return true;
  } else if (msg.type === "start-region") {
    // 從工具列彈出視窗啟動
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => startRegion(tab));
  } else if (msg.type === "ocr-capture") {
    ocrCapture(sender.tab, msg.rect, msg.viewport).then(sendResponse, (e) =>
      sendResponse({ ok: false, error: friendlyError(e) })
    );
    return true;
  } else if (msg.type === "ocr-result") {
    const job = ocrJobs.get(sender.tab.id);
    if (!job) return sendResponse({ ok: false, error: "找不到辨識工作，請重新框選" });
    job.then(sendResponse, (e) => sendResponse({ ok: false, error: friendlyError(e) }));
    ocrJobs.delete(sender.tab.id);
    return true;
  } else if (msg.type === "refresh-badge") {
    chrome.storage.local.get("places").then(({ places = [] }) => updateBadge(places.length));
  }
});

// ---------- 框選畫面文字（OCR） ----------
const ocrJobs = new Map(); // tabId -> Promise<結果>

function startRegion(tab) {
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "start-region" }, { frameId: 0 }).catch(() => {});
  ensureOffscreen().catch(() => {}); // 使用者拖框的時候先把辨識模型載好
}

let offscreenReady;
function ensureOffscreen() {
  offscreenReady ??= (async () => {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "在 Web Worker 裡執行 Tesseract 文字辨識",
    });
  })().catch((e) => {
    offscreenReady = null;
    if (!String(e).includes("Only a single offscreen")) throw e;
  });
  return offscreenReady;
}

async function ocrCapture(tab, rect, viewport) {
  // 截圖要在使用者觸發後（快捷鍵 / 右鍵 / 工具列）才有權限
  const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const { ocrLangs = ["eng", "chi_tra"], ocrDirection = "auto" } = await chrome.storage.local.get(["ocrLangs", "ocrDirection"]);
  const job = (async () => {
    await ensureOffscreen();
    // 截圖像素 / CSS 像素（Retina 螢幕、頁面縮放都會影響）
    const scale = await imageWidth(image) / viewport.w;
    const crop = { x: rect.x * scale, y: rect.y * scale, w: rect.w * scale, h: rect.h * scale };
    const r = await chrome.runtime.sendMessage({
      target: "offscreen", type: "ocr", image, crop, langs: ocrLangs.join("+") || "eng", direction: ocrDirection,
    });
    if (!r) throw new Error("辨識程式沒有回應");
    return r;
  })();
  job.catch(() => {}); // 錯誤留給 ocr-result 回報
  ocrJobs.set(tab.id, job);
  return { ok: true };
}

async function imageWidth(dataUrl) {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const w = bmp.width;
  bmp.close();
  return w;
}

function friendlyError(e) {
  const m = String(e?.message || e);
  if (/activeTab|permission|Cannot access/i.test(m)) return "沒有截圖權限：請用快捷鍵 ⌥⇧X 或工具列按鈕啟動框選";
  return m;
}
