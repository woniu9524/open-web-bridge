"use strict";
/**
 * HAR 录制：Network 域事件 → Stats 累积。
 *
 * 移植自 har-recorder-1.5/stats.js，适配 open-web-bridge：
 *  - entries 用 plain object（与 builder 的 Object.values 用法一致）
 *  - 保持 HAR 1.2 所需的全字段：timing、encodedDataLength、redirect 合成、
 *    WebSocket 帧、主动 body 拉取（loadingFinished 时由 background 触发）
 *
 * Stats 只管网络域；console/storage/screenshots 等录制增强字段
 * 由 background.js 的 recorder 包装对象承载，不污染 Stats。
 */

export class Stats {
  constructor(url) {
    this.url = url;
    this.firstRequestId = undefined;
    this.firstRequestMs = undefined;
    this.domContentEventFiredMs = undefined;
    this.loadEventFiredMs = undefined;
    // requestId -> entry（plain object；builder 用 Object.values 迭代）
    this.entries = {};
    this.responseBodyCounter = 0;
  }
}

export class StatsBuilder {
  static processEvent(stats, { method, params }) {
    const methodName = `_${method.replace(".", "_")}`;
    const handler = StatsBuilder[methodName];
    if (handler) handler(stats, params);
  }

  static _Page_domContentEventFired(stats, params) {
    const { timestamp } = params;
    stats.domContentEventFiredMs = timestamp * 1000;
  }

  static _Page_loadEventFired(stats, params) {
    const { timestamp } = params;
    stats.loadEventFiredMs = timestamp * 1000;
  }

  static _Network_requestWillBeSent(stats, params) {
    const { requestId, initiator, timestamp, redirectResponse } = params;
    // 跳过 data URI
    if (params.request.url.match("^data:")) {
      return;
    }
    // 首请求记一次
    if (!stats.firstRequestId && initiator.type === "other") {
      stats.firstRequestMs = timestamp * 1000;
      stats.firstRequestId = requestId;
    }
    // redirect：Chrome 用同一 requestId，需把上一跳合成独立 entry
    if (redirectResponse) {
      const redirectEntry = stats.entries[requestId];
      if (redirectEntry) {
        redirectEntry.responseParams = { response: redirectResponse };
        redirectEntry.responseFinishedS = timestamp;
        redirectEntry.encodedResponseLength = redirectResponse.encodedDataLength;
        const newId = requestId + "_redirect_" + timestamp;
        stats.entries[newId] = redirectEntry;
        delete stats.entries[requestId];
      }
    }
    // 初始化本 entry
    stats.entries[requestId] = {
      requestParams: params,
      responseParams: undefined,
      responseLength: 0, // 增量累积
      encodedResponseLength: undefined,
      responseFinishedS: undefined,
      responseFailedS: undefined,
      responseBody: undefined,
      responseBodyIsBase64: undefined,
      newPriority: undefined,
    };
  }

  static _Network_dataReceived(stats, params) {
    const { requestId, dataLength } = params;
    const entry = stats.entries[requestId];
    if (!entry) return;
    entry.responseLength += dataLength;
  }

  static _Network_responseReceived(stats, params) {
    const entry = stats.entries[params.requestId];
    if (!entry) return;
    entry.responseParams = params;
  }

  static _Network_resourceChangedPriority(stats, params) {
    const { requestId, newPriority } = params;
    const entry = stats.entries[requestId];
    if (!entry) return;
    entry.newPriority = newPriority;
  }

  static _Network_loadingFinished(stats, params) {
    const { requestId, timestamp, encodedDataLength } = params;
    const entry = stats.entries[requestId];
    if (!entry) return;
    entry.encodedResponseLength = encodedDataLength;
    entry.responseFinishedS = timestamp;
    stats.responseBodyCounter++;
  }

  static _Network_loadingFailed(stats, params) {
    const { requestId, timestamp } = params;
    const entry = stats.entries[requestId];
    if (!entry) return;
    entry.responseFailedS = timestamp;
  }

  // loadingFinished 后由 background 主动拉 body，再以此方法回填
  static _Network_getResponseBody(stats, params) {
    const { requestId, body, base64Encoded } = params;
    const entry = stats.entries[requestId];
    if (!entry) return;
    entry.responseBody = body;
    entry.responseBodyIsBase64 = base64Encoded;
  }

  // ---- WebSocket ----

  static _Network_webSocketWillSendHandshakeRequest(stats, params) {
    stats.entries[params.requestId] = {
      isWebSocket: true,
      frames: [],
      requestParams: params,
      responseParams: undefined,
      responseLength: 0,
      encodedResponseLength: undefined,
      responseFinishedS: undefined,
      responseFailedS: undefined,
      responseBody: undefined,
      responseBodyIsBase64: undefined,
      newPriority: undefined,
    };
  }

  static _Network_webSocketHandshakeResponseReceived(stats, params) {
    StatsBuilder._Network_responseReceived(stats, params);
  }

  static _Network_webSocketClosed(stats, params) {
    const { requestId, timestamp } = params;
    const entry = stats.entries[requestId];
    if (!entry) return;
    entry.responseFinishedS = timestamp;
  }

  static _Network_webSocketFrameSent(stats, params) {
    const { requestId, timestamp, response } = params;
    const entry = stats.entries[requestId];
    if (!entry) return;
    entry.frames.push({
      type: "send",
      time: timestamp,
      opcode: response.opcode,
      data: response.payloadData,
    });
  }

  static _Network_webSocketFrameReceived(stats, params) {
    const { requestId, timestamp, response } = params;
    const entry = stats.entries[requestId];
    if (!entry) return;
    entry.frames.push({
      type: "receive",
      time: timestamp,
      opcode: response.opcode,
      data: response.payloadData,
    });
  }
}
