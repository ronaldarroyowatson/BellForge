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

  function normalizeLayoutMode(value) {
    return String(value || "portrait").trim().toLowerCase() === "landscape" ? "landscape" : "portrait";
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
    const generated = titleForCard(card)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || `card-${Math.random().toString(16).slice(2, 8)}`;
    card.dataset.cardKey = generated;
    return generated;
  }

  function normalizeCardState(cardState = {}) {
    return {
      collapsed: Boolean(cardState.collapsed || cardState.hidden),
      hidden: false,
      order: Number.isFinite(cardState.order) ? Number(cardState.order) : ORDER_FALLBACK,
    };
  }

  function defaultLogger(options = {}) {
    return {
      enabled: Boolean(options.enabled),
      log(channel, data) {
        const debugClient = options.debugClient
          || globalScope.__bellforgeDebug
          || globalScope.BellForgeDebug?.createClient?.({ source: `layout:${options.mode || "unknown"}` });
        if (debugClient?.log) {
          debugClient.log(channel, "layout-event", data, {
            eventType: channel === "masonry reflow" ? "snapshot" : "event",
          });
        }
        if (this.enabled && typeof console !== "undefined" && typeof console.log === "function") {
          console.log(`[BellForge Masonry] ${channel}`, data || "");
        }
      },
    };
  }

  function extractResolutionCandidatesFromText(value) {
    const text = String(value || "");
    if (!text.trim()) {
      return [];
    }

    const candidates = [];
    const currentMatch = text.match(/current\s+(\d{3,5})\s*x\s*(\d{3,5})/i);
    if (currentMatch) {
      candidates.push({ width: Number(currentMatch[1]), height: Number(currentMatch[2]), active: true, preferred: true });
    }

    const connectedMatch = text.match(/connected(?:\s+primary)?(?:[^\n]*?)(\d{3,5})x(\d{3,5})/i);
    if (connectedMatch) {
      candidates.push({ width: Number(connectedMatch[1]), height: Number(connectedMatch[2]), active: true, preferred: false });
    }

    const modeRegex = /(\d{3,5})x(\d{3,5})(?:[^\n]*?)(\*?)(\+?)/g;
    let match;
    while ((match = modeRegex.exec(text)) !== null) {
      candidates.push({
        width: Number(match[1]),
        height: Number(match[2]),
        active: match[3] === "*",
        preferred: match[4] === "+",
      });
    }

    return candidates.filter((candidate) => Number.isFinite(candidate.width) && Number.isFinite(candidate.height));
  }

  function pickBestResolution(candidates, fallback = { width: 1920, height: 1080 }) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return { ...fallback };
    }

    const normalized = candidates
      .map((candidate) => ({
        width: Number(candidate.width),
        height: Number(candidate.height),
        active: candidate.active === true,
        preferred: candidate.preferred === true,
      }))
      .filter((candidate) => Number.isFinite(candidate.width) && Number.isFinite(candidate.height) && candidate.width > 0 && candidate.height > 0);

    if (normalized.length === 0) {
      return { ...fallback };
    }

    normalized.sort((left, right) => {
      if (Number(right.active) !== Number(left.active)) {
        return Number(right.active) - Number(left.active);
      }
      if (Number(right.preferred) !== Number(left.preferred)) {
        return Number(right.preferred) - Number(left.preferred);
      }
      const leftArea = left.width * left.height;
      const rightArea = right.width * right.height;
      if (rightArea !== leftArea) {
        return rightArea - leftArea;
      }
      return right.width - left.width;
    });

    return {
      width: normalized[0].width,
      height: normalized[0].height,
    };
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
    }
    return Math.max(weight, descriptor.priority || 0);
  }

  function sortByOrder(left, right) {
    if (left.explicitOrder !== right.explicitOrder) {
      return left.explicitOrder - right.explicitOrder;
    }
    return left.index - right.index;
  }

  function computeRowSpan(height, rowUnit) {
    const normalizedHeight = Math.max(rowUnit, Number(height) || rowUnit);
    return Math.max(1, Math.ceil(normalizedHeight / rowUnit));
  }

  function computeLayoutPlan(entries, options = {}) {
    const tracks = Math.max(1, Number(options.tracks) || 1);
    const rowUnit = Math.max(1, Number(options.rowUnit) || 8);
    const orderedEntries = entries.slice().sort(sortByOrder);
    const columnHeights = Array(tracks).fill(0);
    const items = [];

    orderedEntries.forEach((entry, index) => {
      let selectedColumn = 0;
      for (let cursor = 1; cursor < columnHeights.length; cursor += 1) {
        if (columnHeights[cursor] < columnHeights[selectedColumn]) {
          selectedColumn = cursor;
        }
      }
      const rowSpan = computeRowSpan(entry.height, rowUnit);
      const rowStart = columnHeights[selectedColumn] + 1;
      columnHeights[selectedColumn] += rowSpan;
      items.push({
        key: entry.key,
        order: index,
        rowIndex: rowStart - 1,
        rowStart,
        rowSpan,
        colStart: selectedColumn + 1,
        colSpan: 1,
        weight: entry.weight,
        collapsed: entry.collapsed,
        card: entry.card,
      });
    });

    return {
      tracks,
      items,
      columnHeights,
    };
  }

  function snapshotFromPlan(plan) {
    return plan.items.map((item) => ({
      key: item.key,
      order: item.order,
      rowIndex: item.rowIndex,
      rowStart: item.rowStart,
      colStart: item.colStart,
      colSpan: item.colSpan,
      rowSpan: item.rowSpan,
      weight: item.weight,
      collapsed: item.collapsed,
    }));
  }

  function createDefaultTrackResolver(mode) {
    return function resolveTracks(width, context = {}) {
      const layoutMode = normalizeLayoutMode(context.layoutMode);
      const isSettings = mode === "settings";
      const minCardWidth = isSettings ? (layoutMode === "landscape" ? 300 : 320) : (layoutMode === "landscape" ? 280 : 300);
      const gap = 12;
      const usableWidth = Math.max(width, minCardWidth);
      const tracks = Math.max(1, Math.floor((usableWidth + gap) / (minCardWidth + gap)));
      return {
        tracks,
        minCardWidth,
        gap,
      };
    };
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
    const getDefaultCardState = typeof options.getDefaultCardState === "function" ? options.getDefaultCardState : null;
    const getLayoutMode = typeof options.getLayoutMode === "function" ? options.getLayoutMode : null;
    const trackResolver = options.trackResolver || createDefaultTrackResolver(mode);
    const syncChannel = options.syncChannel || null;
    const logger = options.logger || defaultLogger({
      enabled: typeof localStorage !== "undefined" && localStorage.getItem("bellforge.debug.fibo") === "true",
      mode,
    });

    if (!container) {
      return {
        recompute() {},
        autoArrange() {},
        resetState() {},
        setCardCollapsed() { return false; },
        applyRemoteState() {},
        emitLayoutSnapshot() {},
        setEditing() {},
        getLayoutCache() { return { columns: 0, layoutMode: "portrait", positions: {}, heights: {}, columnHeights: [] }; },
        getSnapshot() { return []; },
        getState() { return {}; },
      };
    }

    const cards = Array.from(container.querySelectorAll(cardSelector));
    const state = storageKey && typeof localStorage !== "undefined"
      ? safeParseJson(localStorage.getItem(storageKey) || "{}", {})
      : {};
    const layoutCache = { columns: 0, layoutMode: "portrait", positions: {}, heights: {}, columnHeights: [] };
    let frameToken = 0;
    let pendingAutoArrange = false;
    let isApplyingRemoteState = false;
    let skipPersistOnce = false;
    let editingEnabled = true;
    let dragSourceKey = "";

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

    function currentContainerGap() {
      if (typeof getComputedStyle !== "function") {
        return 12;
      }
      const styles = getComputedStyle(container);
      return Math.max(0, Math.round(numericCssValue(styles.columnGap || styles.gap, 12)));
    }

    function resolveLayoutMode() {
      if (getLayoutMode) {
        return normalizeLayoutMode(getLayoutMode({ mode, container, cards }));
      }
      if (container?.dataset?.layoutMode) {
        return normalizeLayoutMode(container.dataset.layoutMode);
      }
      if (typeof document !== "undefined" && document.documentElement) {
        return normalizeLayoutMode(document.documentElement.dataset.designLayoutMode);
      }
      return "portrait";
    }

    function defaultStateForCard(card) {
      const key = ensureCardKey(card);
      const defaultState = getDefaultCardState ? getDefaultCardState(card, key, { mode, container }) : {};
      return normalizeCardState(defaultState || {});
    }

    function readCardState(card) {
      const key = ensureCardKey(card);
      if (!state[key]) {
        state[key] = defaultStateForCard(card);
      } else {
        state[key] = normalizeCardState(state[key]);
      }
      return state[key];
    }

    function persistState(reason) {
      const normalizedReason = typeof reason === "string" ? reason : "card-state";
      const isInternalRecompute = normalizedReason === "reflow" || normalizedReason === "auto-arrange";
      if (skipPersistOnce && isInternalRecompute) {
        skipPersistOnce = false;
        return;
      }
      if (!storageKey || typeof localStorage === "undefined" || isApplyingRemoteState) {
        skipPersistOnce = false;
        return;
      }
      if (skipPersistOnce) {
        skipPersistOnce = false;
      }
      localStorage.setItem(storageKey, JSON.stringify(state));
      logger.log("layout state persisted", { reason: normalizedReason, state });
    }

    function writeCardState(card, nextState, reason) {
      const key = ensureCardKey(card);
      state[key] = normalizeCardState({ ...readCardState(card), ...nextState });
      persistState(reason || "card-state");
    }

    function updateCardChrome(card) {
      const cardState = readCardState(card);
      const helper = card.querySelector(".card-helper-text");
      if (helper) {
        const helperText = card.dataset.cardHelperText || "";
        helper.hidden = !cardState.collapsed || !helperText;
        helper.textContent = helperText;
      }
      const toggle = card.querySelector('[data-card-action="collapse-toggle"]');
      if (toggle) {
        toggle.textContent = cardState.collapsed ? "Expand" : "Collapse";
        toggle.setAttribute("aria-expanded", cardState.collapsed ? "false" : "true");
      }
      const titlebar = card.querySelector(".card-titlebar");
      if (titlebar) {
        titlebar.setAttribute("draggable", editingEnabled ? "true" : "false");
      }
    }

    function applyState(card) {
      const cardState = readCardState(card);
      const collapsedPx = resolveCollapsedHeight(card);
      card.classList.toggle("is-collapsed", Boolean(cardState.collapsed));
      card.style.setProperty("--fibo-collapsed-height", `${collapsedPx}px`);
      if (cardState.collapsed) {
        card.style.height = `${collapsedPx}px`;
        card.style.minHeight = `${collapsedPx}px`;
        card.style.maxHeight = `${collapsedPx}px`;
      } else {
        card.style.removeProperty("height");
        card.style.removeProperty("min-height");
        card.style.removeProperty("max-height");
      }
      if (card.matches("details")) {
        card.open = !cardState.collapsed;
      }
      updateCardChrome(card);
    }

    function appendHelperText(target) {
      const helper = document.createElement("span");
      helper.className = "card-helper-text";
      helper.hidden = true;
      helper.textContent = target.closest("[data-fibo-card]")?.dataset.cardHelperText || "";
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
      logger.log("collapse/expand", { reason: reason || "toggle-collapse", card: ensureCardKey(card), collapsed: !current.collapsed });
      scheduleRecompute();
    }

    function bindToolButton(button, card) {
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleCollapsed(card, "collapse-toggle");
      });
    }

    function reorderCards(draggedKey, targetKey) {
      if (!editingEnabled || !draggedKey || !targetKey || draggedKey === targetKey) {
        return;
      }
      const ordered = cards.slice().sort((left, right) => sortByOrder(
        { explicitOrder: readCardState(left).order, index: cards.indexOf(left) },
        { explicitOrder: readCardState(right).order, index: cards.indexOf(right) }
      ));
      const fromIndex = ordered.findIndex((card) => ensureCardKey(card) === draggedKey);
      const toIndex = ordered.findIndex((card) => ensureCardKey(card) === targetKey);
      if (fromIndex < 0 || toIndex < 0) {
        return;
      }
      const moved = ordered.splice(fromIndex, 1)[0];
      ordered.splice(toIndex, 0, moved);
      ordered.forEach((card, index) => {
        state[ensureCardKey(card)] = { ...readCardState(card), order: index };
      });
      logger.log("drag-and-drop", { draggedKey, targetKey, ordered: ordered.map((card) => ensureCardKey(card)) });
      persistState("drag-drop");
      scheduleRecompute();
    }

    function attachDragHandlers(handle, card) {
      handle.setAttribute("draggable", editingEnabled ? "true" : "false");
      handle.addEventListener("dragstart", (event) => {
        if (!editingEnabled) {
          event.preventDefault();
          return;
        }
        dragSourceKey = ensureCardKey(card);
        event.dataTransfer?.setData("text/plain", dragSourceKey);
        if (typeof event.dataTransfer?.setDragImage === "function") {
          event.dataTransfer.setDragImage(card, 24, 24);
        }
        card.classList.add("is-dragging");
      });
      handle.addEventListener("dragend", () => {
        dragSourceKey = "";
        card.classList.remove("is-dragging");
      });
      handle.addEventListener("dragover", (event) => {
        if (!editingEnabled) {
          return;
        }
        event.preventDefault();
      });
      handle.addEventListener("drop", (event) => {
        if (!editingEnabled) {
          return;
        }
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
        summary.addEventListener("click", (event) => {
          if (event.target instanceof Element && event.target.closest(".card-tools")) {
            event.preventDefault();
            return;
          }
          globalScope.setTimeout(() => {
            writeCardState(card, { collapsed: !card.open, hidden: false }, "toggle-collapse");
            applyState(card);
            scheduleRecompute();
          }, 0);
        });
        return;
      }

      const directHeading = card.querySelector(":scope > h1, :scope > h2, :scope > h3");
      const titlebar = document.createElement("div");
      titlebar.className = "card-titlebar";
      const titleGroup = document.createElement("div");
      titleGroup.className = "card-titlegroup";
      const headingEl = document.createElement("h2");
      headingEl.textContent = titleForCard(card);
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
        if (directHeading && node === directHeading) {
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
      const composedHeight = Math.ceil(titlebarHeight + contentHeight + verticalPadding);
      const scrollHeight = Math.ceil(card.scrollHeight || 0);
      return Math.max(composedHeight, scrollHeight);
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
        explicitWeight: card.dataset.layoutWeight != null && card.dataset.layoutWeight !== "" ? Number(card.dataset.layoutWeight) : null,
        priority,
        hasGraphic: Boolean(contentEl.querySelector("svg, canvas, img")),
        isDetailsOpen: card.matches("details[open]"),
        multilineText: (contentEl.textContent.match(/\n/g) || []).length,
        textLength: contentEl.textContent.trim().length,
        height: measuredCardHeight(card),
      };
      descriptor.weight = computeDescriptorWeight(descriptor);
      layoutCache.heights[key] = descriptor.height;
      return descriptor;
    }

    function emitLayoutSnapshot(reason) {
      if (!syncChannel || typeof globalScope.parent === "undefined" || globalScope.parent === globalScope || typeof globalScope.parent.postMessage !== "function") {
        return;
      }
      const registry = cards.map((card) => ({
        key: ensureCardKey(card),
        title: titleForCard(card),
        order: readCardState(card).order,
        collapsed: Boolean(readCardState(card).collapsed),
      }));
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
      cards.forEach((card) => applyState(card));
      const layoutMode = resolveLayoutMode();
      const trackConfig = trackResolver(currentContainerWidth(), { mode, container, cards, layoutMode });
      const gap = currentContainerGap();
      const descriptors = cards.map((card, index) => buildCardDescriptor(card, index));
      const plan = computeLayoutPlan(descriptors, {
        tracks: trackConfig.tracks,
        rowUnit,
      });

      layoutCache.columns = trackConfig.tracks;
      layoutCache.layoutMode = layoutMode;
      layoutCache.columnHeights = plan.columnHeights.slice();
      container.style.setProperty("--fibo-columns", String(trackConfig.tracks));
      container.style.setProperty("--bf-masonry-min-card-width", `${trackConfig.minCardWidth}px`);
      container.style.setProperty("--bf-masonry-gap", `${gap}px`);

      plan.items.forEach((item) => {
        const card = item.card;
        card.style.setProperty("--fibo-order", String(item.order));
        card.style.setProperty("--fibo-col-span", String(item.colSpan));
        card.style.setProperty("--fibo-row-span", String(item.rowSpan));
        card.style.setProperty("--fibo-col-start", String(item.colStart));
        card.style.setProperty("--fibo-row-start", String(item.rowStart));
        card.dataset.fiboOrder = String(item.order);
        card.dataset.fiboRowIndex = String(item.rowIndex);
        card.dataset.fiboRowStart = String(item.rowStart);
        card.dataset.fiboColStart = String(item.colStart);
        card.dataset.fiboColSpan = String(item.colSpan);
        card.dataset.fiboRowSpan = String(item.rowSpan);
        card.dataset.fiboWeight = String(item.weight);
        const key = ensureCardKey(card);
        state[key] = { ...readCardState(card), order: item.order };
        layoutCache.positions[key] = {
          order: item.order,
          colStart: item.colStart,
          rowStart: item.rowStart,
          rowSpan: item.rowSpan,
        };
      });

      logger.log("masonry decisions", {
        mode,
        layoutMode,
        containerWidth: currentContainerWidth(),
        columns: trackConfig.tracks,
        minCardWidth: trackConfig.minCardWidth,
        gap,
      });
      logger.log("masonry reflow", {
        columns: trackConfig.tracks,
        layoutMode,
        snapshot: snapshotFromPlan(plan),
      });
      persistState(pendingAutoArrange ? "auto-arrange" : "reflow");
      emitLayoutSnapshot(pendingAutoArrange ? "auto-arrange" : "reflow");
      pendingAutoArrange = false;
    }

    function scheduleRecompute() {
      if (frameToken) {
        return;
      }
      frameToken = globalScope.requestAnimationFrame(recompute);
    }

    function handleViewportReflow(reason) {
      logger.log("window resize", {
        reason,
        containerWidth: currentContainerWidth(),
        viewportWidth: globalScope.innerWidth,
        viewportHeight: globalScope.innerHeight,
      });
      scheduleRecompute();
    }

    function autoArrange() {
      const ordered = cards
        .map((card, index) => buildCardDescriptor(card, index))
        .sort((left, right) => {
          if (right.priority !== left.priority) {
            return right.priority - left.priority;
          }
          if (right.weight !== left.weight) {
            return right.weight - left.weight;
          }
          return left.index - right.index;
        });
      ordered.forEach((entry, index) => {
        state[entry.key] = { ...readCardState(entry.card), order: index };
      });
      pendingAutoArrange = true;
      logger.log("auto-arrange", { ordered: ordered.map((entry) => entry.key) });
      scheduleRecompute();
    }

    function resetState(reason) {
      cards.forEach((card) => {
        state[ensureCardKey(card)] = defaultStateForCard(card);
      });
      pendingAutoArrange = true;
      persistState(reason || "reset-state");
      scheduleRecompute();
    }

    function setCardCollapsed(cardKey, collapsed, reason) {
      const card = cards.find((entry) => ensureCardKey(entry) === cardKey);
      if (!card) {
        return false;
      }
      writeCardState(card, { collapsed: Boolean(collapsed), hidden: false }, reason || "set-card-collapsed");
      applyState(card);
      scheduleRecompute();
      return true;
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
      logger.log("remote layout state", { reason: reason || "remote-sync", remoteState });
      scheduleRecompute();
    }

    function setEditing(enabled) {
      editingEnabled = enabled !== false;
      cards.forEach((card) => updateCardChrome(card));
    }

    cards.forEach((card) => {
      const key = ensureCardKey(card);
      if (!state[key]) {
        state[key] = defaultStateForCard(card);
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
      resetState,
      setCardCollapsed,
      applyRemoteState,
      emitLayoutSnapshot,
      setEditing,
      getLayoutCache() {
        return {
          columns: layoutCache.columns,
          layoutMode: layoutCache.layoutMode,
          positions: { ...layoutCache.positions },
          heights: { ...layoutCache.heights },
          columnHeights: layoutCache.columnHeights.slice(),
        };
      },
      getSnapshot() {
        const descriptors = cards.map((card, index) => buildCardDescriptor(card, index));
        return snapshotFromPlan(computeLayoutPlan(descriptors, {
          tracks: layoutCache.columns || trackResolver(currentContainerWidth(), { mode, container, cards, layoutMode: resolveLayoutMode() }).tracks,
          rowUnit,
        }));
      },
      getState() {
        return safeParseJson(JSON.stringify(state), {});
      },
    };
  }

  function buildRecursiveFibonacciRows() {
    return [];
  }

  function ratiosForRowSize() {
    return [1];
  }

  function normalizeRatios(ratios) {
    return Array.isArray(ratios) ? ratios : [1];
  }

  return {
    ORDER_FALLBACK,
    buildRecursiveFibonacciRows,
    ratiosForRowSize,
    normalizeRatios,
    computeDescriptorWeight,
    computeLayoutPlan,
    computeRowSpan,
    snapshotFromPlan,
    createAdaptiveLayout,
    createDefaultTrackResolver,
    extractResolutionCandidatesFromText,
    normalizeLayoutMode,
    pickBestResolution,
  };
});
