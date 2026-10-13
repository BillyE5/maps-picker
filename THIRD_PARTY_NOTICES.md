# Third-Party Notices

本專案的 `vendor/` 目錄包含以下第三方元件，各自依其授權條款發布。
專案本身的程式碼（`vendor/` 以外）採用 MIT 授權，見 [LICENSE](LICENSE)。

| 元件 | 位置 | 授權 | 來源 |
|---|---|---|---|
| PaddleOCR PP-OCRv5 mobile 偵測／辨識模型與字典（ONNX 版本取自 RapidOCR） | `vendor/paddle/` | Apache-2.0 | https://github.com/PaddlePaddle/PaddleOCR 、 https://github.com/RapidAI/RapidOCR |
| ONNX Runtime Web 1.30 | `vendor/onnxruntime/` | MIT | https://github.com/microsoft/onnxruntime |
| Tesseract.js 7 / tesseract.js-core | `vendor/tesseract/*.js`、`vendor/tesseract/core/` | Apache-2.0（全文見 `vendor/tesseract/LICENSE.md`） | https://github.com/naptha/tesseract.js |
| Tesseract 語言資料（eng、chi_tra、chi_tra_vert、jpn、jpn_vert） | `vendor/tesseract/lang/` | Apache-2.0 | https://github.com/tesseract-ocr/tessdata |

Apache License 2.0 全文：https://www.apache.org/licenses/LICENSE-2.0
MIT License（ONNX Runtime）：Copyright (c) Microsoft Corporation，全文見 https://github.com/microsoft/onnxruntime/blob/main/LICENSE
