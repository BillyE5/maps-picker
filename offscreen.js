// 背景頁（service worker）不能開 Web Worker / canvas，所以辨識在這個隱藏頁面裡做
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== "offscreen" || msg.type !== "ocr") return;
  MapsOCR.recognize(msg.image, { langs: msg.langs, crop: msg.crop, direction: msg.direction })
    .then((r) => sendResponse({ ok: true, lines: r.lines, confidence: r.confidence }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

// 先把模型載進來，第一次框選就不用等
PaddleOCR.load().catch((e) => console.warn("PaddleOCR 載入失敗", e));
