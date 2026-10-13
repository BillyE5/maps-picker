// 文字辨識（主要）：PaddleOCR PP-OCRv5 mobile（ONNX）＋ onnxruntime-web
// 先用偵測模型找出每一行字的位置，再逐行用辨識模型認字；一個模型就涵蓋繁簡中、日文、英文
// 在 offscreen.html 裡執行，全部在本機
(() => {
  const BASE = new URL("vendor/", document.baseURI).href;
  ort.env.wasm.wasmPaths = BASE + "onnxruntime/";
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

  let models = null;
  function load() {
    models ??= (async () => {
      const opt = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
      const [det, rec, dict] = await Promise.all([
        ort.InferenceSession.create(BASE + "paddle/det.onnx", opt),
        ort.InferenceSession.create(BASE + "paddle/rec.onnx", opt),
        fetch(BASE + "paddle/dict.txt").then((r) => r.text()),
      ]);
      // CTC：0 = blank，1..n = 字典，最後一個 = 空白
      const chars = ["", ...dict.split(/\r?\n/).filter((c, i, a) => c || i < a.length - 1), " "];
      return { det, rec, chars };
    })();
    models.catch(() => (models = null));
    return models;
  }

  function canvas(w, h) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    return c;
  }

  // ---------- 偵測 ----------
  const DET_MAX = 960, DET_MIN = 160, DET_PAD = 16;
  const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

  // 回傳原圖座標系的文字框 [{x, y, w, h, score}]
  async function detect(src, det) {
    const sw = src.width, sh = src.height;
    let ratio = Math.min(1, DET_MAX / Math.max(sw, sh));
    // 太小的圖先放大，細的筆畫（例如「一」）才偵測得到
    if (Math.min(sw, sh) * ratio < DET_MIN) ratio = Math.min(DET_MIN / Math.min(sw, sh), DET_MAX * 2 / Math.max(sw, sh));
    // 四周留邊：框得很貼的時候，貼邊的字比較不會被漏掉
    const iw = Math.round(sw * ratio), ih = Math.round(sh * ratio);
    const W = Math.ceil((iw + DET_PAD * 2) / 32) * 32, H = Math.ceil((ih + DET_PAD * 2) / 32) * 32;
    const c = canvas(W, H);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = borderColor(src);
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, DET_PAD, DET_PAD, iw, ih);
    const px = ctx.getImageData(0, 0, W, H).data;

    // Paddle 用 OpenCV 讀圖，通道順序是 BGR
    const n = W * H, input = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) input[k * n + i] = (px[i * 4 + 2 - k] / 255 - MEAN[k]) / STD[k];
    }
    const out = await det.run({ [det.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, H, W]) });
    const prob = out[det.outputNames[0]].data;

    return components(prob, W, H, 0.3)
      .filter((b) => b.score >= 0.5 && b.w >= 3 && b.h >= 3)
      .map((b) => {
        // 偵測結果比實際字小一圈，往外擴（同 Paddle 的 unclip，ratio 1.5）
        const d = (b.w * b.h * 1.5) / (2 * (b.w + b.h));
        const x0 = Math.max(0, (b.x - d - DET_PAD) / ratio), y0 = Math.max(0, (b.y - d - DET_PAD) / ratio);
        const x1 = Math.min(sw, (b.x + b.w + d - DET_PAD) / ratio), y1 = Math.min(sh, (b.y + b.h + d - DET_PAD) / ratio);
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, score: b.score };
      })
      .filter((b) => b.w >= 4 && b.h >= 4);
  }

  // 機率圖二值化後找連通區塊（4-連通），回傳外框與平均機率
  function components(prob, W, H, th) {
    const label = new Int32Array(W * H);
    const stack = new Int32Array(W * H);
    const boxes = [];
    let id = 0;
    for (let s = 0; s < W * H; s++) {
      if (label[s] || prob[s] <= th) continue;
      id++;
      let top = 0, x0 = W, y0 = H, x1 = 0, y1 = 0, sum = 0, cnt = 0;
      stack[top++] = s; label[s] = id;
      while (top) {
        const p = stack[--top];
        const x = p % W, y = (p - x) / W;
        sum += prob[p]; cnt++;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        const nb = [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1];
        for (const q of nb) {
          if (q >= 0 && !label[q] && prob[q] > th) { label[q] = id; stack[top++] = q; }
        }
      }
      if (cnt >= 9) boxes.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, score: sum / cnt });
    }
    return boxes;
  }

  // 用邊緣像素的平均色補邊，比補白/補黑自然
  function borderColor(src) {
    const c = canvas(8, 8);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, 8, 8);
    const d = ctx.getImageData(0, 0, 8, 8).data;
    let r = 0, g = 0, b = 0, k = 0;
    for (let i = 0; i < 64; i++) {
      const x = i % 8, y = i >> 3;
      if (x && y && x < 7 && y < 7) continue;
      r += d[i * 4]; g += d[i * 4 + 1]; b += d[i * 4 + 2]; k++;
    }
    return `rgb(${r / k | 0},${g / k | 0},${b / k | 0})`;
  }

  // 同一行、靠得很近的框併成一個：像「一」這種扁字常被切成獨立的框，單獨看只會被認成「-」
  function mergeRow(boxes, isVert) {
    const flat = (b) => !isVert(b);
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i], b = boxes[j];
          if (!flat(a) || !flat(b)) continue;
          const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          const gapX = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
          const dy = Math.abs(a.y + a.h / 2 - (b.y + b.h / 2));
          if (overlapY < Math.min(a.h, b.h) * 0.6 || dy > Math.max(a.h, b.h) * 0.3) continue; // 不同行
          if (gapX > Math.max(a.h, b.h) * 0.6) continue; // 離太遠
          const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
          boxes[i] = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y, score: Math.max(a.score, b.score) };
          boxes.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
    return boxes;
  }

  // ---------- 辨識 ----------
  const REC_H = 48, REC_MAX_W = 3200;

  async function recognizeLine(src, box, rec, chars, isVert) {
    // 直的框（直書）轉 90° 變成橫的再認，跟 Paddle 官方做法一樣
    const vertical = isVert(box);
    const bw = vertical ? box.h : box.w, bh = vertical ? box.w : box.h;
    const W = Math.max(REC_H, Math.min(REC_MAX_W, Math.ceil((REC_H * bw) / bh)));
    const c = canvas(W, REC_H);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    if (vertical) {
      // 逆時針轉 90°：欄的頂端變成行的左端
      ctx.translate(0, REC_H);
      ctx.rotate(-Math.PI / 2);
      ctx.drawImage(src, box.x, box.y, box.w, box.h, 0, 0, REC_H, W);
    } else {
      ctx.drawImage(src, box.x, box.y, box.w, box.h, 0, 0, W, REC_H);
    }
    const px = ctx.getImageData(0, 0, W, REC_H).data;
    const n = W * REC_H, input = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) input[k * n + i] = px[i * 4 + 2 - k] / 127.5 - 1;
    }
    const out = await rec.run({ [rec.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, REC_H, W]) });
    const t = out[rec.outputNames[0]];
    const [, T, C] = t.dims;
    const data = t.data;

    // CTC greedy decode
    let text = "", confSum = 0, cnt = 0, prev = 0;
    for (let i = 0; i < T; i++) {
      let best = 0, bp = -1;
      for (let j = 0; j < C; j++) {
        const v = data[i * C + j];
        if (v > bp) { bp = v; best = j; }
      }
      if (best && best !== prev) {
        text += chars[best] ?? "";
        confSum += bp; cnt++;
      }
      prev = best;
    }
    return { text: text.trim(), confidence: cnt ? confSum / cnt : 0, vertical };
  }

  // ---------- 排版：把框排成閱讀順序 ----------
  function arrange(items) {
    const vert = items.filter((it) => it.vertical);
    const horiz = items.filter((it) => !it.vertical);
    const lines = [];

    // 橫書：中心點高度相近的算同一行，由上到下、由左到右
    horiz.sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2));
    const rows = [];
    for (const it of horiz) {
      const cy = it.y + it.h / 2;
      const row = rows.find((r) => Math.abs(r.cy - cy) < Math.min(r.h, it.h) * 0.5);
      if (row) row.items.push(it);
      else rows.push({ cy, h: it.h, items: [it] });
    }
    for (const r of rows) {
      r.items.sort((a, b) => a.x - b.x);
      lines.push({ pos: r.cy, text: joinWords(r.items.map((it) => it.text)) });
    }

    // 直書：中心點左右相近的算同一欄（同一欄有時會被切成上下幾段），欄由右到左、欄內由上到下
    vert.sort((a, b) => b.x + b.w / 2 - (a.x + a.w / 2));
    const cols = [];
    for (const it of vert) {
      const cx = it.x + it.w / 2;
      const col = cols.find((c) => Math.abs(c.cx - cx) < Math.min(c.w, it.w) * 0.5);
      if (col) col.items.push(it);
      else cols.push({ cx, w: it.w, items: [it] });
    }
    const v = cols.map((c) => c.items.sort((a, b) => a.y - b.y).map((it) => it.text).join(""));
    return [...lines.sort((a, b) => a.pos - b.pos).map((l) => l.text), ...v];
  }

  const CJK_RE = /[　-ヿ㐀-鿿豈-﫿＀-￯]/;
  function joinWords(words) {
    let s = "";
    for (const w of words) {
      if (s && !(CJK_RE.test(s.at(-1)) && CJK_RE.test(w[0]))) s += " ";
      s += w;
    }
    return s;
  }

  // ---------- 入口 ----------
  // 回傳 { lines, confidence(0–100), score }，格式跟 Tesseract 那條路一樣
  // direction: "auto" 看框的形狀判斷直橫；"h" 全當橫書；"v" 只要比較高就當直書（兩三個字的直欄也算）
  async function recognize(bmp, crop, direction = "auto") {
    const isVert = direction === "h" ? () => false
      : direction === "v" ? (b) => b.h > b.w
      : (b) => b.h >= b.w * 1.5;
    const { det, rec, chars } = await load();
    const src = canvas(crop.w, crop.h);
    src.getContext("2d").drawImage(bmp, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);

    let boxes = mergeRow(await detect(src, det), isVert);
    // 什麼都沒找到（例如框得只剩一行字）：整塊當成一行
    if (!boxes.length) boxes = [{ x: 0, y: 0, w: crop.w, h: crop.h }];

    const items = [];
    for (const b of boxes) {
      const r = await recognizeLine(src, b, rec, chars, isVert);
      if (r.text && r.confidence >= 0.5) items.push({ ...b, ...r });
    }
    const lines = arrange(items).filter((l) => (l.match(/[\p{L}\p{N}]/gu) || []).length >= 1);
    const letters = items.reduce((n, it) => n + (it.text.match(/[\p{L}\p{N}]/gu) || []).length, 0);
    const conf = items.length ? items.reduce((s, it) => s + it.confidence, 0) / items.length : 0;
    return { lines, confidence: Math.round(conf * 100), score: letters * conf, engine: "paddle" };
  }

  window.PaddleOCR = { recognize, load };
})();
