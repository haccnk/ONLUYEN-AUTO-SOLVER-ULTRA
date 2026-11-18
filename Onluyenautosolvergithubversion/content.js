(() => {
  if (typeof window.__autoSolverCleanup === "function") {
    try { window.__autoSolverCleanup(); } catch (e) {}
  }

  const EXT = window.__OnLuyenExtractor;
  if (!EXT) {
    console.warn("[AutoSolver Ultra] Không tìm thấy __OnLuyenExtractor!");
    return;
  }

  let isProcessing = false;
  let solvedSignature = "";
  let debounceTimer = null;
  let isExtensionEnabled = true;
  let autoAdvanceEnabled = true;
  let intelligenceMode = "smart";
  let domObserver = null;
  let heartbeatTimer = null;
  let processingWatchdog = null;
  let hasAutoDownloaded = false;
  let lastWaitingStatusAt = 0;

  const solvedListKeys = new Set();
  const skippedFailedListKeys = new Set();
  const failCountMap = new Map();
  const attemptedSingleQuestions = new Set();
  const rejectedHistoryMap = new Map();

  function startProcessingWatchdog(label = "") {
    if (processingWatchdog) clearTimeout(processingWatchdog);
    processingWatchdog = setTimeout(() => {
      processingWatchdog = null;
      if (isProcessing) {
        isProcessing = false;
        syncStatus(`⚠️ Quá thời gian chờ phản hồi${label ? ` (${label})` : ""}, đã tự mở khóa!`);
      }
    }, 55000);
  }

  function clearProcessingWatchdog() {
    if (processingWatchdog) {
      clearTimeout(processingWatchdog);
      processingWatchdog = null;
    }
  }

  function isContextValid() {
    try {
      return typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
  }

  function recordRejectedAnswer(sig, ans) {
    if (!sig || !ans) return [];
    if (!rejectedHistoryMap.has(sig)) rejectedHistoryMap.set(sig, new Set());
    rejectedHistoryMap.get(sig).add(String(ans).trim());
    return Array.from(rejectedHistoryMap.get(sig));
  }

  function getRejectedAnswers(sig, oldUiAns) {
    if (oldUiAns) return recordRejectedAnswer(sig, oldUiAns);
    return rejectedHistoryMap.has(sig) ? Array.from(rejectedHistoryMap.get(sig)) : [];
  }

  function onRuntimeMessage(msg, sender, sendResponse) {
    if (!msg) return false;

    if (msg.action === "SOLVER_DEBUG_LOG") {
      const prefix = `%c[AutoSolver Ultra ${msg.timestamp}] ${msg.title}\n`;
      const detailTxt = typeof msg.detail === "object" ? JSON.stringify(msg.detail, null, 2) : String(msg.detail);
      if (msg.level === "error") {
        console.warn(prefix, "background:#dc2626;color:#fff;padding:2px 6px;border-radius:4px;font-weight:bold;", detailTxt);
      } else if (msg.level === "warn") {
        console.warn(prefix, "background:#d97706;color:#fff;padding:2px 6px;border-radius:4px;font-weight:bold;", detailTxt);
      } else {
        console.info(prefix, "background:#059669;color:#fff;padding:2px 6px;border-radius:4px;font-weight:bold;", detailTxt);
      }
      return false;
    }

    if (msg.action === "RETRY_SPECIFIC_QUESTION") {
      handleManualRetryQuestion(msg.targetQuestionNumber);
      if (typeof sendResponse === "function") sendResponse({ ok: true });
      return true;
    }

    if (msg.action === "PING") {
      if (typeof sendResponse === "function") {
        sendResponse({ ok: true, url: window.location.href, isQuiz: isQuizPage() });
      }
      return true;
    }

    if (msg.action === "FORCE_SCAN_NOW") {
      clearProcessingWatchdog();
      isProcessing = false;
      solvedSignature = "";
      failCountMap.clear();
      skippedFailedListKeys.clear();
      const diag = processScreen(true);
      if (typeof sendResponse === "function") sendResponse({ ok: true, diag });
      return true;
    }

    return false;
  }

  if (isContextValid()) {
    try {
      chrome.runtime.onMessage.addListener(onRuntimeMessage);
    } catch (e) {}
  }

  function cleanupSelf() {
    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    clearProcessingWatchdog();
    clearTimeout(debounceTimer);
    window.removeEventListener("keydown", onKeyDown);
    try {
      if (isContextValid()) chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch (e) {}
  }
  window.__autoSolverCleanup = cleanupSelf;

  function onKeyDown(e) {
    if (!isContextValid()) return cleanupSelf();
    if (e.altKey && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      chrome.storage.local.set({ autoSolverEnabled: !isExtensionEnabled });
    }
    if (e.altKey && (e.key === "r" || e.key === "R")) {
      e.preventDefault();
      handleManualRetryQuestion(null);
    }
  }
  window.addEventListener("keydown", onKeyDown);

  function syncStatus(solverStatus, lastSolvedAnswer = null, lastSolvedMeta = null) {
    if (!isContextValid()) return cleanupSelf();
    try {
      const payload = { solverStatus };
      if (lastSolvedAnswer !== null) payload.lastSolvedAnswer = lastSolvedAnswer;
      if (lastSolvedMeta !== null) payload.lastSolvedMeta = lastSolvedMeta;
      chrome.storage.local.set(payload);
    } catch (e) {}
  }

  function saveCleanExportItem(entry) {
    if (!isContextValid()) return;
    chrome.storage.local.get(["quizExportHistory"], (res) => {
      if (!isContextValid()) return;
      const list = Array.isArray(res?.quizExportHistory) ? res.quizExportHistory : [];
      const idx = list.findIndex((i) => i.signature === entry.signature || (entry.qLabel && i.qLabel === entry.qLabel));
      if (idx === -1) {
        list.push(entry);
      } else {
        list[idx] = entry;
      }
      chrome.storage.local.set({ quizExportHistory: list });
    });
  }

  function autoDownloadCleanTxt() {
    if (!isContextValid() || hasAutoDownloaded) return;
    chrome.storage.local.get(["quizExportHistory"], (res) => {
      const history = Array.isArray(res?.quizExportHistory) ? res.quizExportHistory : [];
      if (history.length === 0) return;
      hasAutoDownloaded = true;

      const lines = history.map((item, idx) => {
        return `Câu ${idx + 1}:\n${item.question}\nĐáp án: ${item.answer}`;
      });

      const blob = new Blob([lines.join("\n\n----------------------------------------\n\n")], {
        type: "text/plain;charset=utf-8"
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `De_Va_Dap_An_Ultra_${Date.now()}.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  }

  function findContinueButton(scopeDoc = document) {
    return (
      Array.from(scopeDoc.querySelectorAll("button, [role='button'], a, div, span")).find((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || r.top < 60 || el.children.length > 2) return false;
        const t = (el.innerText || "").trim().toUpperCase();
        return t === "TIẾP TỤC" || t === "CÂU TIẾP" || t === "TIẾP THEO" || t === "CÂU SAU";
      }) || null
    );
  }

  function resolveTargetScopeDoc() {
    if (EXT.getMultiBlocks(document).length >= 2 || EXT.classifyQuestionInScope(document, false).type) {
      return document;
    }
    const iframes = Array.from(document.querySelectorAll("iframe"));
    for (const ifr of iframes) {
      try {
        const r = ifr.getBoundingClientRect();
        if (r.width < 120 || r.height < 120) continue;
        const doc = ifr.contentDocument || ifr.contentWindow?.document;
        if (!doc || !doc.body) continue;
        if (EXT.getMultiBlocks(doc).length >= 2 || EXT.classifyQuestionInScope(doc, false).type) {
          return doc;
        }
      } catch (e) {}
    }
    return document;
  }

  function isQuizPage(scopeDoc = document) {
    const fullUrl = (
      window.location.pathname +
      window.location.hash +
      window.location.search
    ).toLowerCase();

    if (/(\/|^)(home-student|login|sign-in|dashboard|profile|ranking)(\/|\?|#|$)/i.test(fullUrl)) {
      return false;
    }

    const txt = scopeDoc.body?.innerText || "";
    const hasContinue = Boolean(findContinueButton(scopeDoc));
    if (
      fullUrl.includes("result") ||
      (/Kết quả chi tiết|Số câu đúng|Tổng điểm/i.test(txt) && /Đáp án của bạn/i.test(txt) && !hasContinue)
    ) {
      return false;
    }

    if (
      /(practice|exam|test|step|assignment|docx|homework|bai-tap|kiem-tra|luyen-tap|de-thi|quiz|contest|arena|study|learn)/.test(
        fullUrl
      )
    ) {
      return true;
    }
    if (/#\d{5,}/.test(txt) || /(?:Câu(?:\s+hỏi)?|Question)\s+\d+/i.test(txt) || /Nộp bài|Phiếu trả lời/i.test(txt)) {
      return true;
    }
    return EXT.classifyQuestionInScope(scopeDoc, false).type !== null;
  }

  if (isContextValid()) {
    chrome.storage.local.get(["autoSolverEnabled", "autoAdvanceEnabled", "intelligenceMode"], (res) => {
      if (typeof res?.autoSolverEnabled === "boolean") isExtensionEnabled = res.autoSolverEnabled;
      if (typeof res?.autoAdvanceEnabled === "boolean") autoAdvanceEnabled = res.autoAdvanceEnabled;
      if (["fast", "smart", "ultra"].includes(res?.intelligenceMode)) intelligenceMode = res.intelligenceMode;
      if (isQuizPage() && isExtensionEnabled) processScreen();
    });

    chrome.storage.onChanged.addListener((ch) => {
      if (!isContextValid()) return cleanupSelf();
      if (ch.autoAdvanceEnabled) {
        autoAdvanceEnabled = ch.autoAdvanceEnabled.newValue !== false;
      }
      if (ch.intelligenceMode && ["fast", "smart", "ultra"].includes(ch.intelligenceMode.newValue)) {
        intelligenceMode = ch.intelligenceMode.newValue;
      }
      if (ch.autoSolverEnabled) {
        isExtensionEnabled = ch.autoSolverEnabled.newValue;
        if (isExtensionEnabled) {
          solvedSignature = "";
          isProcessing = false;
          processScreen();
        } else {
          isProcessing = false;
          clearTimeout(debounceTimer);
        }
      }
    });
  }

  function dispatchClick(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: r.left + Math.min(Math.max(r.width / 2, 4), 20),
      clientY: r.top + Math.max(r.height / 2, 4),
      pointerId: 1,
      isPrimary: true
    };
    el.dispatchEvent(new PointerEvent("pointerdown", init));
    el.dispatchEvent(new MouseEvent("mousedown", init));
    el.dispatchEvent(new PointerEvent("pointerup", init));
    el.dispatchEvent(new MouseEvent("mouseup", init));
    el.dispatchEvent(new MouseEvent("click", init));
    if (typeof el.click === "function") el.click();
  }

  function dismissSubmitModal() {
    const bodyTxt = document.body?.innerText || "";
    if (/chắc chắn muốn nộp bài|xác nhận nộp bài|kết thúc bài làm|nộp bài thi/i.test(bodyTxt)) {
      const cancelBtn = Array.from(document.querySelectorAll("button, [role='button'], div, span")).find((el) => {
        const t = (el.innerText || "").trim().toUpperCase();
        return el.children.length === 0 && (t === "HỦY" || t === "HỦY BỎ" || t === "QUAY LẠI" || t === "ĐÓNG" || t === "KHÔNG");
      });
      if (cancelBtn) {
        dispatchClick(cancelBtn.closest("button") || cancelBtn);
        autoDownloadCleanTxt();
        return true;
      }
    }
    return false;
  }

  function clickMCQ(c) {
    if (!c) return;
    if (c.badgeEl) dispatchClick(c.badgeEl);
    if (c.badgeEl?.parentElement && c.badgeEl.parentElement !== c.rowEl) dispatchClick(c.badgeEl.parentElement);
    if (c.rowEl) {
      dispatchClick(c.rowEl);
      const inp = c.rowEl.querySelector("input, label, [role='radio'], [role='button']");
      if (inp) dispatchClick(inp);
    }
  }

  function fillInput(inputEl, rawVal, answerKind, cb) {
    if (!inputEl) {
      if (typeof cb === "function") cb();
      return;
    }

    const rawStr = String(rawVal ?? "").trim();
    const isTextMode = answerKind === "TEXT" || /[A-Za-zÀ-ỹ]/.test(rawStr);
    const val = isTextMode ? rawStr.replace(/\s+/g, " ").trim() : rawStr.replace(/\s+/g, "");

    const apply = (v) => {
      try {
        inputEl.focus();
        const proto =
          inputEl instanceof HTMLTextAreaElement
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (nativeSetter) {
          nativeSetter.call(inputEl, v);
        } else {
          inputEl.value = v;
        }
      } catch (err) {
        inputEl.value = v;
      }

      inputEl.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: v }));
      inputEl.dispatchEvent(new Event("change", { bubbles: true }));
      inputEl.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", keyCode: 13 }));
      inputEl.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", keyCode: 13 }));
      inputEl.blur();
    };

    apply(val);
    setTimeout(() => {
      if (!isTextMode && (!inputEl.value || !inputEl.value.trim())) {
        const altVal = val.includes(",") ? val.replace(",", ".") : val.replace(".", ",");
        apply(altVal);
      }
      setTimeout(() => {
        if (typeof cb === "function") cb();
      }, 220);
    }, 220);
  }

  function formatCleanAnswerForExport(type, normAns, mcq) {
    if (type === "MCQ") {
      const idx = normAns.charCodeAt(0) - 65;
      const choiceTxt = EXT.sanitizeChoiceText(mcq?.[idx]?.text || "", normAns);
      return choiceTxt ? `${normAns}. ${choiceTxt}` : normAns;
    }
    if (type === "TRUE_FALSE" && normAns.includes("-")) {
      return normAns
        .split("-")
        .map((v, i) => `${String.fromCharCode(97 + i)}) ${v === "Đ" ? "Đúng" : "Sai"}`)
        .join(" | ");
    }
    return normAns;
  }

  function applyAnswerToDOM(type, ansStr, answerKind, mcq, shortInp, tf, onDone) {
    if (type === "MCQ" && ansStr) {
      const idx = ansStr.charCodeAt(0) - 65;
      if (mcq[idx]) {
        clickMCQ(mcq[idx]);
        setTimeout(() => {
          // Chỉ click nhắc lại nếu UI vẫn chưa báo đã chọn
          const nowSelected = EXT.detectUIAns("MCQ", mcq, null, null);
          if (nowSelected !== ansStr) clickMCQ(mcq[idx]);
          onDone();
        }, 180);
        return;
      }
    } else if (type === "SHORT_ANSWER" && ansStr !== "") {
      fillInput(shortInp, ansStr, answerKind, onDone);
      return;
    } else if (type === "TRUE_FALSE" && ansStr.includes("-")) {
      const parts = ansStr.split("-");
      parts.slice(0, 4).forEach((p, idx) => {
        setTimeout(() => {
          const btn = p === "Đ" ? tf.trueBtns[idx] : tf.falseBtns[idx];
          if (btn) dispatchClick(btn);
        }, idx * 180);
      });
      setTimeout(onDone, 850);
      return;
    }
    onDone();
  }

  function getMultiBlocks(rootDoc = document) {
    return EXT.getMultiBlocks(rootDoc);
  }

  function getNavState() {
    const map = new Map();
    let activeNum = null;

    for (const el of document.querySelectorAll("button, a, div, span, li")) {
      const r = el.getBoundingClientRect();
      if (r.width < 18 || r.width > 68 || r.height < 18 || r.height > 68 || r.top < 35) continue;
      if (el.children.length === 0 && /^\d{1,3}$/.test(el.innerText.trim())) {
        const num = parseInt(el.innerText.trim(), 10);
        if (num >= 1 && num <= 150 && !map.has(num)) {
          map.set(num, el);
          const cls = String(el.className || "") + " " + String(el.parentElement?.className || "");
          if (/active|current|selected|focus/i.test(cls)) {
            activeNum = num;
          }
        }
      }
    }
    return { map, activeNum };
  }

  function buildMetaFromResult(qLabel, res) {
    return {
      qLabel,
      subject: res.subject || "Tổng hợp",
      confidence: res.confidence ?? 90,
      verifiedTwoPass: Boolean(res.verifiedTwoPass),
      step: res.step || "",
      selfCheck: res.selfCheck || "",
      auditNote: res.auditNote || "",
      modelUsed: res.modelUsed || "",
      normalizedAns: res.normalizedAns || ""
    };
  }

  // =========================================================================
  // GIẢI LẠI CÂU CHỈ ĐỊNH / CÂU HIỆN TẠI (CỘNG DỒN LỊCH SỬ ĐÁP ÁN SAI)
  // =========================================================================
  function handleManualRetryQuestion(targetQNum) {
    if (!isContextValid()) return cleanupSelf();
    isProcessing = true;
    startProcessingWatchdog("Giải lại");

    const blocks = getMultiBlocks();

    if (blocks.length >= 2) {
      let targetBlock = null;
      if (targetQNum) {
        targetBlock = blocks.find((b) => b.qNum === Number(targetQNum));
      } else {
        const viewportCenter = window.innerHeight / 2;
        targetBlock = blocks.reduce((best, cur) => {
          const r = cur.blockEl.getBoundingClientRect();
          const dist = Math.abs((r.top + r.bottom) / 2 - viewportCenter);
          return !best || dist < best.dist ? { item: cur, dist } : best;
        }, null)?.item;
      }

      if (!targetBlock) {
        clearProcessingWatchdog();
        syncStatus(`⚠️ Không tìm thấy Câu ${targetQNum} trên trang!`);
        isProcessing = false;
        return;
      }

      targetBlock.blockEl.scrollIntoView({ behavior: "instant", block: "center" });
      const classified = EXT.classifyQuestionInScope(targetBlock.blockEl, true);
      if (!classified.type) {
        clearProcessingWatchdog();
        isProcessing = false;
        return;
      }

      const { type, shortInp, tf, mcq } = classified;
      const payload = EXT.extractQuestionPayload(targetBlock.blockEl, classified);
      const oldUiAns = EXT.detectUIAns(type, mcq, shortInp, tf);
      const qKey = `LIST_Q${targetBlock.qNum}_${type}_${payload.stemText.slice(0, 50)}`;
      skippedFailedListKeys.delete(qKey);
      failCountMap.delete(qKey);
      const rejectedList = getRejectedAnswers(qKey, oldUiAns);

      syncStatus(`🔄 Đang giải lại Câu ${targetBlock.qNum} (Tránh: ${rejectedList.join(", ") || "trống"})...`);

      setTimeout(() => {
        chrome.runtime.sendMessage(
          {
            action: "SOLVE_QUIZ",
            data: {
              questionType: type,
              qCode: `Câu ${targetBlock.qNum}`,
              rawScreenText: payload.stemText,
              contextPassage: payload.contextPassage,
              extraDetails: payload.extraDetails,
              hasVisuals: true,
              visualSignature: payload.visualSignature,
              intelligenceMode,
              isManualRetry: true,
              rejectedAnswer: oldUiAns,
              rejectedAnswers: rejectedList
            }
          },
          (res) => {
            clearProcessingWatchdog();
            isProcessing = false;
            if (chrome.runtime.lastError || !res?.success || !res.result) {
              syncStatus(`⚠️ Giải lại Câu ${targetBlock.qNum} thất bại, hãy bấm thử lại!`);
              return;
            }
            const r = res.result;
            const normAns = r.normalizedAns || "";
            const cleanExportAns = formatCleanAnswerForExport(type, normAns, mcq);
            solvedListKeys.add(qKey);

            saveCleanExportItem({
              signature: qKey,
              qLabel: `Câu ${targetBlock.qNum}`,
              question: payload.extraDetails ? `${payload.stemText}\n${payload.extraDetails}` : payload.stemText,
              answer: cleanExportAns,
              step: r.step || "",
              subject: r.subject || "",
              confidence: r.confidence ?? 90,
              verifiedTwoPass: Boolean(r.verifiedTwoPass),
              auditNote: r.auditNote || ""
            });

            applyAnswerToDOM(type, normAns, r.answerKind, mcq, shortInp, tf, () => {
              syncStatus(
                `✅ Đã giải lại Câu ${targetBlock.qNum}: [${oldUiAns || "?"}] ➔ [${normAns}]`,
                `Câu ${targetBlock.qNum} (Giải lại): ${cleanExportAns}`,
                buildMetaFromResult(`Câu ${targetBlock.qNum}`, r)
              );
            });
          }
        );
      }, 280);
      return;
    }

    // Trường hợp Single-Step Mode
    const runSingleRetryOnCurrentView = () => {
      const classified = EXT.classifyQuestionInScope(document, false);
      if (!classified.type) {
        clearProcessingWatchdog();
        syncStatus("⚠️ Không nhận diện được câu hỏi hiện tại để giải lại!");
        isProcessing = false;
        return;
      }

      const { type, shortInp, tf, mcq } = classified;
      const payload = EXT.extractQuestionPayload(document, classified);
      const oldUiAns = EXT.detectUIAns(type, mcq, shortInp, tf);
      const qCode = (document.body.innerText.match(/#\d{5,}/) || [])[0] || (targetQNum ? `Câu ${targetQNum}` : "Câu hiện tại");
      const cleanQuestionFull = payload.extraDetails ? `${payload.stemText}\n${payload.extraDetails}` : payload.stemText;
      const curSig = `${qCode}_${type}_${payload.stemText.slice(0, 80)}_${payload.visualSignature.slice(0, 40)}`;
      failCountMap.delete(curSig);
      const rejectedList = getRejectedAnswers(curSig, oldUiAns);

      syncStatus(`🔄 Đang giải lại ${qCode} (Tránh: ${rejectedList.join(", ") || "trống"})...`);

      setTimeout(() => {
        chrome.runtime.sendMessage(
          {
            action: "SOLVE_QUIZ",
            data: {
              questionType: type,
              qCode,
              rawScreenText: payload.stemText,
              contextPassage: payload.contextPassage,
              extraDetails: payload.extraDetails,
              hasVisuals: true,
              visualSignature: payload.visualSignature,
              intelligenceMode,
              isManualRetry: true,
              rejectedAnswer: oldUiAns,
              rejectedAnswers: rejectedList
            }
          },
          (res) => {
            clearProcessingWatchdog();
            isProcessing = false;
            if (chrome.runtime.lastError || !res?.success || !res.result) {
              syncStatus(`⚠️ Giải lại ${qCode} thất bại, hãy bấm thử lại!`);
              return;
            }
            const r = res.result;
            const normAns = r.normalizedAns || "";
            const cleanExportAns = formatCleanAnswerForExport(type, normAns, mcq);
            solvedSignature = curSig;

            saveCleanExportItem({
              signature: curSig,
              qLabel: qCode,
              question: cleanQuestionFull,
              answer: cleanExportAns,
              step: r.step || "",
              subject: r.subject || "",
              confidence: r.confidence ?? 90,
              verifiedTwoPass: Boolean(r.verifiedTwoPass),
              auditNote: r.auditNote || ""
            });

            applyAnswerToDOM(type, normAns, r.answerKind, mcq, shortInp, tf, () => {
              syncStatus(
                `✅ Đã giải lại ${qCode}: [${oldUiAns || "?"}] ➔ [${normAns}]`,
                `${qCode} (Giải lại): ${cleanExportAns}`,
                buildMetaFromResult(qCode, r)
              );
            });
          }
        );
      }, 300);
    };

    if (targetQNum) {
      const { map } = getNavState();
      const targetBtn = map.get(Number(targetQNum));
      if (targetBtn) {
        dispatchClick(targetBtn);
        setTimeout(runSingleRetryOnCurrentView, 600);
        return;
      }
    }

    runSingleRetryOnCurrentView();
  }

  // =========================================================================
  // CHẾ ĐỘ DANH SÁCH NHIỀU CÂU (LIST MODE)
  // =========================================================================
  function processListMode(blocks) {
    if (!isContextValid()) return cleanupSelf();
    if (isProcessing || !isExtensionEnabled) return;

    let task = null;
    for (const b of blocks) {
      const classified = EXT.classifyQuestionInScope(b.blockEl, true);
      if (!classified.type) continue;

      const { type, shortInp, tf, mcq } = classified;
      const payload = EXT.extractQuestionPayload(b.blockEl, classified);
      const qKey = `LIST_Q${b.qNum}_${type}_${payload.stemText.slice(0, 50)}`;
      if (skippedFailedListKeys.has(qKey)) continue;

      const uiAns = EXT.detectUIAns(type, mcq, shortInp, tf);

      if (solvedListKeys.has(qKey) || uiAns) {
        if (uiAns && !solvedListKeys.has(qKey)) {
          saveCleanExportItem({
            signature: qKey,
            qLabel: `Câu ${b.qNum}`,
            question: payload.extraDetails ? `${payload.stemText}\n${payload.extraDetails}` : payload.stemText,
            answer: formatCleanAnswerForExport(type, uiAns, mcq)
          });
        }
        solvedListKeys.add(qKey);
        continue;
      }

      task = {
        qNum: b.qNum,
        blockEl: b.blockEl,
        qKey,
        type,
        payload,
        tf,
        mcq,
        shortInp
      };
      break;
    }

    if (!task) {
      if (skippedFailedListKeys.size > 0) {
        syncStatus(`⚠️ Đã xong phần đạt yêu cầu (còn ${skippedFailedListKeys.size} câu lỗi tạm bỏ qua, bấm 🔍 Quét ngay để thử lại)`);
      } else {
        syncStatus(`✅ Đã hoàn thành ${blocks.length} câu! Đang xuất file đáp án...`);
        autoDownloadCleanTxt();
      }
      return;
    }

    isProcessing = true;
    startProcessingWatchdog(`Câu ${task.qNum}`);
    task.blockEl.scrollIntoView({ behavior: "instant", block: "center" });
    syncStatus(`🧠 Đang phân tích Câu ${task.qNum}/${blocks.length} (${task.type})...`);

    setTimeout(() => {
      if (!isContextValid()) return cleanupSelf();
      chrome.runtime.sendMessage(
        {
          action: "SOLVE_QUIZ",
          data: {
            questionType: task.type,
            qCode: `Câu ${task.qNum}`,
            rawScreenText: task.payload.stemText,
            contextPassage: task.payload.contextPassage,
            extraDetails: task.payload.extraDetails,
            hasVisuals: task.payload.hasVisuals,
            visualSignature: task.payload.visualSignature,
            intelligenceMode
          }
        },
        (res) => {
          clearProcessingWatchdog();
          if (!isContextValid()) return cleanupSelf();
          if (chrome.runtime.lastError || !res?.success || !res.result) {
            const fails = (failCountMap.get(task.qKey) || 0) + 1;
            failCountMap.set(task.qKey, fails);
            if (fails >= 3) {
              skippedFailedListKeys.add(task.qKey);
              syncStatus(`⚠️ Câu ${task.qNum} lỗi 3 lần, tạm bỏ qua để giải tiếp câu khác...`);
              isProcessing = false;
              if (isExtensionEnabled) setTimeout(() => processScreen(false), 600);
            } else {
              syncStatus(`⚠️ Lỗi tạm thời Câu ${task.qNum} (lần ${fails}/3), thử lại sau 4.5s...`);
              setTimeout(() => {
                isProcessing = false;
                if (isExtensionEnabled) processScreen(false);
              }, 4500);
            }
            return;
          }

          failCountMap.delete(task.qKey);
          const r = res.result;
          const normAns = r.normalizedAns || "";
          const cleanExportAns = formatCleanAnswerForExport(task.type, normAns, task.mcq);

          solvedListKeys.add(task.qKey);
          saveCleanExportItem({
            signature: task.qKey,
            qLabel: `Câu ${task.qNum}`,
            question: task.payload.extraDetails
              ? `${task.payload.stemText}\n${task.payload.extraDetails}`
              : task.payload.stemText,
            answer: cleanExportAns,
            step: r.step || "",
            subject: r.subject || "",
            confidence: r.confidence ?? 90,
            verifiedTwoPass: Boolean(r.verifiedTwoPass),
            auditNote: r.auditNote || ""
          });

          syncStatus(
            `Đã giải Câu ${task.qNum}/${blocks.length}`,
            `Câu ${task.qNum}: ${cleanExportAns}`,
            buildMetaFromResult(`Câu ${task.qNum}`, r)
          );

          applyAnswerToDOM(task.type, normAns, r.answerKind, task.mcq, task.shortInp, task.tf, () => {
            setTimeout(() => {
              isProcessing = false;
              if (isExtensionEnabled) processScreen();
            }, 350);
          });
        }
      );
    }, 240);
  }

  // =========================================================================
  // CHẾ ĐỘ TỪNG CÂU (SINGLE-STEP MODE)
  // =========================================================================
  function advanceSingleStep(currentQKey) {
    attemptedSingleQuestions.add(currentQKey);

    setTimeout(() => {
      if (!isContextValid()) return cleanupSelf();
      if (!isExtensionEnabled || !isQuizPage()) {
        isProcessing = false;
        return;
      }
      if (dismissSubmitModal()) {
        isProcessing = false;
        return;
      }

      const snap = document.body.innerText.slice(0, 350);

      const actionBtns = Array.from(document.querySelectorAll("button, [role='button'], a, div, span")).filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || r.top < 80 || el.children.length > 2) return false;
        const t = (el.innerText || "").trim().toUpperCase();
        return t === "TIẾP TỤC" || t === "TRẢ LỜI" || t === "TIẾP THEO" || t === "CÂU TIẾP" || t === "CÂU SAU";
      });

      if (actionBtns.length > 0) {
        const btn = actionBtns[actionBtns.length - 1];
        dispatchClick(btn.closest("button") || btn);
      }

      setTimeout(() => {
        if (dismissSubmitModal()) {
          isProcessing = false;
          return;
        }

        const followUpBtn = Array.from(document.querySelectorAll("button, [role='button'], div, span")).find((el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0 || r.top < 80 || el.children.length > 2) return false;
          const t = (el.innerText || "").trim().toUpperCase();
          return t === "TIẾP TỤC" || t === "CÂU TIẾP" || t === "TIẾP THEO";
        });

        if (followUpBtn) {
          dispatchClick(followUpBtn.closest("button") || followUpBtn);
        }

        setTimeout(() => {
          if (dismissSubmitModal()) {
            isProcessing = false;
            return;
          }

          if (document.body.innerText.slice(0, 350) === snap) {
            const { map, activeNum } = getNavState();
            const maxQ = map.size > 0 ? Math.max(...map.keys()) : 0;
            const nextNum = activeNum ? activeNum + 1 : attemptedSingleQuestions.size + 1;

            if (maxQ > 0 && nextNum <= maxQ && map.has(nextNum)) {
              dispatchClick(map.get(nextNum));
            } else {
              syncStatus("✅ Đã hoàn thành toàn bộ đề! Đang xuất file đáp án...");
              autoDownloadCleanTxt();
              isProcessing = false;
              return;
            }
          }

          isProcessing = false;
          if (isExtensionEnabled) setTimeout(processScreen, 400);
        }, 450);
      }, 550);
    }, 380);
  }

  function processScreen(forceDiagnostic = false) {
    if (!isContextValid()) {
      cleanupSelf();
      return { reason: "context_invalid" };
    }
    if (!isExtensionEnabled) return { reason: "disabled" };
    if (isProcessing && !forceDiagnostic) return { reason: "busy" };

    const scopeDoc = resolveTargetScopeDoc();
    if (!isQuizPage(scopeDoc)) {
      if (forceDiagnostic) syncStatus("ℹ️ Trang hiện tại không phải giao diện làm bài.");
      return { reason: "not_quiz_page", url: window.location.href };
    }
    if (dismissSubmitModal()) return { reason: "submit_modal_dismissed" };

    const bodyTxt = scopeDoc.body?.innerText || document.body?.innerText || "";
    const resumeBtn = Array.from(scopeDoc.querySelectorAll("button, [role='button'], div")).find(
      (b) => (b.innerText || "").trim() === "Tiếp tục" && bodyTxt.includes("Tạm dừng")
    );
    if (resumeBtn && bodyTxt.includes("Bạn có muốn tiếp tục")) {
      dispatchClick(resumeBtn);
      return { reason: "resumed" };
    }

    // Xử lý màn hình giải thích trung gian ở chế độ Luyện tập từng câu (Step Mode)
    if (autoAdvanceEnabled && /Đáp án đúng|Lời giải chi tiết/i.test(bodyTxt)) {
      const nextBtn = findContinueButton(scopeDoc);
      if (nextBtn) {
        syncStatus("⏭️ Đang chuyển qua bước giải thích sang câu tiếp...");
        dispatchClick(nextBtn.closest("button") || nextBtn);
        setTimeout(() => {
          if (isExtensionEnabled) processScreen(false);
        }, 500);
        return { reason: "step_explanation_advanced" };
      }
    }

    const blocks = getMultiBlocks(scopeDoc);
    if (blocks.length >= 2) {
      processListMode(blocks);
      return { reason: "list_mode", blocks: blocks.length };
    }

    const classified = EXT.classifyQuestionInScope(scopeDoc, false);
    if (!classified.type) {
      const now = Date.now();
      if (forceDiagnostic || now - lastWaitingStatusAt > 6000) {
        lastWaitingStatusAt = now;
        syncStatus("🔍 Đang chờ câu hỏi hiển thị trên trang...");
      }
      return { reason: "no_question_detected", url: window.location.href };
    }

    const { type, shortInp, tf, mcq } = classified;
    const payload = EXT.extractQuestionPayload(scopeDoc, classified);
    const qCode = (bodyTxt.match(/#\d{5,}/) || [])[0] || `Câu_${attemptedSingleQuestions.size + 1}`;
    const cleanQuestionFull = payload.extraDetails ? `${payload.stemText}\n${payload.extraDetails}` : payload.stemText;

    const curSig = `${qCode}_${type}_${payload.stemText.slice(0, 80)}_${payload.visualSignature.slice(0, 40)}`;
    if (!forceDiagnostic && curSig === solvedSignature) return { reason: "already_solved_sig", qCode, type };

    const existingUIAns = EXT.detectUIAns(type, mcq, shortInp, tf);
    if (existingUIAns && /Đáp án của bạn/i.test(bodyTxt)) {
      solvedSignature = curSig;
      const cleanExportAns = formatCleanAnswerForExport(type, existingUIAns, mcq);
      saveCleanExportItem({
        signature: curSig,
        qLabel: qCode,
        question: cleanQuestionFull,
        answer: cleanExportAns
      });
      syncStatus(`Bỏ qua ${qCode} (Đã làm)`, `${qCode}: ${cleanExportAns}`);
      if (autoAdvanceEnabled) advanceSingleStep(curSig);
      return { reason: "skipped_already_answered", qCode, type };
    }

    isProcessing = true;
    startProcessingWatchdog(qCode);
    solvedSignature = curSig;

    window.scrollTo({ top: 0, behavior: "instant" });
    syncStatus(`🧠 Đang giải ${qCode} (${type})...`);

    setTimeout(() => {
      if (!isContextValid()) return cleanupSelf();
      chrome.runtime.sendMessage(
        {
          action: "SOLVE_QUIZ",
          data: {
            questionType: type,
            qCode,
            rawScreenText: payload.stemText,
            contextPassage: payload.contextPassage,
            extraDetails: payload.extraDetails,
            hasVisuals: payload.hasVisuals,
            visualSignature: payload.visualSignature,
            intelligenceMode
          }
        },
        (res) => {
          clearProcessingWatchdog();
          if (!isContextValid()) return cleanupSelf();
          if (chrome.runtime.lastError || !res?.success || !res.result) {
            const fails = (failCountMap.get(curSig) || 0) + 1;
            failCountMap.set(curSig, fails);
            if (fails >= 3) {
              // Giữ solvedSignature = curSig để dừng vòng lặp lỗi vô tận ở câu hiện tại
              isProcessing = false;
              syncStatus("⚠️ Câu này lỗi 3 lần (kiểm tra API Key / bấm 🔍 Quét ngay hoặc chuyển câu kế)");
            } else {
              syncStatus(`⚠️ Lỗi tạm thời (lần ${fails}/3), tự thử lại sau 5s...`);
              setTimeout(() => {
                solvedSignature = "";
                isProcessing = false;
              }, 5000);
            }
            return;
          }

          failCountMap.delete(curSig);
          const r = res.result;
          const normAns = r.normalizedAns || "";
          const cleanExportAns = formatCleanAnswerForExport(type, normAns, mcq);

          saveCleanExportItem({
            signature: curSig,
            qLabel: qCode,
            question: cleanQuestionFull,
            answer: cleanExportAns,
            step: r.step || "",
            subject: r.subject || "",
            confidence: r.confidence ?? 90,
            verifiedTwoPass: Boolean(r.verifiedTwoPass),
            auditNote: r.auditNote || ""
          });

          syncStatus(
            autoAdvanceEnabled ? `Đã giải ${qCode}` : `✅ Đã tích ${qCode} (Chờ bấm Tiếp)`,
            `${qCode}: ${cleanExportAns}`,
            buildMetaFromResult(qCode, r)
          );

          applyAnswerToDOM(type, normAns, r.answerKind, mcq, shortInp, tf, () => {
            if (autoAdvanceEnabled) {
              advanceSingleStep(curSig);
            } else {
              isProcessing = false;
            }
          });
        }
      );
    }, 180);

    return { reason: "solving_started", qCode, type };
  }

  domObserver = new MutationObserver(() => {
    if (!isContextValid()) return cleanupSelf();
    if (!isExtensionEnabled) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => processScreen(false), 450);
  });
  domObserver.observe(document.documentElement, { childList: true, subtree: true });

  heartbeatTimer = setInterval(() => {
    if (!isContextValid()) return cleanupSelf();
    if (isExtensionEnabled && !isProcessing) {
      processScreen(false);
    }
  }, 2000);
})();
