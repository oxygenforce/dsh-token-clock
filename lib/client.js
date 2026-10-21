/**
 * dsh-token-clock — 客户端半边
 *
 * 在每条已完成回答的官方动作行（复制/赞踩/分支图标 + 结束时间）末尾，追加常驻读数：
 *
 *     [复制][赞踩][…]  20:10  8.6K tok · 42秒
 *
 * 并在回答正文与这一行之间画一条 1px 的淡色分隔线（跟随主题边框色，低透明度）。
 *
 * 数据来源（都是宿主已经算好、随快照发布的值，本插件不订阅会话事件也不重放日志）：
 *   · Token：TurnLocation.data 里 `turn-tail` 节点发布的 `tokenUsage`
 *            （TurnTokenUsage：uncachedInputTokens / outputTokens / totalTokens / cache* / reasoning）；
 *            窗口化历史里该节点可能缺席，此时退回 closing.usage 的采样用量。
 *   · 耗时：turn/start 事件 → closing assistant/message 事件的时间差（Unix epoch ms）。
 *
 * 渲染位置：`conversation.chat.turnTail` 列表座位（每条已完成回合一次，位于回答正文与官方
 * 复制/分支图标行之间）。官方只在 hover 时隐藏图标行（.actions），tail 区常驻可见，
 * 所以这行读数无需悬停即可看到；鼠标悬停时通过 title 给出精确分解。
 */

window.__ModuleLoader__.load({
  id: "dsh-token-clock",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const ReactDOM = (() => {
      try {
        return require("react-dom");
      } catch {
        return null;
      }
    })();

    const NS = "dsh-token-clock";
    const SLOT = "conversation.chat.turnTail";
    const ENTRY_ID = "dsh-token-clock";
    const ORDER = -10;

    const TOKEN_BASE = 1000;
    const TOKEN_BASE_SQUARED = 1000000;

    // ── 文案 ────────────────────────────────────────────────────────────────
    // 占位符是宿主 locale 的插值语法；tok 与官方 TurnUsage 芯片保持同一缩写。
    const MESSAGES_ZH = {
      "tokens": "{count} tok",
      "durationSeconds": "{seconds}秒",
      "durationMinutes": "{minutes}分{seconds}秒",
      "tooltipTitle": "本轮用量",
      "tooltipTotal": "总计 {total} tok",
      "tooltipInput": "未缓存输入 {count}",
      "tooltipCacheRead": "缓存读取 {count}",
      "tooltipCacheWrite": "缓存写入 {count}",
      "tooltipOutput": "输出 {count}",
      "tooltipReasoning": "（其中推理 {count}）",
      "tooltipDuration": "回答耗时 {duration}",
      "ariaTokens": "本轮 Token 用量 {tokens}",
      "ariaDuration": "回答耗时 {duration}",
      "sessionTotal": "共 {count} tok",
      "tooltipSession": "本会话累计 {total} tok",
      "ariaSession": "本会话累计 {tokens}",
      "listSeparator": "，",
    };

    const MESSAGES_EN = {
      "tokens": "{count} tok",
      "durationSeconds": "{seconds}s",
      "durationMinutes": "{minutes}m {seconds}s",
      "tooltipTitle": "Turn usage",
      "tooltipTotal": "Total {total} tok",
      "tooltipInput": "Uncached input {count}",
      "tooltipCacheRead": "Cached input {count}",
      "tooltipCacheWrite": "Cache write {count}",
      "tooltipOutput": "Output {count}",
      "tooltipReasoning": " ({count} reasoning)",
      "tooltipDuration": "Answer duration {duration}",
      "ariaTokens": "Token usage this turn {tokens}",
      "ariaDuration": "Answer duration {duration}",
      "sessionTotal": "{count} tok total",
      "tooltipSession": "Session total {total} tok",
      "ariaSession": "Session total {tokens}",
      "listSeparator": ", ",
    };

    /** 极简兜底插值：只在宿主没有把 t 注入到组件 props 时使用。 */
    function interpolate(template, params) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (
        params && Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
      ));
    }

    function makeDictionary(dictionary) {
      return function t(key, params) {
        const template = Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : key;
        return interpolate(template, params);
      };
    }

    const fallbackT = makeDictionary(MESSAGES_ZH);

    // ── 数值 ────────────────────────────────────────────────────────────────

    /** 非负有限数；其它（undefined / null / NaN / 负数）返回 undefined。 */
    function count(value) {
      const numeric = typeof value === "number" ? value : (typeof value === "string" && value.trim() !== "" ? Number(value) : NaN);
      return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
    }

    /** 紧凑读数，与官方数字族同构：8.6K / 120K / 1.2M。 */
    function compactCount(value) {
      const scaled = (candidate) => (candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10));
      if (value < TOKEN_BASE) return String(Math.round(value));
      if (value < TOKEN_BASE_SQUARED) return `${scaled(value / TOKEN_BASE)}K`;
      return `${scaled(value / TOKEN_BASE_SQUARED)}M`;
    }

    /** 精确读数：千位分组，给 title 用。 */
    function exactCount(value) {
      const digits = String(Math.round(value));
      const groups = [];
      for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end));
      return groups.join(",");
    }

    /** 耗时读数：<10s 保留一位小数，<60s 取整，更长走 分+秒。 */
    function formatDuration(ms, t) {
      const seconds = ms / 1000;
      if (seconds < 9.95) return t("durationSeconds", { seconds: String(Math.round(seconds * 10) / 10) });
      if (seconds < 59.5) return t("durationSeconds", { seconds: String(Math.round(seconds)) });
      const whole = Math.round(seconds);
      const minutes = Math.floor(whole / 60);
      const rest = whole % 60;
      return t("durationMinutes", { minutes: String(minutes), seconds: rest < 10 ? `0${rest}` : String(rest) });
    }

    // ── 数据提取 ────────────────────────────────────────────────────────────

    function readTurnTail(turn) {
      try {
        const data = turn?.data;
        if (!data || typeof data.get !== "function") return undefined;
        return data.get("turn-tail");
      } catch {
        return undefined;
      }
    }

    /**
     * 归一化一轮的 Token 用量。
     * 优先 turn-tail 节点上的 TurnTokenUsage；缺席时退回 closing assistant 的采样 usage。
     * 总量为 0 或全无字段时返回 null（不显示无意义的 0 tok）。
     */
    function readUsage(tail) {
      if (tail === null || typeof tail !== "object") return null;
      const direct = tail.tokenUsage;
      if (direct && typeof direct === "object") {
        const normalized = normalizeTokens(direct, false);
        if (normalized !== null) return normalized;
      }
      const sampled = tail.closing && typeof tail.closing === "object" ? tail.closing.usage : undefined;
      if (sampled && typeof sampled === "object") return normalizeTokens(sampled, true);
      return null;
    }

    function normalizeTokens(raw, sampled) {
      const input = sampled ? (count(raw.inputTokens) ?? count(raw.uncachedInputTokens)) : count(raw.uncachedInputTokens);
      const cacheRead = count(raw.cacheReadTokens);
      const cacheWrite = count(raw.cacheWriteTokens);
      const output = count(raw.outputTokens);
      const reasoning = count(raw.reasoningTokens);
      const knownTotal = count(raw.totalTokens);
      const total = knownTotal ?? ((input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) + (output ?? 0));
      if (!(total > 0)) return null;
      return { total, input, cacheRead, cacheWrite, output, reasoning };
    }

    /** 一轮的墙钟耗时（毫秒）。起点缺席（窗口化历史）时退回首个 step/start。 */
    function readDurationMs(turn, tail) {
      try {
        const start = count(turn?.start?.time) ?? count(turn?.steps?.[0]?.start?.time);
        const end = count(tail?.closing?.time) ?? count(turn?.end?.time);
        if (start === undefined || end === undefined) return null;
        const ms = end - start;
        return ms > 0 ? ms : null;
      } catch {
        return null;
      }
    }

    // ── 组件 ────────────────────────────────────────────────────────────────

    // 官方动作行容器自身带 data-clock="end"（MessageIconActions 的根 div）；
    // 往它的末端 portal，读数就落在“20:10”这类结束时间之后，与图标行同排。
    const ACTIONS_ROW_SELECTOR = '[data-clock="end"]';

    /**
     * 横线视觉居中：找到正文块（上一段 flow item）的底边，把它到线的距离
     * 和线到动作行的距离拉平。用 transform 位移，不写 margin —— 布局高度不变，
     * 新回答流式渲染时不会引起滚动位置跳动。
     */
    // 横线位置：固定贴在官方图标行上方 RULE_GAP 像素。
    // 不再“取上下空白的中点”——动作行上方会插进官方的“已完成，用时 Xs”折叠行，
    // 用中点算会把线顶得太高。这里改用图标行作为唯一基准，位置稳定可预期。
    const RULE_GAP = 15;

    function centerRule(rule, tailRoot, actionsRow) {
      if (rule === null || actionsRow === null) return;
      try {
        // 先清掉上一次的位移再量，避免量到“已经位移过”的位置反复漂移。
        rule.style.transform = "";
        const ruleRect = rule.getBoundingClientRect();
        const rowRect = actionsRow.getBoundingClientRect();
        const targetTop = rowRect.top - RULE_GAP;
        const delta = Math.round(targetTop - ruleRect.top);
        if (!Number.isFinite(delta)) return;
        rule.style.transform = delta === 0 ? "" : `translateY(${Math.max(-60, Math.min(60, delta))}px)`;
      } catch {
        /* 布局异常时保留样式表里的兜底位置 */
      }
    }

    // ── 跟随底部 ────────────────────────────────────────────────────────────
    // 宿主在“读者自己滚动过”之后会停止跟随并记住阅读位置；个别时候新指令已经出现，
    // 视图却仍停在上一屏，新回答就落到屏幕外。这里只在「新指令出现」这一个时刻检查：
    // 如果离底部还有明显距离，就补一次贴底（不改变宿主自己的跟随策略）。
    function scrollHostAncestor(node) {
      let el = node;
      while (el !== null && el !== document.body) {
        const style = getComputedStyle(el);
        const scrollable = /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
        if (scrollable) return el;
        el = el.parentElement;
      }
      return null;
    }

    function stickToBottomOnNewInstruction() {
      const follow = () => {
        try {
          const row = document.querySelector("[data-chat-flow-kind='user']");
          if (row === null) return;
          const scroller = scrollHostAncestor(row);
          if (scroller === null) return;
          const floor = scroller.scrollHeight - scroller.clientHeight;
          // 小于 40px 视为“本来就贴底”，不做任何事，避免和宿主的平滑滚动抢位置。
          if (floor - scroller.scrollTop <= 40) return;
          scroller.scrollTop = floor;
        } catch { /* ignore */ }
      };
      let observer = null;
      try {
        observer = new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (node.nodeType !== 1) continue;
              if (node.matches?.("[data-chat-flow-kind='user']") === true) {
                requestAnimationFrame(() => setTimeout(follow, 120));
              }
            }
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
      } catch { /* ignore */ }
      return () => observer?.disconnect();
    }

    function TurnMetrics(props) {
      const t = typeof props?.t === "function" ? props.t : fallbackT;
      // 会话累计用量：宿主提供的 tokenUsage 会话投影（整条日志的 token 总和），
      // 随流式生成实时变化。hook 顺序稳定（typeof 取决于固定的 props 形状）。
      const useProjection = typeof props?.useProjection === "function" ? props.useProjection : null;
      const sessionUsage = useProjection === null ? undefined : useProjection("tokenUsage");
      let layout = null;
      try {
        layout = buildLayout(props, t, sessionUsage);
      } catch {
        layout = null;
      }

      // 先无条件调用 hooks，再决定是否渲染：同一回合内数据可能从无到有，
      // 条件式跳过 hooks 会破坏 hook 顺序。
      const hasData = layout !== null;
      const anchorRef = React.useRef(null);
      const ruleRef = React.useRef(null);
      const [row, setRow] = React.useState(null);

      React.useEffect(() => {
        if (!hasData) return;
        const anchor = anchorRef.current;
        if (!anchor || typeof anchor.closest !== "function") return;
        const tailRoot = anchor.closest("[data-turn-tail]");
        const actionsRow = tailRoot === null ? null : tailRoot.querySelector(ACTIONS_ROW_SELECTOR);
        if (actionsRow !== null) setRow(actionsRow);
      }, [hasData]);
      // 会话总量变化后标题/aria 里的大数也要跟着走，这里不额外建 effect。

      React.useEffect(() => {
        if (row === null) return;
        const tailRoot = row.closest("[data-turn-tail]");
        centerRule(ruleRef.current, tailRoot, row);
        // 聊天区有 .16s 的间距过渡，挂载瞬间量到的可能还是动画中间值，
        // 过渡结束后再量一次；只改 transform，不会引起排版跳动。
        const settle = setTimeout(() => centerRule(ruleRef.current, tailRoot, row), 260);
        return () => clearTimeout(settle);
      }, [row]);

      if (!hasData) return null;

      const metrics = h(
        "span",
        {
          className: "dtc-metrics",
          "data-dsh-token-clock": "",
          role: "group",
          "aria-label": layout.ariaLabel,
          title: layout.title,
        },
        layout.children,
      );

      const ported = row !== null && ReactDOM !== null && typeof ReactDOM.createPortal === "function"
        ? ReactDOM.createPortal(metrics, row)
        : null;

      return h(
        React.Fragment,
        null,
        h("div", { className: "dtc-rule", ref: ruleRef, role: "separator", "aria-hidden": "true" }),
        h(
          "span",
          {
            ref: anchorRef,
            className: "dtc-anchor",
            style: ported === null ? undefined : { display: "none" },
          },
          ported === null ? metrics : ported,
        ),
      );
    }

    function sessionTotalOf(sessionUsage) {
      if (sessionUsage === undefined || sessionUsage === null || typeof sessionUsage !== "object") return undefined;
      const input = count(sessionUsage.uncachedInputTokens) ?? 0;
      const read = count(sessionUsage.cacheReadTokens) ?? 0;
      const write = count(sessionUsage.cacheWriteTokens) ?? 0;
      const output = count(sessionUsage.outputTokens) ?? 0;
      const total = input + read + write + output;
      return total > 0 ? total : undefined;
    }

    function buildLayout(props, t, sessionUsage) {
      const turn = props?.turn;
      if (turn === undefined || turn === null) return null;

      const tail = readTurnTail(turn);
      const usage = readUsage(tail);
      const durationMs = readDurationMs(turn, tail);
      if (usage === null && durationMs === null) return null;

      const tokenLabel = usage === null ? null : t("tokens", { count: compactCount(usage.total) });
      const durationLabel = durationMs === null ? null : formatDuration(durationMs, t);
      const sessionTotal = sessionTotalOf(sessionUsage);
      const sessionLabel = sessionTotal === undefined ? null : t("sessionTotal", { count: compactCount(sessionTotal) });

      const children = [];
      if (tokenLabel !== null) children.push(h("span", { key: "tokens", className: "dtc-part" }, tokenLabel));
      if (tokenLabel !== null && durationLabel !== null) children.push(h("span", { key: "sep", className: "dtc-sep", "aria-hidden": "true" }, "·"));
      if (durationLabel !== null) children.push(h("span", { key: "duration", className: "dtc-part" }, durationLabel));
      if (sessionLabel !== null) {
        children.push(h("span", { key: "sep-session", className: "dtc-sep", "aria-hidden": "true" }, "·"));
        children.push(h("span", { key: "session", className: "dtc-part dtc-session" }, sessionLabel));
      }

      const ariaParts = [];
      if (tokenLabel !== null) ariaParts.push(t("ariaTokens", { tokens: tokenLabel }));
      if (durationLabel !== null) ariaParts.push(t("ariaDuration", { duration: durationLabel }));
      if (sessionLabel !== null) ariaParts.push(t("ariaSession", { tokens: sessionLabel }));

      return {
        children,
        ariaLabel: ariaParts.join(t("listSeparator")),
        title: buildTooltip(usage, durationLabel, sessionTotal, t),
      };
    }

    /** 悬停提示：标题 + 精确总量与分桶 + 耗时，空行分段。缺项自动省略。 */
    function buildTooltip(usage, durationLabel, sessionTotal, t) {
      const lines = [];
      if (usage !== null) {
        lines.push(t("tooltipTitle"));
        const buckets = [t("tooltipTotal", { total: exactCount(usage.total) })];
        if (usage.input !== undefined) buckets.push(t("tooltipInput", { count: exactCount(usage.input) }));
        if (usage.cacheRead !== undefined) buckets.push(t("tooltipCacheRead", { count: exactCount(usage.cacheRead) }));
        if (usage.cacheWrite !== undefined) buckets.push(t("tooltipCacheWrite", { count: exactCount(usage.cacheWrite) }));
        if (usage.output !== undefined) {
          const reasoning = usage.reasoning === undefined ? "" : t("tooltipReasoning", { count: exactCount(usage.reasoning) });
          buckets.push(`${t("tooltipOutput", { count: exactCount(usage.output) })}${reasoning}`);
        }
        lines.push(buckets.join(" · "));
      }
      if (durationLabel !== null) lines.push(t("tooltipDuration", { duration: durationLabel }));
      return lines.join("\n");
    }

    // ── 样式 ────────────────────────────────────────────────────────────────

    const STYLE_ID = "dsh-token-clock";
    const STYLE_CSS = `
.dtc-rule {
  width: 100%;
  height: 1px;
  /* 位置由 centerRule() 量出来的 translateY 决定，这里不再预留 margin */
  margin-top: 0;
  border-radius: 1px;
  background: var(--dsw-alias-border-l2);
  opacity: 0.72;
}
.dtc-metrics {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: 7px;
  font-size: calc(var(--dsh-content-font-size-secondary, 13px) + 1.5px);
  line-height: calc(20px + var(--dsh-content-font-delta, 0px));
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  user-select: none;
  cursor: default;
  letter-spacing: 0.01em;
}
.dtc-metrics:hover {
  color: var(--dsw-alias-label-primary);
}
.dtc-part {
  display: inline-flex;
  align-items: baseline;
  gap: 3px;
}
.dtc-sep {
  opacity: 0.4;
}
.dtc-session {
  opacity: 0.86;
}
/* 读数常驻：官方只在“最后一条回答”常显动作行，其余回合需悬停；
   这里仅对含本插件读数的动作行强制显示（不影响其他回合）。 */
[data-turn-tail]:has([data-dsh-token-clock]) [data-clock="end"] {
  opacity: 1 !important;
}
`;

    function ensureStyle(doc) {
      if (doc.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return () => {};
      const style = doc.createElement("style");
      style.setAttribute("data-plugin-css", STYLE_ID);
      style.textContent = STYLE_CSS;
      doc.head.appendChild(style);
      return () => {
        style.remove();
      };
    }


    // ── 临时诊断（定位滚动跟随问题，定位后删除）────────────────────────────
    /**
     * 内容“先撑高、再塌陷”会把跟随打断：宿主按撑高后的底部发起平滑滚动，
     * 元素塌陷后目标失效，滚动停在半路（实测停在离底部 200~800px 处，
     * 看起来就像“界面回到我指令的底部”）。
     *
     * 判据：
     *   1) 最近 1 秒内滚动高度比现在高过 20px 以上（发生过塌陷），或位置在无操作时突跳；
     *   2) 塌陷前视图本来就贴着底部（dist ≤ 4）；
     *   3) 不是读者自己滚出来的（wheel / 方向键 300ms 内的滚动才算读者意图）。
     * 三条都成立才补一次贴底。
     */
    function healCollapsedFollow() {
      let scroller = null;
      let samples = [];            // { floor, dist }
      const SAMPLE_WINDOW = 10;
      let healing = false;
      let intentAt = 0;            // 最近一次“读者意图”时间（wheel / 方向键）

      const measure = () => {
        if (scroller === null) return null;
        const floor = scroller.scrollHeight - scroller.clientHeight;
        return { floor, dist: floor - scroller.scrollTop };
      };
      const push = (now) => {
        const m = measure();
        if (m === null) return;
        samples.push(m);
        if (samples.length > SAMPLE_WINDOW) samples.shift();
        if (now === undefined) return;
      };

      const snap = () => {
        if (scroller === null) return;
        healing = true;
        scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
        requestAnimationFrame(() => {
          if (scroller !== null) scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
          setTimeout(() => { healing = false; }, 120);
        });
        samples = [];
      };

      const evaluate = () => {
        const m = measure();
        if (m === null) return;
        const peak = samples.reduce((max, s) => Math.max(max, s.floor), m.floor);
        const wasFollowing = samples.some((s) => s.dist <= 4);
        const collapsed = peak - m.floor > 20;
        samples.push(m);
        if (samples.length > SAMPLE_WINDOW) samples.shift();
        if (healing) return;
        if (!collapsed || !wasFollowing) return;
        if (Date.now() - intentAt < 300) return;
        snap();
      };

      const onScroll = () => {
        if (healing) return;
        if (Date.now() - intentAt < 300) { push(); return; }  // 读者自己滚的，只记录
        evaluate();                                            // 程序/布局引起的滚动：检查是否掉队
      };
      const onIntent = () => { intentAt = Date.now(); };

      const attach = () => {
        const flowNode = document.querySelector("[data-chat-flow-kind]");
        const next = flowNode === null ? null : scrollHostAncestor(flowNode);
        if (next === scroller) return;
        if (scroller !== null) {
          scroller.removeEventListener("scroll", onScroll);
          scroller.removeEventListener("wheel", onIntent);
        }
        scroller = next;
        samples = [];
        if (scroller !== null) {
          scroller.addEventListener("scroll", onScroll, { passive: true });
          scroller.addEventListener("wheel", onIntent, { passive: true });
          push();                       // 立即播种：此刻若贴底，就是塌陷前的“在底部”证据
        }
      };
      document.addEventListener("keydown", onIntent, true);

      attach();                          // 不要等第一个 tick，否则塌陷会发生在播种之前
      const timer = setInterval(() => { attach(); evaluate(); }, 200);
      return () => {
        clearInterval(timer);
        document.removeEventListener("keydown", onIntent, true);
        if (scroller !== null) {
          scroller.removeEventListener("scroll", onScroll);
          scroller.removeEventListener("wheel", onIntent);
        }
      };
    }

    // ── 插件体 ──────────────────────────────────────────────────────────────

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        ctx.effect(() => ensureStyle(document), "dsh-token-clock: styles");
        ctx.effect(stickToBottomOnNewInstruction, "dsh-token-clock: follow tail");
        ctx.effect(healCollapsedFollow, "dsh-token-clock: heal collapsed follow");
        ctx.effect(
          () => ctx.locale.register(NS, { zh: MESSAGES_ZH, en: MESSAGES_EN }),
          "dsh-token-clock: dictionaries",
        );
        ctx.slots.inject(SLOT, () => ctx.slots.register(
          { name: SLOT, id: ENTRY_ID, order: ORDER, locale: NS },
          TurnMetrics,
        ));
      },
    };
  },
});
