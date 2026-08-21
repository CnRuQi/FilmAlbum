/* ============================================================
 * 胶片放映机 · 核心控制逻辑
 * ------------------------------------------------------------
 *  - 30fps 固定，暂停点 = 2 秒 22 帧 = 第 82 帧 ≈ 2.7333s
 *  - 伪随机播放：Fisher-Yates 洗牌，一轮 21 张不重复
 *  - 双缓冲 <video> 无缝切换 + 跨轮预缓存
 *  - 触发切换（方向键/点击/滑动）→ 当前视频从 82 帧播到片尾（退出动画）→ 立即接下一个
 *  - 连续切换（快速连按）→ 队列逐个消费，中间素材直接从 82 帧起播，跳过插入动画
 *  - 队列清空后，下一段正常播放插入动画并停在 82 帧
 * ============================================================ */

(() => {
  "use strict";

  /* ---------- 常量 ---------- */
  const SP_COUNT = 21; // 素材总数
  const TARGET_FRAME = 82; // 2s22f @30fps
  const TARGET_SEC = TARGET_FRAME / 30; // ≈ 2.7333

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
  const lampGlow = document.getElementById("lampGlow");
  const bgm = document.getElementById("bgm");
  const btnPrev = document.getElementById("btnPrev");
  const btnBgm = document.getElementById("btnBgm");
  const btnNext = document.getElementById("btnNext");
  const controls = document.getElementById("controls");

  /* ---------- 状态 ---------- */
  let state = State.BOOT;
  let started = false;
  let activeIdx = 0;
  let frameToken = 0; // 帧追踪令牌，防止旧回调干扰
  let secondWarm = null; // 二级预缓存（<link rel="preload">）
  let pending = []; // 待执行切换方向队列（+1 下一个 / -1 上一个）
  let lastPressAt = 0;     // 最近一次按键时间戳（判断是否已松手）
  const PRESS_GAP = 250;   // 距最后一次按键超过该毫秒数视为已松手：只走当前一步

  /* ---------- 伪随机轮次管理 ---------- */
  let round = []; // 当前轮次（1~21 洗牌）
  let roundPos = -1; // 当前在轮次中的位置
  let nextRound = null; // 提前生成下一轮

  const NUMBERS = Array.from({ length: SP_COUNT }, (_, i) => i + 1);

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function newRound() {
    return shuffle([...NUMBERS]);
  }

  function ensureRound() {
    if (round.length === 0) {
      round = newRound();
      roundPos = 0;
    }
  }

  /** 下一个要播的素材编号（不推进游标） */
  function peekNext() {
    if (roundPos + 1 < round.length) return round[roundPos + 1];
    if (!nextRound) nextRound = newRound();
    return nextRound[0];
  }

  /** 下下个要播的素材编号 */
  function peekNext2() {
    if (roundPos + 2 < round.length) return round[roundPos + 2];
    if (!nextRound) nextRound = newRound();
    if (roundPos + 1 < round.length) return nextRound[0];
    return nextRound.length > 1 ? nextRound[1] : nextRound[0];
  }

  /** 回退方向的素材 */
  function peekPrev() {
    if (roundPos - 1 >= 0) return round[roundPos - 1];
    return peekNext();
  }

  /** 回退方向的下下个素材 */
  function peekPrev2() {
    if (roundPos - 2 >= 0) return round[roundPos - 2];
    if (roundPos - 1 >= 0) return peekNext();
    return peekNext2();
  }

  /** 前进到下一个素材 */
  function advance() {
    if (roundPos + 1 < round.length) {
      roundPos++;
    } else {
      round = nextRound || newRound();
      nextRound = null;
      roundPos = 0;
    }
    return round[roundPos];
  }

  /** 回退到上一个素材 */
  function retreat() {
    if (roundPos <= 0) return null;
    roundPos--;
    return round[roundPos];
  }

  /* ---------- 工具 ---------- */
  const videoUrl = (idx) => `shucai/sp${idx}/s${idx}.mp4`;

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
      v.pause();
      state = State.PAUSED;
      preloadNext();
    }
  }

  /* ---------- 预缓存 ---------- */
  function preloadNext(dir = 1) {
    const nextIdx = dir < 0 ? peekPrev() : peekNext();
    const v = inactiveVideo();
    const url = videoUrl(nextIdx);

    if (v.getAttribute("src") !== url) {
      try {
        v.src = url;
      } catch (e) {}
    }
    warmSecond(dir);
  }

  function warmSecond(dir = 1) {
    const idx2 = dir < 0 ? peekPrev2() : peekNext2();
    const url2 = videoUrl(idx2);
    if (secondWarm && secondWarm.getAttribute("href") === url2) return;
    if (secondWarm) secondWarm.remove();
    secondWarm = document.createElement("link");
    secondWarm.rel = "preload";
    secondWarm.as = "video";
    secondWarm.href = url2;
    document.head.appendChild(secondWarm);
  }

  /* ---------- 播放核心 ---------- */
  function startPlayback(v, idx, from82) {
    const token = ++frameToken;
    activeIdx = idx;
    state = from82 ? State.RESUME : State.INSERT;

    v.onended = () => {
      if (v !== activeVideo()) return;
      handleEnded(v);
    };

    const url = videoUrl(idx);
    if (v.getAttribute("src") !== url) {
      v.pause();
      v.src = url;
    }
    v.currentTime = from82 ? TARGET_SEC : 0;

    const playP = v.play();
    if (playP && playP.catch) pulseNoop(playP);

    if (!from82) {
      trackToTarget(v, token);
    }
  }

  function pulseNoop(p) {
    p.catch(() => {});
  }

  function handleEnded(v) {
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
      targetIdx = retreat();
      if (targetIdx === null) {
        pending.length = 0;
        const v = activeVideo();
        startPlayback(v, activeIdx, false);
        preloadNext(1);
        syncControlState();
        return;
      }
    } else {
      targetIdx = advance();
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
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
      return;
    }

    if (state === State.INSERT) {
      state = State.RESUME;
      v.currentTime = TARGET_SEC;
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
      return;
    }
  }

  const goNext = () => step(1);
  const goPrev = () => step(-1);

  /* ---------- 入场 ---------- */
  function beginScreening() {
    if (started) return;
    started = true;

    // 开启背景音乐
    bgm.volume = 0.5;
    const p = bgm.play();
    if (p && p.catch) p.catch(() => {});

    lampGlow.classList.add("on");
    overlay.classList.add("faded");
    setTimeout(() => overlay.classList.add("hidden"), 800);
    setTimeout(() => lampGlow.classList.add("done"), 1100);

    setTimeout(() => {
      ensureRound();
      syncControlState();
      controls.classList.remove("hidden"); // 开始放映后显示底部控制区
      const v = videoA;
      setActive(v);
      startPlayback(v, round[roundPos], false);
      preloadNext();
    }, 220);
  }

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

  /* ---------- 背景音开关（按钮与 M 键共用） ---------- */
  function toggleBgm() {
    bgm.muted = !bgm.muted;
    if (!bgm.muted && bgm.paused) {
      const playBgm = bgm.play();
      if (playBgm && playBgm.catch) playBgm.catch(() => {});
    }
    btnBgm.classList.toggle("off", bgm.muted);
  }

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

  /* ---------- 边界状态：轮首禁用「上一个」 ---------- */
  function syncControlState() {
    btnPrev.classList.toggle("disabled", roundPos <= 0);
  }

  // 键盘快捷键
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") {
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
