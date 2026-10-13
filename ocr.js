// 文字辨識：先用 PaddleOCR（paddle.js），結果不好才用這裡的 Tesseract 備援
// Tesseract：裁切 → 前處理（放大、灰階、白字轉黑字）→ 辨識
// 在 offscreen.html 裡執行（需要 DOM canvas 和 Web Worker）
(() => {
  const BASE = new URL("vendor/tesseract/", document.baseURI).href;
  // 橫書、直書各留一個 worker，自動判斷方向時兩種都會用到，不用反覆重載語言檔
  const workers = new Map(); // "h" | "v" -> { langs, worker }

  async function getWorker(kind, langs) {
    const cur = workers.get(kind);
    if (cur && cur.langs === langs) return cur.worker;
    workers.delete(kind);
    if (cur) await (await cur.worker).terminate();
    const worker = Tesseract.createWorker(langs, 1 /* LSTM */, {
      workerPath: BASE + "worker.min.js",
      corePath: BASE + "core",
      langPath: BASE + "lang",
      workerBlobURL: false,
      cacheMethod: "none", // 語言檔已在本機，不需要再存 IndexedDB
    });
    workers.set(kind, { langs, worker });
    worker.catch(() => workers.get(kind)?.worker === worker && workers.delete(kind));
    return worker;
  }

  // 直書模型只有中日文；英文在直書裡通常是轉 90° 的，直書模型本身也認得一些拉丁字
  function vertLangs(langs) {
    const v = langs.split("+").filter((l) => l === "chi_tra" || l === "jpn").map((l) => l + "_vert");
    return v.length ? v.join("+") : "";
  }

  async function loadBitmap(dataUrl) {
    const blob = await (await fetch(dataUrl)).blob();
    return createImageBitmap(blob);
  }

  // Otsu 門檻值
  function otsu(gray) {
    const hist = new Array(256).fill(0);
    for (const v of gray) hist[v]++;
    const total = gray.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, th = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) ** 2;
      if (between > best) { best = between; th = t; }
    }
    return th;
  }

  // 產生幾種前處理版本，Tesseract 對「白底黑字」最準
  function makeVariants(bmp, crop, vertical) {
    const sw = crop ? crop.w : bmp.width;
    const sh = crop ? crop.h : bmp.height;
    // 字太小就放大；Tesseract 喜歡字高 30px 以上（直書看的是欄寬）
    const across = vertical ? sw : sh;
    let scale = across < 80 ? 4 : across < 160 ? 3 : across < 400 ? 2 : 1;
    scale = Math.min(scale, 4000 / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));

    const src = document.createElement("canvas");
    src.width = w; src.height = h;
    const ctx = src.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, crop ? crop.x : 0, crop ? crop.y : 0, sw, sh, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const px = img.data;

    const gray = new Uint8ClampedArray(w * h);
    const white = new Uint8ClampedArray(w * h);
    const whiteStrict = new Uint8ClampedArray(w * h);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      gray[j] = 0.299 * r + 0.587 * g + 0.114 * b;
      const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
      white[j] = mn > 185 && mx - mn < 45 ? 0 : 255; // 接近白色 → 當成字（黑）
      whiteStrict[j] = mn > 225 && mx - mn < 30 ? 0 : 255; // 背景也偏亮時用
    }

    // 判斷字是亮的還是暗的：通常字是少數像素
    const th = otsu(gray);
    let light = 0;
    for (const v of gray) if (v > th) light++;
    const lightText = light < gray.length / 2;

    const PAD = 24; // 四周留白，避免貼邊的字被吃掉
    const toCanvas = (fn) => {
      const c = document.createElement("canvas");
      c.width = w + PAD * 2; c.height = h + PAD * 2;
      const cx = c.getContext("2d");
      cx.fillStyle = "#fff";
      cx.fillRect(0, 0, c.width, c.height);
      const out = new ImageData(w, h);
      for (let j = 0; j < gray.length; j++) {
        const v = fn(j);
        out.data[j * 4] = out.data[j * 4 + 1] = out.data[j * 4 + 2] = v;
        out.data[j * 4 + 3] = 255;
      }
      cx.putImageData(out, PAD, PAD);
      return c;
    };

    const auto = toCanvas((j) => (lightText ? 255 - gray[j] : gray[j]));
    const flip = toCanvas((j) => (lightText ? gray[j] : 255 - gray[j]));
    const whiteMask = toCanvas((j) => white[j]);
    const whiteMaskStrict = toCanvas((j) => whiteStrict[j]);
    return lightText ? [auto, whiteMask, whiteMaskStrict, flip] : [auto, flip, whiteMask];
  }

  const CJK = "\\u3000-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef";

  function cleanLines(text) {
    return text
      .split(/\n+/)
      .map((l) =>
        l
          .replace(new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, "g"), "$1") // 中日文字間的多餘空白
          .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.)）]+$/gu, "") // 頭尾雜訊符號
          .trim()
      )
      .filter((l) => {
        const meaningful = (l.match(/[\p{L}\p{N}]/gu) || []).length;
        return meaningful >= 2 && meaningful / l.length > 0.5;
      });
  }

  // 只保留信心度夠的字；分數 = 可信字元數 × 信心度，用來挑最好的前處理版本
  const MIN_WORD_CONF = 55;
  function scoreResult(data, variant, vertical) {
    const lines = [];
    let prevBox = null;
    let score = 0, dropped = 0, confSum = 0, kept = 0;
    for (const block of data.blocks || []) {
      for (const para of block.paragraphs) {
        for (const line of para.lines) {
          const words = [];
          for (const word of line.words) {
            const letters = (word.text.match(/[\p{L}\p{N}]/gu) || []).length;
            if (!letters) continue;
            // 很短的字（1–2 個字母）容易是背景雜訊，要求更高信心度；中日文單字不在此限
            const isCjk = new RegExp(`[${CJK}]`).test(word.text);
            const need = letters <= 2 && !isCjk && !/^\d+[,.]?$/.test(word.text) ? 80 : MIN_WORD_CONF;
            if (word.confidence < need) { dropped++; continue; }
            words.push(word.text);
            score += letters * word.confidence / 100;
            confSum += word.confidence; kept++;
          }
          if (!words.length) continue;
          // 直書時 Tesseract 常把同一欄切成好幾段，x 範圍重疊就接回同一行
          const b = line.bbox;
          const sameColumn = vertical && prevBox &&
            Math.min(b.x1, prevBox.x1) - Math.max(b.x0, prevBox.x0) > 0.5 * Math.min(b.x1 - b.x0, prevBox.x1 - prevBox.x0);
          if (sameColumn) {
            lines[lines.length - 1] += words.join("");
          } else {
            lines.push(words.join(" "));
          }
          prevBox = b;
        }
      }
    }
    return {
      lines: cleanLines(lines.join("\n")),
      score,
      dropped,
      confidence: kept ? Math.round(confSum / kept) : 0,
      variant,
    };
  }

  async function runPass(kind, langs, bmp, crop, maxVariants) {
    const w = await getWorker(kind, langs);
    // 6 = 一整塊橫書；5 = 一整塊直書（欄由右到左）
    await w.setParameters({ tessedit_pageseg_mode: kind === "v" ? "5" : "6", preserve_interword_spaces: "1" });
    let best = null;
    const variants = makeVariants(bmp, crop, kind === "v").slice(0, maxVariants);
    for (let i = 0; i < variants.length; i++) {
      const { data } = await w.recognize(variants[i], {}, { text: true, blocks: true });
      const cand = scoreResult(data, i, kind === "v");
      cand.vertical = kind === "v";
      if (!best || cand.score > best.score) best = cand;
      if (cand.dropped === 0 && cand.confidence >= 88 && cand.lines.length) break; // 夠乾淨就不用再試
    }
    return best;
  }

  const isGood = (r) => r && r.lines.length && r.confidence >= 80;

  // direction: "auto" | "h" | "v"
  async function recognize(dataUrl, { langs = "eng+chi_tra", crop = null, direction = "auto" } = {}) {
    const bmp = await loadBitmap(dataUrl);
    if (crop) {
      // 限制在圖片範圍內
      crop.x = Math.max(0, Math.round(crop.x));
      crop.y = Math.max(0, Math.round(crop.y));
      crop.w = Math.min(bmp.width - crop.x, Math.round(crop.w));
      crop.h = Math.min(bmp.height - crop.y, Math.round(crop.h));
    }
    const w = crop ? crop.w : bmp.width, h = crop ? crop.h : bmp.height;
    const vLangs = vertLangs(langs) || "chi_tra_vert";

    // 先用 PaddleOCR（中日文、藝術字、影片字幕都比 Tesseract 準）；Paddle 認不出來才退回 Tesseract
    if (window.PaddleOCR) {
      try {
        const p = await PaddleOCR.recognize(bmp, crop || { x: 0, y: 0, w, h }, direction);
        if (p.lines.length && p.confidence >= 70) return p;
        const t = await tesseract(bmp, crop, w, h, langs, vLangs, direction);
        return t && t.score > p.score ? t : p;
      } catch (e) {
        console.warn("PaddleOCR 失敗，改用 Tesseract", e);
      }
    }
    return tesseract(bmp, crop, w, h, langs, vLangs, direction);
  }

  async function tesseract(bmp, crop, w, h, langs, vLangs, direction) {
    if (direction === "h") return runPass("h", langs, bmp, crop, 4);
    if (direction === "v") return runPass("v", vLangs, bmp, crop, 4);

    // 自動：沒勾中日文就只有橫書；框得又瘦又高先試直書，否則先試橫書
    const cjk = !!vertLangs(langs);
    if (!cjk) return runPass("h", langs, bmp, crop, 4);
    const order = h > w * 1.3 ? ["v", "h"] : ["h", "v"];
    const first = await runPass(order[0], order[0] === "v" ? vLangs : langs, bmp, crop, 4);
    if (isGood(first)) return first;
    // 很扁的框幾乎不可能是直書，不浪費時間
    if (order[1] === "v" && w > h * 2.5) return first;
    const second = await runPass(order[1], order[1] === "v" ? vLangs : langs, bmp, crop, 2);
    return second && second.score > first.score ? second : first;
  }

  window.MapsOCR = { recognize };
})();
