const DEFAULT_API_KEYS = [
  
];

const PRIMARY_MODELS = [
  "gemini-3.1-flash-lite",
  "gemini-3.1-flash-lite-preview",
  "gemini-3-flash-preview",
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest"
];

const AUDITOR_MODELS = [
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite-preview",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite"
];

const MODELS = PRIMARY_MODELS;

const keyStateMap = new Map();
let roundRobinCursor = 0;

const PER_KEY_MIN_INTERVAL_MS = 1800;
const COOLDOWN_429_DEFAULT_MS = 20000;
const COOLDOWN_TIMEOUT_MS = 5000;
const COOLDOWN_SERVER_ERR_MS = 4000;
const REQUEST_TIMEOUT_MS = 25000;
const TOTAL_SOLVE_GUARD_MS = 60000;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const answerCache = new Map();

function getKeyState(apiKey, model) {
  const id = `${model}__${apiKey}`;
  if (!keyStateMap.has(id)) {
    keyStateMap.set(id, {
      apiKey,
      model,
      lastUsedAt: 0,
      cooldownUntil: 0,
      failCount: 0
    });
  }
  return keyStateMap.get(id);
}

function parseRetryDelayMs(errMsg) {
  const txt = String(errMsg || "");
  const matchSec = txt.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  if (matchSec) {
    return Math.ceil(parseFloat(matchSec[1]) * 1000) + 1000;
  }
  if (/GenerateRequestsPerDay|PerDay|requests per day/i.test(txt)) {
    return 3600000;
  }
  return COOLDOWN_429_DEFAULT_MS;
}

function syncPersistedCooldown(id, cooldownUntil) {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  try {
    chrome.storage.local.get(["persistedModelCooldowns"], (res) => {
      const mapObj = res?.persistedModelCooldowns && typeof res.persistedModelCooldowns === "object"
        ? { ...res.persistedModelCooldowns }
        : {};
      const now = Date.now();
      for (const k of Object.keys(mapObj)) {
        if (!mapObj[k] || mapObj[k] <= now) delete mapObj[k];
      }
      if (cooldownUntil > now) {
        mapObj[id] = cooldownUntil;
      } else {
        delete mapObj[id];
      }
      chrome.storage.local.set({ persistedModelCooldowns: mapObj });
    });
  } catch (e) {}
}

function applyLoadedCooldowns(persistedObj) {
  if (!persistedObj || typeof persistedObj !== "object") return;
  const now = Date.now();
  for (const [id, until] of Object.entries(persistedObj)) {
    if (typeof until === "number" && until > now) {
      const sepIdx = id.indexOf("__");
      if (sepIdx > 0) {
        const model = id.slice(0, sepIdx);
        const key = id.slice(sepIdx + 2);
        const st = getKeyState(key, model);
        if (until > st.cooldownUntil) {
          st.cooldownUntil = until;
        }
      }
    }
  }
}

function markKeySuccess(apiKey, model) {
  const st = getKeyState(apiKey, model);
  st.lastUsedAt = Date.now();
  st.cooldownUntil = 0;
  st.failCount = 0;
  syncPersistedCooldown(`${model}__${apiKey}`, 0);
}

function isNonPenaltyParseError(errMsg) {
  const msg = String(errMsg || "");
  return (
    msg.includes("Không thể trích xuất đáp án") ||
    msg.includes("Chuỗi phản hồi rỗng") ||
    msg.includes("trả về rỗng") ||
    msg.includes("SyntaxError")
  );
}

function markKeyPenalty(apiKey, model, errMsg) {
  const msg = String(errMsg || "");
  // Không phạt cooldown model/key khi lỗi chỉ do parse chuỗi JSON
  if (isNonPenaltyParseError(msg)) {
    return;
  }

  const st = getKeyState(apiKey, model);
  const now = Date.now();
  st.lastUsedAt = now;
  st.failCount += 1;

  if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED")) {
    const waitDuration = parseRetryDelayMs(msg);
    st.cooldownUntil = now + waitDuration;
    if (waitDuration > 15000 || /PerDay|requests per day/i.test(msg)) {
      syncPersistedCooldown(`${model}__${apiKey}`, st.cooldownUntil);
    }
  } else if (msg.includes("TIMEOUT")) {
    st.cooldownUntil = now + COOLDOWN_TIMEOUT_MS;
  } else if (msg.includes("403") || msg.includes("API_KEY_INVALID")) {
    st.cooldownUntil = now + 600000;
    syncPersistedCooldown(`${model}__${apiKey}`, st.cooldownUntil);
  } else if (msg.includes("HTTP 404")) {
    st.cooldownUntil = now + 3600000;
    syncPersistedCooldown(`${model}__${apiKey}`, st.cooldownUntil);
  } else {
    st.cooldownUntil = now + COOLDOWN_SERVER_ERR_MS;
  }
}

function acquireBestKeyForModel(model, apiKeys) {
  const now = Date.now();
  let bestCandidate = null;
  let minWaitMs = Infinity;
  const totalKeys = apiKeys.length;
  if (totalKeys === 0) return null;

  for (let i = 0; i < totalKeys; i++) {
    const idx = (roundRobinCursor + i) % totalKeys;
    const key = apiKeys[idx];
    const st = getKeyState(key, model);

    const cooldownWait = Math.max(0, st.cooldownUntil - now);
    const intervalWait = Math.max(0, st.lastUsedAt + PER_KEY_MIN_INTERVAL_MS - now);
    const totalWait = Math.max(cooldownWait, intervalWait);

    if (totalWait === 0) {
      roundRobinCursor = (idx + 1) % totalKeys;
      st.lastUsedAt = now;
      return { apiKey: key, waitMs: 0, keyIndex: idx + 1 };
    }

    if (totalWait < minWaitMs) {
      minWaitMs = totalWait;
      bestCandidate = { apiKey: key, waitMs: totalWait, keyIndex: idx + 1 };
    }
  }

  roundRobinCursor = (roundRobinCursor + 1) % totalKeys;
  if (bestCandidate && bestCandidate.waitMs <= 12000) {
    const st = getKeyState(bestCandidate.apiKey, model);
    st.lastUsedAt = now + bestCandidate.waitMs;
  }
  return bestCandidate;
}

async function getSolverConfig() {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    try {
      const data = await chrome.storage.local.get([
        "customApiKeys",
        "intelligenceMode",
        "persistedModelCooldowns"
      ]);
      applyLoadedCooldowns(data.persistedModelCooldowns);
      const customRaw = Array.isArray(data.customApiKeys)
        ? data.customApiKeys
        : String(data.customApiKeys || "").split(/[\r\n,;]+/);
      const merged = Array.from(
        new Set([...customRaw, ...DEFAULT_API_KEYS].map((k) => String(k || "").trim()).filter(Boolean))
      );
      const mode = ["fast", "smart", "ultra"].includes(data.intelligenceMode)
        ? data.intelligenceMode
        : "smart";
      return { apiKeys: merged, mode };
    } catch (e) {}
  }
  return { apiKeys: DEFAULT_API_KEYS.slice(), mode: "smart" };
}

function setBadge(txt, color = "#16a34a") {
  if (typeof chrome === "undefined" || !chrome.action) return;
  try {
    chrome.action.setBadgeText({ text: String(txt).slice(0, 4) });
    chrome.action.setBadgeBackgroundColor({ color });
  } catch (e) {}
}

function forwardFullLogToTabConsole(tab, level, title, detailObj) {
  if (typeof chrome === "undefined" || !chrome.tabs || !tab || !tab.id) return;
  try {
    chrome.tabs.sendMessage(tab.id, {
      action: "SOLVER_DEBUG_LOG",
      level,
      title,
      timestamp: new Date().toLocaleTimeString("vi-VN"),
      detail: detailObj
    }).catch(() => {});
  } catch (e) {}
}

function updateSolverStatus(payload) {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  try {
    chrome.storage.local.set(payload);
  } catch (e) {}
}

async function captureScreenIfActive(tab) {
  if (typeof chrome === "undefined" || !chrome.tabs?.captureVisibleTab) return null;
  if (!tab || !tab.active) return null;
  try {
    const winId = tab.windowId || chrome.windows.WINDOW_ID_CURRENT;
    const p = chrome.tabs.captureVisibleTab(winId, { format: "jpeg", quality: 92 });
    const url = await Promise.race([p, new Promise((r) => setTimeout(() => r(null), 2200))]);
    return url && url.includes(",") ? { mimeType: "image/jpeg", data: url.split(",")[1] } : null;
  } catch (e) {
    return null;
  }
}

// =========================================================================
// CHUẨN HÓA ĐÁP ÁN & PHÁT HIỆN XUNG ĐỘT NỘI BỘ
// =========================================================================
function normalizeShortAnswer(rawVal, answerKind) {
  const s = String(rawVal ?? "").trim();
  if (!s) return { text: "", kind: answerKind || "NUMBER" };

  const hasLetters = /[A-Za-zÀ-ỹ]/.test(s);
  const effectiveKind = answerKind === "TEXT" || (hasLetters && !/^-?\d+([.,]\d+)?\s*[a-zA-Z°/%]+$/.test(s))
    ? "TEXT"
    : "NUMBER";

  if (effectiveKind === "TEXT") {
    return {
      text: s.replace(/\s+/g, " ").trim(),
      kind: "TEXT"
    };
  }

  const numMatch = s.replace(/\s+/g, "").match(/-?\d+(?:[.,]\d+)?/);
  const cleanedNum = numMatch ? numMatch[0].replace(".", ",") : s.replace(/\s+/g, "").replace(".", ",");
  return {
    text: cleanedNum,
    kind: "NUMBER"
  };
}

function extractTFListFromEvaluations(evals) {
  if (!Array.isArray(evals) || evals.length < 4) return null;
  const order = ["a", "b", "c", "d"];
  const byLabel = new Map();
  evals.forEach((item, idx) => {
    const lbl = String(item?.label || order[idx] || "").trim().toLowerCase().replace(/[^a-d]/g, "");
    if (lbl && !byLabel.has(lbl) && typeof item?.isTrue === "boolean") {
      byLabel.set(lbl, item.isTrue);
    }
  });
  if (order.every((k) => byLabel.has(k))) {
    return order.map((k) => byLabel.get(k));
  }
  const seq = evals.slice(0, 4).map((e) => Boolean(e?.isTrue));
  return seq.length === 4 ? seq : null;
}

function normAns(type, obj) {
  if (!obj) return "";
  if (type === "MCQ") {
    const raw = (obj.mcqAnswer || obj.finalMcqAnswer || "").trim().toUpperCase();
    const m = raw.match(/[A-D]/);
    return m ? m[0] : "";
  }
  if (type === "SHORT_ANSWER") {
    const raw = obj.shortAnswer ?? obj.finalShortAnswer ?? "";
    return normalizeShortAnswer(raw, obj.answerKind).text;
  }
  if (type === "TRUE_FALSE") {
    const evalList = extractTFListFromEvaluations(obj.statementEvaluations || obj.statementVerdicts);
    const rawList = Array.isArray(obj.trueFalseList)
      ? obj.trueFalseList
      : Array.isArray(obj.finalTrueFalseList)
      ? obj.finalTrueFalseList
      : null;
    const chosen = evalList || (rawList && rawList.length >= 4 ? rawList.slice(0, 4).map(Boolean) : null);
    if (chosen) {
      return chosen.map((v) => (v ? "Đ" : "S")).join("-");
    }
  }
  return "";
}

function detectTFInternalConflict(obj) {
  const evalList = extractTFListFromEvaluations(obj?.statementEvaluations);
  const rawList = Array.isArray(obj?.trueFalseList) ? obj.trueFalseList.slice(0, 4).map(Boolean) : null;
  if (!evalList || !rawList || rawList.length < 4) return false;
  return evalList.some((v, idx) => v !== rawList[idx]);
}

function parseRobustGeminiOutput(rawText, questionType) {
  if (!rawText) throw new Error("Chuỗi phản hồi rỗng");
  let cleaned = String(rawText).trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {}

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const jsonCandidate = cleaned.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(jsonCandidate);
    } catch (e) {
      try {
        const fixed = jsonCandidate.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]");
        return JSON.parse(fixed);
      } catch (e2) {}
    }
  }

  const stepMatch = cleaned.match(/"(?:stepByStep|step|independentAnalysis)"\s*:\s*"([\s\S]*?)(?:"\s*,\s*"|$)/i);
  const extractedStep = stepMatch ? stepMatch[1].replace(/\\n/g, " ").trim() : "";

  if (questionType === "MCQ") {
    const mKey =
      cleaned.match(/"(?:finalMcqAnswer|mcqAnswer)"\s*:\s*"([A-D])"/i) ||
      cleaned.match(/"(?:finalMcqAnswer|mcqAnswer)"\s*:\s*"?([A-D])/i);
    if (mKey) return { step: extractedStep, mcqAnswer: mKey[1].toUpperCase(), confidence: 70 };
    const mStandalone = cleaned.match(/\b([A-D])\b\s*$/);
    if (mStandalone) return { step: extractedStep, mcqAnswer: mStandalone[1].toUpperCase(), confidence: 60 };
  } else if (questionType === "SHORT_ANSWER") {
    const mShort = cleaned.match(/"(?:finalShortAnswer|shortAnswer)"\s*:\s*"([^"]*)"/i);
    if (mShort) return { step: extractedStep, shortAnswer: mShort[1].trim(), confidence: 70 };
    const mNum = cleaned.match(/-?\d+(?:[.,]\d+)?/g);
    if (mNum && mNum.length > 0) return { step: extractedStep, shortAnswer: mNum[mNum.length - 1], confidence: 60 };
  } else if (questionType === "TRUE_FALSE") {
    const mBool = cleaned.match(/\b(true|false)\b/gi);
    if (mBool && mBool.length >= 4) {
      return {
        step: extractedStep,
        trueFalseList: mBool.slice(-4).map((v) => v.toLowerCase() === "true"),
        confidence: 70
      };
    }
  }

  throw new Error(`Không thể trích xuất đáp án từ chuỗi: ${cleaned.slice(0, 180)}`);
}

// =========================================================================
// CACHE KEY CHỐNG TRÙNG LẶP ĐỒ THỊ & ĐOẠN VĂN
// =========================================================================
function buildCacheKey(quizData, mode) {
  const parts = [
    mode || "smart",
    quizData.questionType || "",
    quizData.qCode || "",
    (quizData.contextPassage || "").slice(0, 220).trim(),
    (quizData.rawScreenText || "").trim(),
    (quizData.extraDetails || "").trim(),
    (quizData.visualSignature || "").trim()
  ];
  return parts.join("::");
}

function normalizeRejectedList(quizData) {
  const list = [];
  if (Array.isArray(quizData.rejectedAnswers)) {
    list.push(...quizData.rejectedAnswers);
  }
  if (quizData.rejectedAnswer) {
    list.push(quizData.rejectedAnswer);
  }
  return Array.from(new Set(list.map((x) => String(x || "").trim()).filter(Boolean)));
}

// =========================================================================
// PROMPT CHUYÊN GIA GDPT 2018 & SCHEMA GỌN CHỐNG CỤT JSON
// =========================================================================
const EXPERT_SYSTEM_INSTRUCTION = `Bạn là Hội đồng chuyên gia giải đề thi THPT Quốc gia Việt Nam theo chương trình GDPT 2018 (Toán, Vật lí, Hóa học, Sinh học, Tin học, Tiếng Anh, Ngữ văn, Lịch sử, Địa lí, GDKT&PL).
NGUYÊN TẮC TỐI THƯỢNG:
1. Nếu có hình ảnh đính kèm: ĐỌC VÀ ĐỐI CHIẾU TRỰC TIẾP SỐ LIỆU, ĐỒ THỊ, BẢNG BIẾN THIÊN, DẤU GẠCH CHÂN, SỐ MŨ TỪ HÌNH ẢNH. Nếu văn bản DOM và hình ảnh khác nhau ở công thức/ký hiệu, ưu tiên HÌNH ẢNH.
2. Thực hiện toàn bộ bước nháp dài, xét cực tính ĐÚNG hay KHÔNG ĐÚNG / SAI / NGOẠI TRỪ / CLOSEST / OPPOSITE, phiên âm IPA/trọng âm cả 4 đáp án, đổi đơn vị SI và tự kiểm tra bẫy bên trong phần suy nghĩ nội tâm (thought); còn trường JSON 'step' CHỈ ghi tóm tắt cốt lõi ngắn gọn (tối đa 3-4 câu / ~90 từ).
3. QUY TẮC CHỐNG BẪY MÔN HỌC:
   - Toán: Kiểm tra ĐKXĐ, tích vô hướng vectơ phải đưa về CÙNG ĐIỂM ĐẦU (vec(AB).vec(BC) = -AB.BC.cosB), bảng biến thiên & mẫu ghép nhóm SGK 2018; hypebol (H): trục thực 2a, tiêu cự 2c, |MF1 - MF2| = 2a.
   - Vật lí 2018: Phân biệt ĐỘ DỊCH CHUYỂN d (có dấu/hướng) với QUÃNG ĐƯỜNG s (>=0); VẬN TỐC TRUNG BÌNH v = d/t với TỐC ĐỘ TRUNG BÌNH s/t; đổi chuẩn đơn vị SI (km/h -> m/s, cm -> m, ms -> s, g -> kg).
   - Hóa học 2018: Danh pháp IUPAC mới, cấu hình e đặc biệt (Cr Z=24: [Ar]3d^5 4s^1, Cu Z=29: [Ar]3d^10 4s^1), bảo toàn e, hiệu suất H%, điều kiện chuẩn 25°C 1 bar (24,79 L/mol).
   - Tin học 2018: 1 KB = 1024 B (> 1000 B), phân biệt 2^10 với 210, Python range(a, b) dừng ở b - 1.
   - Tiếng Anh: Với thẻ [GẠCH_CHÂN: ...], phiên âm IPA / trọng âm cho CẢ 4 ĐÁP ÁN A, B, C, D trong phần thought trước khi chọn; với Đọc hiểu, đối chiếu dẫn chứng trong Đoạn văn ngữ cảnh.
4. TRẢ LỜI NGẮN (SHORT_ANSWER): Phân biệt ĐIỀN SỐ (answerKind="NUMBER", dùng dấu phẩy ',' cho số thập phân, không ghi đơn vị, làm tròn đúng yêu cầu hoặc vừa tối đa 4 ký tự gồm cả '-' và ',') với ĐIỀN TỪ/CỤM TỪ (answerKind="TEXT", giữ nguyên khoảng trắng).`;

function buildQuestionTextBlock(q, rejectedList) {
  const blocks = [];
  if (rejectedList.length > 0) {
    blocks.push(
      `[CẢNH BÁO BẮT BUỘC TRÁNH ĐÁP ÁN SAI]: Các đáp án sau ĐÃ SAI ở lần thử trước: ${rejectedList.map((r) => `"${r}"`).join(", ")}. Hãy giải lại từ đầu và TUYỆT ĐỐI KHÔNG chọn lại các đáp án này.`
    );
  }
  if (q.contextPassage && q.contextPassage.trim()) {
    blocks.push(`--- ĐOẠN VĂN / NGỮ CẢNH CHUNG ---\n${q.contextPassage.trim()}`);
  }
  blocks.push(`--- NỘI DUNG CÂU HỎI ---\n${q.rawScreenText || "(Xem trong ảnh đính kèm)"}`);
  if (q.extraDetails && q.extraDetails.trim()) {
    blocks.push(q.extraDetails.trim());
  }
  return blocks.join("\n\n");
}

function getPass1PromptAndSchema(q, rejectedList) {
  const qBlock = buildQuestionTextBlock(q, rejectedList);

  if (q.questionType === "SHORT_ANSWER") {
    return {
      prompt: `Giải câu hỏi TRẢ LỜI NGẮN sau (nháp kỹ trong thought, chỉ tóm tắt ngắn 2-3 câu vào "step"):
- "subject": tên môn học.
- "step": công thức, phép tính chính, đơn vị và kiểm tra bẫy/làm tròn (tối đa 90 từ).
- "answerKind": "NUMBER" nếu là số, "TEXT" nếu là từ/cụm từ.
- "shortAnswer": CHỈ ghi duy nhất kết quả cuối cùng (số dùng dấu ',', không đơn vị; chữ giữ nguyên khoảng trắng).
- "confidence": độ tin cậy (0-100).

${qBlock}`,
      schema: {
        type: "OBJECT",
        properties: {
          subject: { type: "STRING" },
          step: { type: "STRING" },
          answerKind: { type: "STRING", enum: ["NUMBER", "TEXT"] },
          shortAnswer: { type: "STRING" },
          confidence: { type: "INTEGER" }
        },
        required: ["subject", "step", "answerKind", "shortAnswer", "confidence"]
      }
    };
  }

  if (q.questionType === "TRUE_FALSE") {
    return {
      prompt: `Giải câu hỏi ĐÚNG / SAI gồm 4 mệnh đề a, b, c, d sau (tính & soi bẫy từng ý trong thought, tóm tắt gọn vào "step"):
- "subject": tên môn học.
- "step": nêu ngắn gọn lý do Đúng/Sai của từng ý a, b, c, d (tối đa 90 từ).
- "trueFalseList": mảng ĐÚNG 4 giá trị boolean [ý a, ý b, ý c, ý d].
- "confidence": độ tin cậy (0-100).

${qBlock}`,
      schema: {
        type: "OBJECT",
        properties: {
          subject: { type: "STRING" },
          step: { type: "STRING" },
          trueFalseList: { type: "ARRAY", items: { type: "BOOLEAN" } },
          confidence: { type: "INTEGER" }
        },
        required: ["subject", "step", "trueFalseList", "confidence"]
      }
    };
  }

  // MCQ
  return {
    prompt: `Giải câu hỏi TRẮC NGHIỆM 4 lựa chọn A, B, C, D sau (kiểm tra cực tính ĐÚNG/SAI, CLOSEST/OPPOSITE và xét cả 4 đáp án trong thought, tóm tắt gọn vào "step"):
- "subject": tên môn học.
- "step": tóm tắt ngắn gọn lập luận/phép tính và lý do loại trừ (tối đa 90 từ).
- "mcqAnswer": chữ cái đúng nhất ("A", "B", "C" hoặc "D").
- "confidence": độ tin cậy (0-100).

${qBlock}`,
    schema: {
      type: "OBJECT",
      properties: {
        subject: { type: "STRING" },
        step: { type: "STRING" },
        mcqAnswer: { type: "STRING", enum: ["A", "B", "C", "D"] },
        confidence: { type: "INTEGER" }
      },
      required: ["subject", "step", "mcqAnswer", "confidence"]
    }
  };
}

function getAuditorPromptAndSchema(q, pass1Res, rejectedList) {
  const qBlock = buildQuestionTextBlock(q, rejectedList);
  const proposal = `--- ĐÁP ÁN ĐỀ XUẤT CẦN THẨM ĐỊNH ---
Đáp án đề xuất: ${pass1Res.normalizedAns}
Tóm tắt cũ: ${pass1Res.step || ""}`;

  const auditGuide = `Bạn là GIÁM KHẢO PHẢN BIỆN ĐỘC LẬP. Hãy tự giải lại trong phần thought và soi 5 nhóm bẫy:
1. Ngược yêu cầu ĐÚNG vs SAI/KHÔNG/NGOẠI TRỪ, CLOSEST vs OPPOSITE.
2. Lỗi dấu, góc vectơ (vec(AB).vec(BC) = -AB.BC.cosB), thiếu ĐKXĐ, độ dịch chuyển vs quãng đường.
3. Đổi đơn vị SI, làm tròn, 1 KB = 1024 B, range().
4. Phát âm IPA / trọng âm [GẠCH_CHÂN: ...] và bằng chứng đọc hiểu.
5. Lỗi nhầm thứ tự 4 ý a, b, c, d trong câu Đúng/Sai.
Nếu đúng hoàn toàn -> verdict="CONFIRM"; nếu phát hiện sai hoặc vi phạm danh sách bị loại -> verdict="CORRECT" và sửa lại đáp án chuẩn xác. Viết 'step' và 'auditNote' ngắn gọn (tối đa 80 từ).`;

  if (q.questionType === "SHORT_ANSWER") {
    return {
      prompt: `${auditGuide}\n\n${qBlock}\n\n${proposal}`,
      schema: {
        type: "OBJECT",
        properties: {
          step: { type: "STRING" },
          verdict: { type: "STRING", enum: ["CONFIRM", "CORRECT"] },
          answerKind: { type: "STRING", enum: ["NUMBER", "TEXT"] },
          auditNote: { type: "STRING" },
          finalShortAnswer: { type: "STRING" },
          finalConfidence: { type: "INTEGER" }
        },
        required: ["step", "verdict", "answerKind", "auditNote", "finalShortAnswer", "finalConfidence"]
      }
    };
  }

  if (q.questionType === "TRUE_FALSE") {
    return {
      prompt: `${auditGuide}\n\n${qBlock}\n\n${proposal}`,
      schema: {
        type: "OBJECT",
        properties: {
          step: { type: "STRING" },
          verdict: { type: "STRING", enum: ["CONFIRM", "CORRECT"] },
          auditNote: { type: "STRING" },
          finalTrueFalseList: { type: "ARRAY", items: { type: "BOOLEAN" } },
          finalConfidence: { type: "INTEGER" }
        },
        required: ["step", "verdict", "auditNote", "finalTrueFalseList", "finalConfidence"]
      }
    };
  }

  return {
    prompt: `${auditGuide}\n\n${qBlock}\n\n${proposal}`,
    schema: {
      type: "OBJECT",
      properties: {
        step: { type: "STRING" },
        verdict: { type: "STRING", enum: ["CONFIRM", "CORRECT"] },
        auditNote: { type: "STRING" },
        finalMcqAnswer: { type: "STRING", enum: ["A", "B", "C", "D"] },
        finalConfidence: { type: "INTEGER" }
      },
      required: ["step", "verdict", "auditNote", "finalMcqAnswer", "finalConfidence"]
    }
  };
}

// =========================================================================
// GỌI GEMINI API VỚI THINKING BUDGET CÓ TRẦN + LƯỚI CỨU HỘ MAX_TOKENS
// =========================================================================
async function executeGeminiRequest({
  model,
  apiKey,
  systemText,
  prompt,
  schema,
  imgObj,
  temperature,
  thinkingBudget,
  timeoutMs
}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const runOnce = async (reqPrompt, thinkingConfig, maxOutputTokens) => {
    const parts = [{ text: reqPrompt }];
    if (imgObj && imgObj.data) {
      parts.unshift({ inlineData: { mimeType: imgObj.mimeType, data: imgObj.data } });
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort("TIMEOUT_REQ"), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemText }] },
          contents: [{ parts }],
          generationConfig: {
            temperature,
            maxOutputTokens,
            thinkingConfig,
            responseMimeType: "application/json",
            responseSchema: schema
          }
        })
      });
      if (!res.ok) {
        const errTxt = await res.text();
        throw new Error(`HTTP ${res.status} (${model}): ${errTxt}`);
      }
      const data = await res.json();
      const finishReason = data?.candidates?.[0]?.finishReason || "";
      const candidateParts = data?.candidates?.[0]?.content?.parts || [];
      const nonThoughtParts = candidateParts.filter((p) => !p.thought && typeof p.text === "string");
      const combinedText = (nonThoughtParts.length > 0 ? nonThoughtParts : candidateParts)
        .map((p) => p.text || "")
        .join("\n")
        .trim();
      return { combinedText, finishReason };
    } catch (err) {
      if (err.name === "AbortError" || String(err).includes("TIMEOUT_REQ")) {
        throw new Error(`TIMEOUT_${Math.round(timeoutMs / 1000)}S trên model ${model}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  let resp;
  try {
    resp = await runOnce(prompt, { thinkingBudget }, 16384);
  } catch (err) {
    const msg = String(err?.message || "");
    if (msg.includes("HTTP 400") && /thinkingBudget|thinkingConfig/i.test(msg)) {
      resp = await runOnce(prompt, { thinkingLevel: thinkingBudget >= 2048 ? "MEDIUM" : "LOW" }, 16384);
    } else {
      throw err;
    }
  }

  let { combinedText, finishReason } = resp;
  const looksTruncated = finishReason === "MAX_TOKENS" || (combinedText && !combinedText.endsWith("}"));

  // Lưới an toàn chống cụt JSON: nếu bị MAX_TOKENS, gọi lại ngay 1 lần với budget gọn 512 để chốt đáp án
  if (!combinedText || looksTruncated) {
    const emergencyPrompt = `${prompt}\n\n[KHẨN CẤP]: Viết 'step' tối đa 20 từ và xuất đủ JSON đáp án hoàn chỉnh ngay lập tức!`;
    try {
      const retryResp = await runOnce(emergencyPrompt, { thinkingBudget: 512 }, 4096);
      if (retryResp.combinedText) {
        combinedText = retryResp.combinedText;
      }
    } catch (e) {
      // Nếu emergency retry lỗi vẫn trả combinedText cũ để parser thử cứu nếu có thể
    }
  }

  if (!combinedText) throw new Error(`API (${model}) trả về rỗng`);
  return combinedText;
}

async function callWithRotation({
  modelList,
  apiKeys,
  systemText,
  prompt,
  schema,
  imgObj,
  temperature,
  thinkingBudget,
  questionType,
  tab,
  passLabel
}) {
  let lastErr = null;
  for (const model of modelList) {
    for (let attempt = 0; attempt < apiKeys.length; attempt++) {
      const slot = acquireBestKeyForModel(model, apiKeys);
      if (!slot) break;
      const { apiKey, waitMs, keyIndex } = slot;
      const maskedKey = `Key#${keyIndex}(${apiKey.slice(0, 5)}...${apiKey.slice(-4)})`;

      if (waitMs > 12000) {
        break;
      }
      if (waitMs > 0) {
        updateSolverStatus({
          solverStatus: `⏳ [${passLabel}] Điều phối ${maskedKey} (chờ ${(waitMs / 1000).toFixed(1)}s)...`
        });
        await delay(waitMs);
      }

      try {
        const rawText = await executeGeminiRequest({
          model,
          apiKey,
          systemText,
          prompt,
          schema,
          imgObj,
          temperature,
          thinkingBudget,
          timeoutMs: REQUEST_TIMEOUT_MS
        });
        const parsed = parseRobustGeminiOutput(rawText, questionType);
        markKeySuccess(apiKey, model);
        return { parsed, modelUsed: model, maskedKey };
      } catch (err) {
        lastErr = err;
        const msg = String(err.message || "");
        markKeyPenalty(apiKey, model, msg);
        forwardFullLogToTabConsole(tab, "warn", `[${passLabel}] Lỗi trên ${model} (${maskedKey}), chuyển kế tiếp`, {
          model,
          keyUsed: maskedKey,
          fullError: msg
        });
        if (msg.includes("HTTP 404") || msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED")) break;
      }
    }
  }
  throw lastErr || new Error("Tất cả Model và API Key đều đang bận hoặc hết hạn mức");
}

function shouldRunAuditorPass(mode, quizData, pass1Result, rejectedList) {
  if (mode === "fast") return false;
  if (quizData.isManualRetry) return true;
  if (pass1Result.hasInternalConflict) return true;
  if (rejectedList.includes(pass1Result.normalizedAns)) return true;

  if (mode === "ultra") {
    if (quizData.questionType === "TRUE_FALSE" || quizData.questionType === "SHORT_ANSWER") return true;
    const text = `${quizData.rawScreenText || ""} ${quizData.extraDetails || ""}`;
    const hasReasoningCue =
      quizData.hasVisuals ||
      !!quizData.contextPassage ||
      /(\$|\[GẠCH_CHÂN:|\[HÌNH_|\d|KHÔNG|SAI|NGOẠI TRỪ|CLOSEST|OPPOSITE|NHẤT|TÍNH|GIÁ TRỊ)/i.test(text);
    if (hasReasoningCue || pass1Result.confidence < 98) return true;
  }

  // Chế độ smart: tiết kiệm quota, chỉ kích hoạt lớp 2 khi độ tin cậy < 78%
  return pass1Result.confidence < 78;
}

function formatPass1Result(parsed, questionType, modelUsed) {
  const normalizedAns = normAns(questionType, parsed);
  const stepText = (parsed.step || parsed.stepByStep || "").trim();
  const hasInternalConflict = questionType === "TRUE_FALSE" ? detectTFInternalConflict(parsed) : false;
  const conf = Number.isFinite(Number(parsed.confidence)) ? Math.max(0, Math.min(100, Number(parsed.confidence))) : 88;
  const answerKind =
    questionType === "SHORT_ANSWER" ? normalizeShortAnswer(parsed.shortAnswer, parsed.answerKind).kind : undefined;

  return {
    normalizedAns,
    answerKind,
    subject: parsed.subject || "Tổng hợp",
    polarityCheck: parsed.polarityCheck || "",
    step: stepText,
    selfCheck: parsed.selfCheck || "",
    confidence: conf,
    needsSecondOpinion: Boolean(parsed.needsSecondOpinion),
    hasInternalConflict,
    verifiedTwoPass: false,
    auditNote: "",
    modelUsed
  };
}

async function handleSolve(quizData, tab, cacheKey, overrideConfig = null) {
  const { apiKeys, mode: configMode } = overrideConfig || (await getSolverConfig());
  const mode = quizData.intelligenceMode || configMode || "smart";

  if (!apiKeys || apiKeys.length === 0) {
    throw new Error("Chưa cấu hình API Key nào!");
  }

  const shouldCapture =
    mode !== "fast"
      ? true
      : Boolean(quizData.hasVisuals || quizData.isManualRetry || (quizData.rawScreenText || "").length < 40);
  const imgObj = shouldCapture ? await captureScreenIfActive(tab) : null;
  const rejectedList = normalizeRejectedList(quizData);
  const pass1Budget = mode === "fast" ? 1024 : 3072;

  // LỚP 1: DEEP REASONING SOLVER
  const pass1Spec = getPass1PromptAndSchema(quizData, rejectedList);
  const { parsed: pass1Parsed, modelUsed: model1, maskedKey: key1 } = await callWithRotation({
    modelList: PRIMARY_MODELS,
    apiKeys,
    systemText: EXPERT_SYSTEM_INSTRUCTION,
    prompt: pass1Spec.prompt,
    schema: pass1Spec.schema,
    imgObj,
    temperature: 0.0,
    thinkingBudget: pass1Budget,
    questionType: quizData.questionType,
    tab,
    passLabel: "Lớp 1"
  });

  const finalRes = formatPass1Result(pass1Parsed, quizData.questionType, model1);
  if (!finalRes.normalizedAns) {
    throw new Error("Không trích xuất được đáp án hợp lệ ở Lớp 1");
  }

  // LỚP 2: KIỂM CHỨNG ĐỘC LẬP (ADVERSARIAL AUDITOR)
  if (shouldRunAuditorPass(mode, quizData, finalRes, rejectedList)) {
    updateSolverStatus({ solverStatus: `🔬 Đang kiểm chứng Lớp 2 (${finalRes.subject})...` });
    try {
      const pass2Spec = getAuditorPromptAndSchema(quizData, finalRes, rejectedList);
      const { parsed: pass2Parsed, modelUsed: model2 } = await callWithRotation({
        modelList: AUDITOR_MODELS,
        apiKeys,
        systemText:
          "Bạn là Giám khảo phản biện độc lập bậc cao (GDPT 2018). Hãy soi kỹ mọi bẫy câu hỏi trong thought rồi xác nhận hoặc sửa đáp án ngắn gọn.",
        prompt: pass2Spec.prompt,
        schema: pass2Spec.schema,
        imgObj,
        temperature: 0.1,
        thinkingBudget: 3072,
        questionType: quizData.questionType,
        tab,
        passLabel: "Kiểm chứng Lớp 2"
      });

      const auditAns = normAns(quizData.questionType, pass2Parsed);
      finalRes.verifiedTwoPass = true;
      finalRes.auditNote = pass2Parsed.auditNote || "";
      if (Number.isFinite(Number(pass2Parsed.finalConfidence))) {
        finalRes.confidence = Math.max(0, Math.min(100, Number(pass2Parsed.finalConfidence)));
      }

      const prevAns = finalRes.normalizedAns;
      const shouldOverride =
        auditAns &&
        !rejectedList.includes(auditAns) &&
        ((pass2Parsed.verdict === "CORRECT" && auditAns !== prevAns) ||
          (rejectedList.includes(prevAns) && auditAns !== prevAns));

      if (shouldOverride) {
        finalRes.normalizedAns = auditAns;
        if (quizData.questionType === "SHORT_ANSWER") {
          finalRes.answerKind = normalizeShortAnswer(pass2Parsed.finalShortAnswer, pass2Parsed.answerKind).kind;
        }
        finalRes.step = `[Phản biện Lớp 2 đã sửa từ "${prevAns}" -> "${auditAns}"]\n${
          pass2Parsed.step || finalRes.step
        }`;
        finalRes.modelUsed = `${model1} -> ${model2}`;
      }
    } catch (auditErr) {
      forwardFullLogToTabConsole(tab, "warn", "Kiểm chứng Lớp 2 bỏ qua do lỗi tạm thời", {
        error: String(auditErr?.message || auditErr)
      });
    }
  }

  if (cacheKey) {
    answerCache.set(cacheKey, finalRes);
  }

  forwardFullLogToTabConsole(
    tab,
    "info",
    `Giải thành công [${finalRes.modelUsed}] (${key1}) -> ${finalRes.normalizedAns} (${finalRes.confidence}%${
      finalRes.verifiedTwoPass ? ", 2-Pass" : ""
    })`,
    {
      subject: finalRes.subject,
      step: finalRes.step,
      auditNote: finalRes.auditNote,
      answer: finalRes.normalizedAns
    }
  );

  return finalRes;
}

// =========================================================================
// CHROME EXTENSION LIFECYCLE & MESSAGE LISTENERS
// =========================================================================
if (typeof chrome !== "undefined" && chrome.runtime) {
  chrome.runtime.onInstalled.addListener(async () => {
    try {
      const tabs = await chrome.tabs.query({ url: ["https://app.onluyen.vn/*", "https://*.onluyen.vn/*"] });
      for (const t of tabs) {
        if (t.id) {
          chrome.scripting
            .executeScript({ target: { tabId: t.id }, files: ["dom_extractor.js", "content.js"] })
            .catch(() => {});
        }
      }
    } catch (e) {}
  });

  if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.autoSolverEnabled) {
        const enabled = changes.autoSolverEnabled.newValue;
        setBadge(enabled ? "ON" : "OFF", enabled ? "#2563eb" : "#64748b");
      }
    });
  }

  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (!req || req.action !== "SOLVE_QUIZ") return false;

    let done = false;
    const reply = (payload) => {
      if (!done) {
        done = true;
        try {
          sendResponse(payload);
        } catch (e) {}
      }
    };

    (async () => {
      const config = await getSolverConfig();
      const isForceRetry = Boolean(req.data?.isManualRetry);
      const cacheKey = buildCacheKey(req.data || {}, config.mode);

      if (isForceRetry) {
        answerCache.delete(cacheKey);
      } else if (answerCache.has(cacheKey)) {
        const cachedRes = answerCache.get(cacheKey);
        setBadge(cachedRes.normalizedAns || "OK", "#16a34a");
        reply({ success: true, result: cachedRes });
        return;
      }

      setBadge(isForceRetry ? "FIX" : "...", isForceRetry ? "#d97706" : "#2563eb");

      const guard = setTimeout(() => {
        setBadge("TIME", "#dc2626");
        const timeoutErr = "Quá thời gian phản hồi tổng (60s)";
        forwardFullLogToTabConsole(sender.tab, "warn", "Timeout tổng 60s", {
          questionType: req.data?.questionType
        });
        reply({ success: false, error: timeoutErr });
      }, TOTAL_SOLVE_GUARD_MS);

      try {
        const res = await handleSolve(req.data, sender.tab, cacheKey, config);
        clearTimeout(guard);
        setBadge(res.normalizedAns || "OK", isForceRetry ? "#d97706" : "#16a34a");
        reply({ success: true, result: res });
      } catch (err) {
        clearTimeout(guard);
        const fullMsg = err?.message || "Lỗi API không xác định";
        setBadge("ERR", "#dc2626");
        updateSolverStatus({ solverStatus: `⚠️ Lỗi: ${fullMsg.slice(0, 220)}` });
        forwardFullLogToTabConsole(sender.tab, "error", "Tất cả Model/API Key đều thất bại", {
          fullErrorMessage: fullMsg
        });
        reply({ success: false, error: fullMsg });
      }
    })();

    return true;
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DEFAULT_API_KEYS,
    MODELS,
    PRIMARY_MODELS,
    AUDITOR_MODELS,
    normAns,
    normalizeShortAnswer,
    extractTFListFromEvaluations,
    detectTFInternalConflict,
    parseRobustGeminiOutput,
    buildCacheKey,
    normalizeRejectedList,
    shouldRunAuditorPass,
    handleSolve
  };
}
