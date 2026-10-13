(() => {
  if (window.__mapsPickerLoaded) return;
  window.__mapsPickerLoaded = true;

  const MAX_LEN = 300;

  // ---- 來源資訊：YouTube 會帶上目前影片秒數，之後可以跳回那一段 ----
  function getSource() {
    let url = location.href;
    const video = document.querySelector("video");
    if (/(^|\.)youtube\.com$/.test(location.hostname) && video && video.currentTime > 0) {
      try {
        const u = new URL(url);
        u.searchParams.set("t", Math.floor(video.currentTime) + "s");
        url = u.toString();
      } catch (_) {}
    }
    return { title: document.title.replace(/ - YouTube$/, ""), url };
  }

  function getSelectedText() {
    return (window.getSelection()?.toString() || "").trim();
  }

  // ---- 浮動按鈕（用 Shadow DOM 避免被網站 CSS 影響）----
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;top:0;left:0;z-index:2147483647;display:none;";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      .bar { display:flex; gap:2px; background:#fff; border-radius:18px; padding:3px;
             box-shadow:0 2px 10px rgba(0,0,0,.25); font:13px/1 -apple-system,"PingFang TC","Noto Sans TC",sans-serif; }
      button { all:unset; cursor:pointer; padding:6px 10px; border-radius:15px; color:#1f1f1f; white-space:nowrap; }
      button:hover { background:#e8f0fe; color:#1a73e8; }
      .toast { position:fixed; left:50%; bottom:40px; transform:translateX(-50%); background:#202124; color:#fff;
               padding:10px 16px; border-radius:8px; font:14px -apple-system,"PingFang TC",sans-serif;
               box-shadow:0 2px 10px rgba(0,0,0,.3); opacity:0; transition:opacity .2s; pointer-events:none; }
      .toast.show { opacity:1; }
      :host(.nosave) [data-act="save"] { display:none; }
    </style>
    <div class="bar">
      <button data-act="open" title="在 Google Maps 開啟">📍 地圖</button>
      <button data-act="save" title="存進清單，之後再處理">＋ 存</button>
      <button data-act="copy" title="複製文字">⧉ 複製</button>
    </div>
    <div class="toast"></div>
  `;
  const bar = shadow.querySelector(".bar");
  const toastEl = shadow.querySelector(".toast");
  let currentText = "";

  function mount() {
    if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
  }

  function hide() {
    host.style.display = "none";
    bar.style.display = "flex";
  }

  function showAt(rect) {
    mount();
    host.style.display = "block";
    const w = bar.offsetWidth || 150, h = 34;
    let left = window.scrollX + rect.left + rect.width / 2 - w / 2;
    let top = window.scrollY + rect.top - h - 8;
    if (rect.top < h + 12) top = window.scrollY + rect.bottom + 8; // 上面空間不夠就放下面
    left = Math.max(window.scrollX + 4, Math.min(left, window.scrollX + document.documentElement.clientWidth - w - 4));
    host.style.left = left + "px";
    host.style.top = top + "px";
  }

  let toastTimer;
  function toast(msg) {
    mount();
    host.style.display = "block";
    bar.style.display = "none";
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove("show");
      setTimeout(hide, 200);
    }, 1600);
  }

  function resultMessage(res) {
    if (res === "dup") return "清單裡已經有了";
    if (res) return "已存進清單 ✓";
    return "存檔失敗";
  }

  // http 頁面或沒焦點時 clipboard API 會失敗，改用舊方法（複製目前的反白）
  async function copyText(text, selectFallback) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      selectFallback?.();
      document.execCommand("copy");
    }
  }

  bar.addEventListener("mousedown", (e) => e.preventDefault()); // 保留反白
  bar.addEventListener("click", async (e) => {
    const act = e.target.closest("button")?.dataset.act;
    if (!act || !currentText) return;
    if (act === "open") {
      chrome.runtime.sendMessage({ type: "open", text: currentText });
      hide();
    } else if (act === "save") {
      const res = await chrome.runtime.sendMessage({ type: "save", text: currentText, source: getSource() });
      toast(resultMessage(res));
    } else if (act === "copy") {
      await copyText(currentText);
      toast("已複製 ✓");
    }
  });

  document.addEventListener("mouseup", (e) => {
    if (e.composedPath().includes(host)) return;
    // 等瀏覽器更新 selection
    setTimeout(() => {
      const sel = window.getSelection();
      const text = getSelectedText();
      if (!text || text.length > MAX_LEN || !sel.rangeCount) return hide();
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect.width && !rect.height) return hide();
      currentText = text;
      showAt(rect);
    }, 10);
  }, true);

  document.addEventListener("mousedown", (e) => {
    if (!e.composedPath().includes(host)) hide();
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); }, true);
  window.addEventListener("scroll", () => { if (bar.style.display !== "none") hide(); }, { passive: true, capture: true });


  // ---- 框選畫面文字（OCR）----
  const ocrHost = document.createElement("div");
  ocrHost.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:none;";
  const ocrShadow = ocrHost.attachShadow({ mode: "closed" });
  ocrShadow.innerHTML = `
    <style>
      * { box-sizing:border-box; }
      .mask { position:fixed; inset:0; cursor:crosshair; background:rgba(0,0,0,.35); }
      .mask.dragging { background:transparent; }
      .hint { position:fixed; top:16px; left:50%; transform:translateX(-50%); background:#202124; color:#fff;
              padding:8px 14px; border-radius:8px; font:14px -apple-system,"PingFang TC","Noto Sans TC",sans-serif;
              pointer-events:none; box-shadow:0 2px 10px rgba(0,0,0,.3); }
      .box { position:fixed; border:2px solid #8ab4f8; box-shadow:0 0 0 9999px rgba(0,0,0,.35); display:none; pointer-events:none; }
      .panel { position:fixed; width:380px; max-width:calc(100vw - 16px); background:#fff; color:#1f1f1f; border-radius:12px;
               box-shadow:0 4px 24px rgba(0,0,0,.35); padding:12px; display:none;
               font:13px/1.4 -apple-system,"PingFang TC","Noto Sans TC",sans-serif; }
      .status { color:#5f6368; padding:4px 2px; }
      .status.err { color:#d93025; }
      textarea { width:100%; min-height:88px; max-height:200px; resize:vertical; border:1px solid #dadce0; border-radius:8px;
                 padding:8px; font:14px/1.45 -apple-system,"PingFang TC","Noto Sans TC",sans-serif; color:#1f1f1f; background:#fff; }
      textarea:focus { outline:2px solid #1a73e8; border-color:transparent; }
      .note { color:#5f6368; font-size:11px; margin:4px 2px 8px; }
      .btns { display:flex; gap:6px; }
      button { all:unset; cursor:pointer; padding:7px 12px; border-radius:16px; border:1px solid #dadce0; white-space:nowrap; text-align:center; }
      button:hover { background:#f1f3f4; }
      button.primary { background:#1a73e8; color:#fff; border-color:#1a73e8; }
      button.primary:hover { background:#1765cc; }
      .spacer { flex:1; }
      :host(.nosave) [data-act="save"] { display:none; }
    </style>
    <div class="mask"></div>
    <div class="hint">拖曳框出畫面上的地址或店名 · Esc 取消</div>
    <div class="box"></div>
    <div class="panel">
      <div class="status"></div>
      <div class="result" hidden>
        <textarea spellcheck="false"></textarea>
        <div class="note">可以直接修改文字，或刪掉不需要的行</div>
        <div class="btns">
          <button class="primary" data-act="open">📍 地圖</button>
          <button data-act="save" title="存進清單，之後再處理">＋ 存</button>
          <button data-act="copy" title="複製文字">⧉ 複製</button>
          <span class="spacer"></span>
          <button data-act="again" title="重新框選">重框</button>
          <button data-act="close" title="關閉 (Esc)">✕</button>
        </div>
      </div>
    </div>
  `;
  const $ = (sel) => ocrShadow.querySelector(sel);
  const maskEl = $(".mask"), hintEl = $(".hint"), boxEl = $(".box"), panelEl = $(".panel");
  const statusEl = $(".status"), resultEl = $(".result"), textEl = $("textarea");
  let ocrActive = false, dragStart = null, pausedVideos = [], lastRect = null;

  function pauseVideos() {
    for (const v of document.querySelectorAll("video")) {
      if (!v.paused) { v.pause(); pausedVideos.push(v); }
    }
  }
  function resumeVideos() {
    for (const v of pausedVideos) v.play().catch(() => {});
    pausedVideos = [];
  }

  function startRegion() {
    if (ocrActive && maskEl.style.display !== "none") return;
    ocrActive = true;
    pauseVideos();
    if (!ocrHost.isConnected) document.documentElement.appendChild(ocrHost);
    ocrHost.style.display = "block";
    ocrHost.style.pointerEvents = "auto";
    maskEl.style.display = hintEl.style.display = "block";
    maskEl.classList.remove("dragging");
    boxEl.style.display = panelEl.style.display = "none";
  }

  function closeOcr({ resume = true } = {}) {
    ocrActive = false;
    dragStart = null;
    ocrHost.style.display = "none";
    if (resume) resumeVideos();
    else pausedVideos = [];
  }

  function rectFrom(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
  }

  maskEl.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragStart = { x: e.clientX, y: e.clientY };
    maskEl.classList.add("dragging");
    hintEl.style.display = "none";
    Object.assign(boxEl.style, { display: "block", left: e.clientX + "px", top: e.clientY + "px", width: "0px", height: "0px" });
  });
  maskEl.addEventListener("mousemove", (e) => {
    if (!dragStart) return;
    const r = rectFrom(dragStart, { x: e.clientX, y: e.clientY });
    Object.assign(boxEl.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" });
  });
  maskEl.addEventListener("mouseup", async (e) => {
    if (!dragStart) return;
    const r = rectFrom(dragStart, { x: e.clientX, y: e.clientY });
    dragStart = null;
    if (r.w < 8 || r.h < 8) return startRegion(); // 太小當成誤點
    lastRect = r;
    await runOcr(r);
  });

  async function runOcr(rect) {
    // 先把遮罩全部藏起來，等畫面更新後再截圖
    ocrHost.style.display = "none";
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(res, 30))));
    let cap;
    try {
      cap = await chrome.runtime.sendMessage({
        type: "ocr-capture", rect, viewport: { w: window.innerWidth, h: window.innerHeight },
      });
    } catch (err) {
      cap = { ok: false, error: String(err?.message || err) };
    }

    ocrHost.style.display = "block";
    maskEl.style.display = hintEl.style.display = boxEl.style.display = "none";
    showPanel(rect);
    if (!cap?.ok) return showStatus(cap?.error || "截圖失敗", true);

    showStatus("辨識中…（第一次會比較久）");
    const r = await chrome.runtime.sendMessage({ type: "ocr-result" }).catch((err) => ({ ok: false, error: String(err) }));
    if (!r?.ok) return showStatus("辨識失敗：" + (r?.error || "未知錯誤"), true);
    if (!r.lines.length) return showStatus("沒辨識到文字，試試框大一點或只框文字", true);

    statusEl.style.display = "none";
    resultEl.hidden = false;
    textEl.value = r.lines.join("\n");
    textEl.focus();
  }

  function showStatus(msg, isErr) {
    statusEl.style.display = "block";
    statusEl.textContent = msg;
    statusEl.classList.toggle("err", !!isErr);
    // 失敗時仍顯示輸入框和按鈕，可以自己打字或重框
    resultEl.hidden = !isErr;
    if (isErr) { textEl.value = ""; textEl.focus(); }
  }

  function showPanel(rect) {
    panelEl.style.display = "block";
    resultEl.hidden = true;
    textEl.value = "";
    const pw = Math.min(380, window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.x, window.innerWidth - pw - 8));
    const below = rect.y + rect.h + 10;
    panelEl.style.left = left + "px";
    if (below + 200 < window.innerHeight) {
      panelEl.style.top = below + "px";
      panelEl.style.bottom = "";
    } else {
      panelEl.style.top = "";
      panelEl.style.bottom = Math.max(8, window.innerHeight - rect.y + 10) + "px";
    }
  }

  panelEl.addEventListener("click", async (e) => {
    const act = e.target.closest("button")?.dataset.act;
    if (!act) return;
    const text = textEl.value.trim();
    if (act === "open" && text) {
      chrome.runtime.sendMessage({ type: "open", text });
      closeOcr({ resume: false });
    } else if (act === "save" && text) {
      const res = await chrome.runtime.sendMessage({ type: "save", text, source: getSource() });
      closeOcr();
      toast(resultMessage(res));
    } else if (act === "copy" && text) {
      const btn = e.target.closest("button");
      await copyText(text, () => textEl.select());
      btn.textContent = "已複製 ✓";
      setTimeout(() => { btn.textContent = "⧉ 複製"; }, 1200);
    } else if (act === "again") {
      startRegion();
    } else if (act === "close") {
      closeOcr();
    }
  });

  // 框選模式下攔截按鍵，不讓網站快捷鍵（YouTube 的 k、f、空白鍵…）被觸發
  for (const type of ["keydown", "keyup", "keypress"]) {
    window.addEventListener(type, (e) => {
      if (!ocrActive) return;
      e.stopImmediatePropagation();
      if (type !== "keydown") return;
      if (e.key === "Escape") closeOcr();
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) panelEl.querySelector('[data-act="open"]').click();
    }, true);
  }

  // 「＋ 存」待存清單預設關閉，可在工具列彈出視窗打開
  function applySaveSetting(on) {
    host.classList.toggle("nosave", !on);
    ocrHost.classList.toggle("nosave", !on);
  }
  chrome.storage.local.get("saveList").then(({ saveList = false }) => applySaveSetting(saveList));
  chrome.storage.onChanged.addListener((c) => { if (c.saveList) applySaveSetting(c.saveList.newValue); });

  // ---- 背景頁面（快捷鍵、右鍵選單）呼叫 ----
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "start-region" && window === window.top) {
      startRegion();
    } else if (msg.type === "get-selection") {
      sendResponse({ text: getSelectedText(), source: getSource() });
    } else if (msg.type === "get-source") {
      sendResponse(getSource());
    } else if (msg.type === "toast" && window === window.top) {
      toast(resultMessage(msg.result));
    }
  });
})();
