/* ============================================================
 * 胶片放映机 · 核心控制逻辑
 * ------------------------------------------------------------
 *  - 30fps 固定，暂停点 = 2 秒 22 帧 = 第 82 帧 ≈ 2.7333s
 *  - 素材总数自动探测：指数扩张 + 二分查找（HEAD，降级 GET+Range）
 *  - 坏格黑名单：404 / 解码失败 / 加载超时 → 静默拉黑并跳过
 *  - 伪随机播放：Fisher-Yates 洗牌，一轮 N 格不重复，跨轮预生成且防相邻重复
 *  - 「上一格」基于播放历史栈真实回退（可跨轮），自动跳过已拉黑格子
 *  - 双缓冲 <video> 无缝切换 + 跨轮预缓存
 *  - 连续切换队列 + PRESS_GAP 松手判定
 * ============================================================ */

(() => {
  "use strict";

  /* ---------- 常量 ---------- */
  const TARGET_FRAME = 82; // 2s22f @30fps
  const TARGET_SEC = TARGET_FRAME / 30; // ≈ 2.7333
  const MAX_PROBE = 512; // 自动探测的素材编号上限
  const LOAD_TIMEOUT = 10000; // 切换目标加载超时（超过则视为坏格跳过）
  const PRESS_GAP = 250; // 距最后一次按键超过该毫秒数视为已松手

  const State = {
    BOOT: "boot", // 未开始（入场遮罩）
    INSERT: "insert", // 从 0 播放插入动画（追帧到 82）
    PAUSED: "paused", // 冻结在第 82 帧
    RESUME: "resume", // 从暂停点继续播放（拔片动画末段）
    SWITCHING: "switch", // 正在切换素材（过渡）
  };

  /* ---------- DOM ---------- */
  const theater = document.getElementById("theater");
  const videoA = document.getElementById("videoA");
  const videoB = document.getElementById("videoB");
  const overlay = document.getElementById("startOverlay");
  const startBtn = document.getElementById("startBtn");
  const bgm = document.getElementById("bgm");
  const btnPrev = document.getElementById("btnPrev");
  const btnBgm = document.getElementById("btnBgm");
  const btnNext = document.getElementById("btnNext");
  const controls = document.getElementById("controls");
  const noMaterialTip = document.getElementById("noMaterialTip");
  const reelCode = document.getElementById("reelCode");
  const rcNum = document.getElementById("rcNum");
  const rcTotal = document.getElementById("rcTotal");
  const allDeadTip = document.getElementById("allDeadTip");

  /* ---------- 状态 ---------- */
  let state = State.BOOT;
  let started = false;
  let booting = false;
  let SP_COUNT = 0; // 由自动探测得出
  let NUMBERS = []; // 1..SP_COUNT
  let activeIdx = 0;
  let frameToken = 0; // 帧追踪令牌，防止旧回调干扰
  let secondWarm = null; // 二级预缓存（<link rel="preload">）
  let pending = []; // 待执行切换方向队列（+1 下一个 / -1 上一个）
  let lastPressAt = 0; // 最近一次按键时间戳
  let loadGuard = null; // 加载超时卫兵定时器
  const badSet = new Set(); // 坏格黑名单（404/解码失败/超时）

  /* ---------- 工具 ---------- */
  const videoUrl = (idx) => `shucai/sp${idx}/s${idx}.mp4`;

  /** 统一吞掉 Promise 拒绝（如自动播放策略拦截），避免未处理 rejection */
  function swallow(p) {
    if (p && p.catch) p.catch(() => {});
  }

  const activeVideo = () =>
    videoA.classList.contains("active") ? videoA : videoB;
  const inactiveVideo = () =>
    videoA.classList.contains("active") ? videoB : videoA;

  function setActive(v) {
    const other = v === videoA ? videoB : videoA;
    other.classList.remove("active");
    void other.offsetWidth; // 强制重绘保证 transition 生效
    v.classList.add("active");
  }

  /* ---------- 胶片边缘码计数器 ---------- */
  let padW = 2; // 补零位数：随素材总数动态增长（>99 格时不至于错位）
  const pad2 = (n) => String(n).padStart(padW, "0");

  function updateReelCode(idx) {
    if (!reelCode) return;
    rcNum.textContent = pad2(idx);
    rcNum.classList.remove("tick");
    void rcNum.offsetWidth; // 重启动画
    rcNum.classList.add("tick");
  }

  /* ---------- 素材总数自动探测 ---------- */
  /** file:// 等禁用 fetch 的环境：直接用视频元素加载元数据探测 */
  function probeViaVideo(url) {
    return new Promise((resolve) => {
      const v = document.createElement("video");
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        v.removeAttribute("src");
        try {
          v.load();
        } catch (e) {}
        v.remove();
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), 8000);
      v.preload = "metadata";
      v.onloadedmetadata = () => done(true);
      v.onerror = () => done(false);
      v.src = url;
    });
  }

  /** 探测某个素材是否可访问：HEAD 优先 → GET + Range → 视频元素探测（file://） */
  async function probeExists(idx) {
    const url = videoUrl(idx);
    try {
      const r = await fetch(url, { method: "HEAD" });
      if (r.ok) return true;
      if (r.status === 404 || r.status === 403) return false;
      // 其他状态码（如 405 Method Not Allowed）→ 走 GET 降级
    } catch (e) {
      // fetch 被禁（file:// 协议等）→ 用视频元素探测兜底
      return probeViaVideo(url);
    }
    try {
      const r = await fetch(url, { headers: { Range: "bytes=0-0" } });
      return r.ok || r.status === 206;
    } catch (e) {
      return probeViaVideo(url);
    }
  }

  /** 指数扩张找上界 + 二分查找精确定位连续素材边界 */
  async function detectSpCount() {
    if (!(await probeExists(1))) return 0;
    let lo = 1;
    let hi = 2;
    while (hi < MAX_PROBE && (await probeExists(hi))) {
      lo = hi;
      hi *= 2;
    }
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (await probeExists(mid)) lo = mid;
      else hi = mid;
    }
    return Math.min(lo, MAX_PROBE);
  }

  const detectPromise = detectSpCount();
  let detectDone = false; // 探测是否已完成（决定开始按钮是否需要加载反馈）
  detectPromise.then((n) => {
    detectDone = true;
    if (n === 0) showNoMaterial(); // 探测完成即提示，无需等点击
  });

  function showNoMaterial() {
    if (started) return;
    startBtn.disabled = true;
    const text = startBtn.querySelector(".btn-text");
    if (text) text.textContent = "暂无影片";
    if (noMaterialTip) noMaterialTip.hidden = false;
  }

  /* ---------- 伪随机轮次管理（跳过黑名单） ---------- */
  let round = []; // 当前轮次（好格洗牌）
  let roundPos = -1; // 当前在轮次中的位置
  let nextRound = null; // 提前生成下一轮
  const history = []; // 已播放素材栈：「上一格」据此真实回退（可跨轮）

  const anyGoodLeft = () => NUMBERS.some((n) => !badSet.has(n));

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** 洗牌生成一轮好格；avoidLast = 上一轮末尾编号，用于避免跨轮相邻重复 */
  function newRound(avoidLast) {
    const arr = shuffle(NUMBERS.filter((n) => !badSet.has(n)));
    if (arr.length > 1 && avoidLast != null && arr[0] === avoidLast) {
      const j = 1 + Math.floor(Math.random() * (arr.length - 1));
      [arr[0], arr[j]] = [arr[j], arr[0]]; // 随机换一位到队首，消除相邻重复
    }
    return arr;
  }

  function ensureRound() {
    if (round.length === 0) {
      round = newRound();
      roundPos = 0;
    }
  }

  /** 前进方向第 offset 个好格（跨轮扫描；不足时回退到最后一个可用候选） */
  function peekAt(offset) {
    const seq = [];
    for (let p = roundPos + 1; p < round.length; p++) seq.push(round[p]);
    if (!nextRound) {
      nextRound = newRound(round.length ? round[round.length - 1] : null);
    }
    for (let p = 0; p < nextRound.length; p++) seq.push(nextRound[p]);
    const good = seq.filter((n) => !badSet.has(n));
    return good[offset - 1] ?? null;
  }

  const peekNext = () => peekAt(1);
  const peekNext2 = () => peekAt(2);

  /** 历史栈中从栈顶数第 offset 个好格（跳过后来被拉黑的记录，不弹出） */
  function historyPeek(offset) {
    let seen = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (!badSet.has(history[i]) && ++seen === offset) return history[i];
    }
    return null;
  }

  /** 弹出栈顶最近的好格（顺带丢弃途中已拉黑的记录） */
  function historyPop() {
    while (history.length) {
      const n = history.pop();
      if (!badSet.has(n)) return n;
    }
    return null;
  }

  /** 当前格入栈，供「上一格」回退（前进切换前调用） */
  function pushHistory() {
    if (activeIdx) history.push(activeIdx);
  }

  const peekPrev = () => historyPeek(1);
  const peekPrev2 = () => historyPeek(2);

  /** 前进到下一个好格（消费游标），全部失效返回 null */
  function advance() {
    let guard = NUMBERS.length + 1;
    do {
      if (roundPos + 1 < round.length) {
        roundPos++;
      } else {
        round =
          nextRound ||
          newRound(round.length ? round[round.length - 1] : null);
        nextRound = null;
        roundPos = 0;
      }
      if (--guard <= 0) return null;
    } while (badSet.has(round[roundPos]));
    return round[roundPos];
  }

  /* ---------- 帧级追踪（目标 82 帧） ---------- */
  function trackToTarget(v, token) {
    if (typeof v.requestVideoFrameCallback === "function") {
      const tick = (now, meta) => {
        if (token !== frameToken) return;
        if (state === State.RESUME) return;
        if (v.duration && meta.mediaTime >= v.duration - 0.05) return;

        if (meta.mediaTime >= TARGET_SEC) {
          v.pause();
          onReachedTarget(v);
          return;
        }
        v.requestVideoFrameCallback(tick);
      };
      v.requestVideoFrameCallback(tick);
    } else {
      // 降级：使用 requestAnimationFrame 与屏幕刷新率同步
      const poll = () => {
        if (token !== frameToken) return;
        if (v.currentTime >= TARGET_SEC) {
          if (state === State.INSERT) {
            v.pause();
            onReachedTarget(v);
          }
          return;
        }
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    }
  }

  function onReachedTarget(v) {
    if (state === State.INSERT) {
      disarmLoadGuard();
      v.pause();
      v.muted = true; // 兜底：个别内核（如 X5）pause 后声轨可能仍继续输出
      state = State.PAUSED;
      preloadNext();
    }
  }

  /* ---------- 预缓存 ---------- */
  function preloadNext(dir = 1) {
    const nextIdx = dir < 0 ? peekPrev() : peekNext();
    if (nextIdx == null) return;
    const v = inactiveVideo();
    const url = videoUrl(nextIdx);

    if (v.getAttribute("src") !== url) {
      try {
        v.src = url;
        v.dataset.idx = String(nextIdx); // 错误事件需反查编号
      } catch (e) {}
    }
    warmSecond(dir);
  }

  function warmSecond(dir = 1) {
    const idx2 = dir < 0 ? peekPrev2() : peekNext2();
    if (idx2 == null) return;
    const url2 = videoUrl(idx2);
    if (secondWarm && secondWarm.getAttribute("href") === url2) return;
    if (secondWarm) secondWarm.remove();
    secondWarm = document.createElement("link");
    secondWarm.rel = "preload";
    secondWarm.as = "video";
    secondWarm.href = url2;
    document.head.appendChild(secondWarm);
  }

  /* ---------- 加载超时卫兵 ---------- */
  function armLoadGuard(idx) {
    clearTimeout(loadGuard);
    loadGuard = setTimeout(() => {
      if (badSet.has(idx)) return;
      badSet.add(idx); // 迟迟无响应视为坏格，静默跳过
      const v = activeVideo();
      if (!started || parseInt(v.dataset.idx, 10) !== idx) return;
      if (!anyGoodLeft()) {
        haltAllDead();
        return;
      }
      pending = [1];
      lastPressAt = Date.now();
      drain();
    }, LOAD_TIMEOUT);
  }

  function disarmLoadGuard() {
    clearTimeout(loadGuard);
  }

  /* ---------- 全部素材失效的兜底 ---------- */
  function haltAllDead() {
    disarmLoadGuard();
    [videoA, videoB].forEach((v) => {
      try {
        v.pause();
      } catch (e) {}
      v.onended = null;
    });
    setDisabled(btnPrev, true);
    setDisabled(btnNext, true);
    if (allDeadTip) allDeadTip.hidden = false; // 明确告知素材已全部失效，而非静默黑屏
  }

  /* ---------- 媒体错误 → 静默跳过 ---------- */
  function onMediaError(v) {
    const idx = parseInt(v.dataset.idx, 10) || 0;
    if (idx) badSet.add(idx);
    // 非当前放映画面（预缓存目标出错）：仅标记，不打扰
    if (!started || v !== activeVideo()) return;
    if (!anyGoodLeft()) {
      haltAllDead();
      return;
    }
    pending = [1]; // 当前格已坏，强制向前跳一格
    lastPressAt = Date.now();
    drain();
  }

  /* ---------- 播放核心 ---------- */
  function startPlayback(v, idx, from82) {
    const token = ++frameToken;
    activeIdx = idx;
    v.dataset.idx = String(idx);
    updateReelCode(idx);
    state = from82 ? State.RESUME : State.INSERT;

    v.onended = () => {
      if (v !== activeVideo()) return;
      handleEnded(v);
    };

    const url = videoUrl(idx);
    if (v.getAttribute("src") !== url) {
      v.pause();
      v.src = url;
    } else if (v.ended) {
      // 上次播放已到结尾：部分内核直接重播会无声，强制重新加载
      v.pause();
      v.removeAttribute("src");
      v.load();
      v.src = url;
    }
    v.currentTime = from82 ? TARGET_SEC : 0;
    armLoadGuard(idx);

    v.muted = false; // 解除冻结时的静音兜底，恢复声轨
    v.volume = 1;
    swallow(v.play());

    if (!from82) {
      trackToTarget(v, token);
    }
  }

  function handleEnded(v) {
    disarmLoadGuard();
    if (state === State.SWITCHING) return;

    if (state === State.INSERT) {
      if (pending.length > 0) {
        drain();
        return;
      }
      state = State.PAUSED;
      preloadNext();
      return;
    }

    if (state !== State.RESUME) return;
    drain();
  }

  function drain() {
    const dir = pending.shift();
    if (dir === undefined) {
      // 兜底（正常不会到这里）：回到正常放映，重播当前插入动画停在 82 帧
      const v = activeVideo();
      startPlayback(v, activeIdx, false);
      preloadNext(1);
      return;
    }
    // 已松手（距最后一次按键超过 PRESS_GAP）：当前这一步照走，剩余队列作废
    if (Date.now() - lastPressAt > PRESS_GAP) {
      pending.length = 0;
    }
    state = State.SWITCHING;

    let targetIdx;
    if (dir < 0) {
      targetIdx = historyPop(); // 真实回退：弹出上一格（可跨轮）
      if (targetIdx === null) {
        pending.length = 0;
        const v = activeVideo();
        startPlayback(v, activeIdx, false);
        preloadNext(1);
        syncControlState();
        return;
      }
    } else {
      pushHistory(); // 当前格入栈，供之后「上一格」回退
      targetIdx = advance();
      if (targetIdx == null) {
        haltAllDead();
        return;
      }
    }

    const chain = pending.length > 0;
    syncControlState();
    switchTo(targetIdx, chain, dir);
  }

  function switchTo(idx, from82, dir) {
    const outV = activeVideo();
    try {
      outV.pause();
    } catch (e) {}
    outV.onended = null;

    const nextV = inactiveVideo();
    setActive(nextV);
    startPlayback(nextV, idx, from82);
    preloadNext(dir);
  }

  /* ---------- 前进 / 后退 ---------- */
  function step(dir) {
    if (state === State.BOOT || state === State.SWITCHING) return;
    if (started && !anyGoodLeft()) return;

    pending.push(dir);
    lastPressAt = Date.now(); // 记录本次按键，drain 时判断是否已松手
    const v = activeVideo();

    if (state === State.PAUSED) {
      const frozenAtEnd = v.duration && v.currentTime >= v.duration - 0.05;
      if (frozenAtEnd) {
        drain();
        return;
      }
      state = State.RESUME;
      v.muted = false; // 解除冻结静音，拔片声恢复正常
      swallow(v.play());
      return;
    }

    if (state === State.INSERT) {
      state = State.RESUME;
      v.currentTime = TARGET_SEC;
      swallow(v.play());
      return;
    }
  }

  const goNext = () => step(1);
  const goPrev = () => step(-1);

  /* ---------- 入场 ---------- */
  async function beginScreening() {
    if (started || booting) return;
    booting = true;

    // 探测未完成时给出轻量加载反馈，避免点击后无响应感
    if (!detectDone && !startBtn.disabled) {
      startBtn.disabled = true;
      startBtn.classList.add("loading");
      const loadingLabel = startBtn.querySelector(".btn-text");
      if (loadingLabel) loadingLabel.textContent = "加载中…";
    }

    const count = await detectPromise;

    startBtn.classList.remove("loading");
    const label = startBtn.querySelector(".btn-text");
    if (count === 0) {
      booting = false;
      showNoMaterial(); // 恢复/保持「暂无影片」态
      return;
    }
    if (label) label.textContent = "开始放映";
    startBtn.disabled = false;
    SP_COUNT = count;
    NUMBERS = Array.from({ length: SP_COUNT }, (_, i) => i + 1);
    padW = Math.max(2, String(SP_COUNT).length); // 边缘码补零位数对齐总数
    started = true;

    // 开启背景音乐（已恢复的静音偏好保持生效）
    bgm.volume = 0.75;
    swallow(bgm.play());

    overlay.classList.add("faded");
    setTimeout(() => overlay.classList.add("hidden"), 800);

    setTimeout(() => {
      ensureRound();
      syncControlState();
      controls.classList.remove("hidden"); // 开始放映后显示底部控制区
      rcTotal.textContent = "/ " + pad2(SP_COUNT);
      reelCode.classList.add("on");
      const v = videoA;
      setActive(v);
      startPlayback(v, round[roundPos], false);
      preloadNext();
    }, 220);
  }

  /* ---------- 媒体事件 ---------- */
  [videoA, videoB].forEach((v) => {
    v.addEventListener("error", () => onMediaError(v));
    v.addEventListener("playing", () => {
      disarmLoadGuard();
    });
  });

  /* ---------- 事件绑定 ---------- */
  startBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    beginScreening();
  });

  // 统一在 #theater 上监听全局点击
  let swiped = false;
  theater.addEventListener("click", () => {
    if (state === State.BOOT || swiped) {
      swiped = false;
      return;
    }
    goNext();
  });

  /* ---------- 背景音开关（按钮与 M 键共用；图标由 play/pause 事件驱动） ---------- */
  const BGM_MUTED_KEY = "filmalbum.bgm-muted"; // 记忆用户静音偏好

  // Lucide 风格 stroke 图标数据（多子路径单 d，morphicons 消费后 spring 形变）
  const ICON_SOUND_D =
    "M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298zM16 9a5 5 0 0 1 0 6M19.364 18.364a9 9 0 0 0 0-12.728";
  const ICON_MUTE_D =
    "M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298zM22 9l-6 6M16 9l6 6";

  // morph-icon 降级兜底：file:// 直开时 ES module 被 CORS 拦截，
  // <morph-icon> 未注册为自定义元素 → BGM 钮空壳。此时改由静态 SVG 直绘同款 path。
  const glyphFallback = { active: false };

  function drawGlyphFallback(el, d) {
    if (!el || !glyphFallback.active || !d) return;
    el.innerHTML =
      '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor"' +
      ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="' + d + '"/></svg>';
  }

  window.addEventListener("load", () => {
    if (customElements.get("morph-icon")) return; // module 正常，自定义元素自会渲染
    glyphFallback.active = true;
    syncBgmIcon(); // 复用同步函数：带出当前实际出声态并触发兜底重绘
  });

  /** 以「实际是否出声」为准同步喇叭图标（自动播放被拦截时不会假亮） */
  function syncBgmIcon() {
    const audible = !bgm.muted && !bgm.paused;
    btnBgm.classList.toggle("off", !audible);
    btnBgm.setAttribute("aria-pressed", String(audible));
    const morphIcon = btnBgm.querySelector("morph-icon");
    if (morphIcon) {
      const d = audible ? ICON_SOUND_D : ICON_MUTE_D;
      morphIcon.setAttribute("icon", d);
      drawGlyphFallback(morphIcon, d);
    }
  }

  function toggleBgm() {
    if (btnBgm.classList.contains("disabled")) return; // BGM 文件缺失
    bgm.muted = !bgm.muted;
    if (!bgm.muted && bgm.paused) swallow(bgm.play());
    try {
      localStorage.setItem(BGM_MUTED_KEY, bgm.muted ? "1" : "0");
    } catch (e) {}
    syncBgmIcon();
  }

  bgm.addEventListener("error", () => {
    setDisabled(btnBgm, true); // BGM 文件缺失：禁用开关
  });
  bgm.addEventListener("play", syncBgmIcon);
  bgm.addEventListener("pause", syncBgmIcon);

  // 恢复上次会话的静音偏好
  try {
    if (localStorage.getItem(BGM_MUTED_KEY) === "1") bgm.muted = true;
  } catch (e) {}
  syncBgmIcon();

  /* ---------- 底部控制按钮 ---------- */
  btnPrev.addEventListener("click", (e) => {
    e.stopPropagation();
    goPrev();
  });
  btnNext.addEventListener("click", (e) => {
    e.stopPropagation();
    goNext();
  });
  btnBgm.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleBgm();
  });

  /* ---------- 边界状态：无历史可回退时禁用「上一个」 ---------- */
  /** 真实 disabled 属性 + 样式类同步：屏幕阅读器可感知、不可聚焦、不触发点击 */
  function setDisabled(btn, dis) {
    btn.classList.toggle("disabled", dis);
    btn.disabled = dis;
  }

  function syncControlState() {
    setDisabled(btnPrev, history.length === 0);
  }

  // 键盘快捷键（带修饰键的组合留给浏览器，如 Alt+←/→ 前进后退）
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.code === "Space") {
      // 未开演或焦点在「开始放映」上时不劫持空格，保留其原生按钮激活行为
      if (!started || document.activeElement === startBtn) return;
      e.preventDefault();
      goNext();
      return;
    }
    if (e.key === "ArrowRight") goNext();
    if (e.key === "ArrowLeft") goPrev();
    if (e.key === "m" || e.key === "M") {
      toggleBgm();
    }
  });

  // 触控手势绑定到 #theater（隔离边缘返回，且 pointer-events 不会被 video 拦截）
  let touchStart = null;

  theater.addEventListener(
    "touchstart",
    (e) => {
      const t = e.changedTouches[0];
      touchStart = { x: t.clientX, y: t.clientY };
      swiped = false;
    },
    { passive: true },
  );

  theater.addEventListener(
    "touchend",
    (e) => {
      if (!touchStart) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - touchStart.x;
      const dy = t.clientY - touchStart.y;
      touchStart = null;

      if (Math.abs(dx) < 35 || Math.abs(dx) < Math.abs(dy)) return; // 判定为有效横划
      swiped = true; // 抑制随后触发的 click
      if (dx < 0) goNext();
      else goPrev();
    },
    { passive: true },
  );

  /* ---------- 初始状态 ---------- */
  state = State.BOOT;
})();
