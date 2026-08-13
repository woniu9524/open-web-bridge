"use strict";
/**
 * HAR 1.2 生成器。移植自 har-recorder-1.5/har.js（成熟逻辑原样保留）。
 *
 * 输入：Stats 实例数组（每 tab 一个 page）+ 域名/标题。
 * 输出：HAR 1.2 对象（log.pages + log.entries），可 JSON.stringify 落盘。
 *
 * 额外字段（HAR 扩展约定，下划线前缀）：
 *  _initiator / _priority / _resourceType / _webSocketMessages /
 *  _fromDiskCache / _transferSize / _openerTabId（多 tab 关联用）
 */

export class HARBuilder {
  create(pages, title) {
    const har = {
      log: {
        version: "1.2",
        creator: {
          name: "Open Web Bridge",
          version: "1.0",
          comment: "Network recording via CDP",
        },
        pages: [],
        entries: [],
      },
    };
    for (const [pageIndex, stats] of pages.entries()) {
      const pageId = `page_${pageIndex + 1}_${String(Math.random()).slice(2)}`;
      const domain = title || stats.url || `page_${pageIndex + 1}`;
      const log = this.parsePage(String(pageId), stats, domain);
      har.log.pages.push(log.page);
      har.log.entries.push(...log.entries);
    }
    return har;
  }

  parsePage(pageId, stats, title) {
    let startedDateTime = new Date().toISOString();
    const onContentLoad = stats.domContentEventFiredMs && stats.firstRequestMs
      ? Math.max(0, stats.domContentEventFiredMs - stats.firstRequestMs)
      : 0;
    const onLoad = stats.loadEventFiredMs && stats.firstRequestMs
      ? Math.max(0, stats.loadEventFiredMs - stats.firstRequestMs)
      : 0;
    const entries = [...Object.values(stats.entries)]
      .map((entry) => this.parseEntry(pageId, entry))
      .filter((entry) => entry);
    if (entries[0] && entries[0].startedDateTime) {
      startedDateTime = entries[0].startedDateTime;
    }
    return {
      page: {
        id: pageId,
        title,
        startedDateTime,
        pageTimings: { onContentLoad, onLoad },
        _url: stats.url || null,
        _openerTabId: stats.openerTabId ?? null,
      },
      entries,
    };
  }

  parseEntry(pageref, entry) {
    // 无响应的请求跳过（WebSocket 除外）
    if (!entry.responseParams ||
        (!entry.isWebSocket && !entry.responseFinishedS && !entry.responseFailedS)) {
      return null;
    }
    // 非 WebSocket 缺 timing 也跳过（CDP 文档说 timing 可选）
    if (!entry.isWebSocket && !entry.responseParams.response.timing) {
      return null;
    }
    const { request } = entry.requestParams;
    const { response } = entry.responseParams;
    // WebSocket 字段补全（协议信息不全）
    if (entry.isWebSocket) {
      const requestStatus = (response.requestHeadersText || "").split(" ");
      request.method = requestStatus[0] || "GET";
      request.url = requestStatus[1] || "";
      response.protocol = (response.headersText || "").split(" ")[0] || "ws";
    }
    const wallTimeMs = entry.requestParams.wallTime * 1000;
    const startedDateTime = new Date(wallTimeMs).toISOString();
    const httpVersion = response.protocol || "unknown";
    const { method, url } = request;
    const { status, statusText } = response;
    const headers = this.parseHeaders(httpVersion, request, response);
    const redirectURL = this.getHeaderValue(response.headers, "location", "");
    const queryString = this.parseQueryString(request.url);
    const postData = this.parsePostData(request, headers);
    const { time, timings } = this.computeTimings(entry);
    let serverIPAddress = response.remoteIPAddress;
    if (serverIPAddress) {
      serverIPAddress = serverIPAddress.replace(/^\[(.*)\]$/, "$1");
    }
    const connection = String(response.connectionId);
    const _initiator = entry.requestParams.initiator;
    const { newPriority } = entry;
    const _priority = newPriority || request.initialPriority;
    let _resourceType = entry.requestParams.type
      ? entry.requestParams.type.toLowerCase()
      : undefined;
    const payload = this.computePayload(entry, headers);
    const { mimeType } = response;
    const encoding = entry.responseBodyIsBase64 ? "base64" : undefined;
    let _webSocketMessages;
    if (entry.isWebSocket) {
      _webSocketMessages = entry.frames;
      _resourceType = "websocket";
    }
    return {
      pageref,
      startedDateTime,
      time,
      request: {
        method,
        url,
        httpVersion,
        cookies: [],
        headers: headers.request.pairs,
        queryString,
        headersSize: headers.request.size,
        bodySize: payload.request.bodySize,
        postData,
      },
      response: {
        status,
        statusText,
        httpVersion,
        cookies: [],
        headers: headers.response.pairs,
        redirectURL,
        headersSize: headers.response.size,
        bodySize: payload.response.bodySize,
        _transferSize: payload.response.transferSize,
        content: {
          size: entry.responseLength,
          mimeType: entry.isWebSocket ? "x-unknown" : mimeType,
          compression: payload.response.compression,
          text: entry.responseBody,
          encoding,
        },
      },
      cache: {},
      _fromDiskCache: response.fromDiskCache,
      timings,
      serverIPAddress,
      connection,
      _initiator,
      _priority,
      _webSocketMessages,
      _resourceType,
    };
  }

  parseHeaders(httpVersion, request, response) {
    const requestHeaders = response.requestHeaders || request.headers;
    const responseHeaders = response.headers;
    const headers = {
      request: {
        map: requestHeaders,
        pairs: this.zipNameValue(requestHeaders),
        size: -1,
      },
      response: {
        map: responseHeaders,
        pairs: this.zipNameValue(responseHeaders),
        size: -1,
      },
    };
    // 仅 HTTP/1.x 可较准确估算 header size（含状态行）
    if (httpVersion.match(/^http\/[01].[01]$/i)) {
      const requestText = this.getRawRequest(request, headers.request.pairs);
      const responseText = this.getRawResponse(response, headers.response.pairs);
      headers.request.size = requestText.length;
      headers.response.size = responseText.length;
    }
    return headers;
  }

  computeTimings(entry) {
    if (entry.isWebSocket) {
      const sessionTime =
        entry.frames.length === 0
          ? -1
          : this.toMilliseconds(
              entry.frames[entry.frames.length - 1].time - entry.requestParams.timestamp
            );
      return {
        time: sessionTime,
        timings: {
          blocked: -1, dns: -1, connect: -1, send: 0,
          wait: sessionTime, receive: -1, ssl: -1,
        },
      };
    }
    const timing = entry.responseParams.response.timing;
    const finishedTimestamp = entry.responseFinishedS || entry.responseFailedS;
    const time = this.toMilliseconds(finishedTimestamp - entry.requestParams.timestamp);
    const blockedBase = this.toMilliseconds(timing.requestTime - entry.requestParams.timestamp);
    const blockedStart = this.firstNonNegative([
      timing.dnsStart, timing.connectStart, timing.sendStart,
    ]);
    const blocked = blockedBase + (blockedStart === -1 ? 0 : blockedStart);
    let dns = -1;
    if (timing.dnsStart >= 0) {
      const start = this.firstNonNegative([timing.connectStart, timing.sendStart]);
      dns = start - timing.dnsStart;
    }
    let connect = -1;
    if (timing.connectStart >= 0) {
      connect = timing.sendStart - timing.connectStart;
    }
    const send = timing.sendEnd - timing.sendStart;
    const wait = timing.receiveHeadersEnd - timing.sendEnd;
    const receive = this.toMilliseconds(
      finishedTimestamp - (timing.requestTime + timing.receiveHeadersEnd / 1000)
    );
    let ssl = -1;
    if (timing.sslStart >= 0 && timing.sslEnd >= 0) {
      ssl = timing.sslEnd - timing.sslStart;
    }
    return { time, timings: { blocked, dns, connect, send, wait, receive, ssl } };
  }

  computePayload(entry, headers) {
    let bodySize;
    let compression;
    let transferSize = entry.encodedResponseLength;
    if (headers.response.size === -1) {
      bodySize = -1;
      compression = undefined;
    } else if (entry.responseFailedS) {
      bodySize = 0;
      compression = 0;
      transferSize = headers.response.size;
    } else {
      bodySize = entry.encodedResponseLength - headers.response.size;
      compression = entry.responseLength - bodySize;
    }
    return {
      request: {
        bodySize: parseInt(this.getHeaderValue(headers.request.map, "content-length", -1), 10),
      },
      response: { bodySize, transferSize, compression },
    };
  }

  zipNameValue(map) {
    const pairs = [];
    for (const [name, value] of Object.entries(map || {})) {
      const values = Array.isArray(value) ? value : [value];
      for (const value of values) pairs.push({ name, value });
    }
    return pairs;
  }

  parseQuery(query) {
    return String(query || "")
      .split("&")
      .filter(Boolean)
      .map(function (nameValue) {
        const nameValuePair = nameValue.split("=").map(decodeURIComponent);
        return { [nameValuePair[0]]: nameValuePair[1] };
      });
  }

  getRawRequest(request, headerPairs) {
    const { method, url, protocol } = request;
    const lines = [`${method} ${url} ${protocol}`];
    for (const { name, value } of headerPairs) lines.push(`${name}: ${value}`);
    lines.push("", "");
    return lines.join("\r\n");
  }

  getRawResponse(response, headerPairs) {
    const { status, statusText, protocol } = response;
    const lines = [`${protocol} ${status} ${statusText}`];
    for (const { name, value } of headerPairs) lines.push(`${name}: ${value}`);
    lines.push("", "");
    return lines.join("\r\n");
  }

  getHeaderValue(headers, name, fallback) {
    const pattern = new RegExp(`^${name}$`, "i");
    const key = Object.keys(headers || {}).find((n) => n.match(pattern));
    return key === undefined ? fallback : headers[key];
  }

  parseQueryString(requestUrl) {
    let url;
    try {
      url = new URL(requestUrl);
    } catch (e) {
      return [];
    }
    const map = {};
    for (const pair of url.searchParams.entries()) map[pair[0]] = pair[1];
    return this.zipNameValue(map);
  }

  parsePostData(request, headers) {
    const { postData } = request;
    if (!postData) return undefined;
    const mimeType = this.getHeaderValue(headers.request.map, "content-type");
    const params =
      mimeType === "application/x-www-form-urlencoded"
        ? this.zipNameValue(this.parseQuery(postData))
        : [];
    return { mimeType, params, text: postData };
  }

  firstNonNegative(values) {
    const value = values.find((v) => v >= 0);
    return value === undefined ? -1 : value;
  }

  toMilliseconds(time) {
    return time < 0 ? -1 : time * 1000;
  }
}
