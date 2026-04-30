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
        if (typeof console !== "undefined" && typeof console.debug === "function") {
          console.debug(`[BellForge Masonry] ${channel}`, data || "");
          return;
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

  function computeRowSpan(height, rowUnit, gap = 0) {
    const normalizedHeight = Math.max(rowUnit, Number(height) || rowUnit);
    const normalizedGap = Math.max(0, Number(gap) || 0);
    return Math.max(1, Math.ceil((normalizedHeight + normalizedGap) / (rowUnit + normalizedGap)));
  }

  function computeTrackMetrics(width, minCardWidth, gap) {
    const resolvedGap = Math.max(0, Number(gap) || 0);
    const resolvedMinCardWidth = Math.max(1, Number(minCardWidth) || 1);
    const resolvedWidth = Math.max(resolvedMinCardWidth, Number(width) || resolvedMinCardWidth);
    return {
      width: resolvedWidth,
      minCardWidth: resolvedMinCardWidth,
      gap: resolvedGap,
      tracks: Math.max(1, Math.floor((resolvedWidth + resolvedGap) / (resolvedMinCardWidth + resolvedGap))),
    };
  }

  function computeViewportFrame(options = {}) {
    const baseWidth = Math.max(1, Number(options.baseWidth) || 1920);
    const baseHeight = Math.max(1, Number(options.baseHeight) || 1080);
    const availableWidth = Math.max(1, Number(options.availableWidth) || baseWidth);
    const availableHeight = Math.max(1, Number(options.availableHeight) || baseHeight);
    const allowGrow = options.allowGrow === true;
    const aspectRatio = baseWidth / baseHeight;
    const widthScale = availableWidth / baseWidth;
    const heightScale = availableHeight / baseHeight;
    const unclampedScale = Math.min(widthScale, heightScale);
    const scale = allowGrow ? unclampedScale : Math.min(1, unclampedScale);
    return {
      source: options.source || "container",
      baseWidth,
      baseHeight,
      availableWidth,
      availableHeight,
      layoutWidth: Math.max(1, Number(options.layoutWidth) || baseWidth),
      layoutHeight: Math.max(1, Number(options.layoutHeight) || baseHeight),
      renderWidth: Math.round(baseWidth * scale),
      renderHeight: Math.round(baseHeight * scale),
      scale,
      aspectRatio,
    };
  }

  function computeLayoutPlan(entries, options = {}) {
    const tracks = Math.max(1, Number(options.tracks) || 1);
    const rowUnit = Math.max(1, Number(options.rowUnit) || 8);
    const gap = Math.max(0, Number(options.gap) || 0);
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
      const rowSpan = computeRowSpan(entry.height, rowUnit, gap);
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

  function computeAutoArrangeOrder(entries, options = {}) {
    const preparedEntries = entries
      .map((entry, index) => ({
        ...entry,
        index: Number.isFinite(entry.index) ? Number(entry.index) : index,
        explicitOrder: Number.isFinite(entry.explicitOrder) ? Number(entry.explicitOrder) : ORDER_FALLBACK,
        priority: Number(entry.priority || 0),
        weight: Number(entry.weight || 0),
        height: Math.max(1, Number(entry.height) || 1),
      }))
      .sort((left, right) => {
        if (right.priority !== left.priority) {
          return right.priority - left.priority;
        }
        if (right.weight !== left.weight) {
          return right.weight - left.weight;
        }
        if (right.height !== left.height) {
          return right.height - left.height;
        }
        if (left.explicitOrder !== right.explicitOrder) {
          return left.explicitOrder - right.explicitOrder;
        }
        return left.index - right.index;
      })
      .map((entry, index) => ({
        ...entry,
        explicitOrder: index,
      }));

    const plan = computeLayoutPlan(preparedEntries, options);
    return plan.items
      .slice()
      .sort((left, right) => {
        if (left.rowStart !== right.rowStart) {
          return left.rowStart - right.rowStart;
        }
        if (left.colStart !== right.colStart) {
          return left.colStart - right.colStart;
        }
        return left.order - right.order;
      })
      .map((item) => item.key);
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
      const metrics = computeTrackMetrics(width, minCardWidth, gap);
      return {
        tracks: metrics.tracks,
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
    const viewportResolver = typeof options.viewportResolver === "function" ? options.viewportResolver : null;
    const trackResolver = options.trackResolver || createDefaultTrackResolver(mode);
    const syncChannel = options.syncChannel || null;
    const onSave = typeof options.onSave === "function" ? options.onSave : null;
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
        getLayoutCache() { return { columns: 0, layoutMode: "portrait", positions: {}, heights: {}, columnHeights: [], viewport: null }; },
        getSnapshot() { return []; },
        getState() { return {}; },
      };
    }

    const cards = Array.from(container.querySelectorAll(cardSelector));
    const state = storageKey && typeof localStorage !== "undefined"
      ? safeParseJson(localStorage.getItem(storageKey) || "{}", {})
      : {};
    const layoutCache = { columns: 0, layoutMode: "portrait", positions: {}, heights: {}, columnHeights: [], viewport: null };
    const dragBindings = new WeakMap();
    const dragHandles = new WeakMap();
    const layoutConfig = {
      minCardWidth: Number.isFinite(Number(options.minCardWidth)) ? Number(options.minCardWidth) : null,
      gap: Number.isFinite(Number(options.gap)) ? Number(options.gap) : null,
    };
    let frameToken = 0;
    let pendingAutoArrange = false;
    let isApplyingRemoteState = false;
    let skipPersistOnce = false;
    let editingEnabled = options.editingEnabled !== false;
    let dirty = false;
    let dragSourceKey = "";
    let pendingRecomputeReason = "reflow";

    container.classList.add("fibo-adaptive-grid");

    function setDirty(isDirty, reason) {
      dirty = isDirty === true;
      container.classList.toggle("is-layout-dirty", dirty);
      if (dirty) {
        container.dataset.layoutDirty = "true";
        logger.log("layout dirty", { reason: reason || "unspecified" });
        return;
      }
      delete container.dataset.layoutDirty;
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

    function currentContainerGap() {
      if (typeof getComputedStyle !== "function") {
        return 12;
      }
      const styles = getComputedStyle(container);
      return Math.max(0, Math.round(numericCssValue(styles.columnGap || styles.gap, 12)));
    }

    function resolveViewportProfile() {
      const containerWidth = currentContainerWidth();
      const containerHeight = Math.max(0, Math.round(container.clientHeight || container.getBoundingClientRect().height || globalScope.innerHeight || 0));
      if (!viewportResolver) {
        return computeViewportFrame({
          source: "container",
          baseWidth: containerWidth || globalScope.innerWidth || 1,
          baseHeight: containerHeight || globalScope.innerHeight || 1,
          availableWidth: containerWidth || globalScope.innerWidth || 1,
          availableHeight: containerHeight || globalScope.innerHeight || 1,
          layoutWidth: containerWidth || globalScope.innerWidth || 1,
          layoutHeight: containerHeight || globalScope.innerHeight || 1,
          allowGrow: true,
        });
      }
      const resolved = viewportResolver({
        mode,
        container,
        cards,
        containerWidth,
        containerHeight,
        windowWidth: globalScope.innerWidth || containerWidth || 1,
        windowHeight: globalScope.innerHeight || containerHeight || 1,
      }) || {};
      return computeViewportFrame({
        source: resolved.source || "custom",
        baseWidth: resolved.baseWidth || resolved.layoutWidth || containerWidth || globalScope.innerWidth || 1,
        baseHeight: resolved.baseHeight || resolved.layoutHeight || containerHeight || globalScope.innerHeight || 1,
        availableWidth: resolved.availableWidth || containerWidth || globalScope.innerWidth || 1,
        availableHeight: resolved.availableHeight || containerHeight || globalScope.innerHeight || 1,
        layoutWidth: resolved.layoutWidth || containerWidth || globalScope.innerWidth || 1,
        layoutHeight: resolved.layoutHeight || containerHeight || globalScope.innerHeight || 1,
        allowGrow: resolved.allowGrow === true,
      });
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

    function saveLayout(reason, options = {}) {
      const normalizedReason = typeof reason === "string" ? reason : "card-state";
      const isInternalRecompute = normalizedReason === "reflow" || normalizedReason === "auto-arrange";
      if (skipPersistOnce && isInternalRecompute) {
        skipPersistOnce = false;
        return true;
      }
      if (isApplyingRemoteState) {
        skipPersistOnce = false;
        return true;
      }
      if (skipPersistOnce) {
        skipPersistOnce = false;
      }
      if (!storageKey || typeof localStorage === "undefined") {
        logger.log("layout save attempt", { reason: normalizedReason, state, dirty, persisted: false });
        if (onSave) {
          onSave({ reason: normalizedReason, state: safeParseJson(JSON.stringify(state), {}), dirty, persisted: false });
        }
        if (options.emitSnapshot !== false) {
          emitLayoutSnapshot(normalizedReason);
        }
        return true;
      }
      logger.log("layout save attempt", { reason: normalizedReason, state, dirty });
      try {
        localStorage.setItem(storageKey, JSON.stringify(state));
        setDirty(false, normalizedReason);
        logger.log("layout state persisted", { reason: normalizedReason, state });
        if (onSave) {
          onSave({ reason: normalizedReason, state: safeParseJson(JSON.stringify(state), {}), dirty: false });
        }
        if (options.emitSnapshot !== false) {
          emitLayoutSnapshot(normalizedReason);
        }
        return true;
      } catch (error) {
        logger.log("layout state persistence failed", {
          reason: normalizedReason,
          error: error?.message || String(error),
        });
        setDirty(true, `${normalizedReason}:save-failed`);
        return false;
      }
    }

    function writeCardState(card, nextState, reason) {
      const key = ensureCardKey(card);
      state[key] = normalizeCardState({ ...readCardState(card), ...nextState });
      setDirty(true, reason || "card-state");
      saveLayout(reason || "card-state");
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
        titlebar.classList.toggle("is-layout-editable", editingEnabled);
      }
      card.classList.toggle("is-layout-editable", editingEnabled);
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
      setDirty(true, "drag-drop");
      logger.log("drag-and-drop", { draggedKey, targetKey, ordered: ordered.map((card) => ensureCardKey(card)) });
      requestLayout("drag-drop");
      saveLayout("drag-drop");
    }

    function createDragBinding(handle, card) {
      return {
        dragstart(event) {
        if (!editingEnabled) {
          event.preventDefault();
          return;
        }
        dragSourceKey = ensureCardKey(card);
        logger.log("drag start", { card: dragSourceKey });
        event.dataTransfer?.setData("text/plain", dragSourceKey);
        if (typeof event.dataTransfer?.setDragImage === "function") {
          event.dataTransfer.setDragImage(card, 24, 24);
        }
        card.classList.add("is-dragging");
      },
        dragend() {
        logger.log("drag end", { card: ensureCardKey(card), dirty });
        dragSourceKey = "";
        card.classList.remove("is-dragging");
      },
        dragover(event) {
        if (!editingEnabled) {
          return;
        }
        event.preventDefault();
      },
        drop(event) {
        if (!editingEnabled) {
          return;
        }
        event.preventDefault();
        const draggedKey = event.dataTransfer?.getData("text/plain") || dragSourceKey;
        reorderCards(draggedKey, ensureCardKey(card));
      },
      };
    }

    function enableDragHandle(handle, card) {
      if (!handle) {
        return;
      }
      let binding = dragBindings.get(handle);
      if (!binding) {
        binding = createDragBinding(handle, card);
        dragBindings.set(handle, binding);
      }
      if (handle.dataset.dragControllerAttached === "true") {
        handle.setAttribute("draggable", "true");
        handle.classList.add("is-layout-editable");
        return;
      }
      handle.addEventListener("dragstart", binding.dragstart);
      handle.addEventListener("dragend", binding.dragend);
      handle.addEventListener("dragover", binding.dragover);
      handle.addEventListener("drop", binding.drop);
      handle.dataset.dragControllerAttached = "true";
      handle.setAttribute("draggable", "true");
      handle.classList.add("is-layout-editable");
      card.classList.add("is-layout-editable");
      // Also register dragover and drop on the card body so the user can drop
      // on any part of the card, not only the titlebar.
      if (!card.dataset.dragDropAttached) {
        card.addEventListener("dragover", binding.dragover);
        card.addEventListener("drop", binding.drop);
        card.dataset.dragDropAttached = "true";
      }
    }

    function disableDragHandle(handle, card) {
      const binding = dragBindings.get(handle);
      if (binding && handle.dataset.dragControllerAttached === "true") {
        handle.removeEventListener("dragstart", binding.dragstart);
        handle.removeEventListener("dragend", binding.dragend);
        handle.removeEventListener("dragover", binding.dragover);
        handle.removeEventListener("drop", binding.drop);
      }
      if (binding && card.dataset.dragDropAttached) {
        card.removeEventListener("dragover", binding.dragover);
        card.removeEventListener("drop", binding.drop);
        delete card.dataset.dragDropAttached;
      }
      delete handle.dataset.dragControllerAttached;
      handle.setAttribute("draggable", "false");
      handle.classList.remove("is-layout-editable");
      card.classList.remove("is-layout-editable");
      card.classList.remove("is-dragging");
    }

    function syncDragControllers() {
      cards.forEach((card) => {
        const handle = dragHandles.get(card);
        if (!handle) {
          return;
        }
        if (editingEnabled) {
          enableDragHandle(handle, card);
          return;
        }
        disableDragHandle(handle, card);
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
        dragHandles.set(card, summary);
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
      dragHandles.set(card, titlebar);
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
      const offsetHeight = Math.ceil(card.offsetHeight || 0);
      const renderedHeight = Math.ceil(card.getBoundingClientRect?.().height || 0);
      return Math.max(composedHeight, scrollHeight, offsetHeight, renderedHeight);
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
      const viewportProfile = resolveViewportProfile();
      const trackConfig = trackResolver(viewportProfile.layoutWidth, {
        mode,
        container,
        cards,
        layoutMode,
        config: { ...layoutConfig },
        viewport: viewportProfile,
      });
      const gap = Number.isFinite(Number(trackConfig.gap))
        ? Number(trackConfig.gap)
        : (layoutConfig.gap ?? currentContainerGap());
      const minCardWidth = Number.isFinite(Number(trackConfig.minCardWidth))
        ? Number(trackConfig.minCardWidth)
        : (layoutConfig.minCardWidth ?? 300);
      const descriptors = cards.map((card, index) => buildCardDescriptor(card, index));
      const plan = computeLayoutPlan(descriptors, {
        tracks: trackConfig.tracks,
        rowUnit,
        gap,
      });

      layoutCache.columns = trackConfig.tracks;
      layoutCache.layoutMode = layoutMode;
      layoutCache.columnHeights = plan.columnHeights.slice();
      layoutCache.viewport = { ...viewportProfile };
      container.style.setProperty("--fibo-columns", String(trackConfig.tracks));
      container.style.setProperty("--bf-masonry-min-card-width", `${minCardWidth}px`);
      container.style.setProperty("--bf-masonry-gap", `${gap}px`);
      container.style.setProperty("gap", `${gap}px`);
      container.style.setProperty("--bf-layout-viewport-width", `${viewportProfile.layoutWidth}px`);
      container.style.setProperty("--bf-layout-viewport-height", `${viewportProfile.layoutHeight}px`);
      container.style.setProperty("--bf-layout-render-scale", `${viewportProfile.scale}`);

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
        layoutWidth: viewportProfile.layoutWidth,
        layoutHeight: viewportProfile.layoutHeight,
        viewportSource: viewportProfile.source,
        columns: trackConfig.tracks,
        minCardWidth,
        gap,
        reason: pendingRecomputeReason,
      });
      logger.log("masonry reflow", {
        columns: trackConfig.tracks,
        layoutMode,
        reason: pendingRecomputeReason,
        snapshot: snapshotFromPlan(plan),
      });
      pendingAutoArrange = false;
      pendingRecomputeReason = "reflow";
    }

    function scheduleRecompute(reason) {
      if (typeof reason === "string" && reason) {
        pendingRecomputeReason = reason;
      }
      if (frameToken) {
        return;
      }
      frameToken = globalScope.requestAnimationFrame(recompute);
    }

    function requestLayout(reason) {
      scheduleRecompute(reason || "reflow");
    }

    function handleViewportReflow(reason) {
      logger.log("window resize", {
        reason,
        containerWidth: currentContainerWidth(),
        viewportWidth: globalScope.innerWidth,
        viewportHeight: globalScope.innerHeight,
      });
      requestLayout(reason || "viewport-change");
    }

    function autoArrange() {
      const ordered = cards
        .map((card, index) => buildCardDescriptor(card, index))
      const viewportProfile = resolveViewportProfile();
      const trackConfig = trackResolver(viewportProfile.layoutWidth, {
        mode,
        container,
        cards,
        layoutMode: resolveLayoutMode(),
        config: { ...layoutConfig },
        viewport: viewportProfile,
      });
      const orderedKeys = computeAutoArrangeOrder(cards.map((card, index) => buildCardDescriptor(card, index)), {
        tracks: trackConfig.tracks,
        rowUnit,
        gap: Number.isFinite(Number(trackConfig.gap)) ? Number(trackConfig.gap) : (layoutConfig.gap ?? currentContainerGap()),
      });
      orderedKeys.forEach((key, index) => {
        const entry = cards.find((card) => ensureCardKey(card) === key);
        if (!entry) {
          return;
        }
        state[ensureCardKey(entry)] = { ...readCardState(entry), order: index };
      });
      pendingAutoArrange = true;
      setDirty(true, "auto-arrange");
      logger.log("auto-arrange", {
        ordered: orderedKeys,
        viewportSource: viewportProfile.source,
        layoutWidth: viewportProfile.layoutWidth,
        columns: trackConfig.tracks,
      });
      requestLayout("auto-arrange");
      saveLayout("auto-arrange");
    }

    function resetState(reason) {
      if (storageKey && typeof localStorage !== "undefined") {
        localStorage.removeItem(storageKey);
      }
      cards.forEach((card) => {
        state[ensureCardKey(card)] = defaultStateForCard(card);
      });
      pendingAutoArrange = false;
      setDirty(true, reason || "reset-state");
      logger.log("reset layout", { reason: reason || "reset-state" });
      requestLayout(reason || "reset-state");
      saveLayout(reason || "reset-state");
    }

    function setCardCollapsed(cardKey, collapsed, reason) {
      const card = cards.find((entry) => ensureCardKey(entry) === cardKey);
      if (!card) {
        return false;
      }
      writeCardState(card, { collapsed: Boolean(collapsed), hidden: false }, reason || "set-card-collapsed");
      applyState(card);
      requestLayout(reason || "set-card-collapsed");
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
      requestLayout(reason || "remote-sync");
    }

    function setEditing(enabled) {
      editingEnabled = enabled !== false;
      logger.log(editingEnabled ? "edit mode enabled" : "edit mode disabled", { mode, editingEnabled });
      cards.forEach((card) => updateCardChrome(card));
      syncDragControllers();
    }

    function updateConfig(nextConfig = {}) {
      if (nextConfig.minCardWidth != null && Number.isFinite(Number(nextConfig.minCardWidth))) {
        layoutConfig.minCardWidth = Number(nextConfig.minCardWidth);
      }
      if (nextConfig.gap != null && Number.isFinite(Number(nextConfig.gap))) {
        layoutConfig.gap = Number(nextConfig.gap);
        container.style.setProperty("gap", `${layoutConfig.gap}px`);
      }
      logger.log("layout config updated", { ...layoutConfig });
    }

    function isDirty() {
      return dirty;
    }

    cards.forEach((card) => {
      const key = ensureCardKey(card);
      if (!state[key]) {
        state[key] = defaultStateForCard(card);
      }
      injectControls(card);
      applyState(card);
    });

    syncDragControllers();

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

      cards.forEach((card) => {
        resizeObserver.observe(card);
      });
    }
    if (typeof MutationObserver === "function") {
      const mutationObserver = new MutationObserver((mutations) => {
        const hasContentChange = mutations.some((mutation) => mutation.type === "childList" || mutation.type === "characterData");
        if (hasContentChange) {
          requestLayout("card-content-mutation");
        }
      });
      cards.forEach((card) => {
        const contentTarget = card.querySelector(".card-content") || card;
        mutationObserver.observe(contentTarget, {
          childList: true,
          characterData: true,
          subtree: true,
        });
      });
    }

    scheduleRecompute("initial-layout");

    return {
      recompute: scheduleRecompute,
      requestLayout,
      autoArrange,
      resetState,
      setCardCollapsed,
      applyRemoteState,
      emitLayoutSnapshot,
      saveLayout,
      setEditing,
      updateConfig,
      isDirty,
      getLayoutCache() {
        return {
          columns: layoutCache.columns,
          layoutMode: layoutCache.layoutMode,
          positions: { ...layoutCache.positions },
          heights: { ...layoutCache.heights },
          columnHeights: layoutCache.columnHeights.slice(),
          viewport: layoutCache.viewport ? { ...layoutCache.viewport } : null,
        };
      },
      getSnapshot() {
        const descriptors = cards.map((card, index) => buildCardDescriptor(card, index));
        const viewportProfile = layoutCache.viewport || resolveViewportProfile();
        return snapshotFromPlan(computeLayoutPlan(descriptors, {
          tracks: layoutCache.columns || trackResolver(viewportProfile.layoutWidth, {
            mode,
            container,
            cards,
            layoutMode: resolveLayoutMode(),
            config: { ...layoutConfig },
            viewport: viewportProfile,
          }).tracks,
          rowUnit,
          gap: layoutConfig.gap ?? currentContainerGap(),
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
    computeAutoArrangeOrder,
    computeLayoutPlan,
    computeTrackMetrics,
    computeViewportFrame,
    computeRowSpan,
    snapshotFromPlan,
    createAdaptiveLayout,
    createDefaultTrackResolver,
    extractResolutionCandidatesFromText,
    normalizeLayoutMode,
    pickBestResolution,
  };
});
