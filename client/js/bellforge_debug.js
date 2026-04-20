(function initBellForgeDebug(globalScope) {
  const DEFAULT_ENDPOINT = "/api/debug/event";
  const MAX_LOCAL_EVENTS = 250;

  function safeClone(value, depth = 0) {
    if (depth > 5) {
      return "[depth-truncated]";
    }
    if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.slice(0, 60).map((item) => safeClone(item, depth + 1));
    }
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    }
    if (typeof value === "object") {
      const clone = {};
      Object.entries(value).slice(0, 80).forEach(([key, item]) => {
        clone[key] = safeClone(item, depth + 1);
      });
      return clone;
    }
    return String(value);
  }

  function isVerboseRequested(options = {}) {
    try {
      if (options.verbose === true) return true;
      if (globalScope.localStorage?.getItem("bellforge.debug.verbose") === "true") return true;
      const params = new URLSearchParams(globalScope.location?.search || "");
      return params.get("debug") === "1";
    } catch {
      return Boolean(options.verbose);
    }
  }

  function captureGridSnapshot(containerOrSelector) {
    const container = typeof containerOrSelector === "string"
      ? globalScope.document?.querySelector(containerOrSelector)
      : containerOrSelector;
    if (!container || typeof globalScope.getComputedStyle !== "function") {
      return null;
    }
    const rect = container.getBoundingClientRect();
    const style = getComputedStyle(container);
    const cards = Array.from(container.querySelectorAll("[data-fibo-card]")).map((card) => {
      const cardRect = card.getBoundingClientRect();
      return {
        key: card.dataset.cardKey || "unknown",
        order: Number(card.dataset.fiboOrder || 0),
        rowIndex: Number(card.dataset.fiboRowIndex || 0),
        colStart: Number(card.dataset.fiboColStart || 0),
        colSpan: Number(card.dataset.fiboColSpan || 0),
        rowSpan: Number(card.dataset.fiboRowSpan || 0),
        collapsed: card.classList.contains("is-collapsed"),
        rect: {
          x: Math.round(cardRect.x * 100) / 100,
          y: Math.round(cardRect.y * 100) / 100,
          width: Math.round(cardRect.width * 100) / 100,
          height: Math.round(cardRect.height * 100) / 100,
        },
      };
    });
    return {
      viewport: {
        width: globalScope.innerWidth || 0,
        height: globalScope.innerHeight || 0,
      },
      container: {
        width: Math.round(rect.width * 100) / 100,
        height: Math.round(rect.height * 100) / 100,
        gap: Math.round((Number.parseFloat(style.gap || style.columnGap || "0") || 0) * 100) / 100,
        columns: Number(style.getPropertyValue("--fibo-columns") || container.style.getPropertyValue("--fibo-columns") || 0),
      },
      cards,
    };
  }

  function postEvent(endpoint, entry) {
    try {
      return fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
        keepalive: true,
      }).catch(() => undefined);
    } catch {
      return Promise.resolve(undefined);
    }
  }

  function createClient(options = {}) {
    const state = {
      source: String(options.source || options.surface || "client"),
      endpoint: String(options.endpoint || DEFAULT_ENDPOINT),
      verbose: isVerboseRequested(options),
      events: [],
      mutationEvents: 0,
      globalObserversInstalled: false,
      observers: [],
    };

    function remember(entry) {
      state.events.push(entry);
      while (state.events.length > MAX_LOCAL_EVENTS) {
        state.events.shift();
      }
    }

    function emit(level, channel, message, payload, extra = {}) {
      const entry = {
        source: state.source,
        level: level || "info",
        channel: channel || "general",
        message: message || "event",
        payload: safeClone(payload),
        event_type: extra.eventType || "event",
      };
      if (state.verbose && extra.includeStack !== false) {
        entry.payload = {
          ...(entry.payload && typeof entry.payload === "object" ? entry.payload : { value: entry.payload }),
          stack: new Error().stack,
        };
      }
      remember({ timestamp: new Date().toISOString(), ...entry });
      if (state.verbose || level === "warn" || level === "error") {
        const consoleMethod = level === "error" ? "error" : level === "warn" ? "warn" : "log";
        if (typeof globalScope.console?.[consoleMethod] === "function") {
          globalScope.console[consoleMethod](`[BellForgeDebug:${state.source}] ${channel}: ${message}`, payload || "");
        }
      }
      postEvent(state.endpoint, entry);
      return entry;
    }

    function log(channel, message, payload, extra = {}) {
      return emit("info", channel, message, payload, extra);
    }

    function warn(channel, message, payload, extra = {}) {
      return emit("warn", channel, message, payload, extra);
    }

    function error(channel, message, payload, extra = {}) {
      return emit("error", channel, message, payload, extra);
    }

    function snapshot(channel, message, containerOrSelector, payload = {}, extra = {}) {
      return emit("info", channel, message, {
        ...safeClone(payload),
        layoutSnapshot: captureGridSnapshot(containerOrSelector),
      }, {
        ...extra,
        eventType: extra.eventType || "snapshot",
      });
    }

    function observeMutations(containerOrSelector) {
      const container = typeof containerOrSelector === "string"
        ? globalScope.document?.querySelector(containerOrSelector)
        : containerOrSelector;
      if (!container || typeof MutationObserver === "undefined") {
        return null;
      }
      const observer = new MutationObserver((mutations) => {
        state.mutationEvents += mutations.length;
        const summary = mutations.slice(0, 10).map((mutation) => ({
          type: mutation.type,
          target: mutation.target?.nodeName || null,
          attributeName: mutation.attributeName || null,
          addedNodes: mutation.addedNodes?.length || 0,
          removedNodes: mutation.removedNodes?.length || 0,
        }));
        emit("info", "DOM mutation observers", "Observed DOM mutation batch", {
          count: mutations.length,
          summary,
        }, { eventType: "mutation" });
      });
      observer.observe(container, {
        attributes: true,
        childList: true,
        subtree: true,
      });
      state.observers.push(observer);
      return observer;
    }

    function installGlobalObservers(options = {}) {
      if (state.globalObserversInstalled) {
        return;
      }
      state.globalObserversInstalled = true;
      globalScope.addEventListener("error", (event) => {
        error("exceptions and warnings", "Unhandled window error", {
          message: event.message,
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          error: safeClone(event.error),
        }, { eventType: "exception" });
      });
      globalScope.addEventListener("unhandledrejection", (event) => {
        error("exceptions and warnings", "Unhandled promise rejection", {
          reason: safeClone(event.reason),
        }, { eventType: "exception" });
      });
      if (options.observeContainer) {
        observeMutations(options.observeContainer);
      }
    }

    function getLocalState() {
      return {
        source: state.source,
        verbose: state.verbose,
        mutationEvents: state.mutationEvents,
        eventCount: state.events.length,
        recentEvents: state.events.slice(-25),
      };
    }

    return {
      log,
      warn,
      error,
      snapshot,
      observeMutations,
      installGlobalObservers,
      getLocalState,
      captureGridSnapshot,
    };
  }

  globalScope.BellForgeDebug = {
    createClient,
    captureGridSnapshot,
    safeClone,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);