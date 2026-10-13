const listEl = document.getElementById("list");
const countEl = document.getElementById("count");
const actionsEl = document.getElementById("actions");
const titleEl = document.getElementById("title");
const saveListBox = document.getElementById("saveList");

const mapsUrl = (q) => "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q);

async function getPlaces() {
  return (await chrome.storage.local.get("places")).places || [];
}

async function setPlaces(places) {
  await chrome.storage.local.set({ places });
  chrome.runtime.sendMessage({ type: "refresh-badge" });
  render();
}

async function render() {
  const { saveList = false } = await chrome.storage.local.get("saveList");
  saveListBox.checked = saveList;
  titleEl.firstChild.textContent = saveList ? "📍 待存地點 " : "📍 Maps Picker ";
  listEl.hidden = !saveList;
  if (!saveList) {
    countEl.textContent = "";
    actionsEl.style.display = "none";
    return;
  }
  const places = await getPlaces();
  countEl.textContent = places.length ? `(${places.length})` : "";
  actionsEl.style.display = places.length ? "flex" : "none";
  listEl.replaceChildren();

  if (!places.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "還沒有存任何地點。在網頁上反白地址或店名，按「＋ 存」就會出現在這裡。";
    listEl.append(li);
    return;
  }

  for (const p of places) {
    const li = document.createElement("li");

    const main = document.createElement("div");
    main.className = "main";
    const q = document.createElement("div");
    q.className = "q";
    q.textContent = p.query;
    q.title = "在 Google Maps 開啟";
    q.onclick = () => chrome.tabs.create({ url: mapsUrl(p.query) });
    main.append(q);

    if (p.url) {
      const src = document.createElement("a");
      src.className = "src";
      src.href = p.url;
      src.textContent = "↳ " + (p.title || p.url);
      src.title = p.url;
      src.onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: p.url }); };
      main.append(src);
    }

    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "×";
    del.title = "從清單移除";
    del.onclick = async () => setPlaces((await getPlaces()).filter((x) => x.id !== p.id));

    li.append(main, del);
    listEl.append(li);
  }
}

document.getElementById("openAll").onclick = async () => {
  const places = await getPlaces();
  if (places.length > 10 && !confirm(`要一次開 ${places.length} 個分頁嗎？`)) return;
  for (const p of [...places].reverse()) chrome.tabs.create({ url: mapsUrl(p.query), active: false });
};

document.getElementById("export").onclick = async () => {
  const places = await getPlaces();
  const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const rows = [["名稱/地址", "來源影片", "來源網址", "Google Maps 連結"]];
  for (const p of places) rows.push([p.query, p.title, p.url, mapsUrl(p.query)]);
  const csv = "﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n"); // BOM 讓 Excel 正確顯示中文
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = `maps-picker-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
};

document.getElementById("clear").onclick = async () => {
  if (confirm("確定清空整個清單？")) setPlaces([]);
};

saveListBox.onchange = async () => {
  await chrome.storage.local.set({ saveList: saveListBox.checked });
  render();
};

document.getElementById("ocr").onclick = () => {
  chrome.runtime.sendMessage({ type: "start-region" });
  window.close();
};

// 備援（Tesseract）辨識語言，勾越多越慢；主要的 PaddleOCR 不受影響
const langBoxes = [...document.querySelectorAll("#langs input")];
chrome.storage.local.get("ocrLangs").then(({ ocrLangs = ["eng", "chi_tra"] }) => {
  for (const b of langBoxes) b.checked = ocrLangs.includes(b.value);
});
for (const b of langBoxes) {
  b.onchange = () => {
    const langs = langBoxes.filter((x) => x.checked).map((x) => x.value);
    if (!langs.length) { b.checked = true; return; } // 至少留一個
    chrome.storage.local.set({ ocrLangs: langs });
  };
}

// 文字方向：自動會依框的形狀先猜，辨識不好再換另一個方向試
const dirRadios = [...document.querySelectorAll("#dirs input")];
chrome.storage.local.get("ocrDirection").then(({ ocrDirection = "auto" }) => {
  for (const r of dirRadios) r.checked = r.value === ocrDirection;
});
for (const r of dirRadios) r.onchange = () => chrome.storage.local.set({ ocrDirection: r.value });

render();
