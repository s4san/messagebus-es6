/* eslint-disable no-param-reassign */
/* eslint-disable no-underscore-dangle */
/**
 * This is an es6 port of the messageBus' javascript client.
 * Original Source: https://github.com/SamSaffron/message_bus/blob/master/assets/message-bus.js
 * It exports an es6 class and removes the dependency on -
 * jQuery, document and window from the original source.
 */
import Constants from './Constants.js';
import Logger from './Logger.js';

class MessageBus {
  constructor() {
    // Create an app-wide singleton MessageBus instance
    if (MessageBus.__instance) {
      return MessageBus.__instance;
    }

    if (!(this instanceof MessageBus)) {
      return new MessageBus();
    }

    MessageBus.__instance = this;

    // Sparse global variables
    this.clientId = this.constructor.uniqueId();
    this.responseCallbacks = {};
    this.callbacks = [];
    this.queue = [];
    this.interval = null;
    this.failCount = 0;
    this.baseUrl = `${Constants.serverHost()}/`;
    this.later = [];
    this.chunkedBackoff = 0;

    this.totalAjaxFailures = 0;
    this.totalAjaxCalls = 0;
    this.lastAjax = undefined;

    this.paused = false;
    this.stopped = undefined;
    this.started = undefined;

    // Actual MessageBus Configuration
    this.enableChunkedEncoding = true;
    this.enableLongPolling = true;
    this.callbackInterval = 15e3;
    this.backgroundCallbackInterval = 60e3;
    this.maxPollInterval = 3 * 60e3;
    this.alwaysLongPoll = true;
    this.headers = {};
    this.longPoll = undefined;
  }

  allowChunked() {
    return this.enableChunkedEncoding && this.constructor.hasonprogress();
  }

  shouldLongPoll() {
    return this.alwaysLongPoll;
  }

  processMessages(messages) {
    let gotData = false;
    if (!messages) return false; // server unexpectedly closed connection

    messages.forEach((message) => {
      gotData = true;
      this.callbacks.forEach((callback) => {
        if (callback.channel === message.channel) {
          callback.last_id = message.message_id;
          try {
            callback.func(message.data, message.global_id, message.message_id);
          } catch (e) {
            if (Logger.error) {
              Logger.error(`MESSAGE BUS FAIL: callback ${callback.channel} caused exception`, e);
            }
          }
          if (message.channel === '/__status') {
            if (message.data[callback.channel] !== undefined) {
              callback.last_id = message.data[callback.channel];
            }
          }
        }
      });
    });

    return gotData;
  }

  reqSuccess(messages) {
    this.failCount = 0;
    if (this.paused) {
      if (messages) {
        messages.forEach(message => this.later.push(message));
      }
    } else {
      return this.processMessages(messages);
    }
    return false;
  }

  longPoller(poll, data) {
    let gotData = false;
    let aborted = false;
    this.lastAjax = new Date();
    this.totalAjaxCalls += 1;
    /* eslint-disable no-underscore-dangle */
    data.__seq = this.totalAjaxCalls;

    const longPoll = this.shouldLongPoll() && this.enableLongPolling;
    let chunked = longPoll && this.allowChunked();
    if (this.chunkedBackoff > 0) {
      this.chunkedBackoff -= 1;
      chunked = false;
    }

    const headers = {
      'X-SILENCE-LOGGER': 'true',
    };

    Object.entries(this.headers).forEach(([key, value]) => {
      headers[key] = value;
    });

    if (!chunked) {
      headers['Dont-Chunk'] = 'true';
    }

    headers['Cache-Control'] = 'no-cache';

    const dataType = chunked ? 'text' : 'json';

    const handleProgress = (payload, position) => {
      const separator = '\r\n|\r\n';
      const endChunk = payload.indexOf(separator, position);

      if (endChunk === -1) {
        return position;
      }

      let chunk = payload.substring(position, endChunk);
      chunk = chunk.replace(/\r\n\|\|\r\n/g, separator);

      // debugger;
      try {
        this.reqSuccess(JSON.parse(chunk));
      } catch (e) {
        if (Logger.error) {
          Logger.error('FAILED TO PARSE CHUNKED REPLY', data, e);
        }
      }

      return handleProgress(payload, endChunk + separator.length);
    };

    const disableChunked = () => {
      if (this.longPoll) {
        this.longPoll.abort();
        this.chunkedBackoff = 30;
      }
    };

    const setOnProgressListener = (xhr) => {
      let position = 0;
      // if it takes longer than 3000 ms to get first chunk, we have some proxy
      // this is messing with us, so just backoff from using chunked for now
      const chunkedTimeout = setTimeout(disableChunked, 3000);
      xhr.onprogress = () => {
        clearTimeout(chunkedTimeout);
        if (xhr.getResponseHeader('Content-Type') === 'application/json; charset=utf-8') {
          chunked = false;
          return;
        }
        position = handleProgress(xhr.responseText, position);
      };
    };

    const successHandler = (messages) => {
      if (!chunked) {
        try {
          if (typeof messages === 'string') {
            messages = JSON.parse(messages);
          }
          gotData = this.reqSuccess(messages);
        } catch (e) {
          Logger.error('ERROR IN MESSAGES successHandler', messages, e);
        }
      }
    };

    const errorHandler = (xhr, textStatus) => {
      if (textStatus === 'abort') {
        aborted = true;
      } else {
        this.failCount += 1;
        this.totalAjaxFailures += 1;
      }
    };

    const completeHandler = () => {
      let interval;
      try {
        if (gotData || aborted) {
          interval = 100;
        } else {
          interval = this.callbackInterval;
          if (this.failCount > 2) {
            interval *= this.failCount;
          } else if (!this.shouldLongPoll()) {
            interval = this.backgroundCallbackInterval;
          }
          if (interval > this.maxPollInterval) {
            interval = this.maxPollInterval;
          }

          interval -= new Date() - this.lastAjax;

          if (interval < 100) {
            interval = 100;
          }
        }
      } catch (e) {
        if (Logger.error) {
          Logger.error('MESSAGE BUS FAIL: ', e);
        }
      }

      setTimeout(poll, interval);
      this.longPoll = null;
    };

    const request = new XMLHttpRequest();
    request.open('POST', `${this.baseUrl}message-bus/${this.clientId}/poll${!longPoll ? '?dlp=t' : ''}`, true);
    request.responseType = dataType;
    Object.entries(headers).forEach(([key, value]) => request.setRequestHeader(key, value));

    if (chunked) {
      setOnProgressListener(request);
    }

    request.onload = successHandler;
    request.onerror = errorHandler;
    request.onloadend = completeHandler;

    const formData = new FormData();

    Object.entries(data).forEach(([key, value]) => formData.append(key, value));

    request.send(formData);
    // Logger.info(request);
    return request;
  }

  diagnostics() {
    Logger.info(`Stopped: ${this.stopped} Started: ${this.started}`);
    Logger.info('Current callbacks');
    Logger.info(this.callbacks);
    Logger.info(`Total ajax calls: ${this.totalAjaxCalls}` +
      `Recent failure count: ${this.failCount}` +
      ` Total failures: ${this.totalAjaxFailures}`);
    Logger.info(`Last ajax call: ${(new Date() - this.lastAjax) / 1000} seconds ago`);
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.processMessages(this.later);
    this.later = [];
  }

  stop() {
    this.stopped = true;
    this.started = false;
  }

  start() {
    let delayPollTimeout;

    if (this.started) return;
    this.started = true;
    this.stopped = false;

    const poll = () => {
      const data = {};

      if (this.stopped) return;

      if (this.callbacks.length === 0) {
        if (!delayPollTimeout) {
          delayPollTimeout = setTimeout(() => {
            delayPollTimeout = null;
            poll();
          }, 500);
        }
        return;
      }

      this.callbacks.forEach((callback) => {
        data[callback.channel] = callback.last_id;
      });

      this.longPoll = this.longPoller(poll, data);
    };

    poll();
  }

  status() {
    if (this.paused) {
      return 'paused';
    } else if (this.started) {
      return 'started';
    } else if (this.stopped) {
      return 'stopped';
    }
    throw new Error('Cannot determine current status');
  }

  subscribe(channel, func, lastId) {
    if (!this.started && !this.stopped) {
      this.start();
    }

    if (typeof lastId !== 'number' || lastId < -1) {
      lastId = -1;
    }
    this.callbacks.push({
      channel,
      func,
      last_id: lastId,
    });
    if (this.longPoll) {
      this.longPoll.abort();
    }

    return func;
  }

  // Unsubscribe from a channel
  unsubscribe(channel, func) {
    // TODO allow for globbing in the middle of a channel name
    // like /something/*/something
    // at the moment we only support globbing /something/*
    let glob;
    if (channel.indexOf('*', channel.length - 1) !== -1) {
      channel = channel.substr(0, channel.length - 1);
      glob = true;
    }

    let removed = false;

    /* eslint-disable no-plusplus */
    for (let i = this.callbacks.length - 1; i >= 0; i--) {
      const callback = this.callbacks[i];
      let keep;

      if (glob) {
        keep = callback.channel.substr(0, channel.length) !== channel;
      } else {
        keep = callback.channel !== channel;
      }

      if (!keep && func && callback.func !== func) {
        keep = true;
      }

      if (!keep) {
        this.callbacks.splice(i, 1);
        removed = true;
      }
    }

    if (removed && this.longPoll) {
      this.longPoll.abort();
    }

    return removed;
  }

  static hasonprogress() {
    return new XMLHttpRequest().onprogress === null;
  }

  static uniqueId() {
    return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      /* eslint-disable no-bitwise */
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}

export default new MessageBus();
