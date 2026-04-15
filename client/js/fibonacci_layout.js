(function initBellForgeFibonacciLayout(globalScope, factory) {
  const exported = factory(globalScope);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = exported;
  }
  globalScope.BellForgeFibonacciLayout = exported;
})(typeof globalThis !== "undefined" ? globalThis : this, function buildBellForgeFibonacciLayout(globalScope) {
  const ORDER_FALLBACK = Number.MAX_SAFE_INTEGER;

  function numericCssValue(value, fallback) {
    const parsed = Number.parseFloat(String(value || "").trim());
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function safeParseJson(raw, fallback) {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  function defaultLogger(options = {}) {
    return {
      enabled: Boolean(options.enabled),
      log(message, data) {
        if (this.enabled && typeof console !== "undefined" && typeof console.log === "function") {
          console.log(`[Fibonacci Layout] ${message}`, data || "");
        }
      },
    };
  }

  function normalizeCardState(cardState = {}) {
    return {
      collapsed: Boolean(cardState.collapsed || cardState.hidden),
      hidden: false,
      order: Number.isFinite(cardState.order) ? Number(cardState.order) : ORDER_FALLBACK,
    };
  }

  function createDefaultTrackResolver(mode) {
    return function resolveTracks(width) {
      if (mode === "status-display") {
        if (width >= 860) return { tracks: 5, maxPerRow: 2 };
        return { tracks: 1, maxPerRow: 1 };
      }
      if (mode === "settings") {
        if (width >= 1180) return { tracks: 10, maxPerRow: 3 };
        if (width >= 620) return { tracks: 5, maxPerRow: 2 };
        return { tracks: 1, maxPerRow: 1 };
      }
      if (width >= 1240) return { tracks: 10, maxPerRow: 3 };
      if (width >= 660) return { tracks: 5, maxPerRow: 2 };
      return { tracks: 1, maxPerRow: 1 };
    };
  }

  function buildRecursiveFibonacciRows(count, maxPerRow) {
    if (count <= 0) {
      return [];
    }
    if (maxPerRow <= 1) {
      return Array(count).fill(1);
    }
    if (count <= maxPerRow) {
      return [count];
    }
    if (maxPerRow === 2) {
      if (count === 3) {
        return [2, 1];
      }
      return [2, ...buildRecursiveFibonacciRows(count - 2, maxPerRow)];
    }
    if (count === 4) {
      return [2, 2];
    }
    if (count === 5) {
      return [3, 2];
    }
    const lead = count % 3 === 1 ? 2 : 3;
    return [lead, ...buildRecursiveFibonacciRows(count - lead, maxPerRow)];
  }

  function ratiosForRowSize(rowSize, tracks) {
    if (rowSize <= 1) return [tracks];
    if (rowSize === 2) return [3, 2];
    return [5, 3, 2];
  }

  function normalizeRatios(ratios, tracks) {
    const total = ratios.reduce((sum, value) => sum + value, 0) || 1;
    const normalized = ratios.map((ratio) => Math.max(1, Math.floor((ratio / total) * tracks)));
    let used = normalized.reduce((sum, value) => sum + value, 0);
    let cursor = 0;
    while (used < tracks) {
      normalized[cursor % normalized.length] += 1;
      used += 1;
      cursor += 1;
    }
    while (used > tracks) {
      const target = normalized.findIndex((value) => value > 1);
      if (target === -1) {
        break;
      }
      normalized[target] -= 1;
      used -= 1;
    }
    return normalized;
  }

  function computeDescriptorWeight(descriptor) {
    if (descriptor.collapsed) {
      return 1;
    }
    if (Number.isFinite(descriptor.explicitWeight)) {
      return Number(descriptor.explicitWeight);
    }
    let weight = 1;
    if (descriptor.hasGraphic) {
      weight = 5;
    } else if (descriptor.isDetailsOpen || descriptor.multilineText > 3 || descriptor.textLength > 220) {
      weight = 3;
    } else if (descriptor.textLength === 0) {
      weight = 0;
    }
    return Math.max(weight, descriptor.priority || 0);
  }

  function sortByImportance(left, right) {
    if (right.priority !== left.priority) {
      return right.priority - left.priority;
    }
    if (right.weight !== left.weight) {
      return right.weight - left.weight;
    }
    if (right.height !== left.height) {
      return right.height - left.height;
    }
    return left.index - right.index;
  }

  function computeLayoutPlan(entries, options = {}) {
    const tracks = Math.max(1, Number(options.tracks) || 1);
    const maxPerRow = Math.max(1, Number(options.maxPerRow) || 1);
    const rowUnit = Math.max(1, Number(options.rowUnit) || 8);
    const preferImportance = options.preferImportance === true;
    const weightedEntries = entries.map((entry, index) => ({
      index,
      key: entry.key,
      card: entry.card,
      collapsed: Boolean(entry.collapsed),
      height: Math.max(rowUnit, Number(entry.height) || rowUnit),
      priority: Number(entry.priority) || 0,
      weight: Number(entry.weight) || 0,
      explicitOrder: Number.isFinite(entry.explicitOrder) ? Number(entry.explicitOrder) : ORDER_FALLBACK,
    }));

    weightedEntries.sort(preferImportance
      ? sortByImportance
      : (left, right) => {
        if (left.explicitOrder !== right.explicitOrder) {
          return left.explicitOrder - right.explicitOrder;
        }
        return left.index - right.index;
      });

    const rows = buildRecursiveFibonacciRows(weightedEntries.length, maxPerRow);
    const items = [];
    let cursor = 0;
    let rowStart = 1;
    rows.forEach((rowSize, rowIndex) => {
      const rowEntries = weightedEntries.slice(cursor, cursor + rowSize);
      const ratios = normalizeRatios(ratiosForRowSize(rowSize, tracks), tracks);
      let colStart = 1;
      let maxRowSpan = 1;
      rowEntries.forEach((entry, itemIndex) => {
        const colSpan = ratios[itemIndex] || 1;
        const rowSpan = Math.max(1, Math.ceil(entry.height / rowUnit));
        maxRowSpan = Math.max(maxRowSpan, rowSpan);
        items.push({
          key: entry.key,
          order: cursor + itemIndex,
          rowIndex,
          rowStart,
          rowSpan,
          colStart,
          colSpan,
          weight: entry.weight,
          height: entry.height,
          collapsed: entry.collapsed,
          priority: entry.priority,
          card: entry.card,
        });
        colStart += colSpan;
      });
      cursor += rowSize;
      rowStart += maxRowSpan;
    });

    return {
      tracks,
      maxPerRow,
      rows,
      items,
    };
  }

  function snapshotFromPlan(plan) {
    return plan.items.map((item) => ({
      key: item.key,
      order: item.order,
      rowIndex: item.rowIndex,
      colStart: item.colStart,
      colSpan: item.colSpan,
      rowSpan: item.rowSpan,
      weight: item.weight,
      collapsed: item.collapsed,
    }));
  }

  function titleForCard(card) {
    const explicitTitle = card.dataset.cardTitle;
    if (explicitTitle) {
      return explicitTitle;
    }
    const heading = card.querySelector("h1, h2, h3");
    return heading ? heading.textContent.trim() : "Card";
  }

  function ensureCardKey(card) {
    if (card.dataset.cardKey) {
      return card.dataset.cardKey;
    }
    const generated = titleForCard(card).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || `card-${Math.random().toString(16).slice(2, 8)}`;
    card.dataset.cardKey = generated;
    return generated;
  }

  function createAdaptiveLayout(options) {
    const container = options.container;
    const cardSelector = options.cardSelector;
    const storageKey = options.storageKey;
    const rowUnit = options.rowUnit || 8;
    const collapsedHeight = options.collapsedHeight || 56;
    const collapsedHeightToken = options.collapsedHeightToken || "--bf-space-6";
    const mode = options.mode || "status";
    const defaultPriorities = options.defaultPriorities || {};
    const trackResolver = options.trackResolver || createDefaultTrackResolver(mode);
    const syncChannel = options.syncChannel || null;
    const logger = options.logger || defaultLogger({
      enabled: typeof localStorage !== "undefined" && localStorage.getItem("bellforge.debug.fibo") === "true",
    });

    if (!container) {
      return {
        recompute() {},
        autoArrange() {},
        applyRemoteState() {},
        emitLayoutSnapshot() {},
        getLayoutCache() { return { columns: 0, rows: [], weights: {}, spans: {}, heights: {} }; },
      };
    }

    container.classList.add("fibo-adaptive-grid");
    container.style.setProperty("--fibo-row-unit", `${rowUnit}px`);

    const cards = Array.from(container.querySelectorAll(cardSelector));
    const state = storageKey && typeof localStorage !== "undefined"
      ? safeParseJson(localStorage.getItem(storageKey) || "{}", {})
      : {};
    let frameToken = 0;
    let pendingAutoArrange = false;
    let isApplyingRemoteState = false;
    let skipPersistOnce = false;
    let dragSourceKey = "";
    const layoutCache = { columns: 0, rows: [], weights: {}, spans: {}, heights: {} };

    function flushCaches() {
      layoutCache.columns = 0;
      layoutCache.rows = [];
      layoutCache.weights = {};
      layoutCache.spans = {};
      layoutCache.heights = {};
    }

    function resolveCollapsedHeight(card) {
      if (typeof getComputedStyle !== "function") {
        return collapsedHeight;
      }
      const localValue = card ? getComputedStyle(card).getPropertyValue(collapsedHeightToken).trim() : "";
      const rootValue = getComputedStyle(document.documentElement).getPropertyValue(collapsedHeightToken).trim();
      return Math.max(rowUnit, Math.round(numericCssValue(localValue || rootValue, collapsedHeight)));
    }

    function currentContainerWidth() {
      return Math.max(0, Math.round(container.clientWidth || container.getBoundingClientRect().width || globalScope.innerWidth || 0));
    }

    function readCardState(card) {
      const key = ensureCardKey(card);
      const normalized = normalizeCardState(state[key] || {});
      state[key] = normalized;
      return normalized;
    }

    function persistState(reason) {
      if (!storageKey || typeof localStorage === "undefined" || isApplyingRemoteState || skipPersistOnce) {
        skipPersistOnce = false;
        return;
      }
      localStorage.setItem(storageKey, JSON.stringify(state));
      logger.log("preview-to-status sync events", { reason, state });
    }

    function writeCardState(card, nextState, reason) {
      const key = ensureCardKey(card);
      state[key] = normalizeCardState({ ...readCardState(card), ...nextState });
      persistState(reason || "card-state");
      logger.log("card state load", { card: key, state: state[key] });
    }

    function titleFor(card) {
      return titleForCard(card);
    }

    function updateCardChrome(card) {
      const cardState = readCardState(card);
      const helper = card.querySelector(".card-helper-text");
      if (helper) {
        helper.hidden = !cardState.collapsed;
        helper.textContent = card.dataset.cardHelperText || "hidden";
      }
      const toggle = card.querySelector('[data-card-action="collapse-toggle"]');
      if (toggle) {
        toggle.textContent = cardState.collapsed ? "Expand" : "Collapse";
        toggle.setAttribute("aria-expanded", cardState.collapsed ? "false" : "true");
      }
    }

    function applyState(card) {
      const cardState = readCardState(card);
      card.classList.toggle("is-collapsed", Boolean(cardState.collapsed));
      card.classList.remove("is-hidden");
      card.style.setProperty("--fibo-collapsed-height", `${resolveCollapsedHeight(card)}px`);
      if (card.matches("details")) {
        card.open = !cardState.collapsed;
      }
      updateCardChrome(card);
    }

    function appendHelperText(target) {
      const helper = document.createElement("span");
      helper.className = "card-helper-text";
      helper.hidden = true;
      helper.textContent = target.closest("[data-fibo-card]")?.dataset.cardHelperText || "hidden";
      target.appendChild(helper);
      return helper;
    }

    function createToolButton() {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "card-tool";
      button.dataset.cardAction = "collapse-toggle";
      button.textContent = "Collapse";
      return button;
    }

    function toggleCollapsed(card, reason) {
      const current = readCardState(card);
      writeCardState(card, { collapsed: !current.collapsed, hidden: false }, reason || "toggle-collapse");
      applyState(card);
      logger.log("collapse/expand events", { reason: reason || "toggle-collapse", card: ensureCardKey(card), collapsed: !current.collapsed });
      scheduleRecompute();
    }

    function bindToolButton(button, card) {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleCollapsed(card, "collapse-toggle");
      });
    }

    function reorderCards(draggedKey, targetKey) {
      if (!draggedKey || !targetKey || draggedKey === targetKey) {
        return;
      }
      const ordered = cards.slice().sort((left, right) => {
        const leftOrder = readCardState(left).order;
        const rightOrder = readCardState(right).order;
        if (leftOrder !== rightOrder) {
          return leftOrder - rightOrder;
        }
        return cards.indexOf(left) - cards.indexOf(right);
      });
      const fromIndex = ordered.findIndex((card) => ensureCardKey(card) === draggedKey);
      const toIndex = ordered.findIndex((card) => ensureCardKey(card) === targetKey);
      if (fromIndex < 0 || toIndex < 0) {
        return;
      }
      const [moved] = ordered.splice(fromIndex, 1);
      ordered.splice(toIndex, 0, moved);
      ordered.forEach((card, index) => {
        state[ensureCardKey(card)] = { ...readCardState(card), order: index };
      });
      logger.log("drag-and-drop events", { draggedKey, targetKey, ordered: ordered.map((card) => ensureCardKey(card)) });
      persistState("drag-drop");
      scheduleRecompute();
    }

    function attachDragHandlers(handle, card) {
      handle.setAttribute("draggable", "true");
      handle.addEventListener("dragstart", (event) => {
        dragSourceKey = ensureCardKey(card);
        event.dataTransfer?.setData("text/plain", dragSourceKey);
        if (typeof event.dataTransfer?.setDragImage === "function") {
          event.dataTransfer.setDragImage(card, 24, 24);
        }
        card.classList.add("is-dragging");
        logger.log("drag-and-drop events", { action: "dragstart", card: dragSourceKey });
      });
      handle.addEventListener("dragend", () => {
        dragSourceKey = "";
        card.classList.remove("is-dragging");
      });
      handle.addEventListener("dragover", (event) => {
        event.preventDefault();
      });
      handle.addEventListener("drop", (event) => {
        event.preventDefault();
        const draggedKey = event.dataTransfer?.getData("text/plain") || dragSourceKey;
        reorderCards(draggedKey, ensureCardKey(card));
      });
    }

    function injectControls(card) {
      if (card.querySelector(".card-titlebar")) {
        return;
      }
      if (card.matches("details")) {
        const summary = card.querySelector("summary");
        if (!summary) {
          return;
        }
        const titleGroup = summary.querySelector(":scope > div") || summary;
        titleGroup.classList.add("card-titlegroup");
        if (!titleGroup.querySelector(".card-helper-text")) {
          appendHelperText(titleGroup);
        }
        const tools = document.createElement("div");
        tools.className = "card-tools";
        const collapseButton = createToolButton();
        bindToolButton(collapseButton, card);
        tools.appendChild(collapseButton);
        summary.classList.add("card-titlebar");
        summary.appendChild(tools);
        const detailsContent = document.createElement("div");
        detailsContent.className = "card-content";
        while (summary.nextSibling) {
          detailsContent.appendChild(summary.nextSibling);
        }
        card.appendChild(detailsContent);
        attachDragHandlers(summary, card);
        summary.addEventListener("click", () => {
          globalScope.setTimeout(() => {
            writeCardState(card, { collapsed: !card.open, hidden: false }, "toggle-collapse");
            applyState(card);
            logger.log("collapse/expand events", { reason: "summary-toggle", card: ensureCardKey(card), collapsed: !card.open });
            scheduleRecompute();
          }, 0);
        });
        return;
      }

      const directHeading = card.querySelector(":scope > h1, :scope > h2, :scope > h3");
      if (!directHeading) {
        return;
      }
      const titlebar = document.createElement("div");
      titlebar.className = "card-titlebar";
      const titleGroup = document.createElement("div");
      titleGroup.className = "card-titlegroup";

      const headingEl = document.createElement("h2");
      headingEl.textContent = titleFor(card);
      headingEl.style.margin = "0";
      titleGroup.appendChild(headingEl);
      appendHelperText(titleGroup);

      const tools = document.createElement("div");
      tools.className = "card-tools";
      const collapseButton = createToolButton();
      bindToolButton(collapseButton, card);
      tools.appendChild(collapseButton);

      titlebar.appendChild(titleGroup);
      titlebar.appendChild(tools);

      const content = document.createElement("div");
      content.className = "card-content";
      if (card.classList.contains("hero")) content.classList.add("hero");
      if (card.classList.contains("stats")) content.classList.add("stats");
      if (card.classList.contains("url-panel")) content.classList.add("url-panel");
      if (card.classList.contains("onboarding-qr-panel")) content.classList.add("onboarding-qr-panel");
      while (card.firstChild) {
        const node = card.firstChild;
        if (node === directHeading) {
          card.removeChild(node);
          continue;
        }
        content.appendChild(node);
      }

      card.appendChild(titlebar);
      card.appendChild(content);
      attachDragHandlers(titlebar, card);
      titlebar.addEventListener("click", () => {
        if (card.dataset.cardModalLauncher === "true") {
          return;
        }
        toggleCollapsed(card, "titlebar-toggle");
      });
    }

    function measuredCardHeight(card) {
      if (card.classList.contains("is-collapsed")) {
        return resolveCollapsedHeight(card);
      }
      const titlebarHeight = card.querySelector(".card-titlebar")?.offsetHeight || 34;
      const contentHeight = card.querySelector(".card-content")?.scrollHeight || 0;
      const computed = typeof getComputedStyle === "function" ? getComputedStyle(card) : { paddingTop: 0, paddingBottom: 0 };
      const verticalPadding = numericCssValue(computed.paddingTop, 0) + numericCssValue(computed.paddingBottom, 0);
      return Math.ceil(titlebarHeight + contentHeight + verticalPadding);
    }

    function buildCardDescriptor(card, index) {
      const contentEl = card.querySelector(".card-content") || card;
      const cardState = readCardState(card);
      const key = ensureCardKey(card);
      const priority = Number(card.dataset.layoutPriority || defaultPriorities[key] || 0);
      const descriptor = {
        key,
        card,
        index,
        collapsed: Boolean(cardState.collapsed),
        explicitOrder: cardState.order,
        explicitWeight: Number(card.dataset.layoutWeight || ""),
        priority,
        hasGraphic: Boolean(contentEl.querySelector("svg, canvas, img")),
        isDetailsOpen: card.matches("details[open]"),
        multilineText: (contentEl.textContent.match(/\n/g) || []).length,
        textLength: contentEl.textContent.trim().length,
        height: measuredCardHeight(card),
      };
      descriptor.weight = computeDescriptorWeight(descriptor);
      layoutCache.weights[key] = descriptor.weight;
      layoutCache.heights[key] = descriptor.height;
      return descriptor;
    }

    function shouldGenerateDefaultLayout() {
      return cards.length > 0 && cards.every((card) => readCardState(card).order === ORDER_FALLBACK);
    }

    function emitLayoutSnapshot(reason) {
      if (!syncChannel || typeof globalScope.parent === "undefined" || globalScope.parent === globalScope || typeof globalScope.parent.postMessage !== "function") {
        return;
      }
      const registry = cards.map((card) => ({
        key: ensureCardKey(card),
        title: titleFor(card),
        order: readCardState(card).order,
        collapsed: Boolean(readCardState(card).collapsed),
        hidden: false,
        weight: layoutCache.weights[ensureCardKey(card)] ?? null,
        spans: layoutCache.spans[ensureCardKey(card)] ?? null,
      }));
      logger.log("card registry load", registry);
      globalScope.parent.postMessage({
        type: syncChannel,
        payload: {
          reason,
          registry,
          state,
          layoutCache,
          timestamp: Date.now(),
        },
      }, globalScope.location.origin);
    }

    function recompute() {
      frameToken = 0;
      flushCaches();
      cards.forEach((card) => applyState(card));

      const trackConfig = trackResolver(currentContainerWidth(), { mode, container, cards });
      const descriptors = cards.map((card, index) => buildCardDescriptor(card, index));
      const preferImportance = pendingAutoArrange || shouldGenerateDefaultLayout();
      if (preferImportance && !pendingAutoArrange) {
        logger.log("default layout generation", { ordered: descriptors.slice().sort(sortByImportance).map((descriptor) => descriptor.key) });
      }

      const plan = computeLayoutPlan(descriptors, {
        tracks: trackConfig.tracks,
        maxPerRow: trackConfig.maxPerRow,
        rowUnit,
        preferImportance,
      });

      layoutCache.columns = trackConfig.tracks;
      layoutCache.rows = plan.rows.slice();
      container.style.setProperty("--fibo-columns", String(trackConfig.tracks));

      plan.items.forEach((item) => {
        const card = item.card;
        card.style.setProperty("--fibo-order", String(item.order));
        card.style.setProperty("--fibo-col-span", String(item.colSpan));
        card.style.setProperty("--fibo-row-span", String(item.rowSpan));
        card.style.setProperty("--fibo-col-start", String(item.colStart));
        const key = ensureCardKey(card);
        layoutCache.spans[key] = {
          col: item.colSpan,
          row: item.rowSpan,
          order: item.order,
          start: item.colStart,
        };
        state[key] = { ...readCardState(card), order: item.order };
        logger.log("Fibonacci slot assignments", {
          card: key,
          rowIndex: item.rowIndex,
          colStart: item.colStart,
          colSpan: item.colSpan,
          rowSpan: item.rowSpan,
          order: item.order,
        });
      });

      persistState(pendingAutoArrange ? "auto-arrange" : preferImportance ? "default-layout" : "reflow");
      emitLayoutSnapshot(pendingAutoArrange ? "auto-arrange" : preferImportance ? "default-layout" : "reflow");
      pendingAutoArrange = false;
    }

    function scheduleRecompute() {
      if (frameToken) {
        return;
      }
      frameToken = globalScope.requestAnimationFrame(recompute);
    }

    function handleViewportReflow(reason) {
      logger.log("window resize reflow", {
        reason,
        containerWidth: currentContainerWidth(),
        viewportWidth: globalScope.innerWidth,
        viewportHeight: globalScope.innerHeight,
      });
      scheduleRecompute();
    }

    function autoArrange() {
      pendingAutoArrange = true;
      logger.log("auto-arrange events", { action: "command-received" });
      scheduleRecompute();
    }

    function applyRemoteState(remoteState, reason) {
      if (!remoteState || typeof remoteState !== "object") {
        return;
      }
      isApplyingRemoteState = true;
      Object.entries(remoteState).forEach(([key, cardState]) => {
        state[key] = normalizeCardState({ ...state[key], ...cardState });
      });
      isApplyingRemoteState = false;
      skipPersistOnce = true;
      logger.log("preview-to-status sync events", { reason: reason || "remote-sync", remoteState });
      scheduleRecompute();
    }

    cards.forEach((card) => {
      const key = ensureCardKey(card);
      if (!state[key]) {
        state[key] = normalizeCardState({});
      }
      injectControls(card);
      applyState(card);
    });

    globalScope.addEventListener("resize", () => handleViewportReflow("window-resize"));
    globalScope.addEventListener("orientationchange", () => handleViewportReflow("orientation-change"));
    if (globalScope.visualViewport) {
      globalScope.visualViewport.addEventListener("resize", () => handleViewportReflow("visual-viewport-resize"));
    }
    if (typeof ResizeObserver === "function") {
      const resizeObserver = new ResizeObserver(() => {
        handleViewportReflow("container-resize");
      });
      resizeObserver.observe(container);
    }

    scheduleRecompute();

    return {
      recompute: scheduleRecompute,
      autoArrange,
      applyRemoteState,
      emitLayoutSnapshot,
      getLayoutCache() {
        return {
          columns: layoutCache.columns,
          rows: layoutCache.rows.slice(),
          weights: { ...layoutCache.weights },
          spans: { ...layoutCache.spans },
          heights: { ...layoutCache.heights },
        };
      },
      getSnapshot() {
        return snapshotFromPlan(computeLayoutPlan(cards.map((card, index) => buildCardDescriptor(card, index)), {
          tracks: layoutCache.columns || trackResolver(currentContainerWidth(), { mode, container, cards }).tracks,
          maxPerRow: trackResolver(currentContainerWidth(), { mode, container, cards }).maxPerRow,
          rowUnit,
          preferImportance: false,
        }));
      },
    };
  }

  return {
    ORDER_FALLBACK,
    buildRecursiveFibonacciRows,
    ratiosForRowSize,
    normalizeRatios,
    computeDescriptorWeight,
    computeLayoutPlan,
    snapshotFromPlan,
    createAdaptiveLayout,
    createDefaultTrackResolver,
  };
});