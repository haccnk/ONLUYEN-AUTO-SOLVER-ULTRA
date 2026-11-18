const toggleBtn = document.getElementById("toggleBtn");
const forceScanBtn = document.getElementById("forceScanBtn");
const modeSelect = document.getElementById("modeSelect");
const autoAdvanceChk = document.getElementById("autoAdvanceChk");
const statusText = document.getElementById("statusText");
const lastAnswerText = document.getElementById("lastAnswerText");
const metaBadges = document.getElementById("metaBadges");
const reasoningBox = document.getElementById("reasoningBox");
const countText = document.getElementById("countText");
const retryQNumInput = document.getElementById("retryQNumInput");
const retrySpecificBtn = document.getElementById("retrySpecificBtn");
const exportTxtBtn = document.getElementById("exportTxtBtn");
const exportDetailBtn = document.getElementById("exportDetailBtn");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");
const customKeysInput = document.getElementById("customKeysInput");
const saveKeysBtn = document.getElementById("saveKeysBtn");
const keySavedNote = document.getElementById("keySavedNote");

function renderMeta(meta) {
  if (!meta || (!meta.step && !meta.subject)) {
    metaBadges.style.display = "none";
    reasoningBox.style.display = "none";
    return;
  }

  metaBadges.innerHTML = "";
  metaBadges.style.display = "flex";

  if (meta.subject) {
    const bSub = document.createElement("span");
    bSub.className = "badge subject";
    bSub.textContent = meta.subject;
    metaBadges.appendChild(bSub);
  }

  if (typeof meta.confidence === "number") {
    const bConf = document.createElement("span");
    bConf.className = `badge ${meta.confidence >= 85 ? "conf-high" : "conf-mid"}`;
    bConf.textContent = `Tin cậy ${meta.confidence}%`;
    metaBadges.appendChild(bConf);
  }

  if (meta.verifiedTwoPass) {
    const bVer = document.createElement("span");
    bVer.className = "badge verified";
    bVer.textContent = "✔ Kiểm chứng 2 lớp";
    metaBadges.appendChild(bVer);
  }

  const lines = [];
  if (meta.step) lines.push(`📌 Lời giải: ${meta.step}`);
  if (meta.selfCheck) lines.push(`🔍 Tự soát bẫy: ${meta.selfCheck}`);
  if (meta.auditNote) lines.push(`🔬 Phản biện: ${meta.auditNote}`);

  if (lines.length > 0) {
    reasoningBox.textContent = lines.join("\n\n");
    reasoningBox.style.display = "block";
  } else {
    reasoningBox.style.display = "none";
  }
}

function renderUI(data) {
  const isEnabled = data.autoSolverEnabled !== false;
  toggleBtn.textContent = isEnabled ? "ĐANG BẬT" : "ĐANG TẮT";
  toggleBtn.className = isEnabled ? "toggle-btn on" : "toggle-btn off";

  modeSelect.value = ["fast", "smart", "ultra"].includes(data.intelligenceMode)
    ? data.intelligenceMode
    : "smart";

  autoAdvanceChk.checked = data.autoAdvanceEnabled !== false;

  statusText.textContent = isEnabled
    ? data.solverStatus || "Đang chờ câu hỏi..."
    : "Đã tạm dừng";

  lastAnswerText.textContent = data.lastSolvedAnswer || "Chưa có dữ liệu";
  renderMeta(data.lastSolvedMeta);

  const history = Array.isArray(data.quizExportHistory) ? data.quizExportHistory : [];
  countText.textContent = `${history.length} câu`;

  if (document.activeElement !== customKeysInput && data.customApiKeys) {
    const keysArr = Array.isArray(data.customApiKeys)
      ? data.customApiKeys
      : String(data.customApiKeys).split(/[\r\n,;]+/);
    customKeysInput.value = keysArr.filter(Boolean).join("\n");
  }
}

function loadState() {
  chrome.storage.local.get(
    [
      "autoSolverEnabled",
      "intelligenceMode",
      "autoAdvanceEnabled",
      "solverStatus",
      "lastSolvedAnswer",
      "lastSolvedMeta",
      "quizExportHistory",
      "customApiKeys"
    ],
    renderUI
  );
}

async function ensureContentScriptReady() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return null;
    if (!/onluyen\.vn/i.test(tab.url || "")) return tab;

    const pingOk = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { action: "PING" }, (resp) => {
        if (chrome.runtime.lastError || !resp?.ok) resolve(false);
        else resolve(true);
      });
    });

    if (!pingOk) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["dom_extractor.js", "content.js"]
      });
    }
    return tab;
  } catch (e) {
    return null;
  }
}

loadState();
chrome.storage.onChanged.addListener(loadState);
ensureContentScriptReady();

toggleBtn.addEventListener("click", () => {
  chrome.storage.local.get(["autoSolverEnabled"], async (res) => {
    const nextState = res.autoSolverEnabled === false;
    await chrome.storage.local.set({
      autoSolverEnabled: nextState,
      solverStatus: nextState ? "Đã BẬT! Đang quét đề..." : "Đã TẮT"
    });
    if (nextState) {
      const tab = await ensureContentScriptReady();
      if (tab && tab.id && /onluyen\.vn/i.test(tab.url || "")) {
        chrome.tabs.sendMessage(tab.id, { action: "FORCE_SCAN_NOW" }, () => {
          void chrome.runtime.lastError;
        });
      }
    }
  });
});

forceScanBtn.addEventListener("click", async () => {
  statusText.textContent = "🔍 Đang kiểm tra & quét lại đề...";
  const tab = await ensureContentScriptReady();
  if (!tab || !tab.id) {
    statusText.textContent = "⚠️ Không tìm thấy tab đang mở!";
    return;
  }
  if (!/onluyen\.vn/i.test(tab.url || "")) {
    statusText.textContent = "⚠️ Hãy chuyển sang tab bài thi onluyen.vn!";
    return;
  }
  chrome.tabs.sendMessage(tab.id, { action: "FORCE_SCAN_NOW" }, (resp) => {
    if (chrome.runtime.lastError || !resp?.ok) {
      statusText.textContent = "⚠️ Chưa kết nối được trang, hãy thử F5 1 lần!";
      return;
    }
    const d = resp.diag || {};
    if (d.reason === "not_quiz_page") {
      statusText.textContent = "ℹ️ Tab này chưa vào giao diện làm bài thi.";
    } else if (d.reason === "no_question_detected") {
      statusText.textContent = "⚠️ Đã quét nhưng chưa thấy câu hỏi trên DOM!";
    }
  });
});

modeSelect.addEventListener("change", () => {
  const mode = modeSelect.value;
  chrome.storage.local.set({
    intelligenceMode: mode,
    solverStatus: `Đã chuyển sang chế độ: ${mode.toUpperCase()}`
  });
});

autoAdvanceChk.addEventListener("change", () => {
  chrome.storage.local.set({
    autoAdvanceEnabled: autoAdvanceChk.checked
  });
});

retrySpecificBtn.addEventListener("click", async () => {
  const rawNum = retryQNumInput.value.trim();
  const targetQuestionNumber = rawNum ? parseInt(rawNum, 10) : null;

  statusText.textContent = targetQuestionNumber
    ? `🔄 Đang giải lại Câu ${targetQuestionNumber} (2 lớp)...`
    : "🔄 Đang giải lại câu hiện tại (2 lớp)...";

  try {
    const tab = await ensureContentScriptReady();
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, {
        action: "RETRY_SPECIFIC_QUESTION",
        targetQuestionNumber
      });
    }
  } catch (e) {
    statusText.textContent = "⚠️ Không kết nối được với tab bài thi!";
  }
});

function downloadTextFile(filename, content) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

exportTxtBtn.addEventListener("click", () => {
  chrome.storage.local.get(["quizExportHistory"], (res) => {
    const history = Array.isArray(res.quizExportHistory) ? res.quizExportHistory : [];
    if (history.length === 0) {
      statusText.textContent = "Chưa có câu hỏi nào để xuất!";
      return;
    }
    const blocks = history.map((item, idx) => `Câu ${idx + 1}:\n${item.question}\nĐáp án: ${item.answer}`);
    downloadTextFile(`De_Va_Dap_An_Ultra_${Date.now()}.txt`, blocks.join("\n\n----------------------------------------\n\n"));
  });
});

exportDetailBtn.addEventListener("click", () => {
  chrome.storage.local.get(["quizExportHistory"], (res) => {
    const history = Array.isArray(res.quizExportHistory) ? res.quizExportHistory : [];
    if (history.length === 0) {
      statusText.textContent = "Chưa có câu hỏi nào để xuất!";
      return;
    }
    const blocks = history.map((item, idx) => {
      const lines = [`Câu ${idx + 1}${item.subject ? ` [${item.subject}]` : ""}:`, item.question, `Đáp án: ${item.answer}`];
      if (item.step) lines.push(`Lời giải: ${item.step}`);
      if (item.auditNote) lines.push(`Kiểm chứng: ${item.auditNote}`);
      return lines.join("\n");
    });
    downloadTextFile(`De_Va_Loi_Giai_Chi_Tiet_${Date.now()}.txt`, blocks.join("\n\n========================================\n\n"));
  });
});

clearHistoryBtn.addEventListener("click", () => {
  chrome.storage.local.set({
    quizExportHistory: [],
    lastSolvedAnswer: "Chưa có dữ liệu",
    lastSolvedMeta: null,
    solverStatus: "Đã xóa dữ liệu đề cũ"
  });
});

saveKeysBtn.addEventListener("click", () => {
  const keys = customKeysInput.value
    .split(/[\r\n,;]+/)
    .map((k) => k.trim())
    .filter(Boolean);
  chrome.storage.local.set({ customApiKeys: keys }, () => {
    keySavedNote.textContent = `✔ Đã lưu ${keys.length} API Key dự phòng!`;
    keySavedNote.style.display = "block";
    setTimeout(() => {
      keySavedNote.style.display = "none";
    }, 2500);
  });
});
